// overlayUtils.js -- the coloured frames drawn around the controls while a
// fill runs, so the user sees what the extension is working on: grey for a
// control it has seen, yellow while it is being filled, blue once filled,
// orange when the action did not take. Purely cosmetic; cleared when the fill
// ends or is stopped.
const OverlayUtils = (function () {
    'use strict';

    const COLORS = {
        seen:    { border: 'rgba(120,120,120,0.55)', bg: 'rgba(120,120,120,0.08)', label: '#555' },
        filling: { border: 'rgba(250,204,21,0.95)',  bg: 'rgba(250,204,21,0.22)',  label: '#854d0e' },
        filled:  { border: 'rgba(59,130,246,0.85)',  bg: 'rgba(59,130,246,0.10)',  label: '#1d4ed8' },
        failed:  { border: 'rgba(249,115,22,0.85)',  bg: 'rgba(249,115,22,0.10)',  label: '#c2410c' },
    };
    const ATTR = 'data-formfill-overlay';
    const overlays = new Map();   // element -> { box, label, status }
    let reposition = null;

    function place(element, box, label) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) { box.style.display = 'none'; return; }   // not laid out
        box.style.display = '';
        const x = rect.left + window.scrollX, y = rect.top + window.scrollY;
        box.style.left = (x - 2) + 'px';
        box.style.top = (y - 2) + 'px';
        box.style.width = (rect.width + 4) + 'px';
        box.style.height = (rect.height + 4) + 'px';
        if (label) { label.style.left = (x - 2) + 'px'; label.style.top = (y - 18) + 'px'; }
    }

    function colour(entry, status) {
        const c = COLORS[status] || COLORS.seen;
        entry.box.style.border = `2px solid ${c.border}`;
        entry.box.style.background = c.bg;
        if (entry.label) {
            entry.label.style.color = c.label;
            entry.label.style.background = 'rgba(255,255,255,0.92)';
            entry.label.style.borderColor = c.border;
        }
        entry.status = status;
    }

    function add(element, status = 'seen', text = '') {
        if (!element || overlays.has(element)) return;
        if (!reposition) {
            reposition = () => { for (const [el, entry] of overlays) place(el, entry.box, entry.label); };
            window.addEventListener('scroll', reposition, { passive: true, capture: true });
            window.addEventListener('resize', reposition, { passive: true });
        }
        const box = document.createElement('div');
        box.setAttribute(ATTR, '1');
        box.style.cssText = 'position:absolute; pointer-events:none; z-index:2147483640; border-radius:3px; box-sizing:border-box; transition: border-color 0.2s, background 0.2s, transform 0.15s;';
        let label = null;
        if (text) {
            label = document.createElement('div');
            label.setAttribute(ATTR, '1');
            label.textContent = text;
            label.style.cssText = "position:absolute; pointer-events:none; z-index:2147483641; font: 600 10px/14px -apple-system, 'Segoe UI', sans-serif; padding:1px 5px; border:1px solid transparent; border-radius:3px 3px 0 0; white-space:nowrap; max-width:240px; overflow:hidden; text-overflow:ellipsis;";
        }
        const entry = { box, label, status };
        colour(entry, status);
        document.body.appendChild(box);
        if (label) document.body.appendChild(label);
        overlays.set(element, entry);
        place(element, box, label);
    }

    function setStatus(element, status) {
        const entry = overlays.get(element);
        if (entry) colour(entry, status);
    }

    // A short flash on the control being worked on right now.
    function pulse(element, duration = 450) {
        const entry = overlays.get(element);
        if (!entry) return;
        const before = entry.status;
        colour(entry, 'filling');
        entry.box.style.transform = 'scale(1.015)';
        setTimeout(() => {
            if (!overlays.has(element)) return;
            entry.box.style.transform = '';
            colour(entry, before);
        }, duration);
    }

    function clearAll() {
        overlays.clear();
        if (reposition) {
            window.removeEventListener('scroll', reposition, { capture: true });
            window.removeEventListener('resize', reposition);
            reposition = null;
        }
        document.querySelectorAll(`[${ATTR}]`).forEach(n => n.remove());
    }

    return { add, setStatus, pulse, clearAll };
})();
