// fillLogger.js -- local, per-session record of everything a fill did.
//
// Why: the value the extension tried to enter, the value that ended up in
// the field, and the value the site actually submitted are three different
// things, and they disagree more often than anyone would like. Every fill
// session is recorded so that a developer (or an LLM fed the export) can see,
// per site: what the form looked like (fields + sanitized HTML), what the
// model was asked and answered, what actions ran and what the page did in
// response (new fields, validation errors, autocomplete popups), what the
// form held at the end, and what was submitted afterwards (form data, network
// request bodies, the page that followed).
//
// Storage: browser.storage.local, one key per session ("ffLog:<sessionId>")
// plus an index ("ffLogIndex"). Writes go through the background script so
// concurrent frames never clobber each other. Export/clear from the side
// panel. Nothing leaves the machine.
(function (global) {
    'use strict';

    const LAST_SESSION_KEY = 'ff-last-session';
    let enabled = true;
    let enabledLoaded = false;
    let currentSessionId = null;
    let seq = 0;

    async function loadEnabled() {
        if (enabledLoaded) return enabled;
        try {
            const d = await browser.storage.local.get('ffLogEnabled');
            enabled = d.ffLogEnabled !== false;
        } catch (_) { enabled = true; }
        enabledLoaded = true;
        return enabled;
    }
    try {
        browser.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.ffLogEnabled) enabled = changes.ffLogEnabled.newValue !== false;
        });
    } catch (_) {}

    function send(msg) {
        try {
            const p = browser.runtime.sendMessage(msg);
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
    }

    function frameInfo() {
        return {
            frame: window === window.top ? 'top' : 'iframe',
            frameUrl: location.href,
        };
    }

    async function start(sessionId, meta) {
        await loadEnabled();
        if (!enabled) return false;
        currentSessionId = sessionId;
        seq = 0;
        try { sessionStorage.setItem(LAST_SESSION_KEY, sessionId); } catch (_) {}
        send({
            action: 'ffLog', op: 'start', sessionId,
            meta: { ...frameInfo(), url: location.href, title: document.title, startedAt: Date.now(), ...meta },
        });
        return true;
    }

    // Record one event on the current (or last) session of this frame.
    function event(type, payload) {
        if (!enabled) return;
        const sid = currentSessionId || lastSessionId();
        if (!sid) return;
        const entry = { t: Date.now(), seq: ++seq, type, ...frameInfo(), ...(payload || {}) };
        send({ action: 'ffLog', op: 'append', sessionId: sid, entry });
    }

    function end(summary) {
        if (!enabled || !currentSessionId) return;
        send({ action: 'ffLog', op: 'end', sessionId: currentSessionId, summary: summary || {} });
        // Keep currentSessionId: submit captures after the fill attach to it.
    }

    function lastSessionId() {
        if (currentSessionId) return currentSessionId;
        try { return sessionStorage.getItem(LAST_SESSION_KEY); } catch (_) { return null; }
    }

    function hasSession() { return !!lastSessionId(); }

    // Strip images and long strings from an object for the log (keeps shape).
    function slim(obj, maxStr = 4000) {
        try {
            return JSON.parse(JSON.stringify(obj, (k, v) => {
                if (typeof v === 'string') {
                    if (v.startsWith('data:image')) return `[image ${v.length} chars]`;
                    if (v.length > maxStr) return v.slice(0, maxStr) + `… [${v.length} chars]`;
                }
                return v;
            }));
        } catch (_) { return null; }
    }

    const FillLogger = { start, event, end, lastSessionId, hasSession, slim, loadEnabled, get enabled() { return enabled; }, get sessionId() { return currentSessionId; } };

    if (typeof window !== 'undefined') window.FillLogger = FillLogger;
    else if (typeof global !== 'undefined') global.FillLogger = FillLogger;
    else if (typeof self !== 'undefined') self.FillLogger = FillLogger;

})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global :
   typeof self !== 'undefined' ? self : this);
