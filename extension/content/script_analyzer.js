// ── Script Behavior Analyzer Content Script ───────────────────────────
// Monitors scripts for tracking behavior patterns and reports findings.

(function () {
    'use strict';

    const suspiciousActivity = [];

    // ── Monitor navigator.sendBeacon to tracking endpoints ──────────────

    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
        const urlObj = new URL(url, window.location.href);
        if (isTrackingEndpoint(urlObj.hostname)) {
            reportSuspicious('sendBeacon', url, 'Beacon to known tracking endpoint');
            return true; // Pretend it worked but don't actually send
        }
        return originalSendBeacon.apply(this, arguments);
    };

    // ── Monitor third-party cookie access ───────────────────────────────

    const cookieDescriptor = Object.getOwnPropertyDescriptor(
        Document.prototype, 'cookie'
    );
    if (cookieDescriptor) {
        Object.defineProperty(document, 'cookie', {
            get: function () {
                return cookieDescriptor.get.call(this);
            },
            set: function (value) {
                // Check if the script setting the cookie is from a third-party
                try {
                    const stack = new Error().stack || '';
                    if (isThirdPartyScript(stack)) {
                        reportSuspicious('cookie-set', value.substring(0, 100), 'Third-party script setting cookie');
                    }
                } catch (e) {
                    // Ignore
                }
                return cookieDescriptor.set.call(this, value);
            },
            configurable: true
        });
    }

    // ── Detect fingerprinting API abuse ─────────────────────────────────

    let canvasReadCount = 0;
    const CANVAS_READ_THRESHOLD = 3;

    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const monitoredToDataURL = HTMLCanvasElement.prototype.toDataURL;

    // We add a monitoring layer (privacy.js already adds noise)
    const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
        canvasReadCount++;
        if (canvasReadCount >= CANVAS_READ_THRESHOLD) {
            reportSuspicious('canvas-fingerprint', `${canvasReadCount} canvas reads`,
                'Possible canvas fingerprinting detected');
        }
        return _origToDataURL.apply(this, arguments);
    };

    // ── First-party ad detection ────────────────────────────────────────

    function detectFirstPartyAds() {
        // Common ad-related selectors and attributes
        const adIndicators = [
            '[data-ad]', '[data-ad-slot]', '[data-ad-client]',
            '[data-google-query-id]', '[data-ad-format]',
            '[id*="google_ads"]', '[class*="sponsored"]',
            '[aria-label*="advertisement"]', '[aria-label*="sponsored"]',
            'ins.adsbygoogle',
            '[data-native-ad]', '[data-promoted]'
        ];

        const combinedSelector = adIndicators.join(', ');

        try {
            const adElements = document.querySelectorAll(combinedSelector);
            adElements.forEach(el => {
                // Hide the ad element
                el.style.setProperty('display', 'none', 'important');
            });

            if (adElements.length > 0) {
                reportSuspicious('first-party-ads', `Found ${adElements.length} ad elements`,
                    'First-party ad elements detected and hidden');
            }
        } catch (e) {
            // querySelectorAll can throw on invalid selectors
        }
    }

    // ── Helper functions ────────────────────────────────────────────────

    const knownTrackers = [
        'google-analytics.com', 'googletagmanager.com',
        'facebook.com', 'facebook.net',
        'doubleclick.net', 'googlesyndication.com',
        'hotjar.com', 'fullstory.com',
        'segment.com', 'mixpanel.com',
        'amplitude.com', 'heapanalytics.com',
        'newrelic.com', 'nr-data.net'
    ];

    function isTrackingEndpoint(hostname) {
        return knownTrackers.some(tracker =>
            hostname === tracker || hostname.endsWith('.' + tracker)
        );
    }

    function isThirdPartyScript(stack) {
        const currentDomain = window.location.hostname;
        // Look for script URLs in the stack trace that don't match current domain
        const urlPattern = /https?:\/\/([^/\s]+)/g;
        let match;
        while ((match = urlPattern.exec(stack)) !== null) {
            const scriptDomain = match[1];
            if (scriptDomain !== currentDomain &&
                !currentDomain.endsWith('.' + scriptDomain) &&
                !scriptDomain.endsWith('.' + currentDomain)) {
                return true;
            }
        }
        return false;
    }

    function reportSuspicious(type, detail, description) {
        suspiciousActivity.push({ type, detail, description, timestamp: Date.now() });

        // Send to background script for logging/stats
        try {
            chrome.runtime.sendMessage({
                action: 'scriptAnalysis',
                data: { type, detail, description, domain: window.location.hostname }
            });
        } catch (e) {
            // Extension context may be invalid
        }
    }

    // Run first-party ad detection when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', detectFirstPartyAds);
    } else {
        detectFirstPartyAds();
    }

    // Re-run periodically for dynamically loaded ads
    setInterval(detectFirstPartyAds, 5000);
})();
