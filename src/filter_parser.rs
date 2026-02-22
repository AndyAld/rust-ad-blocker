use hashbrown::HashMap;
use serde::{Deserialize, Serialize};

// ── Request type bitmask ────────────────────────────────────────────────────

bitflags::bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
    pub struct RequestType: u16 {
        const SCRIPT        = 1 << 0;
        const IMAGE         = 1 << 1;
        const STYLESHEET    = 1 << 2;
        const OBJECT        = 1 << 3;
        const XMLHTTPREQUEST = 1 << 4;
        const SUBDOCUMENT   = 1 << 5;
        const WEBSOCKET     = 1 << 6;
        const PING          = 1 << 7;
        const FONT          = 1 << 8;
        const MEDIA         = 1 << 9;
        const OTHER         = 1 << 10;
        const DOCUMENT      = 1 << 11;

        const ALL           = 0xFFFF;
    }
}

impl RequestType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "script" => Some(Self::SCRIPT),
            "image" => Some(Self::IMAGE),
            "stylesheet" => Some(Self::STYLESHEET),
            "object" | "object-subrequest" => Some(Self::OBJECT),
            "xmlhttprequest" | "xhr" => Some(Self::XMLHTTPREQUEST),
            "subdocument" | "sub_frame" => Some(Self::SUBDOCUMENT),
            "websocket" => Some(Self::WEBSOCKET),
            "ping" | "beacon" => Some(Self::PING),
            "font" => Some(Self::FONT),
            "media" => Some(Self::MEDIA),
            "other" => Some(Self::OTHER),
            "document" => Some(Self::DOCUMENT),
            _ => None,
        }
    }
}

// ── Third-party option ──────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThirdParty {
    /// No constraint
    Either,
    /// Only match third-party requests
    ThirdPartyOnly,
    /// Only match first-party requests
    FirstPartyOnly,
}

// ── Network filter ──────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct NetworkFilter {
    /// Original raw filter string (for debugging)
    pub raw: String,
    /// The pattern to match against (with wildcards expanded)
    pub pattern: String,
    /// Whether this is an exception rule (@@)
    pub is_exception: bool,
    /// Whether the pattern is anchored to the start of the URL (|)
    pub is_left_anchor: bool,
    /// Whether the pattern is anchored to the end of the URL (|)
    pub is_right_anchor: bool,
    /// Whether this is a domain anchor (||)
    pub is_hostname_anchor: bool,
    /// Whether this is a regex filter (/regex/)
    pub is_regex: bool,
    /// Whether matching should be case-sensitive
    pub match_case: bool,
    /// Allowed request types (bitmask). ALL = no type restriction.
    pub request_types: RequestType,
    /// Third-party constraint
    pub third_party: ThirdParty,
    /// Domain restrictions: (domain, include). include=true means "only on this domain".
    pub domains: Vec<(String, bool)>,
    /// Compiled regex (lazily populated by the matcher)
    pub compiled_regex: Option<regex::Regex>,
    /// Tokens extracted from the pattern for fast lookup
    pub tokens: Vec<String>,
}

impl NetworkFilter {
    pub fn has_type_constraint(&self) -> bool {
        self.request_types != RequestType::ALL
    }

    pub fn matches_type(&self, request_type: RequestType) -> bool {
        self.request_types.contains(request_type)
    }

    pub fn matches_third_party(&self, is_third_party: bool) -> bool {
        match self.third_party {
            ThirdParty::Either => true,
            ThirdParty::ThirdPartyOnly => is_third_party,
            ThirdParty::FirstPartyOnly => !is_third_party,
        }
    }

    pub fn matches_domain(&self, source_domain: &str) -> bool {
        if self.domains.is_empty() {
            return true;
        }

        let mut has_include = false;
        let mut included = false;

        for (domain, is_include) in &self.domains {
            if *is_include {
                has_include = true;
                if source_domain == domain || source_domain.ends_with(&format!(".{}", domain)) {
                    included = true;
                }
            } else {
                // Exclude domain
                if source_domain == domain || source_domain.ends_with(&format!(".{}", domain)) {
                    return false;
                }
            }
        }

        if has_include {
            included
        } else {
            true
        }
    }
}

// ── Cosmetic filter ─────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct CosmeticFilter {
    /// Original raw filter string
    pub raw: String,
    /// CSS selector to hide
    pub selector: String,
    /// Whether this is an unhide rule (#@#)
    pub is_unhide: bool,
    /// Domains this applies to. Empty = all domains ("generic").
    /// Each entry is (domain, include). include=true means "only on this domain".
    pub domains: Vec<(String, bool)>,
}

impl CosmeticFilter {
    pub fn applies_to_domain(&self, domain: &str) -> bool {
        if self.domains.is_empty() {
            return true; // generic rule
        }

        let mut has_include = false;
        let mut included = false;

        for (d, is_include) in &self.domains {
            if *is_include {
                has_include = true;
                if domain == d || domain.ends_with(&format!(".{}", d)) {
                    included = true;
                }
            } else {
                if domain == d || domain.ends_with(&format!(".{}", d)) {
                    return false;
                }
            }
        }

        if has_include {
            included
        } else {
            true
        }
    }
}

// ── Parsed filter result ────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum FilterRule {
    Network(NetworkFilter),
    Cosmetic(CosmeticFilter),
    Comment,
    Empty,
    Invalid,
}

// ── Parser ──────────────────────────────────────────────────────────────────

pub struct FilterListParser;

impl FilterListParser {
    /// Parse an entire filter list (newline-separated)
    pub fn parse_list(text: &str) -> (Vec<NetworkFilter>, Vec<CosmeticFilter>) {
        let mut network_filters = Vec::new();
        let mut cosmetic_filters = Vec::new();

        for line in text.lines() {
            match Self::parse_line(line) {
                FilterRule::Network(f) => network_filters.push(f),
                FilterRule::Cosmetic(f) => cosmetic_filters.push(f),
                _ => {}
            }
        }

        (network_filters, cosmetic_filters)
    }

    /// Parse a single filter line
    pub fn parse_line(line: &str) -> FilterRule {
        let line = line.trim();

        // Empty line
        if line.is_empty() {
            return FilterRule::Empty;
        }

        // Comments
        if line.starts_with('!') || line.starts_with('[') {
            return FilterRule::Comment;
        }

        // Cosmetic filter: look for ## or #@# or #?#
        if let Some(rule) = Self::try_parse_cosmetic(line) {
            return FilterRule::Cosmetic(rule);
        }

        // Network filter
        match Self::parse_network_filter(line) {
            Some(f) => FilterRule::Network(f),
            None => FilterRule::Invalid,
        }
    }

    /// Try to parse as a cosmetic filter
    fn try_parse_cosmetic(line: &str) -> Option<CosmeticFilter> {
        // Find the ## separator. Handle ##, #@#, #?#
        // Must not be preceded by a $ (which would be a network filter option)
        let (domains_part, selector, is_unhide) =
            if let Some(pos) = line.find("#@#") {
                let domains = &line[..pos];
                let sel = &line[pos + 3..];
                (domains, sel, true)
            } else if let Some(pos) = line.find("#?#") {
                // Extended CSS selector — treat the same for now
                let domains = &line[..pos];
                let sel = &line[pos + 3..];
                (domains, sel, false)
            } else if let Some(pos) = find_cosmetic_separator(line) {
                let domains = &line[..pos];
                let sel = &line[pos + 2..];
                (domains, sel, false)
            } else {
                return None;
            };

        let selector = selector.trim().to_string();
        if selector.is_empty() {
            return None;
        }

        let domains = parse_domain_list(domains_part);

        Some(CosmeticFilter {
            raw: line.to_string(),
            selector,
            is_unhide,
            domains,
        })
    }

    /// Parse a network filter
    fn parse_network_filter(line: &str) -> Option<NetworkFilter> {
        let mut line = line.to_string();

        // Check for exception
        let is_exception = line.starts_with("@@");
        if is_exception {
            line = line[2..].to_string();
        }

        // Split off options (after $)
        let (pattern_part, options_str) = split_options(&line);

        // Parse the pattern
        let (pattern, is_left_anchor, is_right_anchor, is_hostname_anchor, is_regex) =
            parse_pattern(pattern_part);

        // Parse options
        let (request_types, third_party, match_case, domains) =
            parse_options(options_str);

        // Extract tokens for indexing
        let tokens = extract_tokens(&pattern);

        Some(NetworkFilter {
            raw: if is_exception {
                format!("@@{}", line)
            } else {
                line.to_string()
            },
            pattern,
            is_exception,
            is_left_anchor,
            is_right_anchor,
            is_hostname_anchor,
            is_regex,
            match_case,
            request_types,
            third_party,
            domains,
            compiled_regex: None,
            tokens,
        })
    }
}

// ── Helper functions ────────────────────────────────────────────────────────

/// Find the ## cosmetic separator, avoiding false positives in URLs
fn find_cosmetic_separator(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i + 1 < len {
        if bytes[i] == b'#' && bytes[i + 1] == b'#' {
            // Make sure it's not inside a URL-like pattern
            // (preceded by http: or /)
            if i > 0 && bytes[i - 1] == b'/' {
                i += 2;
                continue;
            }
            // Also skip #@# and #?# (handled separately)
            if i > 0 && (bytes[i - 1] == b'@' || bytes[i - 1] == b'?') {
                i += 2;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Parse a comma-separated domain list into (domain, include) pairs
fn parse_domain_list(s: &str) -> Vec<(String, bool)> {
    if s.is_empty() {
        return Vec::new();
    }

    s.split(',')
        .filter(|d| !d.is_empty())
        .map(|d| {
            let d = d.trim();
            if let Some(stripped) = d.strip_prefix('~') {
                (stripped.to_lowercase(), false)
            } else {
                (d.to_lowercase(), true)
            }
        })
        .collect()
}

/// Split a filter line into (pattern, options). Options come after the last unescaped $.
fn split_options(line: &str) -> (&str, &str) {
    // Regex filters: /regex/$options — find $ after the closing /
    if line.starts_with('/') {
        if let Some(end_slash) = line[1..].find('/') {
            let after_regex = end_slash + 2; // position after the closing /
            if after_regex < line.len() && line.as_bytes()[after_regex] == b'$' {
                return (&line[..after_regex], &line[after_regex + 1..]);
            }
            return (line, "");
        }
    }

    // Normal filters: find the last $ that's not part of the pattern
    // We look for $ not preceded by a \ escape
    if let Some(pos) = find_options_separator(line) {
        (&line[..pos], &line[pos + 1..])
    } else {
        (line, "")
    }
}

/// Find the $ separator for options, handling edge cases
fn find_options_separator(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    // Search from the end to find the last valid $
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        if bytes[i] == b'$' {
            // Check it's not escaped
            if i > 0 && bytes[i - 1] == b'\\' {
                continue;
            }
            // Simple heuristic: the part after $ should look like options
            // (contain only alphanumeric, comma, =, ~, |, .)
            let after = &line[i + 1..];
            if looks_like_options(after) {
                return Some(i);
            }
        }
    }
    None
}

fn looks_like_options(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    // Options are comma-separated keywords, possibly with = and domain lists
    s.chars().all(|c| {
        c.is_alphanumeric()
            || c == ','
            || c == '='
            || c == '~'
            || c == '|'
            || c == '.'
            || c == '-'
            || c == '_'
            || c == '*'
    })
}

/// Parse the pattern portion into (clean_pattern, left_anchor, right_anchor, hostname_anchor, is_regex)
fn parse_pattern(pattern: &str) -> (String, bool, bool, bool, bool) {
    let mut p = pattern;

    // Regex: /pattern/
    if p.starts_with('/') && p.len() > 1 && p.ends_with('/') {
        let regex_body = &p[1..p.len() - 1];
        return (regex_body.to_string(), false, false, false, true);
    }

    // Domain anchor: ||
    let is_hostname_anchor = p.starts_with("||");
    if is_hostname_anchor {
        p = &p[2..];
    }

    // Left anchor: |
    let is_left_anchor = !is_hostname_anchor && p.starts_with('|');
    if is_left_anchor {
        p = &p[1..];
    }

    // Right anchor: |
    let is_right_anchor = p.ends_with('|');
    if is_right_anchor {
        p = &p[..p.len() - 1];
    }

    (p.to_string(), is_left_anchor, is_right_anchor, is_hostname_anchor, false)
}

/// Parse the options string ($option1,option2,...) into structured data
fn parse_options(options: &str) -> (RequestType, ThirdParty, bool, Vec<(String, bool)>) {
    let mut request_types = RequestType::ALL;
    let mut third_party = ThirdParty::Either;
    let mut match_case = false;
    let mut domains = Vec::new();
    let mut has_type_opt = false;

    if options.is_empty() {
        return (request_types, third_party, match_case, domains);
    }

    for opt in options.split(',') {
        let opt = opt.trim();
        if opt.is_empty() {
            continue;
        }

        let (negated, opt_name) = if let Some(stripped) = opt.strip_prefix('~') {
            (true, stripped)
        } else {
            (false, opt)
        };

        // Domain option: domain=example.com|~foo.example.com
        if opt_name.starts_with("domain=") {
            let domain_str = &opt_name[7..];
            for d in domain_str.split('|') {
                let d = d.trim();
                if let Some(stripped) = d.strip_prefix('~') {
                    domains.push((stripped.to_lowercase(), false));
                } else {
                    domains.push((d.to_lowercase(), true));
                }
            }
            continue;
        }

        // Match case
        if opt_name == "match-case" {
            match_case = !negated;
            continue;
        }

        // Third-party
        if opt_name == "third-party" || opt_name == "3p" {
            third_party = if negated {
                ThirdParty::FirstPartyOnly
            } else {
                ThirdParty::ThirdPartyOnly
            };
            continue;
        }

        // First-party
        if opt_name == "first-party" || opt_name == "1p" {
            third_party = if negated {
                ThirdParty::ThirdPartyOnly
            } else {
                ThirdParty::FirstPartyOnly
            };
            continue;
        }

        // Request type options
        if let Some(rt) = RequestType::from_str(opt_name) {
            if !has_type_opt {
                // First type option: reset to empty, then add
                request_types = RequestType::empty();
                has_type_opt = true;
            }
            if negated {
                // If negated type, we need to set ALL then remove
                if request_types.is_empty() {
                    request_types = RequestType::ALL;
                }
                request_types.remove(rt);
            } else {
                request_types.insert(rt);
            }
        }
    }

    (request_types, third_party, match_case, domains)
}

/// Extract tokens from a pattern for hash-based indexing.
/// Tokens are alphanumeric strings of 3+ characters.
fn extract_tokens(pattern: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for c in pattern.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' {
            current.push(c.to_ascii_lowercase());
        } else {
            if current.len() >= 3 {
                tokens.push(current.clone());
            }
            current.clear();
        }
    }

    if current.len() >= 5 {
        tokens.push(current);
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_basic_filter() {
        match FilterListParser::parse_line("||example.com^") {
            FilterRule::Network(f) => {
                assert!(f.is_hostname_anchor);
                assert!(!f.is_exception);
                assert_eq!(f.pattern, "example.com^");
            }
            _ => panic!("Expected network filter"),
        }
    }

    #[test]
    fn test_parse_exception() {
        match FilterListParser::parse_line("@@||example.com^") {
            FilterRule::Network(f) => {
                assert!(f.is_exception);
                assert!(f.is_hostname_anchor);
            }
            _ => panic!("Expected network filter"),
        }
    }

    #[test]
    fn test_parse_cosmetic() {
        match FilterListParser::parse_line("example.com##.ad-banner") {
            FilterRule::Cosmetic(f) => {
                assert_eq!(f.selector, ".ad-banner");
                assert!(!f.is_unhide);
                assert_eq!(f.domains.len(), 1);
                assert_eq!(f.domains[0], ("example.com".to_string(), true));
            }
            _ => panic!("Expected cosmetic filter"),
        }
    }

    #[test]
    fn test_parse_cosmetic_unhide() {
        match FilterListParser::parse_line("example.com#@#.ad-banner") {
            FilterRule::Cosmetic(f) => {
                assert!(f.is_unhide);
                assert_eq!(f.selector, ".ad-banner");
            }
            _ => panic!("Expected cosmetic filter"),
        }
    }

    #[test]
    fn test_parse_options() {
        match FilterListParser::parse_line("||ad.com^$script,third-party") {
            FilterRule::Network(f) => {
                assert!(f.request_types.contains(RequestType::SCRIPT));
                assert!(!f.request_types.contains(RequestType::IMAGE));
                assert_eq!(f.third_party, ThirdParty::ThirdPartyOnly);
            }
            _ => panic!("Expected network filter"),
        }
    }

    #[test]
    fn test_parse_domain_option() {
        match FilterListParser::parse_line("||tracker.com^$domain=example.com|~sub.example.com") {
            FilterRule::Network(f) => {
                assert_eq!(f.domains.len(), 2);
                assert_eq!(f.domains[0], ("example.com".to_string(), true));
                assert_eq!(f.domains[1], ("sub.example.com".to_string(), false));
            }
            _ => panic!("Expected network filter"),
        }
    }

    #[test]
    fn test_parse_comment() {
        assert!(matches!(
            FilterListParser::parse_line("! This is a comment"),
            FilterRule::Comment
        ));
    }

    #[test]
    fn test_parse_header() {
        assert!(matches!(
            FilterListParser::parse_line("[Adblock Plus 2.0]"),
            FilterRule::Comment
        ));
    }

    #[test]
    fn test_parse_regex() {
        match FilterListParser::parse_line("/banner\\d+\\.js/") {
            FilterRule::Network(f) => {
                assert!(f.is_regex);
                assert_eq!(f.pattern, "banner\\d+\\.js");
            }
            _ => panic!("Expected network filter"),
        }
    }

    #[test]
    fn test_parse_generic_cosmetic() {
        match FilterListParser::parse_line("##.ad-wrapper") {
            FilterRule::Cosmetic(f) => {
                assert_eq!(f.selector, ".ad-wrapper");
                assert!(f.domains.is_empty());
            }
            _ => panic!("Expected cosmetic filter"),
        }
    }
}
