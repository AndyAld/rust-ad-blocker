mod filter_parser;
mod network_matcher;
mod cosmetic_engine;

use filter_parser::{FilterListParser, RequestType};
use network_matcher::{NetworkFilterEngine, MatchResult};
use cosmetic_engine::CosmeticEngine;
use wasm_bindgen::prelude::*;

// ── Main AdBlocker WASM API ─────────────────────────────────────────────────

#[wasm_bindgen]
pub struct AdBlocker {
    network_engine: NetworkFilterEngine,
    cosmetic_engine: CosmeticEngine,
    /// Count of loaded network filters
    network_filter_count: usize,
    /// Count of loaded cosmetic filters
    cosmetic_filter_count: usize,
}

#[wasm_bindgen]
impl AdBlocker {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        AdBlocker {
            network_engine: NetworkFilterEngine::new(),
            cosmetic_engine: CosmeticEngine::new(),
            network_filter_count: 0,
            cosmetic_filter_count: 0,
        }
    }

    /// Load a filter list in ABP syntax (e.g., EasyList, EasyPrivacy).
    /// Returns the number of filters successfully parsed.
    pub fn load_filter_list(&mut self, text: &str) -> u32 {
        let (network_filters, cosmetic_filters) = FilterListParser::parse_list(text);

        let net_count = network_filters.len();
        let cos_count = cosmetic_filters.len();

        for filter in network_filters {
            self.network_engine.add_filter(filter);
        }

        for filter in cosmetic_filters {
            self.cosmetic_engine.add_filter(filter);
        }

        self.network_filter_count += net_count;
        self.cosmetic_filter_count += cos_count;

        (net_count + cos_count) as u32
    }

    /// Check if a network request should be blocked.
    ///
    /// Arguments:
    /// - `url`: The full URL of the request
    /// - `source_domain`: The domain of the page making the request
    /// - `request_type`: The type of request (e.g., "script", "image", "xmlhttprequest")
    ///
    /// Returns: "block", "allow", or "none"
    pub fn check_request(&self, url: &str, source_domain: &str, request_type: &str) -> String {
        let rt = RequestType::from_str(request_type).unwrap_or(RequestType::OTHER);

        match self.network_engine.check(url, source_domain, rt) {
            MatchResult::Block => "block".to_string(),
            MatchResult::Allow => "allow".to_string(),
            MatchResult::NoMatch => "none".to_string(),
        }
    }

    /// Get CSS selectors to hide elements on a specific domain.
    /// Returns a JSON array of CSS selector strings.
    pub fn get_cosmetic_selectors(&self, domain: &str) -> String {
        let selectors = self.cosmetic_engine.get_selectors_for_domain(domain);
        serde_json::to_string(&selectors).unwrap_or_else(|_| "[]".to_string())
    }

    /// Clear all loaded filters
    pub fn clear_rules(&mut self) {
        self.network_engine.clear();
        self.cosmetic_engine.clear();
        self.network_filter_count = 0;
        self.cosmetic_filter_count = 0;
    }

    /// Get the number of loaded network filters
    pub fn network_filter_count(&self) -> u32 {
        self.network_filter_count as u32
    }

    /// Get the number of loaded cosmetic filters
    pub fn cosmetic_filter_count(&self) -> u32 {
        self.cosmetic_filter_count as u32
    }

    // ── Legacy API (backward compatibility) ─────────────────────────────

    /// Simple URL check (legacy). Equivalent to check_request with type="other".
    pub fn should_block_url(&self, url: &str) -> bool {
        let domain = network_matcher::extract_domain_from_url(&url.to_ascii_lowercase());
        matches!(
            self.network_engine.check(url, &domain, RequestType::OTHER),
            MatchResult::Block
        )
    }

    /// Load rules from the old JSON format (backward compatibility).
    pub fn load_rules_from_json(&mut self, json_str: &str) -> bool {
        #[derive(serde::Deserialize)]
        struct LegacyRuleSet {
            #[serde(default)]
            filter_rules: Vec<String>,
            #[serde(default)]
            regex_rules: Vec<String>,
            #[serde(default)]
            domain_rules: hashbrown::HashMap<String, bool>,
        }

        match serde_json::from_str::<LegacyRuleSet>(json_str) {
            Ok(ruleset) => {
                // Convert legacy rules to ABP-style filter lines and load them
                let mut lines = Vec::new();

                for rule in &ruleset.filter_rules {
                    lines.push(format!("||{}^", rule));
                }

                for pattern in &ruleset.regex_rules {
                    lines.push(format!("/{}/", pattern));
                }

                for (domain, block) in &ruleset.domain_rules {
                    if *block {
                        lines.push(format!("||{}^", domain));
                    } else {
                        lines.push(format!("@@||{}^", domain));
                    }
                }

                let combined = lines.join("\n");
                self.load_filter_list(&combined);
                true
            }
            Err(_) => false,
        }
    }
}

// ── Utility ─────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn log(s: &str) {
    web_sys::console::log_1(&JsValue::from_str(s));
}
