// Debug/aesthetic overlays drawn on top of form fields during vision fill.
// Color-coded: neutral (detected), green (heuristic match), blue (LLM match),
// orange (no value). Cleared when fill completes or stops. Purely cosmetic.

(function (global) {
    'use strict';

    const OverlayUtils = {};
    const COLORS = {
        detected:  { border: 'rgba(120,120,120,0.55)', bg: 'rgba(120,120,120,0.08)', label: '#555' },
        heuristic: { border: 'rgba(34,197,94,0.85)',  bg: 'rgba(34,197,94,0.10)',   label: '#15803d' },
        llm:       { border: 'rgba(59,130,246,0.85)', bg: 'rgba(59,130,246,0.10)',  label: '#1d4ed8' },
        nomatch:   { border: 'rgba(249,115,22,0.85)', bg: 'rgba(249,115,22,0.10)',  label: '#c2410c' },
        filling:   { border: 'rgba(250,204,21,0.95)', bg: 'rgba(250,204,21,0.22)',  label: '#854d0e' },
    };

    const OVERLAY_ATTR = 'data-formfill-overlay';
    let overlays = new Map(); // element -> { box, label, status }
    let repositionHandler = null;

    function ensureRepositionHandler() {
        if (repositionHandler) return;
        repositionHandler = () => {
            for (const [el, entry] of overlays) positionBox(el, entry.box, entry.label);
        };
        window.addEventListener('scroll', repositionHandler, { passive: true, capture: true });
        window.addEventListener('resize', repositionHandler, { passive: true });
    }

    function teardownRepositionHandler() {
        if (!repositionHandler) return;
        window.removeEventListener('scroll', repositionHandler, { capture: true });
        window.removeEventListener('resize', repositionHandler);
        repositionHandler = null;
    }

    function positionBox(element, box, label) {
        const rect = element.getBoundingClientRect();
        // Skip drawing when the field isn't laid out (detached, display:none, etc.)
        if (rect.width === 0 && rect.height === 0) {
            box.style.display = 'none';
            return;
        }
        box.style.display = '';
        const scrollX = window.scrollX || document.documentElement.scrollLeft;
        const scrollY = window.scrollY || document.documentElement.scrollTop;
        box.style.left   = (rect.left   + scrollX - 2) + 'px';
        box.style.top    = (rect.top    + scrollY - 2) + 'px';
        box.style.width  = (rect.width  + 4) + 'px';
        box.style.height = (rect.height + 4) + 'px';
        if (label) {
            label.style.left = (rect.left + scrollX - 2) + 'px';
            label.style.top  = (rect.top  + scrollY - 18) + 'px';
        }
    }

    function applyColor(entry, status) {
        const c = COLORS[status] || COLORS.detected;
        entry.box.style.border = `2px solid ${c.border}`;
        entry.box.style.background = c.bg;
        if (entry.label) {
            entry.label.style.color = c.label;
            entry.label.style.background = 'rgba(255,255,255,0.92)';
            entry.label.style.borderColor = c.border;
        }
        entry.status = status;
    }

    OverlayUtils.add = function (element, status = 'detected', labelText = '') {
        if (!element || overlays.has(element)) return;
        ensureRepositionHandler();

        const box = document.createElement('div');
        box.setAttribute(OVERLAY_ATTR, '1');
        box.style.cssText = `
            position: absolute;
            pointer-events: none;
            z-index: 2147483640;
            border-radius: 3px;
            transition: border-color 0.2s, background 0.2s, transform 0.15s;
            box-sizing: border-box;
        `;

        let label = null;
        if (labelText) {
            label = document.createElement('div');
            label.setAttribute(OVERLAY_ATTR, '1');
            label.textContent = labelText;
            label.style.cssText = `
                position: absolute;
                pointer-events: none;
                z-index: 2147483641;
                font: 600 10px/14px -apple-system, 'Segoe UI', sans-serif;
                padding: 1px 5px;
                border: 1px solid transparent;
                border-radius: 3px 3px 0 0;
                white-space: nowrap;
                max-width: 240px;
                overflow: hidden;
                text-overflow: ellipsis;
            `;
        }

        const entry = { box, label, status };
        applyColor(entry, status);
        document.body.appendChild(box);
        if (label) document.body.appendChild(label);
        overlays.set(element, entry);
        positionBox(element, box, label);
    };

    OverlayUtils.setStatus = function (element, status) {
        const entry = overlays.get(element);
        if (!entry) return;
        applyColor(entry, status);
    };

    // Quick highlight pulse on the field currently being filled.
    OverlayUtils.pulseFilling = function (element, duration = 450) {
        const entry = overlays.get(element);
        if (!entry) return;
        const prev = entry.status;
        applyColor(entry, 'filling');
        entry.box.style.transform = 'scale(1.015)';
        setTimeout(() => {
            if (!overlays.has(element)) return;
            entry.box.style.transform = '';
            applyColor(entry, prev);
        }, duration);
    };

    OverlayUtils.clear = function () {
        for (const [, entry] of overlays) {
            if (entry.box && entry.box.parentNode) entry.box.parentNode.removeChild(entry.box);
            if (entry.label && entry.label.parentNode) entry.label.parentNode.removeChild(entry.label);
        }
        overlays.clear();
        teardownRepositionHandler();
    };

    // Defensive fallback: sweep the DOM for any orphaned overlay nodes.
    OverlayUtils.clearAll = function () {
        OverlayUtils.clear();
        document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach(n => n.remove());
    };

    if (typeof window !== 'undefined') window.OverlayUtils = OverlayUtils;
    else if (typeof global !== 'undefined') global.OverlayUtils = OverlayUtils;
    else if (typeof self !== 'undefined') self.OverlayUtils = OverlayUtils;

})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global :
   typeof self !== 'undefined' ? self : this);
