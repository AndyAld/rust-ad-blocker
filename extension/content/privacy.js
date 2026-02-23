// ── Privacy Protection Content Script ─────────────────────────────────
// Injected at document_start to protect against fingerprinting and WebRTC leaks.
// Must run before any page scripts via a main-world injection wrapper.

(function () {
    'use strict';

    // ── Skip protections on auth/login domains ─────────────────────────
    // Google, Microsoft, etc. use fingerprinting for security (bot detection).
    // Our spoofing triggers "insecure browser" blocks on sign-in pages.
    const AUTH_DOMAINS = [
        'accounts.google.com',
        'accounts.youtube.com',
        'login.microsoftonline.com',
        'login.live.com',
        'appleid.apple.com',
    ];
    const hostname = window.location.hostname;
    if (AUTH_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
        return; // Don't inject protections on auth pages
    }

    // ── Inject into the page's main world ────────────────────────────────
    // Content scripts run in an isolated world, so we need to inject code
    // into the actual page context to override its APIs.
    const script = document.createElement('script');
    script.textContent = `(${mainWorldProtections.toString()})();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();

    function mainWorldProtections() {
        // Deterministic seed from domain so fingerprint is consistent per-site
        // but different across sites (prevents cross-site correlation)
        const seed = hashCode(window.location.hostname);
        let rngState = seed;

        function seededRandom() {
            rngState = (rngState * 1664525 + 1013904223) & 0xFFFFFFFF;
            return (rngState >>> 0) / 0xFFFFFFFF;
        }

        function hashCode(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash) + str.charCodeAt(i);
                hash |= 0;
            }
            return Math.abs(hash) || 1;
        }

        // ── Shared noise injection helper ──────────────────────────────────
        function addNoiseToImageData(data, noiseSeed) {
            let localRng = noiseSeed;
            for (let i = 0; i < data.length; i += 4) {
                localRng = (localRng * 1664525 + 1013904223) & 0xFFFFFFFF;
                if ((localRng & 0xF) < 2) { // ~12.5% of pixels
                    data[i] = (data[i] + ((localRng >> 4) & 3) - 1) & 0xFF;
                    data[i + 1] = (data[i + 1] + ((localRng >> 6) & 3) - 1) & 0xFF;
                    data[i + 2] = (data[i + 2] + ((localRng >> 8) & 3) - 1) & 0xFF;
                }
            }
        }

        // ── Canvas Fingerprint Protection ──────────────────────────────────
        // Add deterministic noise to canvas readback

        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const origToBlob = HTMLCanvasElement.prototype.toBlob;

        CanvasRenderingContext2D.prototype.getImageData = function () {
            const imageData = origGetImageData.apply(this, arguments);
            addNoiseToImageData(imageData.data, seed ^ imageData.data.length);
            return imageData;
        };

        HTMLCanvasElement.prototype.toDataURL = function () {
            try {
                const ctx2d = this.getContext('2d');
                if (ctx2d && this.width > 0 && this.height > 0) {
                    // 2D canvas — inject noise directly
                    const w = Math.min(this.width, 200);
                    const h = Math.min(this.height, 200);
                    const imageData = origGetImageData.call(ctx2d, 0, 0, w, h);
                    addNoiseToImageData(imageData.data, seed ^ (w * h));
                    ctx2d.putImageData(imageData, 0, 0);
                } else if (this.width > 0 && this.height > 0) {
                    // WebGL canvas — copy to a temp 2D canvas, add noise, return that
                    const tmp = document.createElement('canvas');
                    tmp.width = this.width;
                    tmp.height = this.height;
                    const tmpCtx = tmp.getContext('2d');
                    if (tmpCtx) {
                        tmpCtx.drawImage(this, 0, 0);
                        const w = Math.min(tmp.width, 300);
                        const h = Math.min(tmp.height, 300);
                        const imageData = origGetImageData.call(tmpCtx, 0, 0, w, h);
                        addNoiseToImageData(imageData.data, seed ^ (w * h + 99));
                        tmpCtx.putImageData(imageData, 0, 0);
                        return origToDataURL.apply(tmp, arguments);
                    }
                }
            } catch (e) { /* tainted canvas */ }
            return origToDataURL.apply(this, arguments);
        };

        HTMLCanvasElement.prototype.toBlob = function () {
            try {
                const ctx = this.getContext('2d');
                if (ctx && this.width > 0 && this.height > 0) {
                    const w = Math.min(this.width, 200);
                    const h = Math.min(this.height, 200);
                    const imageData = origGetImageData.call(ctx, 0, 0, w, h);
                    addNoiseToImageData(imageData.data, seed ^ (w * h + 7));
                    ctx.putImageData(imageData, 0, 0);
                }
            } catch (e) { /* tainted canvas */ }
            return origToBlob.apply(this, arguments);
        };

        // ── WebGL Fingerprint Protection ───────────────────────────────────
        // Block the debug renderer info extension entirely (like Firefox/Brave).
        // Spoofing a fake GPU creates a WORSE fingerprint because the rendered
        // output doesn't match the reported GPU, making us completely unique.

        function patchWebGL(proto) {
            const origGetExtension = proto.getExtension;
            proto.getExtension = function (name) {
                // Block the extension that reveals GPU vendor/renderer
                if (name === 'WEBGL_debug_renderer_info') {
                    return null;
                }
                return origGetExtension.apply(this, arguments);
            };

            // Also intercept getSupportedExtensions to hide it from the list
            const origGetSupported = proto.getSupportedExtensions;
            proto.getSupportedExtensions = function () {
                const exts = origGetSupported.apply(this, arguments);
                if (exts) {
                    return exts.filter(function (e) {
                        return e !== 'WEBGL_debug_renderer_info';
                    });
                }
                return exts;
            };

            // Return generic strings for VENDOR and RENDERER params
            const origGetParameter = proto.getParameter;
            proto.getParameter = function (param) {
                // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
                if (param === 0x9245 || param === 0x9246) return null;
                return origGetParameter.apply(this, arguments);
            };
        }

        patchWebGL(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') {
            patchWebGL(WebGL2RenderingContext.prototype);
        }

        // ── WebGL readPixels noise (randomizes the WebGL render hash) ─────
        function patchWebGLReadPixels(proto) {
            const origReadPixels = proto.readPixels;
            proto.readPixels = function () {
                origReadPixels.apply(this, arguments);
                // arguments[6] is the output array (Uint8Array or Float32Array)
                const pixels = arguments[6];
                if (pixels && pixels.length) {
                    let localRng = seed ^ pixels.length;
                    for (let i = 0; i < pixels.length; i += 4) {
                        localRng = (localRng * 1664525 + 1013904223) & 0xFFFFFFFF;
                        if ((localRng & 0xF) < 2) { // ~12.5% of pixels
                            pixels[i] = (pixels[i] + ((localRng >> 4) & 3) - 1) & 0xFF;
                            pixels[i + 1] = (pixels[i + 1] + ((localRng >> 6) & 3) - 1) & 0xFF;
                        }
                    }
                }
            };
        }

        patchWebGLReadPixels(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') {
            patchWebGLReadPixels(WebGL2RenderingContext.prototype);
        }

        // ── AudioContext Fingerprint Protection ────────────────────────────
        // Return slightly different analysis results

        const origCreateAnalyser = AudioContext.prototype.createAnalyser;
        AudioContext.prototype.createAnalyser = function () {
            const analyser = origCreateAnalyser.apply(this, arguments);
            const origGetFloatFrequencyData = analyser.getFloatFrequencyData.bind(analyser);

            analyser.getFloatFrequencyData = function (array) {
                origGetFloatFrequencyData(array);
                let localRng = seed ^ array.length;
                for (let i = 0; i < array.length; i++) {
                    localRng = (localRng * 1664525 + 1013904223) & 0xFFFFFFFF;
                    array[i] += ((localRng >>> 0) / 0xFFFFFFFF - 0.5) * 0.001;
                }
            };
            return analyser;
        };

        const origOfflineContext = window.OfflineAudioContext;
        if (origOfflineContext) {
            const origStartRendering = OfflineAudioContext.prototype.startRendering;
            OfflineAudioContext.prototype.startRendering = function () {
                return origStartRendering.apply(this, arguments).then(function (buffer) {
                    const data = buffer.getChannelData(0);
                    let localRng = seed ^ data.length;
                    for (let i = 0; i < data.length; i++) {
                        localRng = (localRng * 1664525 + 1013904223) & 0xFFFFFFFF;
                        data[i] += ((localRng >>> 0) / 0xFFFFFFFF - 0.5) * 0.00001;
                    }
                    return buffer;
                });
            };
        }

        // ── WebRTC IP Leak Protection ──────────────────────────────────────

        if (typeof RTCPeerConnection !== 'undefined') {
            const OrigRTC = RTCPeerConnection;
            window.RTCPeerConnection = function (config) {
                config = config || {};
                config.iceTransportPolicy = 'relay';
                if (config.iceServers) {
                    config.iceServers = config.iceServers.filter(function (s) {
                        const urls = Array.isArray(s.urls) ? s.urls : [s.urls || ''];
                        return urls.some(function (u) { return u && u.startsWith('turn:'); });
                    });
                }
                return new OrigRTC(config);
            };
            window.RTCPeerConnection.prototype = OrigRTC.prototype;
            if (typeof webkitRTCPeerConnection !== 'undefined') {
                window.webkitRTCPeerConnection = window.RTCPeerConnection;
            }
        }

        // ── Navigator Property Spoofing ───────────────────────────────────
        // Use common values that blend in with the crowd

        const nav = navigator;
        const spoofs = {
            hardwareConcurrency: 4,
            deviceMemory: 8,
            platform: 'Win32',
            language: 'en-US',
            languages: ['en-US', 'en'],
        };

        for (const [prop, value] of Object.entries(spoofs)) {
            try {
                Object.defineProperty(Object.getPrototypeOf(nav), prop, {
                    get: function () { return typeof value === 'object' ? [...value] : value; },
                    configurable: true,
                    enumerable: true,
                });
            } catch (e) {
                try {
                    Object.defineProperty(nav, prop, {
                        get: function () { return typeof value === 'object' ? [...value] : value; },
                        configurable: true,
                    });
                } catch (e2) { /* can't override */ }
            }
        }

        // Spoof plugins to empty
        try {
            Object.defineProperty(Object.getPrototypeOf(nav), 'plugins', {
                get: function () {
                    const fakePlugins = [];
                    fakePlugins.length = 0;
                    fakePlugins.item = function () { return null; };
                    fakePlugins.namedItem = function () { return null; };
                    fakePlugins.refresh = function () { };
                    return fakePlugins;
                },
                configurable: true,
                enumerable: true,
            });
        } catch (e) { }

        try {
            Object.defineProperty(Object.getPrototypeOf(nav), 'mimeTypes', {
                get: function () {
                    const fakeMimeTypes = [];
                    fakeMimeTypes.length = 0;
                    fakeMimeTypes.item = function () { return null; };
                    fakeMimeTypes.namedItem = function () { return null; };
                    return fakeMimeTypes;
                },
                configurable: true,
                enumerable: true,
            });
        } catch (e) { }

        // ── Screen Dimensions Spoofing ────────────────────────────────────
        // Report a very common screen size

        try {
            Object.defineProperty(screen, 'width', { get: () => 1920, configurable: true });
            Object.defineProperty(screen, 'height', { get: () => 1080, configurable: true });
            Object.defineProperty(screen, 'availWidth', { get: () => 1920, configurable: true });
            Object.defineProperty(screen, 'availHeight', { get: () => 1040, configurable: true });
            Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
            Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
        } catch (e) { }

        // ── Timezone Spoofing ─────────────────────────────────────────────
        // Spoof to America/New_York (most common US timezone)

        const origDateTimeFormat = Intl.DateTimeFormat;
        const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

        Intl.DateTimeFormat.prototype.resolvedOptions = function () {
            const result = origResolvedOptions.apply(this, arguments);
            result.timeZone = 'America/New_York';
            return result;
        };

        const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
        Date.prototype.getTimezoneOffset = function () {
            // EST = UTC-5 = 300 minutes, EDT = UTC-4 = 240 minutes
            const month = this.getUTCMonth();
            // Approximate DST: March-November
            if (month >= 2 && month <= 10) return 240; // EDT
            return 300; // EST
        };

        // ── Battery API Blocking ──────────────────────────────────────────

        if (navigator.getBattery) {
            navigator.getBattery = function () {
                return Promise.resolve({
                    charging: true,
                    chargingTime: 0,
                    dischargingTime: Infinity,
                    level: 1.0,
                    addEventListener: function () { },
                    removeEventListener: function () { },
                });
            };
        }

        // ── Font Fingerprint Mitigation ───────────────────────────────────
        // Limit measurable fonts by normalizing offsetWidth/offsetHeight
        // when set to fingerprinting test fonts

        const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
        const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
        let fontProbeCount = 0;

        if (origOffsetWidth && origOffsetHeight) {
            Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
                get: function () {
                    const style = this.style;
                    if (style && style.fontFamily && style.position === 'absolute') {
                        fontProbeCount++;
                        if (fontProbeCount > 50) {
                            // After many probes, return a common width to mask unique fonts
                            return 120;
                        }
                    }
                    return origOffsetWidth.get.call(this);
                },
                configurable: true,
            });

            Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
                get: function () {
                    const style = this.style;
                    if (style && style.fontFamily && style.position === 'absolute') {
                        if (fontProbeCount > 50) {
                            return 18;
                        }
                    }
                    return origOffsetHeight.get.call(this);
                },
                configurable: true,
            });
        }
    }
})();
