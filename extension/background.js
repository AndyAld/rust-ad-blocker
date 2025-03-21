// Import the Rust-compiled WebAssembly module
import init, { AdBlocker, log } from './pkg/rust_adblocker.js';

let adBlocker;
let isInitialized = false;
let pendingRequests = [];
let enabled = true;
let blockedToday = 0;
let totalBlocked = 0;

// Default ruleset to use until custom rules are loaded
const DEFAULT_RULES = {
  filter_rules: [
    "googleads.g.doubleclick.net",
    "pagead2.googlesyndication.com",
    "tpc.googlesyndication.com",
    "securepubads.g.doubleclick.net"
  ],
  regex_rules: [
    ".*\\.doubleclick\\.net/.*",
    ".*\\.googlesyndication\\.com/.*",
    ".*\\.google-analytics\\.com/.*",
    ".*\\.adnxs\\.com/.*",
    ".*\\.facebook\\.com/tr/.*"
  ],
  domain_rules: {
    "ads.example.com": true,
    "analytics.example.com": true
  }
};

// Initialize the WebAssembly module
async function initializeAdBlocker() {
  try {
    await init();
    console.log("WebAssembly module initialized");
    
    adBlocker = new AdBlocker();
    
    // Load default rules
    const defaultRulesJson = JSON.stringify(DEFAULT_RULES);
    adBlocker.load_rules_from_json(defaultRulesJson);
    
    // Load custom rules and settings from storage
    chrome.storage.local.get(['adBlockerRules', 'enabled', 'blockedToday', 'totalBlocked'], function(result) {
      if (result.adBlockerRules) {
        adBlocker.load_rules_from_json(result.adBlockerRules);
      }
      
      if (result.enabled !== undefined) {
        enabled = result.enabled;
      }
      
      if (result.blockedToday !== undefined) {
        blockedToday = result.blockedToday;
      }
      
      if (result.totalBlocked !== undefined) {
        totalBlocked = result.totalBlocked;
      }
    });
    
    isInitialized = true;
    
    // Process any requests that were waiting for initialization
    processPendingRequests();
    
    // Set up the web request listener
    chrome.webRequest.onBeforeRequest.addListener(
      handleRequest,
      { urls: ["*://*/*"] },
      ["blocking"]
    );
  } catch (error) {
    console.error("Failed to initialize WebAssembly module:", error);
  }
}

function processPendingRequests() {
  for (const request of pendingRequests) {
    const shouldBlock = adBlocker.should_block_url(request.url);
    if (shouldBlock) {
      log(`Blocked: ${request.url}`);
    }
  }
  pendingRequests = [];
}

function handleRequest(details) {
  if (!isInitialized) {
    pendingRequests.push(details);
    return { cancel: false };
  }
  
  // Don't block if ad blocking is disabled
  if (!enabled) {
    return { cancel: false };
  }
  
  const shouldBlock = adBlocker.should_block_url(details.url);
  
  if (shouldBlock) {
    console.log(`Blocked: ${details.url}`);
    
    // Update counters
    blockedToday++;
    totalBlocked++;
    
    // Save updated stats
    chrome.storage.local.set({
      'blockedToday': blockedToday,
      'totalBlocked': totalBlocked
    });
    
    return { cancel: true };
  }
  
  return { cancel: false };
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "updateRules" && message.rules) {
    if (isInitialized) {
      adBlocker.load_rules_from_json(message.rules);
      chrome.storage.local.set({ 'adBlockerRules': message.rules });
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "AdBlocker not initialized" });
    }
  } else if (message.action === "toggleEnabled") {
    enabled = message.enabled;
    chrome.storage.local.set({ 'enabled': enabled });
    sendResponse({ success: true });
  } else if (message.action === "getStats") {
    sendResponse({
      enabled: enabled,
      blockedToday: blockedToday,
      totalBlocked: totalBlocked
    });
  }
  return true;
});

// Initialize the ad blocker when the extension starts
initializeAdBlocker();
