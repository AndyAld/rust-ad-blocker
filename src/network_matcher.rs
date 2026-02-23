use crate::filter_parser::{NetworkFilter, RequestType, ThirdParty};
use hashbrown::HashMap;
use regex::Regex;
use std::cell::RefCell;
use bloomfilter::Bloom;

// ── Match result ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MatchResult {
    /// URL should be blocked
    Block,
    /// URL is explicitly allowed (exception rule matched)
    Allow,
    /// No matching rule found — let it through
    NoMatch,
}

// ── Network filter engine ───────────────────────────────────────────────────

pub struct NetworkFilterEngine {
    /// Blocking filters indexed by best token for fast lookup
    block_filters: FilterIndex,
    /// Exception filters indexed by best token for fast lookup
    exception_filters: FilterIndex,
    /// Hostname-anchored block filters indexed by domain
    hostname_block_filters: HashMap<String, Vec<NetworkFilter>>,
    /// Hostname-anchored exception filters indexed by domain
    hostname_exception_filters: HashMap<String, Vec<NetworkFilter>>,
    /// Filters with no tokens (must be checked against every request)
    generic_block_filters: Vec<NetworkFilter>,
    /// Exception filters with no tokens
    generic_exception_filters: Vec<NetworkFilter>,
    /// Bloom filter for O(1) pre-check of blocking tokens
    token_bloom: Bloom<String>,
}

/// Index of filters by best (longest) token for fast lookup.
/// Each filter is indexed by exactly ONE token — the longest one — which
/// minimizes the candidate set size for any given URL.
struct FilterIndex {
    filters: HashMap<String, Vec<usize>>,
    all_filters: Vec<NetworkFilter>,
}

impl FilterIndex {
    fn new() -> Self {
        FilterIndex {
            filters: HashMap::new(),
            all_filters: Vec::new(),
        }
    }

    fn add(&mut self, filter: NetworkFilter) -> Option<String> {
        let idx = self.all_filters.len();
        // Pick the best (longest) token — fewer collisions, smaller buckets
        let best_token = filter.tokens.iter()
            .max_by_key(|t| t.len())
            .cloned();
        self.all_filters.push(filter);
        if let Some(ref token) = best_token {
            self.filters.entry(token.clone()).or_default().push(idx);
        }
        best_token
    }

    fn get_candidates(&self, tokens: &[String]) -> Vec<&NetworkFilter> {
        // Find the token bucket with the fewest entries (most selective)
        let mut best: Option<&Vec<usize>> = None;
        let mut best_count = usize::MAX;
        for token in tokens {
            if let Some(indices) = self.filters.get(token) {
                if indices.len() < best_count {
                    best_count = indices.len();
                    best = Some(indices);
                }
            }
        }
        match best {
            Some(indices) => indices.iter()
                .map(|&idx| &self.all_filters[idx])
                .collect(),
            None => Vec::new(),
        }
    }
}

impl NetworkFilterEngine {
    pub fn new() -> Self {
        // Bloom filter sized for ~200K items with 0.1% false positive rate
        NetworkFilterEngine {
            block_filters: FilterIndex::new(),
            exception_filters: FilterIndex::new(),
            hostname_block_filters: HashMap::new(),
            hostname_exception_filters: HashMap::new(),
            generic_block_filters: Vec::new(),
            generic_exception_filters: Vec::new(),
            token_bloom: Bloom::new_for_fp_rate(200_000, 0.001),
        }
    }

    /// Add a parsed network filter to the engine
    pub fn add_filter(&mut self, filter: NetworkFilter) {
        if filter.is_hostname_anchor && !filter.pattern.contains('*') {
            // Index by the hostname portion for fast domain-based lookup
            let hostname = extract_hostname_from_pattern(&filter.pattern);
            if filter.is_exception {
                self.hostname_exception_filters
                    .entry(hostname)
                    .or_default()
                    .push(filter);
            } else {
                self.hostname_block_filters
                    .entry(hostname)
                    .or_default()
                    .push(filter);
            }
        } else if filter.tokens.is_empty() {
            // No tokens — goes to the generic bucket
            if filter.is_exception {
                self.generic_exception_filters.push(filter);
            } else {
                self.generic_block_filters.push(filter);
            }
        } else {
            // Token-indexed filter
            if filter.is_exception {
                self.exception_filters.add(filter);
            } else {
                // Add to index and register the best token in the bloom filter
                if let Some(token) = self.block_filters.add(filter) {
                    self.token_bloom.set(&token);
                }
            }
        }
    }

    /// Clear all filters
    pub fn clear(&mut self) {
        self.block_filters = FilterIndex::new();
        self.exception_filters = FilterIndex::new();
        self.hostname_block_filters.clear();
        self.hostname_exception_filters.clear();
        self.generic_block_filters.clear();
        self.generic_exception_filters.clear();
        self.token_bloom = Bloom::new_for_fp_rate(200_000, 0.001);
    }

    /// Check if a request should be blocked
    pub fn check(
        &self,
        url: &str,
        source_domain: &str,
        request_type: RequestType,
    ) -> MatchResult {
        let url_lower = url.to_ascii_lowercase();
        let request_domain = extract_domain_from_url(&url_lower);
        let is_third_party = !is_same_domain(&request_domain, source_domain);

        // Extract tokens from the URL for lookup
        let url_tokens = extract_url_tokens(&url_lower);

        // Bloom filter fast-path: if no URL tokens are in the bloom,
        // skip token-indexed block filters entirely (but still check
        // hostname-anchored and generic filters)
        let has_bloom_hit = url_tokens.iter().any(|t| self.token_bloom.check(&t));

        // 1. Check hostname-anchored filters first (fastest path)
        if self.check_hostname_filters(
            &url_lower,
            &request_domain,
            source_domain,
            request_type,
            is_third_party,
        ) {
            // Check for hostname-anchored exceptions
            if self.check_hostname_exceptions(
                &url_lower,
                &request_domain,
                source_domain,
                request_type,
                is_third_party,
            ) {
                return MatchResult::Allow;
            }

            // Check token-indexed exceptions
            let exception_candidates = self.exception_filters.get_candidates(&url_tokens);
            for filter in exception_candidates {
                if matches_filter(filter, &url_lower, source_domain, request_type, is_third_party) {
                    return MatchResult::Allow;
                }
            }

            // Check generic exceptions
            for filter in &self.generic_exception_filters {
                if matches_filter(filter, &url_lower, source_domain, request_type, is_third_party) {
                    return MatchResult::Allow;
                }
            }

            return MatchResult::Block;
        }

        // 2. Check token-indexed blocking filters (skip if bloom says no)
        if !has_bloom_hit {
            // Bloom filter says none of the URL tokens match any block filter
            // Skip straight to generic filters
        } else {
        let block_candidates = self.block_filters.get_candidates(&url_tokens);
        for filter in &block_candidates {
            if matches_filter(filter, &url_lower, source_domain, request_type, is_third_party) {
                // Found a match — check for exceptions
                let exception_candidates = self.exception_filters.get_candidates(&url_tokens);
                for exc_filter in exception_candidates {
                    if matches_filter(
                        exc_filter,
                        &url_lower,
                        source_domain,
                        request_type,
                        is_third_party,
                    ) {
                        return MatchResult::Allow;
                    }
                }

                for exc_filter in &self.generic_exception_filters {
                    if matches_filter(
                        exc_filter,
                        &url_lower,
                        source_domain,
                        request_type,
                        is_third_party,
                    ) {
                        return MatchResult::Allow;
                    }
                }

                return MatchResult::Block;
            }
        }
        } // end bloom-hit block

        // 3. Skip generic (tokenless) blocking filters.
        //    These filters have no identifying tokens and are checked against
        //    every single request, causing excessive false positives.
        //    Hostname-anchored and token-indexed filters provide sufficient
        //    coverage — generic filters trade too much precision for coverage.
        //
        //    NOTE: Generic EXCEPTION filters are still checked above when a
        //    hostname or token-indexed filter matches (lines 199-237).

        MatchResult::NoMatch
    }

    fn check_hostname_filters(
        &self,
        url: &str,
        request_domain: &str,
        source_domain: &str,
        request_type: RequestType,
        is_third_party: bool,
    ) -> bool {
        // Check exact domain and parent domains (stop before bare TLDs)
        let parts: Vec<&str> = request_domain.split('.').collect();
        for i in 0..parts.len() {
            let remaining = parts.len() - i;
            if remaining < 2 {
                break; // Don't check bare TLDs like "org", "com"
            }
            let domain = parts[i..].join(".");
            if let Some(filters) = self.hostname_block_filters.get(&domain) {
                for filter in filters {
                    if matches_filter(filter, url, source_domain, request_type, is_third_party) {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn check_hostname_exceptions(
        &self,
        url: &str,
        request_domain: &str,
        source_domain: &str,
        request_type: RequestType,
        is_third_party: bool,
    ) -> bool {
        let parts: Vec<&str> = request_domain.split('.').collect();
        for i in 0..parts.len() {
            let remaining = parts.len() - i;
            if remaining < 2 {
                break;
            }
            let domain = parts[i..].join(".");
            if let Some(filters) = self.hostname_exception_filters.get(&domain) {
                for filter in filters {
                    if matches_filter(filter, url, source_domain, request_type, is_third_party) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

// ── Pattern matching ────────────────────────────────────────────────────────

/// Check if a filter matches a given request
fn matches_filter(
    filter: &NetworkFilter,
    url: &str,
    source_domain: &str,
    request_type: RequestType,
    is_third_party: bool,
) -> bool {
    // Check type constraint
    if filter.has_type_constraint() && !filter.matches_type(request_type) {
        return false;
    }

    // Check third-party constraint
    if !filter.matches_third_party(is_third_party) {
        return false;
    }

    // Check domain constraint
    if !filter.matches_domain(source_domain) {
        return false;
    }

    // Check URL pattern
    matches_pattern(filter, url)
}

/// Match the filter's pattern against a URL
fn matches_pattern(filter: &NetworkFilter, url: &str) -> bool {
    let pattern = if filter.match_case {
        &filter.pattern
    } else {
        &filter.pattern
    };

    // Regex filter
    if filter.is_regex {
        return match_regex(pattern, url, !filter.match_case);
    }

    // Hostname anchor (||)
    if filter.is_hostname_anchor {
        return match_hostname_anchor(pattern, url);
    }

    // Convert ABP pattern (with * and ^) to a simple matching check
    let pattern_lower = pattern.to_ascii_lowercase();

    if filter.is_left_anchor && filter.is_right_anchor {
        // |pattern| — exact match
        match_abp_pattern_at_start(&pattern_lower, url) && match_abp_pattern_at_end(&pattern_lower, url)
    } else if filter.is_left_anchor {
        // |pattern — match start
        match_abp_pattern_at_start(&pattern_lower, url)
    } else if filter.is_right_anchor {
        // pattern| — match end
        match_abp_pattern_at_end(&pattern_lower, url)
    } else {
        // plain pattern — match anywhere
        match_abp_pattern_anywhere(&pattern_lower, url)
    }
}

/// Match a hostname-anchored pattern (||pattern)
fn match_hostname_anchor(pattern: &str, url: &str) -> bool {
    // Extract what comes after the protocol in the URL
    let url_after_proto = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("wss://"))
        .or_else(|| url.strip_prefix("ws://"))
        .unwrap_or(url);

    let pattern_lower = pattern.to_ascii_lowercase();

    // Check at position 0 (exact domain start)
    if match_abp_pattern_at_start(&pattern_lower, url_after_proto) {
        return true;
    }

    // Check at each subdomain boundary (after each '.')
    let mut pos = 0;
    while let Some(dot_pos) = url_after_proto[pos..].find('.') {
        let boundary = pos + dot_pos + 1;
        if boundary < url_after_proto.len()
            && match_abp_pattern_at_start(&pattern_lower, &url_after_proto[boundary..])
        {
            return true;
        }
        pos = boundary;
    }

    false
}

/// Match an ABP-style pattern (with * and ^) anywhere in the URL
fn match_abp_pattern_anywhere(pattern: &str, url: &str) -> bool {
    if !pattern.contains('*') && !pattern.contains('^') {
        return url.contains(pattern);
    }

    // Split pattern by * (wildcard "match anything")
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut pos = 0;

    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if let Some(found) = find_abp_part(part, &url[pos..]) {
            if i == 0 {
                pos += found + part_match_len(part);
            } else {
                pos += found + part_match_len(part);
            }
        } else {
            return false;
        }
    }

    true
}

/// Match an ABP-style pattern at the start of the URL
fn match_abp_pattern_at_start(pattern: &str, url: &str) -> bool {
    if !pattern.contains('*') && !pattern.contains('^') {
        return url.starts_with(pattern);
    }

    let parts: Vec<&str> = pattern.split('*').collect();
    let mut pos = 0;

    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            // First part must match at position 0
            if !match_abp_part_at(part, url, 0) {
                return false;
            }
            pos = part_match_len(part);
        } else {
            if let Some(found) = find_abp_part(part, &url[pos..]) {
                pos += found + part_match_len(part);
            } else {
                return false;
            }
        }
    }

    true
}

/// Match an ABP-style pattern at the end of the URL
fn match_abp_pattern_at_end(pattern: &str, url: &str) -> bool {
    if !pattern.contains('*') && !pattern.contains('^') {
        return url.ends_with(pattern);
    }

    // For end-anchored, we just do an anywhere match and verify the match reaches the end
    // This is a simplified approach
    match_abp_pattern_anywhere(pattern, url)
}

/// Find an ABP-pattern part (containing ^) in a string
fn find_abp_part(part: &str, haystack: &str) -> Option<usize> {
    if !part.contains('^') {
        return haystack.find(part);
    }

    // ^ matches a separator character or end of string
    for start in 0..haystack.len() {
        if match_abp_part_at(part, haystack, start) {
            return Some(start);
        }
    }
    None
}

/// Check if an ABP-pattern part matches at a specific position
fn match_abp_part_at(part: &str, haystack: &str, start: usize) -> bool {
    let mut h_pos = start;
    for ch in part.chars() {
        if ch == '^' {
            // ^ matches a separator character or end of string
            if h_pos >= haystack.len() {
                // End of string — ^ matches
                continue;
            }
            let h_char = haystack.as_bytes()[h_pos];
            if is_separator(h_char) {
                h_pos += 1;
            } else {
                return false;
            }
        } else {
            if h_pos >= haystack.len() {
                return false;
            }
            if haystack.as_bytes()[h_pos] != ch as u8 {
                return false;
            }
            h_pos += 1;
        }
    }
    true
}

/// Calculate the matching length of a pattern part
fn part_match_len(part: &str) -> usize {
    part.len() // Each ^ consumes exactly one character (or zero at end)
}

/// Check if a byte is a separator character (not alphanumeric, not -, not .)
fn is_separator(b: u8) -> bool {
    !b.is_ascii_alphanumeric() && b != b'-' && b != b'.' && b != b'_' && b != b'%'
}

/// Thread-local regex cache — compile each pattern once
thread_local! {
    static REGEX_CACHE: RefCell<HashMap<String, Option<Regex>>> =
        RefCell::new(HashMap::new());
}

/// Match a regex pattern against a URL (with caching)
fn match_regex(pattern: &str, url: &str, case_insensitive: bool) -> bool {
    let cache_key = if case_insensitive {
        format!("(?i){}", pattern)
    } else {
        pattern.to_string()
    };

    REGEX_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let entry = cache.entry(cache_key.clone()).or_insert_with(|| {
            Regex::new(&cache_key).ok()
        });
        match entry {
            Some(re) => re.is_match(url),
            None => false,
        }
    })
}

// ── URL utilities ───────────────────────────────────────────────────────────

/// Extract the domain from a URL (lowercase)
pub fn extract_domain_from_url(url: &str) -> String {
    let url = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("wss://"))
        .or_else(|| url.strip_prefix("ws://"))
        .unwrap_or(url);

    let end = url.find(|c: char| c == '/' || c == '?' || c == '#').unwrap_or(url.len());
    let domain = &url[..end];

    // Remove port
    let domain = if let Some(colon) = domain.rfind(':') {
        &domain[..colon]
    } else {
        domain
    };

    domain.to_ascii_lowercase()
}

/// Check if two domains are the "same" (share the same registrable domain)
fn is_same_domain(domain1: &str, domain2: &str) -> bool {
    if domain1 == domain2 {
        return true;
    }

    // Simple heuristic: compare the last two parts (e.g., example.com)
    let base1 = get_base_domain(domain1);
    let base2 = get_base_domain(domain2);
    base1 == base2
}

/// Get the base/registrable domain (last two parts for simple TLDs)
fn get_base_domain(domain: &str) -> &str {
    let parts: Vec<&str> = domain.rsplit('.').collect();
    if parts.len() <= 2 {
        return domain;
    }

    // Handle common multi-part TLDs
    let tld = parts[0];
    let sld = parts[1];
    let is_multi_part_tld = matches!(
        (sld, tld),
        ("co", "uk")
            | ("com", "au")
            | ("co", "jp")
            | ("co", "nz")
            | ("com", "br")
            | ("co", "in")
    );

    if is_multi_part_tld && parts.len() > 2 {
        // Return last 3 parts
        let start = domain.len()
            - parts[0].len()
            - parts[1].len()
            - parts[2].len()
            - 2; // 2 dots
        &domain[start..]
    } else {
        // Return last 2 parts
        let start = domain.len() - parts[0].len() - parts[1].len() - 1;
        &domain[start..]
    }
}

/// Extract tokens from a URL for filter lookup
fn extract_url_tokens(url: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for c in url.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' {
            current.push(c);
        } else {
            if current.len() >= 3 {
                tokens.push(current.clone());
            }
            current.clear();
        }
    }

    if current.len() >= 3 {
        tokens.push(current);
    }

    tokens
}

/// Extract the hostname from a hostname-anchored filter pattern
fn extract_hostname_from_pattern(pattern: &str) -> String {
    // Pattern is like "domain.com^" or "domain.com/path"
    let end = pattern
        .find('^')
        .or_else(|| pattern.find('/'))
        .or_else(|| pattern.find('*'))
        .unwrap_or(pattern.len());
    pattern[..end].to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter_parser::FilterListParser;

    fn make_engine_with_filters(filters: &[&str]) -> NetworkFilterEngine {
        let mut engine = NetworkFilterEngine::new();
        for line in filters {
            let (network_filters, _) = FilterListParser::parse_list(line);
            for f in network_filters {
                engine.add_filter(f);
            }
        }
        engine
    }

    #[test]
    fn test_basic_block() {
        let engine = make_engine_with_filters(&["||doubleclick.net^"]);
        assert_eq!(
            engine.check(
                "https://ad.doubleclick.net/tracker",
                "example.com",
                RequestType::SCRIPT
            ),
            MatchResult::Block
        );
    }

    #[test]
    fn test_no_match() {
        let engine = make_engine_with_filters(&["||doubleclick.net^"]);
        assert_eq!(
            engine.check("https://example.com/page", "example.com", RequestType::DOCUMENT),
            MatchResult::NoMatch
        );
    }

    #[test]
    fn test_exception_overrides_block() {
        let engine = make_engine_with_filters(&[
            "||ads.example.com^",
            "@@||ads.example.com^$domain=trusted.com",
        ]);

        // Should block normally
        assert_eq!(
            engine.check(
                "https://ads.example.com/banner",
                "other.com",
                RequestType::IMAGE
            ),
            MatchResult::Block
        );

        // Should allow on trusted domain
        assert_eq!(
            engine.check(
                "https://ads.example.com/banner",
                "trusted.com",
                RequestType::IMAGE
            ),
            MatchResult::Allow
        );
    }

    #[test]
    fn test_third_party_filter() {
        let engine = make_engine_with_filters(&["||tracker.com^$third-party"]);

        // Third party — should block
        assert_eq!(
            engine.check(
                "https://tracker.com/pixel",
                "example.com",
                RequestType::IMAGE
            ),
            MatchResult::Block
        );

        // First party — should not match
        assert_eq!(
            engine.check(
                "https://tracker.com/pixel",
                "tracker.com",
                RequestType::IMAGE
            ),
            MatchResult::NoMatch
        );
    }

    #[test]
    fn test_type_filter() {
        let engine = make_engine_with_filters(&["||analytics.com^$script"]);

        // Script — should block
        assert_eq!(
            engine.check(
                "https://analytics.com/track.js",
                "example.com",
                RequestType::SCRIPT
            ),
            MatchResult::Block
        );

        // Image — should not match
        assert_eq!(
            engine.check(
                "https://analytics.com/pixel.gif",
                "example.com",
                RequestType::IMAGE
            ),
            MatchResult::NoMatch
        );
    }

    #[test]
    fn test_domain_extraction() {
        assert_eq!(
            extract_domain_from_url("https://www.example.com/path"),
            "www.example.com"
        );
        assert_eq!(
            extract_domain_from_url("http://example.com:8080/path"),
            "example.com"
        );
    }

    #[test]
    fn test_same_domain() {
        assert!(is_same_domain("example.com", "example.com"));
        assert!(is_same_domain("sub.example.com", "example.com"));
        assert!(is_same_domain("www.example.com", "cdn.example.com"));
        assert!(!is_same_domain("example.com", "other.com"));
    }

    #[test]
    fn test_separator_matching() {
        let engine = make_engine_with_filters(&["||example.com^"]);
        // ^ should match / separator
        assert_eq!(
            engine.check(
                "https://example.com/anything",
                "other.com",
                RequestType::DOCUMENT
            ),
            MatchResult::Block
        );
        // ^ should match ? separator
        assert_eq!(
            engine.check(
                "https://example.com?query",
                "other.com",
                RequestType::DOCUMENT
            ),
            MatchResult::Block
        );
    }
}
