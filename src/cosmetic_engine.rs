use crate::filter_parser::CosmeticFilter;
use hashbrown::HashMap;

// ── Cosmetic filter engine ──────────────────────────────────────────────────

pub struct CosmeticEngine {
    /// Domain-specific cosmetic filters: domain → filters
    domain_filters: HashMap<String, Vec<CosmeticFilter>>,
    /// Generic cosmetic filters (no domain restriction)
    generic_filters: Vec<CosmeticFilter>,
    /// Unhide (exception) filters: domain → filters
    domain_unhide_filters: HashMap<String, Vec<CosmeticFilter>>,
    /// Generic unhide filters
    generic_unhide_filters: Vec<CosmeticFilter>,
}

impl CosmeticEngine {
    pub fn new() -> Self {
        CosmeticEngine {
            domain_filters: HashMap::new(),
            generic_filters: Vec::new(),
            domain_unhide_filters: HashMap::new(),
            generic_unhide_filters: Vec::new(),
        }
    }

    /// Add a cosmetic filter to the engine
    pub fn add_filter(&mut self, filter: CosmeticFilter) {
        if filter.is_unhide {
            if filter.domains.is_empty() {
                self.generic_unhide_filters.push(filter);
            } else {
                for (domain, is_include) in &filter.domains {
                    if *is_include {
                        self.domain_unhide_filters
                            .entry(domain.clone())
                            .or_insert_with(Vec::new)
                            .push(filter.clone());
                    }
                }
            }
        } else {
            if filter.domains.is_empty() {
                self.generic_filters.push(filter);
            } else {
                for (domain, is_include) in &filter.domains {
                    if *is_include {
                        self.domain_filters
                            .entry(domain.clone())
                            .or_insert_with(Vec::new)
                            .push(filter.clone());
                    }
                }
            }
        }
    }

    /// Clear all cosmetic filters
    pub fn clear(&mut self) {
        self.domain_filters.clear();
        self.generic_filters.clear();
        self.domain_unhide_filters.clear();
        self.generic_unhide_filters.clear();
    }

    /// Get all CSS selectors that should be hidden on a given domain.
    /// Returns a deduplicated list of selectors.
    pub fn get_selectors_for_domain(&self, domain: &str) -> Vec<String> {
        let mut selectors = Vec::new();
        let mut unhidden: hashbrown::HashSet<String> = hashbrown::HashSet::new();

        // Collect unhide selectors first
        // Generic unhides
        for filter in &self.generic_unhide_filters {
            if filter.applies_to_domain(domain) {
                unhidden.insert(filter.selector.clone());
            }
        }

        // Domain-specific unhides
        let domain_parts: Vec<&str> = domain.split('.').collect();
        for i in 0..domain_parts.len() {
            let d = domain_parts[i..].join(".");
            if let Some(filters) = self.domain_unhide_filters.get(&d) {
                for filter in filters {
                    if filter.applies_to_domain(domain) {
                        unhidden.insert(filter.selector.clone());
                    }
                }
            }
        }

        // Collect hide selectors, excluding unhidden ones
        // Generic selectors
        for filter in &self.generic_filters {
            if !unhidden.contains(&filter.selector) {
                selectors.push(filter.selector.clone());
            }
        }

        // Domain-specific selectors
        for i in 0..domain_parts.len() {
            let d = domain_parts[i..].join(".");
            if let Some(filters) = self.domain_filters.get(&d) {
                for filter in filters {
                    if filter.applies_to_domain(domain) && !unhidden.contains(&filter.selector) {
                        selectors.push(filter.selector.clone());
                    }
                }
            }
        }

        // Deduplicate
        let mut seen = hashbrown::HashSet::new();
        selectors.retain(|s| seen.insert(s.clone()));

        selectors
    }

    /// Get stats about loaded cosmetic filters
    pub fn stats(&self) -> (usize, usize) {
        let domain_count: usize = self.domain_filters.values().map(|v| v.len()).sum();
        let generic_count = self.generic_filters.len();
        (generic_count, domain_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter_parser::FilterListParser;

    fn make_engine(lines: &[&str]) -> CosmeticEngine {
        let mut engine = CosmeticEngine::new();
        for line in lines {
            let (_, cosmetic_filters) = FilterListParser::parse_list(line);
            for f in cosmetic_filters {
                engine.add_filter(f);
            }
        }
        engine
    }

    #[test]
    fn test_generic_selector() {
        let engine = make_engine(&["##.ad-banner"]);
        let selectors = engine.get_selectors_for_domain("example.com");
        assert!(selectors.contains(&".ad-banner".to_string()));
    }

    #[test]
    fn test_domain_specific_selector() {
        let engine = make_engine(&["example.com##.sidebar-ad"]);
        let selectors = engine.get_selectors_for_domain("example.com");
        assert!(selectors.contains(&".sidebar-ad".to_string()));

        // Should not apply to another domain
        let selectors = engine.get_selectors_for_domain("other.com");
        assert!(!selectors.contains(&".sidebar-ad".to_string()));
    }

    #[test]
    fn test_unhide_overrides_generic() {
        let engine = make_engine(&["##.ad-banner", "example.com#@#.ad-banner"]);
        // Should be hidden on other sites
        let selectors = engine.get_selectors_for_domain("other.com");
        assert!(selectors.contains(&".ad-banner".to_string()));

        // Should NOT be hidden on example.com
        let selectors = engine.get_selectors_for_domain("example.com");
        assert!(!selectors.contains(&".ad-banner".to_string()));
    }

    #[test]
    fn test_subdomain_matching() {
        let engine = make_engine(&["example.com##.promo"]);
        // Should apply to subdomain
        let selectors = engine.get_selectors_for_domain("www.example.com");
        assert!(selectors.contains(&".promo".to_string()));
    }
}
