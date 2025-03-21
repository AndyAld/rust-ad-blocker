use hashbrown::{HashMap, HashSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct AdBlocker {
    filter_rules: HashSet<String>,
    regex_rules: Vec<Regex>,
    domain_rules: HashMap<String, bool>,
}

#[wasm_bindgen]
impl AdBlocker {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        AdBlocker {
            filter_rules: HashSet::new(),
            regex_rules: Vec::new(),
            domain_rules: HashMap::new(),
        }
    }

    pub fn add_filter_rule(&mut self, rule: &str) {
        self.filter_rules.insert(rule.to_string());
    }

    pub fn add_regex_rule(&mut self, pattern: &str) {
        if let Ok(regex) = Regex::new(pattern) {
            self.regex_rules.push(regex);
        }
    }

    pub fn add_domain_rule(&mut self, domain: &str, block: bool) {
        self.domain_rules.insert(domain.to_string(), block);
    }

    pub fn should_block_url(&self, url: &str) -> bool {
        // Check direct matches
        if self.filter_rules.contains(url) {
            return true;
        }

        // Check domain rules
        if let Some(domain) = extract_domain(url) {
            if let Some(&block) = self.domain_rules.get(&domain) {
                return block;
            }
        }

        // Check regex patterns
        for regex in &self.regex_rules {
            if regex.is_match(url) {
                return true;
            }
        }

        false
    }

    pub fn load_rules_from_json(&mut self, json_str: &str) -> bool {
        match serde_json::from_str::<RuleSet>(json_str) {
            Ok(ruleset) => {
                // Load filter rules
                for rule in ruleset.filter_rules {
                    self.add_filter_rule(&rule);
                }
                
                // Load regex rules
                for pattern in ruleset.regex_rules {
                    self.add_regex_rule(&pattern);
                }
                
                // Load domain rules
                for (domain, block) in ruleset.domain_rules {
                    self.add_domain_rule(&domain, block);
                }
                
                true
            }
            Err(_) => false,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct RuleSet {
    filter_rules: Vec<String>,
    regex_rules: Vec<String>,
    domain_rules: HashMap<String, bool>,
}

fn extract_domain(url: &str) -> Option<String> {
    // Simple domain extraction
    let url = url.trim_start_matches("http://").trim_start_matches("https://");
    let domain_end = url.find('/').unwrap_or(url.len());
    Some(url[..domain_end].to_string())
}

// Helper function to log to console from Rust
#[wasm_bindgen]
pub fn log(s: &str) {
    web_sys::console::log_1(&JsValue::from_str(s));
}
