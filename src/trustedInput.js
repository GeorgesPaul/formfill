// trustedInput.js -- real input, when the browser lets us have it.
//
// Every event a content script dispatches is isTrusted:false, and browsers
// run default actions only for trusted events. A synthetic mousedown does not
// move focus, a synthetic keydown inserts nothing, a synthetic Enter submits
// nothing, and a widget that keeps its own focus inside a menu never sees the
// arrow keys sent to its trigger. eventSim.js and typingEngine.js reproduce
// the browser's event trail as faithfully as a script can; this module is the
// rung above that: it asks the browser itself to perform the input. hands.js
// uses it whenever it is there.
//
// Backends:
//   - gecko-experiment: Firefox and its forks (Floorp, LibreWolf, Nightly)
//     loaded as a temporary add-on with the bundled WebExtension Experiment
//     (experiments/input/). The events are synthesized inside the page's own
//     process through nsIDOMWindowUtils / nsITextInputProcessor, which is what
//     WebDriver does. Trusted, default actions run, focus moves for real.
//   - none: the store build, Chrome, or a Firefox that refuses experiments.
//     hands.js falls back to the synthetic path; nothing else changes.
//
// The content script never holds a privileged handle. It sends
// { action: 'ffInput' } messages to the background page, which knows the
// sender's tab and frame and forwards to browser.ffInput.run. Coordinates are
// CSS pixels of this frame's viewport (getBoundingClientRect), which is what
// the actor expects for this frame.
const TrustedInput = (function () {
    'use strict';

    const wait = ms => new Promise(r => setTimeout(r, ms));

    let probed = null;          // { available, backend } | { available: false, reason }
    let disabled = false;       // flipped when the transport keeps failing
    const stats = { calls: 0, failures: 0, clicks: 0, keys: 0, chars: 0, errors: [], slowest: 0 };
    function noteError(e, ms) {
        stats.failures++;
        stats.errors.push({ error: String(e && e.message || e).slice(0, 300), ms });
        if (stats.errors.length > 5) stats.errors.shift();
        if (stats.failures >= 3 && stats.failures === stats.calls) disabled = true;
    }

    function send(msg) {
        return browser.runtime.sendMessage(msg);
    }

    async function probe(force) {
        if (probed && !force) return probed;
        if (window.__ffNoTrustedInput) { probed = { available: false, reason: 'disabled' }; return probed; }
        try {
            const r = await send({ action: 'ffInput', op: 'probe' });
            probed = (r && r.available)
                ? { available: true, backend: r.backend || 'unknown' }
                : { available: false, reason: (r && r.reason) || 'unavailable' };
        } catch (e) {
            probed = { available: false, reason: String((e && e.message) || e) };
        }
        disabled = !probed.available;
        return probed;
    }

    function active() {
        return !!(probed && probed.available) && !disabled && !window.__ffNoTrustedInput;
    }

    function backend() { return probed && probed.available ? probed.backend : 'none'; }

    async function run(ops) {
        if (!active()) return { ok: false, error: 'trusted input not available' };
        stats.calls++;
        const t0 = Date.now();
        // A call that never comes back must not freeze the fill: the budget is
        // the ops' own waits plus a generous margin, then it counts as failed.
        const waits = ops.reduce((a, o) => a + (o.kind === 'wait' ? (Number(o.ms) || 0) : 0), 0);
        const limit = 4000 + waits + ops.length * 20;
        try {
            const r = await Promise.race([
                send({ action: 'ffInput', op: 'run', ops }),
                wait(limit).then(() => ({ ok: false, error: `no reply within ${limit} ms` })),
            ]);
            const ms = Date.now() - t0;
            if (ms > stats.slowest) stats.slowest = ms;
            if (!r || r.error || r.ok === false) {
                const err = r ? (r.error || (r.results || []).map(x => x.error).filter(Boolean).join('; ') || 'not ok') : 'no reply';
                noteError(err, ms);
                return { ok: false, error: err };
            }
            return r;
        } catch (e) {
            noteError(e, Date.now() - t0);
            return { ok: false, error: String((e && e.message) || e) };
        }
    }

    // ------------------------------------------------------------ geometry

    function isTogglish(el) {
        const type = (el.getAttribute('type') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        return type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch';
    }

    function visibleRect(el) {
        let r;
        try { r = el.getBoundingClientRect(); } catch (_) { return null; }
        if (r.width < 1 || r.height < 1) return null;
        let s;
        try { s = (el.ownerDocument.defaultView || window).getComputedStyle(el); } catch (_) { return null; }
        if (s.display === 'none' || s.visibility === 'hidden') return null;
        return r;
    }

    // The element that visually stands for a control: the control itself, or
    // for a checkbox hidden behind a styled label, that label (or the proxy
    // span next to the input).
    function visualFor(el) {
        const own = visibleRect(el);
        if (own) return { el, rect: own };
        if (isTogglish(el)) {
            const labels = [];
            try { if (el.labels) for (const l of el.labels) labels.push(l); } catch (_) {}
            const wrapping = el.closest && el.closest('label');
            if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);
            for (const l of labels) { const r = visibleRect(l); if (r) return { el: l, rect: r }; }
            const p = el.parentElement;
            if (p) { const r = visibleRect(p); if (r && r.width < 600 && r.height < 200) return { el: p, rect: r }; }
        }
        return null;
    }

    function acceptableHit(el, hit, proxy) {
        if (!hit) return false;
        const doc = el.ownerDocument || document;
        if (hit === doc.body || hit === doc.documentElement) return false;
        if (hit === el || el.contains(hit)) return true;
        if (proxy && proxy !== el && (hit === proxy || proxy.contains(hit))) return true;
        const lab = hit.closest && hit.closest('label');
        if (lab && (lab.control === el || lab.contains(el))) return true;
        // A wrapper drawn around the input (the box of a combobox) is the input
        // for pointing purposes: the click lands on the input's own box.
        let up = el.parentElement;
        for (let i = 0; i < 3 && up; i++, up = up.parentElement) {
            if (hit === up) return true;
        }
        return false;
    }

    // Where to click for `el`: a point inside its visual box that actually
    // hits it (or its label proxy). Scrolls it into view first. Returns null
    // when something else covers it everywhere we try.
    // Scroll `el` into view without animation. A smooth scroll (CSS
    // scroll-behavior, or a menu adjusting its own scrollTop) keeps moving
    // after the call returns; a point measured then lands on the neighbour
    // by the time the click arrives (Portugal became Poland in a 250-entry
    // menu). Returns true when something scrolled.
    function scrollInstant(node, block) {
        const doc = node.ownerDocument || document;
        const win = doc.defaultView || window;
        const before = [win.scrollX, win.scrollY, scrollTops(node)];
        try { node.scrollIntoView({ block: block || 'center', inline: 'nearest', behavior: 'instant' }); }
        catch (_) { try { node.scrollIntoView({ block: block || 'center', inline: 'nearest' }); } catch (_) {} }
        const after = [win.scrollX, win.scrollY, scrollTops(node)];
        return JSON.stringify(before) !== JSON.stringify(after);
    }

    function scrollTops(node) {
        const out = [];
        let p = node.parentElement;
        for (let i = 0; i < 12 && p; i++, p = p.parentElement) { if (p.scrollHeight > p.clientHeight + 1) out.push(p.scrollTop); }
        return out;
    }

    function pointFor(el) {
        const doc = el.ownerDocument || document;
        const win = doc.defaultView || window;
        let v = visualFor(el);
        if (!v) return null;
        const inView = r => r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
        // Also inside its scrollable ancestors (a menu's own scroll box).
        let clipped = false;
        for (let p = v.el.parentElement, i = 0; p && i < 12; p = p.parentElement, i++) {
            if (p.scrollHeight > p.clientHeight + 1) {
                const pr = p.getBoundingClientRect();
                if (v.rect.top < pr.top || v.rect.bottom > pr.bottom) { clipped = true; break; }
            }
        }
        if (clipped || !inView(v.rect) || v.rect.top < 0 || v.rect.bottom > win.innerHeight) {
            scrollInstant(v.el, 'center');
            v = visualFor(el) || v;
        }
        const r = v.rect;
        const candidates = [
            [r.left + r.width / 2, r.top + r.height / 2],
            [r.left + Math.min(12, r.width / 3), r.top + r.height / 2],
            [r.right - Math.min(12, r.width / 3), r.top + r.height / 2],
            [r.left + r.width / 2, r.top + Math.min(8, r.height / 3)],
            [r.left + r.width / 2, r.bottom - Math.min(8, r.height / 3)],
        ];
        for (const [x, y] of candidates) {
            if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) continue;
            let hit = null;
            try { hit = doc.elementFromPoint(x, y); } catch (_) {}
            // Shadow roots: descend to the real target.
            let depth = 0;
            while (hit && hit.shadowRoot && depth++ < 5) {
                let inner = null;
                try { inner = hit.shadowRoot.elementFromPoint(x, y); } catch (_) {}
                if (!inner || inner === hit) break;
                hit = inner;
            }
            if (acceptableHit(el, hit, v.el)) return { x, y, hit };
        }
        return null;
    }

    // ------------------------------------------------------------ actions

    // A real click on `el`: move, press, release at a point that hits it.
    // The browser produces the pointer/mouse/focus/click events itself.
    async function click(el, opts = {}) {
        if (!active() || !el) return { ok: false, reason: 'inactive' };
        const p = pointFor(el);
        if (!p) return { ok: false, reason: 'occluded' };
        stats.clicks++;
        const ops = [
            { kind: 'mouse', type: 'mousemove', x: p.x, y: p.y },
            { kind: 'wait', ms: 15 },
            { kind: 'mouse', type: 'mousedown', x: p.x, y: p.y, button: opts.button || 0 },
            { kind: 'wait', ms: opts.holdMs || 30 },
            { kind: 'mouse', type: 'mouseup', x: p.x, y: p.y, button: opts.button || 0 },
        ];
        const r = await run(ops);
        return { ok: !!r.ok, hit: p.hit, point: { x: p.x, y: p.y }, focused: r.focused, error: r.error };
    }

    // One key press at whatever the page has focused.
    async function key(name, mods = {}) {
        if (!active()) return { ok: false, reason: 'inactive' };
        stats.keys++;
        const r = await run([{ kind: 'key', key: name, ...mods }]);
        return { ok: !!r.ok, focused: r.focused, error: r.error };
    }

    // Type text with a human cadence: one keystroke per round trip, so that
    // between keystrokes the caller can check the cursor is still somewhere
    // (opts.ensureFocus, async, returns true when typing may continue).
    // opts: minDelayMs, maxDelayMs, pauseEveryChars, pauseMs, isCancelled.
    async function type(text, opts = {}) {
        if (!active()) return { ok: false, reason: 'inactive' };
        const str = String(text == null ? '' : text);
        const min = opts.minDelayMs != null ? opts.minDelayMs : 18;
        const max = opts.maxDelayMs != null ? opts.maxDelayMs : 55;
        const every = opts.pauseEveryChars || 7;
        const pause = opts.pauseMs != null ? opts.pauseMs : 90;
        const chars = Array.from(str);
        for (let i = 0; i < chars.length; i++) {
            if (opts.isCancelled && opts.isCancelled()) throw new Error('Form filling stopped by user.');
            if (opts.ensureFocus && !(await opts.ensureFocus(i))) return { ok: false, error: 'field lost focus', typed: i };
            const r = await run([{ kind: 'string', text: chars[i] }]);
            stats.chars++;
            if (!r.ok) return { ok: false, error: r.error, typed: i };
            await wait(Math.round(min + Math.random() * (max - min)) + ((i + 1) % every === 0 ? pause : 0));
        }
        return { ok: true, typed: chars.length };
    }

    return { probe, active, backend, run, click, key, type, pointFor, stats };
})();

if (typeof window !== 'undefined') window.TrustedInput = TrustedInput;
