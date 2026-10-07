// fillLogger.js -- local, per-session record of everything a fill did.
// Development builds only: the store build leaves this file out.
//
// Why: the value the extension tried to enter, the value that ended up in
// the field, and the value the site actually submitted are three different
// things, and they disagree more often than anyone would like. Every fill
// session is recorded so that a developer (or an LLM fed the export) can see,
// per site: what the page looked like to the model at every look, what the
// model answered, what the hands did and what each control showed afterwards,
// and what was submitted once the user pressed the button (form values, form
// data, network request bodies, the page that followed).
//
// Storage: browser.storage.local, one key per session ("ffLog:<sessionId>")
// plus an index ("ffLogIndex"). Writes go through the background script so
// concurrent frames never clobber each other. Export/clear from the side
// panel. Nothing leaves the machine.
const FillLogger = (function () {
    'use strict';

    const LAST_SESSION_KEY = 'ff-last-session';        // this tab's last fill, across page loads
    const PENDING_KEY = 'ff-post-submit-pending';      // set when a filled page is left
    const SECRET_KEY = /pass(word)?|pwd|secret|cvv|cvc|csc/i;
    // Buttons whose press is worth recording what the form held at that moment.
    const SUBMITS = /\b(submit|send|pay|order|buy|purchase|register|sign ?up|create|confirm|book|checkout|apply|save|finish|complete|continue|next|proceed|verstuur|verzend|bestel|betaal|opslaan|bevestig|verder|volgende|abschicken|senden|bestellen|zahlen|weiter|speichern|envoyer|payer|commander|suivant|valider|enviar|pagar|guardar|submeter|confirmar|continuar|autenticar|entrar)\b/i;

    let enabled = true;
    let enabledLoaded = false;
    let currentSessionId = null;
    let seq = 0;
    let watching = false;

    async function loadEnabled() {
        if (!enabledLoaded) {
            try { enabled = (await browser.storage.local.get('ffLogEnabled')).ffLogEnabled !== false; } catch (_) { enabled = true; }
            enabledLoaded = true;
        }
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

    const frameInfo = () => ({ frame: window === window.top ? 'top' : 'iframe', frameUrl: location.href });

    // ------------------------------------------------------------ a session

    // Open (or join, from another frame) the session. Returns whether logging is on.
    async function start(sessionId, meta) {
        if (!(await loadEnabled())) return false;
        currentSessionId = sessionId;
        seq = 0;
        try { sessionStorage.setItem(LAST_SESSION_KEY, sessionId); } catch (_) {}
        send({
            action: 'ffLog', op: 'start', sessionId,
            meta: { ...frameInfo(), url: location.href, title: document.title, startedAt: Date.now(), ...meta },
        });
        watch();
        // Wake the page-world hook (pageHook.js) that relays request bodies.
        document.dispatchEvent(new CustomEvent('ff-record', { detail: 'on' }));
        return true;
    }

    // Record one event on the current (or this tab's last) session.
    function event(type, payload) {
        const sessionId = lastSessionId();
        if (!enabled || !sessionId) return;
        send({ action: 'ffLog', op: 'append', sessionId, entry: { t: Date.now(), seq: ++seq, type, ...frameInfo(), ...(payload || {}) } });
    }

    // The fill is over. The session id is kept: what is submitted afterwards
    // still belongs to it.
    function end(summary) {
        if (!enabled || !currentSessionId) return;
        send({ action: 'ffLog', op: 'end', sessionId: currentSessionId, summary: summary || {} });
    }

    function lastSessionId() {
        if (currentSessionId) return currentSessionId;
        try { return sessionStorage.getItem(LAST_SESSION_KEY); } catch (_) { return null; }
    }

    // A copy of `obj` fit for the log: images dropped, long strings capped.
    function slim(obj, maxStr = 4000) {
        try {
            return JSON.parse(JSON.stringify(obj, (k, v) => {
                if (typeof v !== 'string') return v;
                if (v.startsWith('data:image')) return `[image ${v.length} chars]`;
                return v.length > maxStr ? v.slice(0, maxStr) + `… [${v.length} chars]` : v;
            }));
        } catch (_) { return null; }
    }

    // ------------------------------------------------------------ what the page holds

    // Every field as the engine sees it right now: what it is called and what it holds.
    function values() {
        return PageView.capture({ baseline: null }).fields.map(f => {
            const v = { ref: f.ref, role: f.role, label: f.name || f.placeholder || f.hint || '', value: f.toggle ? f.checked : f.value };
            if (f.shows) v.shows = f.shows;
            if (f.invalid) v.invalid = true;
            return v;
        });
    }

    // Sanitized HTML of the form(s) the fields live in, capped in size.
    function pageHtml(maxBytes = 300 * 1024) {
        const fields = PageView.capture({ baseline: null }).fields.map(f => f.el);
        const forms = new Set(), loose = [];
        for (const el of fields) {
            const form = el.closest('form');
            if (form) forms.add(form); else loose.push(el);
        }
        const containers = Array.from(forms);
        if (loose.length) {
            // Fields outside any form: the smallest element holding them all.
            let common = loose[0];
            for (const el of loose) while (common && !common.contains(el)) common = common.parentElement;
            if (common) containers.push(common);
        }
        if (!containers.length) containers.push(document.body);

        const parts = [];
        let total = 0;
        for (const c of containers) {
            let html = sanitizedHtml(c);
            if (total + html.length > maxBytes) html = html.slice(0, Math.max(0, maxBytes - total)) + '<!-- truncated -->';
            parts.push(html);
            total += html.length;
            if (total >= maxBytes) break;
        }
        return parts.join('\n<!-- ---- next container ---- -->\n');
    }

    function sanitizedHtml(node) {
        const clone = node.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, template, svg, canvas, video, audio, picture, iframe, link, meta, [data-formfill-overlay]').forEach(n => n.remove());
        for (const el of clone.querySelectorAll('*')) {
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on') || name === 'srcdoc' || name === 'srcset') { el.removeAttribute(attr.name); continue; }
                if (attr.value.length > 400) el.setAttribute(attr.name, attr.value.slice(0, 400) + '…');
                if (name === 'src' && attr.value.startsWith('data:')) el.setAttribute(attr.name, 'data:…');
            }
            if (el.tagName === 'INPUT' && el.type === 'password') el.removeAttribute('value');
        }
        return clone.outerHTML || '';
    }

    // The browser's own view of what a form would send.
    function formData(form) {
        const out = [];
        try {
            for (const [key, v] of new FormData(form).entries()) {
                if (out.length >= 300) break;
                let value = typeof v === 'string' ? v : `[file ${v.name || ''} ${v.size || 0}B]`;
                if (SECRET_KEY.test(key)) value = '[redacted]';
                out.push([key, value.length > 500 ? value.slice(0, 500) + '…' : value]);
            }
        } catch (_) {}
        return out;
    }

    // ------------------------------------------------------------ what gets submitted afterwards

    const lastCaptureAt = {};

    function captureSubmission(trigger, extra) {
        if (!lastSessionId()) return;
        // Rapid repeats of the SAME trigger are one press; a submit event right
        // after a button click is kept, because it carries the form data.
        const now = Date.now();
        if (now - (lastCaptureAt[trigger] || 0) < 300) return;
        lastCaptureAt[trigger] = now;
        event('submitCapture', { trigger, url: location.href, values: values(), ...extra });
    }

    // Watch this page for the moment its form is sent. Installed with the
    // first fill in a tab, and again on every page that tab loads afterwards.
    function watch() {
        if (watching) return;
        watching = true;
        const safely = fn => e => { try { fn(e); } catch (_) {} };

        // Native form submission: exactly what the browser sends.
        document.addEventListener('submit', safely(e => {
            const form = e.target && e.target.tagName === 'FORM' ? e.target : null;
            captureSubmission('submit-event', {
                formAction: form ? form.action : undefined,
                formMethod: form ? form.method : undefined,
                formData: form ? formData(form) : undefined,
                defaultPrevented: e.defaultPrevented,
            });
        }), true);

        // A press on anything that looks like a submit or next button (forms
        // driven by script never fire a submit event).
        document.addEventListener('click', safely(e => {
            const el = e.target.closest('button, input[type="submit"], input[type="button"], [role="button"], a');
            if (!el) return;
            const text = (el.tagName === 'INPUT' ? el.value : (el.textContent || el.getAttribute('aria-label') || '')).trim().slice(0, 80);
            const type = (el.getAttribute('type') || '').toLowerCase();
            if (type !== 'submit' && !SUBMITS.test(text)) return;
            const form = el.form || el.closest('form');
            captureSubmission('button-click', { button: text, buttonType: type, formAction: form ? form.action : undefined, formData: form ? formData(form) : undefined });
        }), true);

        // Enter in a field.
        document.addEventListener('keydown', safely(e => {
            const el = e.target;
            if (e.key !== 'Enter' || !el.matches('input, [role="textbox"], [role="combobox"]')) return;
            const form = el.form || el.closest('form');
            captureSubmission('enter-key', { field: el.name || el.id, formData: form ? formData(form) : undefined });
        }), true);

        // Request bodies, relayed from the page world (pageHook.js).
        document.addEventListener('ff-net-capture', safely(e => {
            if (lastSessionId()) event('networkSubmit', JSON.parse(e.detail));
        }));

        // Leaving the page: what it held, and a note for the page that follows.
        window.addEventListener('pagehide', safely(() => {
            if (!lastSessionId()) return;
            event('pagehide', { url: location.href, values: values() });
            sessionStorage.setItem(PENDING_KEY, JSON.stringify({ sessionId: lastSessionId(), from: location.href, t: Date.now() }));
        }));
    }

    // A previous page in this tab was left after a fill: record where that
    // led and what the new page says (errors, a confirmation).
    function recordLandingPage() {
        let pending = null;
        try {
            pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
            sessionStorage.removeItem(PENDING_KEY);
        } catch (_) {}
        if (!pending || !pending.sessionId || Date.now() - pending.t > 10 * 60 * 1000) return;
        const collect = () => {
            const texts = [];
            const said = document.querySelectorAll('[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [class*="success" i], [class*="thank" i], [class*="confirm" i], [class*="danger" i], [class*="warning" i], h1, h2');
            for (const el of said) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (t && t.length <= 300 && PageView.onScreen(el)) texts.push(t);
                if (texts.length >= 25) break;
            }
            const held = values();
            event('postSubmitPage', { from: pending.from, url: location.href, title: document.title, texts, fieldsOnNewPage: held.length, values: held.slice(0, 60) });
        };
        if (document.readyState === 'complete') setTimeout(collect, 800);
        else window.addEventListener('load', () => setTimeout(collect, 800), { once: true });
    }

    // A tab that was filled earlier keeps being watched on the pages it loads.
    if (lastSessionId()) {
        loadEnabled().then(on => { if (on) { watch(); recordLandingPage(); } });
    }

    return { start, event, end, slim, values, pageHtml };
})();

if (typeof window !== 'undefined') window.FillLogger = FillLogger;
