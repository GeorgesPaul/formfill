// browserCompat.js: one shim so a single source tree runs on both
// Firefox (MV2, `browser.*`, persistent background page) and
// Chrome (MV3, `chrome.*`, service worker).
//
// Load this FIRST in every context: content scripts, extension pages, and the
// service worker's importScripts list.
//
// Chrome MV3's `chrome.*` APIs already return promises when no callback is
// passed, so aliasing `browser` to `chrome` covers almost everything. The
// handful of genuine API differences live in `Compat` below.
(function (g) {
    'use strict';

    if (typeof g.browser === 'undefined' || !g.browser || !g.browser.runtime) {
        g.browser = g.chrome;
    }
    const api = g.browser;

    const Compat = {};

    Compat.manifestVersion = (function () {
        try { return api.runtime.getManifest().manifest_version; } catch (_) { return 2; }
    })();
    Compat.isMV3 = Compat.manifestVersion === 3;

    // MV2 has tabs.executeScript; MV3 replaced it with scripting.executeScript.
    Compat.executeScriptFiles = async function (tabId, files) {
        if (api.scripting && api.scripting.executeScript) {
            await api.scripting.executeScript({ target: { tabId, allFrames: true }, files });
            return;
        }
        for (const file of files) {
            await api.tabs.executeScript(tabId, { file, allFrames: true });
        }
    };

    // Load the page-side scripts into a tab that has none: a page that was
    // open before the extension was (re)loaded, or one where the manifest's
    // content scripts do not run (the PDF viewer). The list is the manifest's
    // own, so it cannot drift from what pages normally get.
    Compat.injectContentScripts = function (tabId) {
        const entry = (api.runtime.getManifest().content_scripts || []).find(cs => cs.world !== 'MAIN');
        return Compat.executeScriptFiles(tabId, entry ? entry.js : []);
    };

    // Chrome rejects an explicit null windowId; both browsers accept the
    // single-argument form, which means "current window".
    Compat.captureVisibleTab = function (windowId, options) {
        if (windowId === null || windowId === undefined) {
            return api.tabs.captureVisibleTab(options);
        }
        return api.tabs.captureVisibleTab(windowId, options);
    };

    // Fire-and-forget messaging. When no receiver exists (popup closed, service
    // worker asleep) Chrome rejects the promise; nobody awaits these, so the
    // rejection would surface as a console error on every progress tick.
    Compat.notify = function (message) {
        try {
            const p = api.runtime.sendMessage(message);
            if (p && typeof p.catch === 'function') p.catch(() => {});
            return p;
        } catch (_) {
            return Promise.resolve(undefined);
        }
    };

    g.Compat = Compat;
})(typeof globalThis !== 'undefined' ? globalThis : self);
