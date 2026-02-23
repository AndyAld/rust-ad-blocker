// ── Cosmetic Filtering Content Script ─────────────────────────────────
// Injected into every page at document_start to hide ad elements via CSS.

(function () {
    'use strict';

    const domain = window.location.hostname;
    let styleElement = null;
    let appliedSelectors = new Set();

    // Request cosmetic selectors from the background script
    chrome.runtime.sendMessage(
        { action: 'getCosmeticSelectors', domain: domain },
        function (response) {
            if (chrome.runtime.lastError) {
                return;
            }
            if (response && response.selectors && response.selectors.length > 0) {
                injectHidingRules(response.selectors);
            }
        }
    );

    // Inject CSS rules to hide ad elements
    function injectHidingRules(selectors) {
        if (!selectors || selectors.length === 0) return;

        if (!styleElement) {
            styleElement = document.createElement('style');
            styleElement.id = 'rust-adblocker-cosmetic';
            styleElement.type = 'text/css';
            (document.head || document.documentElement).appendChild(styleElement);
        }

        const newSelectors = selectors.filter(s => !appliedSelectors.has(s));
        if (newSelectors.length === 0) return;

        for (const sel of newSelectors) {
            appliedSelectors.add(sel);
        }

        // Build CSS rule: selector1, selector2, ... { display: none !important }
        // Chunk into groups of 50 to avoid overly long CSS rules
        const chunkSize = 50;
        let css = '';
        for (let i = 0; i < newSelectors.length; i += chunkSize) {
            const chunk = newSelectors.slice(i, i + chunkSize);
            css += chunk.join(',\n') + ' { display: none !important; }\n';
        }

        styleElement.textContent += css;
    }

    // Watch for dynamically inserted ad elements
    let selectorsLoaded = false;
    let lastCheck = 0;
    const CHECK_COOLDOWN = 2000; // ms between re-checks

    const observer = new MutationObserver(function (mutations) {
        // Once selectors are loaded and applied, skip re-requests
        // (filter lists don't change mid-page)
        if (selectorsLoaded) return;

        // Debounce: skip if a check is pending or cooldown hasn't elapsed
        const now = Date.now();
        if (observer._pendingCheck || now - lastCheck < CHECK_COOLDOWN) return;
        observer._pendingCheck = true;

        const scheduleCheck = window.requestIdleCallback || requestAnimationFrame;
        scheduleCheck(function () {
            observer._pendingCheck = false;
            lastCheck = Date.now();
            chrome.runtime.sendMessage(
                { action: 'getCosmeticSelectors', domain: domain },
                function (response) {
                    if (chrome.runtime.lastError) return;
                    if (response && response.selectors) {
                        injectHidingRules(response.selectors);
                        selectorsLoaded = true; // Stop future re-requests
                    }
                }
            );
        });
    });

    // Start observing once DOM is ready
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true });
            }
        });
    }
})();
