// ── Rust AdBlocker Background Script ──────────────────────────────────
// Full-featured ad blocker with filter list support, privacy protection,
// CNAME cloaking detection, and header modification.

import init, { AdBlocker, log } from './pkg/rust_adblocker.js';

let adBlocker;
let isInitialized = false;
let pendingRequests = [];
let enabled = true;
let blockedToday = 0;
let totalBlocked = 0;

// Privacy settings (defaults)
let settings = {
  stripTrackingParams: true,
  stripReferrer: true,
  normalizeUserAgent: true,
  fingerprintProtection: true,
  webrtcProtection: true,
  cnameDetection: true
};

let trackingParams = [];
let cnameTrackers = {};
let filterListManager = null;

// ── A common, generic User-Agent string ──────────────────────────────
const NORMALIZED_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// ── Known First-Party Ad / Tracking Subdomains ───────────────────────
// These operate on the same base domain but are purely for ads/tracking.
const FIRST_PARTY_ADS = [
  'alb.reddit.com',
  'events.reddit.com',
  'metrics.reddit.com',
  'pixel.reddit.com'
];

// ── Known GENERIC content CDNs that should never be blocked ──────────
// These are shared infrastructure CDNs, not site-specific.
const GENERIC_CDNS = new Set([
  'ctfassets.net',          // Contentful CMS
  'cloudfront.net',         // AWS CloudFront
  'akamaized.net',          // Akamai
  'akamaihd.net',           // Akamai HD
  'fastly.net',             // Fastly
  'jsdelivr.net',           // jsDelivr
  'unpkg.com',              // unpkg
  'cloudflare.com',         // Cloudflare
  'wp.com',                 // WordPress
  'githubusercontent.com',  // GitHub
  'cloudinary.com',         // Cloudinary
  'imgix.net',              // imgix
  'googleapis.com',         // Google APIs/Fonts
  'gstatic.com',            // Google static
  'googleusercontent.com',  // Google user content (profile images)
  'youtube.com',            // YouTube (Google-owned)
  'ytimg.com',              // YouTube images
  'ggpht.com',              // Google profile photos
  'bootstrapcdn.com',       // Bootstrap CDN
  'fontawesome.com',        // Font Awesome
  'discourse-cdn.com',      // Discourse hosted forums
  'cloudflareinsights.com', // Cloudflare analytics
  'azureedge.net',          // Azure CDN
  'azurefd.net',            // Azure Front Door
  'b-cdn.net',              // BunnyCDN
  'stackpathdns.com',       // StackPath CDN
  'kxcdn.com',              // KeyCDN
]);

// ── Detect related domains (site-specific CDNs) ─────────────────────
// e.g. redditstatic.com ↔ reddit.com, fbcdn.net ↔ facebook.com
// Extracts the "core name" (longest word ≥4 chars before the TLD) and
// checks if both domains share it.
function areRelatedDomains(domain1, domain2) {
  if (!domain1 || !domain2) return false;
  const core1 = extractCoreName(domain1);
  const core2 = extractCoreName(domain2);
  if (!core1 || !core2 || core1.length < 4) return false;
  return core1 === core2;
}

function extractCoreName(baseDomain) {
  // "redditstatic.com" → "reddit" (strip common suffixes)
  // "reddit.com" → "reddit"
  const parts = baseDomain.split('.');
  if (parts.length < 2) return '';
  let name = parts[parts.length - 2]; // part before TLD
  // Strip common CDN/asset suffixes to find the core brand name
  const suffixes = ['static', 'cdn', 'media', 'assets', 'content', 'img', 'images', 'ssl', 'edge'];
  for (const suffix of suffixes) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      name = name.slice(0, -suffix.length);
      break;
    }
    if (name.startsWith(suffix) && name.length > suffix.length) {
      name = name.slice(suffix.length);
      break;
    }
  }
  return name.toLowerCase();
}

// ── Map Chrome request types to our engine's type strings ────────────
function mapRequestType(chromeType) {
  const typeMap = {
    'main_frame': 'document',
    'sub_frame': 'subdocument',
    'stylesheet': 'stylesheet',
    'script': 'script',
    'image': 'image',
    'font': 'font',
    'object': 'object',
    'xmlhttprequest': 'xmlhttprequest',
    'ping': 'ping',
    'media': 'media',
    'websocket': 'websocket',
    'other': 'other'
  };
  return typeMap[chromeType] || 'other';
}

// ── Extract domain from URL ──────────────────────────────────────────
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// ── Domain caching for performance ───────────────────────────────────
// Same URLs repeat across requests — avoid redundant parsing
const _domainCache = new Map();
const _baseDomainCache = new Map();
const MAX_DOMAIN_CACHE = 2000;

function getDomainCached(urlOrDomain) {
  let result = _domainCache.get(urlOrDomain);
  if (result !== undefined) return result;
  result = getDomain(urlOrDomain);
  if (_domainCache.size >= MAX_DOMAIN_CACHE) _domainCache.clear();
  _domainCache.set(urlOrDomain, result);
  return result;
}

function getBaseDomainCached(hostname) {
  let result = _baseDomainCache.get(hostname);
  if (result !== undefined) return result;
  result = getBaseDomain(hostname);
  if (_baseDomainCache.size >= MAX_DOMAIN_CACHE) _baseDomainCache.clear();
  _baseDomainCache.set(hostname, result);
  return result;
}

// ── Extract base (registrable) domain ────────────────────────────────
// e.g. 'static-assets.cargurus.com' → 'cargurus.com'
//      'www.cargurus.com' → 'cargurus.com'
function getBaseDomain(hostname) {
  if (!hostname) return '';
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  // Handle common two-part TLDs like co.uk, com.au, co.jp
  const twoPartTLDs = ['co.uk', 'com.au', 'co.jp', 'co.kr', 'com.br', 'co.nz', 'co.za', 'com.mx'];
  const lastTwo = parts.slice(-2).join('.');
  if (twoPartTLDs.includes(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

// ── Get source domain from request details ───────────────────────────
function getSourceDomain(details) {
  // Try initiator first (Chrome 63+), then documentUrl
  const source = details.initiator || details.documentUrl || details.url;
  return getDomainCached(source);
}

// ── Load data files ──────────────────────────────────────────────────
async function loadDataFiles() {
  try {
    const paramsResponse = await fetch(chrome.runtime.getURL('data/tracking_params.json'));
    const paramsData = await paramsResponse.json();
    trackingParams = paramsData.tracking_params || [];
  } catch (e) {
    console.warn('Could not load tracking params:', e);
  }

  try {
    const cnameResponse = await fetch(chrome.runtime.getURL('data/cname_trackers.json'));
    const cnameData = await cnameResponse.json();
    cnameTrackers = cnameData.known_cname_trackers || {};
  } catch (e) {
    console.warn('Could not load CNAME trackers:', e);
  }
}

// ── Load saved settings ──────────────────────────────────────────────
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['enabled', 'blockedToday', 'totalBlocked', 'lastResetDate', 'privacySettings'],
      (result) => {
        if (result.enabled !== undefined) enabled = result.enabled;
        if (result.blockedToday !== undefined) blockedToday = result.blockedToday;
        if (result.totalBlocked !== undefined) totalBlocked = result.totalBlocked;
        if (result.privacySettings) {
          settings = { ...settings, ...result.privacySettings };
        }

        // Daily reset
        const today = new Date().toDateString();
        if (result.lastResetDate !== today) {
          blockedToday = 0;
          chrome.storage.local.set({ blockedToday: 0, lastResetDate: today });
        }

        resolve();
      }
    );
  });
}

// ── Initialize filter list manager and load lists ────────────────────
async function loadFilterLists() {
  try {
    // FilterListManager is loaded globally via background.html <script> tag
    if (typeof FilterListManager === 'undefined') {
      console.warn('FilterListManager not available, falling back to default rules');
      await loadDefaultRules();
      return;
    }

    filterListManager = new FilterListManager();
    await filterListManager.init();

    // Load cached lists into the engine
    const cachedTexts = filterListManager.getAllCachedTexts();
    let totalFilters = 0;
    for (const text of cachedTexts) {
      totalFilters += adBlocker.load_filter_list(text);
    }
    console.log(`Loaded ${totalFilters} filters from ${cachedTexts.length} cached lists`);

    // Check if we need to update lists
    if (filterListManager.needsUpdate() || cachedTexts.length === 0) {
      console.log('Updating filter lists...');
      updateFilterLists();
    }
  } catch (e) {
    console.error('Failed to load filter list manager:', e);
    // Fallback: load default rules
    await loadDefaultRules();
  }
}

// ── Fallback: load default rules ─────────────────────────────────────
async function loadDefaultRules() {
  try {
    const response = await fetch(chrome.runtime.getURL('default_rules.json'));
    const rules = await response.json();
    let total = adBlocker.load_rules_from_json(JSON.stringify(rules));

    // Always inject our own custom hardcoded rules
    const customRules = [
      "||alb.reddit.com^",                     // Reddit Ad Load Balancer network requests
      "reddit.com##shreddit-ad-post",          // Reddit new UI ad post container
      "reddit.com##shreddit-dynamic-ad-link",  // Reddit new UI dynamic ad link
      "reddit.com##.promotedlink",             // Reddit old UI promoted links
      "reddit.com##.ad-container",             // Generic ad container on reddit
      "/pagead.js$domain=adblock.turtlecute.org", // Test rule for adblock.turtlecute.org
      "/widget/ads."                           // Generic test rule
    ].join('\n');
    total += adBlocker.load_filter_list(customRules);

    console.log(`Loaded ${total} default/custom rules`);
  } catch (e) {
    console.warn('Could not load default rules:', e);
  }
}

// ── Update filter lists in the background ────────────────────────────
async function updateFilterLists() {
  if (!filterListManager) return;

  try {
    const results = await filterListManager.updateAllLists((progress) => {
      console.log(`Updating: ${progress.currentList} (${progress.current + 1}/${progress.total})`);
    });

    // Reload all filters into the engine
    adBlocker.clear_rules();
    let totalFilters = 0;

    // Always inject our own custom hardcoded rules first
    const customRules = [
      "||alb.reddit.com^",                     // Reddit Ad Load Balancer network requests
      "reddit.com##shreddit-ad-post",          // Reddit new UI ad post container
      "reddit.com##shreddit-dynamic-ad-link",  // Reddit new UI dynamic ad link
      "reddit.com##.promotedlink",             // Reddit old UI promoted links
      "reddit.com##.ad-container",             // Generic ad container on reddit
      "/pagead.js$domain=adblock.turtlecute.org", // Test rule for adblock.turtlecute.org
      "/widget/ads."                           // Generic test rule
    ].join('\n');
    totalFilters += adBlocker.load_filter_list(customRules);

    for (const text of filterListManager.getAllCachedTexts()) {
      totalFilters += adBlocker.load_filter_list(text);
    }
    console.log(`Reloaded ${totalFilters} filters after update`);
  } catch (e) {
    console.error('Failed to update filter lists:', e);
  }
}

// ── Initialize ───────────────────────────────────────────────────────
async function initializeAdBlocker() {
  try {
    await init();
    console.log('WebAssembly module initialized');

    adBlocker = new AdBlocker();

    // Load data files, settings, and filter lists in parallel
    await Promise.all([
      loadDataFiles(),
      loadSettings()
    ]);

    // Load filter lists (depends on adBlocker being created)
    await loadFilterLists();

    isInitialized = true;
    processPendingRequests();

    // Set up request listeners
    setupRequestListeners();

    console.log(`Rust AdBlocker initialized — ${adBlocker.network_filter_count()} network filters, ${adBlocker.cosmetic_filter_count()} cosmetic filters`);
  } catch (error) {
    console.error('Failed to initialize WebAssembly module:', error);
  }
}

// ── Set up request interception ──────────────────────────────────────
function setupRequestListeners() {
  // Main request blocking
  chrome.webRequest.onBeforeRequest.addListener(
    handleRequest,
    { urls: ['*://*/*'] },
    ['blocking']
  );

  // Header modification
  chrome.webRequest.onBeforeSendHeaders.addListener(
    handleHeaders,
    { urls: ['*://*/*'] },
    ['blocking', 'requestHeaders']
  );
}

// ── Handle incoming requests ─────────────────────────────────────────
function handleRequest(details) {
  if (!isInitialized) {
    pendingRequests.push(details);
    return { cancel: false };
  }

  if (!enabled) {
    return { cancel: false };
  }

  const url = details.url;
  const sourceDomain = getSourceDomain(details);
  const requestType = mapRequestType(details.type);

  // Never block top-level page navigations — only block sub-resources
  if (details.type === 'main_frame') {
    // Still strip tracking params from navigations
    if (settings.stripTrackingParams) {
      const cleanedUrl = stripTrackingParameters(url);
      if (cleanedUrl && cleanedUrl !== url) {
        return { redirectUrl: cleanedUrl };
      }
    }
    return { cancel: false };
  }

  try {
    const requestDomain = getDomainCached(url);

    // 1. Check CNAME cloaking (static list) — applies even to first-party
    if (settings.cnameDetection) {
      if (isCnameCloakedTracker(requestDomain)) {
        incrementBlocked();
        console.log(`[BLOCKED-CNAME] ${details.type}: ${url}`);
        return { cancel: true };
      }
    }

    // 2. Block known first-party tracking/ad subdomains immediately.
    //    These operate on the same base domain but are purely for ads/tracking.
    //    We must check this BEFORE the same-site bypass logic below.
    if (FIRST_PARTY_ADS.some(adDomain => requestDomain === adDomain || requestDomain.endsWith('.' + adDomain))) {
      incrementBlocked();
      console.log(`[BLOCKED-1P-AD] ${details.type}: ${url}`);
      return { cancel: true };
    }

    // 3. Skip filter check for same-site or related-domain requests.
    //    Covers: same base domain (static-assets.cargurus.com ↔ www.cargurus.com)
    //    AND site-specific CDNs (redditstatic.com ↔ reddit.com)
    const requestBase = getBaseDomainCached(requestDomain);
    const sourceBase = getBaseDomainCached(sourceDomain);
    if (requestBase === sourceBase || areRelatedDomains(requestBase, sourceBase)) {
      return { cancel: false };
    }

    // 3. Skip blocking for known generic content CDNs.
    if (GENERIC_CDNS.has(requestBase)) {
      return { cancel: false };
    }

    // 4. Check against filter rules (Rust/WASM engine) — third-party only
    const result = adBlocker.check_request(url, sourceDomain, requestType);

    if (result === 'block') {
      incrementBlocked();
      console.log(`[BLOCKED] ${details.type}: ${url} (from: ${sourceDomain})`);
      return { cancel: true };
    }
  } catch (e) {
    // If the engine throws, never block — fail open
    console.error('[AdBlocker error]', e, url);
  }

  return { cancel: false };
}

// ── Handle request headers ───────────────────────────────────────────
function handleHeaders(details) {
  if (!enabled || !isInitialized) {
    return {};
  }

  // Workaround for Chromium bug: modifying WebSocket headers via webRequest API
  // detaches the request from the document's CSP context, bypassing connect-src enforcement.
  if (details.type === 'websocket') {
    return {};
  }

  const sourceDomain = getSourceDomain(details);
  const requestDomain = getDomain(details.url);
  const isThirdParty = sourceDomain !== requestDomain;
  let modified = false;

  for (let i = details.requestHeaders.length - 1; i >= 0; i--) {
    const header = details.requestHeaders[i];
    const name = header.name.toLowerCase();

    // Strip Referer for third-party requests
    if (settings.stripReferrer && name === 'referer' && isThirdParty) {
      // Send only the origin instead of the full URL
      try {
        const refUrl = new URL(header.value);
        header.value = refUrl.origin + '/';
        modified = true;
      } catch (e) {
        // Remove if we can't parse
        details.requestHeaders.splice(i, 1);
        modified = true;
      }
    }

    // Remove tracking headers
    if (name === 'x-forwarded-for' || name === 'x-real-ip') {
      details.requestHeaders.splice(i, 1);
      modified = true;
    }

    // Normalize User-Agent
    if (settings.normalizeUserAgent && name === 'user-agent') {
      header.value = NORMALIZED_USER_AGENT;
      modified = true;
    }
  }

  if (modified) {
    return { requestHeaders: details.requestHeaders };
  }
  return {};
}

// ── URL parameter stripping ──────────────────────────────────────────
function stripTrackingParameters(url) {
  try {
    const urlObj = new URL(url);
    let changed = false;

    for (const param of trackingParams) {
      if (urlObj.searchParams.has(param)) {
        urlObj.searchParams.delete(param);
        changed = true;
      }
    }

    return changed ? urlObj.toString() : null;
  } catch (e) {
    return null;
  }
}

// ── CNAME cloaking detection ─────────────────────────────────────────
function isCnameCloakedTracker(hostname) {
  // Check against the known CNAME trackers list
  for (const trackerDomain of Object.keys(cnameTrackers)) {
    if (hostname === trackerDomain || hostname.endsWith('.' + trackerDomain)) {
      return true;
    }
  }
  return false;
}

// ── Process pending requests ─────────────────────────────────────────
function processPendingRequests() {
  for (const request of pendingRequests) {
    const sourceDomain = getSourceDomain(request);
    const requestType = mapRequestType(request.type);
    const result = adBlocker.check_request(request.url, sourceDomain, requestType);
    if (result === 'block') {
      log(`Would have blocked: ${request.url}`);
    }
  }
  pendingRequests = [];
}

// ── Update blocked counter ───────────────────────────────────────────
function incrementBlocked() {
  blockedToday++;
  totalBlocked++;
  chrome.storage.local.set({
    blockedToday: blockedToday,
    totalBlocked: totalBlocked
  });
}

// ── Message handler ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'getStats':
      sendResponse({
        enabled: enabled,
        blockedToday: blockedToday,
        totalBlocked: totalBlocked,
        networkFilters: isInitialized ? adBlocker.network_filter_count() : 0,
        cosmeticFilters: isInitialized ? adBlocker.cosmetic_filter_count() : 0,
        settings: settings
      });
      break;

    case 'toggleEnabled':
      enabled = message.enabled;
      chrome.storage.local.set({ enabled: enabled });
      sendResponse({ success: true });
      break;

    case 'updateSettings':
      settings = { ...settings, ...message.settings };
      chrome.storage.local.set({ privacySettings: settings });
      sendResponse({ success: true });
      break;

    case 'getCosmeticSelectors':
      if (isInitialized && message.domain) {
        const selectorsJson = adBlocker.get_cosmetic_selectors(message.domain);
        try {
          sendResponse({ selectors: JSON.parse(selectorsJson) });
        } catch (e) {
          sendResponse({ selectors: [] });
        }
      } else {
        sendResponse({ selectors: [] });
      }
      break;

    case 'getFilterListStats':
      if (filterListManager) {
        sendResponse({ lists: filterListManager.getStats() });
      } else {
        sendResponse({ lists: [] });
      }
      break;

    case 'toggleFilterList':
      if (filterListManager && message.id !== undefined) {
        filterListManager.toggleList(message.id, message.enabled).then(() => {
          // Reload filters
          reloadAllFilters().then(() => {
            sendResponse({ success: true });
          });
        });
        return true; // async response
      }
      sendResponse({ success: false });
      break;

    case 'updateFilterLists':
      updateFilterLists().then(() => {
        sendResponse({ success: true });
      });
      return true; // async response

    case 'addCustomFilterList':
      if (filterListManager && message.url) {
        filterListManager.addCustomList(message.url, message.title).then((id) => {
          sendResponse({ success: true, id: id });
        });
        return true;
      }
      sendResponse({ success: false });
      break;

    case 'removeCustomFilterList':
      if (filterListManager && message.id) {
        filterListManager.removeCustomList(message.id).then(() => {
          reloadAllFilters().then(() => {
            sendResponse({ success: true });
          });
        });
        return true;
      }
      sendResponse({ success: false });
      break;

    case 'updateRules':
      // Legacy: load rules from JSON
      if (isInitialized && message.rules) {
        adBlocker.load_rules_from_json(message.rules);
        chrome.storage.local.set({ adBlockerRules: message.rules });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'AdBlocker not initialized' });
      }
      break;

    case 'scriptAnalysis':
      // Log suspicious script activity
      if (message.data) {
        console.log(`[Script Analysis] ${message.data.type}: ${message.data.description} on ${message.data.domain}`);
      }
      break;

    default:
      break;
  }
  return true; // keep message channel open
});

// ── Reload all filters ───────────────────────────────────────────────
async function reloadAllFilters() {
  if (!isInitialized || !filterListManager) return;

  adBlocker.clear_rules();
  let totalFilters = 0;
  for (const text of filterListManager.getAllCachedTexts()) {
    totalFilters += adBlocker.load_filter_list(text);
  }
  console.log(`Reloaded ${totalFilters} filters`);
}

// ── Start ────────────────────────────────────────────────────────────
initializeAdBlocker();
