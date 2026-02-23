// ── Filter List Manager ───────────────────────────────────────────────
// Handles downloading, caching, and updating filter lists.

const FILTER_LISTS = {
    easylist: {
        title: 'EasyList',
        url: 'https://easylist.to/easylist/easylist.txt',
        description: 'General ad blocking rules',
        enabled: true
    },
    easyprivacy: {
        title: 'EasyPrivacy',
        url: 'https://easylist.to/easylist/easyprivacy.txt',
        description: 'Tracker blocking rules',
        enabled: true
    },
    ublock_filters: {
        title: 'uBlock Origin Filters',
        url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
        description: 'Additional ad blocking rules from uBlock Origin',
        enabled: true
    },
    ublock_privacy: {
        title: 'uBlock Origin Privacy',
        url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
        description: 'Privacy-focused rules from uBlock Origin',
        enabled: true
    },
    peter_lowe: {
        title: "Peter Lowe's Ad and Tracking List",
        url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
        description: 'Ad and tracking server blocklist',
        enabled: true
    },
    ublock_annoyances: {
        title: 'uBlock Origin Annoyances',
        url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-others.txt',
        description: 'Cookie notices, newsletter popups, social widgets',
        enabled: false
    }
};

const UPDATE_INTERVAL_HOURS = 96; // 4 days

class FilterListManager {
    constructor() {
        this.lists = {};
        this.customLists = [];
    }

    // Initialize: load settings and cached lists
    async init() {
        return new Promise((resolve) => {
            chrome.storage.local.get(
                ['filterListSettings', 'filterListCache', 'customFilterLists', 'lastFilterUpdate'],
                (result) => {
                    // Merge saved settings with defaults
                    this.lists = {};
                    for (const [id, defaultConfig] of Object.entries(FILTER_LISTS)) {
                        this.lists[id] = {
                            ...defaultConfig,
                            ...(result.filterListSettings?.[id] || {})
                        };
                    }

                    this.customLists = result.customFilterLists || [];
                    this.cache = result.filterListCache || {};
                    this.lastUpdate = result.lastFilterUpdate || 0;
                    resolve();
                }
            );
        });
    }

    // Check if lists need updating
    needsUpdate() {
        const hoursSinceUpdate = (Date.now() - this.lastUpdate) / (1000 * 60 * 60);
        return hoursSinceUpdate >= UPDATE_INTERVAL_HOURS;
    }

    // Download a single filter list
    async downloadList(url) {
        try {
            const response = await fetch(url, {
                cache: 'no-cache',
                headers: { 'Accept': 'text/plain' }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.text();
        } catch (error) {
            console.error(`Failed to download ${url}:`, error);
            return null;
        }
    }

    // Update all enabled lists (downloads in parallel)
    async updateAllLists(onProgress) {
        const allLists = [
            ...Object.entries(this.lists).filter(([_, config]) => config.enabled),
            ...this.customLists.filter(l => l.enabled).map(l => [l.id, l])
        ];

        if (onProgress) {
            onProgress({ current: 0, total: allLists.length, currentList: 'Starting parallel downloads...' });
        }

        // Download all lists in parallel
        const downloads = allLists.map(([id, config]) =>
            this.downloadList(config.url).then(text => ({ id, config, text }))
        );

        const settled = await Promise.allSettled(downloads);
        const results = {};

        for (const outcome of settled) {
            if (outcome.status === 'fulfilled' && outcome.value.text) {
                const { id, text } = outcome.value;
                results[id] = text;
                this.cache[id] = {
                    text: text,
                    timestamp: Date.now(),
                    lineCount: text.split('\n').length
                };
            }
        }

        if (onProgress) {
            onProgress({ current: allLists.length, total: allLists.length, currentList: 'Done' });
        }

        // Save cache
        this.lastUpdate = Date.now();
        await this.saveCache();

        return results;
    }

    // Get all cached list texts for loading into the engine
    getAllCachedTexts() {
        const texts = [];
        for (const [id, config] of Object.entries(this.lists)) {
            if (config.enabled && this.cache[id]?.text) {
                texts.push(this.cache[id].text);
            }
        }
        for (const custom of this.customLists) {
            if (custom.enabled && this.cache[custom.id]?.text) {
                texts.push(this.cache[custom.id].text);
            }
        }
        return texts;
    }

    // Add a custom filter list
    async addCustomList(url, title) {
        const id = 'custom_' + Date.now();
        const customList = {
            id: id,
            title: title || url,
            url: url,
            description: 'Custom filter list',
            enabled: true
        };
        this.customLists.push(customList);
        await this.saveSettings();
        return id;
    }

    // Remove a custom filter list
    async removeCustomList(id) {
        this.customLists = this.customLists.filter(l => l.id !== id);
        delete this.cache[id];
        await this.saveSettings();
        await this.saveCache();
    }

    // Toggle a list on/off
    async toggleList(id, enabled) {
        if (this.lists[id]) {
            this.lists[id].enabled = enabled;
        } else {
            const custom = this.customLists.find(l => l.id === id);
            if (custom) {
                custom.enabled = enabled;
            }
        }
        await this.saveSettings();
    }

    // Save settings to storage
    async saveSettings() {
        const settings = {};
        for (const [id, config] of Object.entries(this.lists)) {
            settings[id] = { enabled: config.enabled };
        }

        return new Promise((resolve) => {
            chrome.storage.local.set({
                filterListSettings: settings,
                customFilterLists: this.customLists
            }, resolve);
        });
    }

    // Save cache to storage
    async saveCache() {
        return new Promise((resolve) => {
            chrome.storage.local.set({
                filterListCache: this.cache,
                lastFilterUpdate: this.lastUpdate
            }, resolve);
        });
    }

    // Get stats about all lists
    getStats() {
        const stats = [];
        for (const [id, config] of Object.entries(this.lists)) {
            stats.push({
                id,
                title: config.title,
                url: config.url,
                description: config.description,
                enabled: config.enabled,
                cached: !!this.cache[id],
                lineCount: this.cache[id]?.lineCount || 0,
                lastUpdated: this.cache[id]?.timestamp || null,
                isCustom: false
            });
        }
        for (const custom of this.customLists) {
            stats.push({
                id: custom.id,
                title: custom.title,
                url: custom.url,
                description: custom.description,
                enabled: custom.enabled,
                cached: !!this.cache[custom.id],
                lineCount: this.cache[custom.id]?.lineCount || 0,
                lastUpdated: this.cache[custom.id]?.timestamp || null,
                isCustom: true
            });
        }
        return stats;
    }
}

// Export for use in background.js
if (typeof window !== 'undefined') {
    window.FilterListManager = FilterListManager;
    window.FILTER_LISTS = FILTER_LISTS;
}
