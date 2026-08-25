// accessibleName.js -- what a human (or a screen reader) would call a field.
//
// The old label lookup was deliberately strict and returned null for most
// real-world layouts (floating labels in sibling divs, table/grid forms, a
// label rendered after the input, placeholder-only designs). The browser
// already computes an accessible name for every control; this is a compact
// version of that algorithm (aria-labelledby > aria-label > <label> > title/
// placeholder) followed by layout heuristics that mirror how a person reads
// the page: the nearest short text to the left of or above the control, or the
// column header in a table layout.
//
// Also exposes the pieces the agent loop needs to judge a field's state:
//   describe(el)  -> hint/description text (aria-describedby, helper text)
//   errorText(el) -> visible validation text the page shows for this field
//   optionLabel(el) -> label of a single radio/checkbox
(function (global) {
    'use strict';

    const CONTROLS = 'input, select, textarea, button, [role="textbox"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable=""], [contenteditable="true"]';
    const ERROR_HINT = /(^|[\s_-])(error|invalid|danger|alert|warning|feedback|validation|err)([\s_-]|$)/i;

    function clean(t) {
        return String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    }

    function rootOf(el) {
        try { const r = el.getRootNode(); return (r && r.querySelectorAll) ? r : (el.ownerDocument || document); }
        catch (_) { return el.ownerDocument || document; }
    }

    function winOf(el) {
        return (el.ownerDocument && el.ownerDocument.defaultView) || window;
    }

    function visible(el) {
        if (!el || el.nodeType !== 1) return false;
        let r;
        try { r = el.getBoundingClientRect(); } catch (_) { return false; }
        if (r.width < 1 || r.height < 1) return false;
        let s;
        try { s = winOf(el).getComputedStyle(el); } catch (_) { return false; }
        if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        return true;
    }

    // Text of an element without the text of any form controls nested in it.
    function textWithoutControls(el, maxLen = 200) {
        if (!el) return '';
        let t = '';
        try {
            const clone = el.cloneNode(true);
            clone.querySelectorAll(CONTROLS).forEach(n => n.remove());
            clone.querySelectorAll('script, style, template, [aria-hidden="true"]').forEach(n => n.remove());
            t = clean(clone.textContent);
        } catch (_) { t = clean(el.textContent); }
        if (t.length > maxLen) t = t.slice(0, maxLen);
        return t;
    }

    function byIds(el, attr) {
        const v = el.getAttribute(attr);
        if (!v) return [];
        const root = rootOf(el);
        const doc = el.ownerDocument || document;
        const out = [];
        for (const id of v.split(/\s+/)) {
            if (!id) continue;
            let n = null;
            try { n = root.getElementById ? root.getElementById(id) : root.querySelector('#' + CSS.escape(id)); } catch (_) {}
            if (!n) { try { n = doc.getElementById(id); } catch (_) {} }
            if (n) out.push(n);
        }
        return out;
    }

    function idUniqueInRoot(el) {
        if (!el.id) return false;
        try { return rootOf(el).querySelectorAll('[id="' + CSS.escape(el.id) + '"]').length === 1; }
        catch (_) { return false; }
    }

    function labelsFor(el) {
        const out = [];
        const wrapping = el.closest ? el.closest('label') : null;
        if (wrapping) out.push(wrapping);
        if (el.id && idUniqueInRoot(el)) {
            try {
                rootOf(el).querySelectorAll('label[for="' + CSS.escape(el.id) + '"]').forEach(l => { if (!out.includes(l)) out.push(l); });
            } catch (_) {}
        }
        // Form-associated elements expose .labels (covers the same cases, but
        // also custom elements that implement ElementInternals).
        try {
            if (el.labels && el.labels.length) {
                for (const l of el.labels) if (!out.includes(l)) out.push(l);
            }
        } catch (_) {}
        return out;
    }

    // Smallest ancestor that contains this control and no other control: the
    // field's own row/group as a human sees it.
    function ownContainer(el, maxUp = 6) {
        let prev = null;
        let node = el.parentElement;
        for (let i = 0; i < maxUp && node; i++, prev = node, node = node.parentElement) {
            if (node.tagName === 'FORM' || node.tagName === 'BODY') return prev;
            let controls;
            try { controls = node.querySelectorAll(CONTROLS); } catch (_) { return prev; }
            // Controls nested inside the field itself (a combobox wrapper) don't count.
            let others = 0;
            for (const c of controls) if (c !== el && !el.contains(c) && !c.contains(el)) others++;
            // This ancestor spans other fields: the previous one was the field's own.
            if (others > 0) return prev;
        }
        return prev;
    }

    // Walk up to (but excluding) the first ancestor that spans other controls
    // and return that ancestor's child which contains el. This is the row.
    function rowContainer(el, maxUp = 6) {
        let node = el;
        for (let i = 0; i < maxUp && node.parentElement; i++) {
            const parent = node.parentElement;
            if (parent.tagName === 'FORM' || parent.tagName === 'BODY') return node;
            let others = 0;
            try {
                for (const c of parent.querySelectorAll(CONTROLS)) {
                    if (c !== el && !el.contains(c) && !c.contains(el)) { others++; break; }
                }
            } catch (_) {}
            if (others > 0) return node;
            node = parent;
        }
        return node;
    }

    // Leaf-ish text elements: visible, short text, no controls inside.
    // Cached so one snapshot builds the list once; FormKit.snapshot() clears
    // it up front, because geometry goes stale the moment the page scrolls or
    // mutates (stale rects silently mislabel every field).
    let leafCache = null;
    let leafCacheDoc = null;
    let leafCacheTime = 0;
    function clearCache() {
        leafCache = null; leafCacheDoc = null; leafCacheTime = 0;
    }
    function leafTexts(doc) {
        const now = Date.now();
        if (leafCache && leafCacheDoc === doc && now - leafCacheTime < 800) return leafCache;
        const out = [];
        const all = doc.querySelectorAll('label, span, div, p, td, th, legend, li, b, strong, em, small, dt, dd, h1, h2, h3, h4, h5, h6, a, font');
        let n = 0;
        for (const el of all) {
            if (++n > 6000) break;
            if (el.children.length > 3) continue;
            if (el.querySelector && el.querySelector(CONTROLS)) continue;
            const t = clean(el.textContent);
            if (!t || t.length > 120) continue;
            // Only leaf-ish: children (if any) must not carry most of the text.
            if (el.children.length) {
                let childText = 0;
                for (const c of el.children) childText += clean(c.textContent).length;
                if (childText === t.length && el.children.length === 1 && el.children[0].children.length === 0) {
                    // single wrapper around one leaf: keep the outer one only
                } else if (childText > 0 && el.children.length > 1) continue;
            }
            if (!visible(el)) continue;
            out.push({ el, text: t, rect: el.getBoundingClientRect() });
        }
        leafCache = out; leafCacheDoc = doc; leafCacheTime = now;
        return out;
    }

    function overlapsV(a, b) { return a.top < b.bottom && b.top < a.bottom; }
    function overlapsH(a, b) { return a.left < b.right && b.left < a.right; }

    // Nearest short text to the left of, or above, the control.
    function geometricLabel(el) {
        let r;
        try { r = el.getBoundingClientRect(); } catch (_) { return null; }
        if (r.width < 1 && r.height < 1) return null;
        const doc = el.ownerDocument || document;
        const leaves = leafTexts(doc);
        let best = null, bestScore = Infinity;
        for (const leaf of leaves) {
            if (leaf.el === el || leaf.el.contains(el) || el.contains(leaf.el)) continue;
            const lr = leaf.rect;
            if (ERROR_HINT.test(leaf.el.className || '')) continue;
            let score = Infinity;
            // Left on the same row.
            if (lr.right <= r.left + 6 && overlapsV(lr, r) && r.left - lr.right < 320) {
                score = (r.left - lr.right) + 0.2 * Math.abs((lr.top + lr.bottom) / 2 - (r.top + r.bottom) / 2);
            }
            // Directly above (label on its own line).
            else if (lr.bottom <= r.top + 6 && r.top - lr.bottom < 70 && (overlapsH(lr, r) || Math.abs(lr.left - r.left) < 40)) {
                score = 40 + (r.top - lr.bottom) + 0.3 * Math.abs(lr.left - r.left);
            }
            if (score < bestScore) { bestScore = score; best = leaf; }
        }
        return best ? best.text : null;
    }

    // Table layouts: header cell of this column, or the previous cell in the row.
    function tableLabel(el) {
        const td = el.closest ? el.closest('td, th') : null;
        if (!td) return null;
        const tr = td.parentElement;
        if (!tr) return null;
        // Previous cell with text and no control (classic "label | input" rows).
        let prev = td.previousElementSibling;
        while (prev) {
            const hasControl = prev.querySelector && prev.querySelector(CONTROLS);
            const t = textWithoutControls(prev, 120);
            if (!hasControl && t) return t;
            if (hasControl) break;
            prev = prev.previousElementSibling;
        }
        // Column header.
        const table = td.closest('table');
        if (table) {
            const idx = Array.prototype.indexOf.call(tr.children, td);
            const headRow = table.querySelector('thead tr, tr');
            if (headRow && headRow !== tr && headRow.children[idx]) {
                const t = textWithoutControls(headRow.children[idx], 120);
                if (t) return t;
            }
        }
        return null;
    }

    function humanize(s) {
        if (!s) return '';
        return String(s)
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[_\-.:]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Main entry: { name, source }. `name` may be null when nothing visible
    // identifies the field; callers should then fall back to name/id hints.
    function compute(el) {
        if (!el) return { name: null, source: 'none' };

        const lb = byIds(el, 'aria-labelledby').map(n => textWithoutControls(n, 160)).filter(Boolean);
        if (lb.length) return { name: lb.join(' '), source: 'aria-labelledby' };

        const al = clean(el.getAttribute('aria-label'));
        if (al) return { name: al, source: 'aria-label' };

        for (const l of labelsFor(el)) {
            const t = textWithoutControls(l, 160);
            if (t) return { name: t, source: 'label' };
        }

        // Custom widgets often carry the visible label on a wrapper the input
        // sits in (MUI, Ant Design): a label inside the field's own container.
        const own = ownContainer(el, 4);
        if (own) {
            let lbl = null;
            try { lbl = own.querySelector('label, legend, [class*="label" i]'); } catch (_) {}
            if (lbl && !lbl.contains(el) && !ERROR_HINT.test(lbl.className || '')) {
                const t = textWithoutControls(lbl, 160);
                if (t) return { name: t, source: 'container-label' };
            }
        }

        const tl = tableLabel(el);
        if (tl) return { name: tl, source: 'table' };

        const geo = geometricLabel(el);
        if (geo) return { name: geo, source: 'layout' };

        const ph = clean(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
        if (ph) return { name: ph, source: 'placeholder' };

        const title = clean(el.getAttribute('title'));
        if (title) return { name: title, source: 'title' };

        // Last resort: the row's own text (checkbox with trailing text, etc.).
        const row = rowContainer(el, 3);
        if (row && row !== el) {
            const t = textWithoutControls(row, 120);
            if (t && t.length <= 120) return { name: t, source: 'row-text' };
        }

        return { name: null, source: 'none' };
    }

    // Label for one radio button / checkbox (its option text).
    function optionLabel(el) {
        for (const l of labelsFor(el)) {
            const t = textWithoutControls(l, 160);
            if (t) return t;
        }
        const al = clean(el.getAttribute('aria-label'));
        if (al) return al;
        const lb = byIds(el, 'aria-labelledby').map(n => textWithoutControls(n, 160)).filter(Boolean);
        if (lb.length) return lb.join(' ');
        // Text immediately after the control (unwrapped "<input> Yes" markup).
        let sib = el.nextSibling;
        let hops = 0;
        while (sib && hops++ < 3) {
            if (sib.nodeType === 3) { const t = clean(sib.textContent); if (t) return t; }
            else if (sib.nodeType === 1) {
                if (sib.matches && sib.matches(CONTROLS)) break;
                const t = textWithoutControls(sib, 120); if (t) return t;
            }
            sib = sib.nextSibling;
        }
        const row = rowContainer(el, 2);
        if (row && row !== el) { const t = textWithoutControls(row, 120); if (t) return t; }
        return clean(el.value) || null;
    }

    // Non-error helper text: aria-describedby, and small hint text in the row.
    function describe(el) {
        const parts = [];
        for (const n of byIds(el, 'aria-describedby')) {
            if (!visible(n)) continue;
            if (ERROR_HINT.test(n.className || '') || n.getAttribute('role') === 'alert') continue;
            const t = textWithoutControls(n, 200);
            if (t) parts.push(t);
        }
        if (!parts.length) {
            const own = ownContainer(el, 3);
            if (own) {
                let hints = [];
                try { hints = own.querySelectorAll('small, [class*="hint" i], [class*="help" i], [class*="description" i], [class*="note" i]'); } catch (_) {}
                for (const h of hints) {
                    if (!visible(h) || h.contains(el)) continue;
                    if (ERROR_HINT.test(h.className || '')) continue;
                    const t = textWithoutControls(h, 200);
                    if (t) { parts.push(t); if (parts.length >= 2) break; }
                }
            }
        }
        return parts.join(' | ') || null;
    }

    function isReddish(el) {
        try {
            const c = winOf(el).getComputedStyle(el).color;
            const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m) return false;
            const r = +m[1], g = +m[2], b = +m[3];
            return r >= 150 && g <= 110 && b <= 110;
        } catch (_) { return false; }
    }

    // Visible validation text belonging to this field, or null.
    function errorText(el) {
        const seen = new Set();
        const parts = [];
        const add = (n) => {
            if (!n || seen.has(n) || !visible(n) || n.contains(el)) return;
            seen.add(n);
            const t = textWithoutControls(n, 240);
            if (t) parts.push(t);
        };

        for (const n of byIds(el, 'aria-errormessage')) add(n);
        const invalid = el.getAttribute('aria-invalid') === 'true';
        for (const n of byIds(el, 'aria-describedby')) {
            if (invalid || ERROR_HINT.test(n.className || '') || n.getAttribute('role') === 'alert' || isReddish(n)) add(n);
        }

        if (!parts.length) {
            // Error text is rendered inside the field's own row/group.
            let scope = ownContainer(el, 4);
            if (!scope) scope = rowContainer(el, 4);
            if (scope) {
                let cands = [];
                try {
                    cands = scope.querySelectorAll('[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [class*="danger" i], [class*="warning" i], [class*="feedback" i], [class*="validation" i], [id*="error" i], [id*="err-" i]');
                } catch (_) {}
                for (const c of cands) {
                    if (parts.length >= 2) break;
                    add(c);
                }
                if (!parts.length) {
                    // Red short text in the row (custom error styling without hints).
                    const doc = el.ownerDocument || document;
                    for (const leaf of leafTexts(doc)) {
                        if (!scope.contains(leaf.el) || leaf.el.contains(el)) continue;
                        if (leaf.text.length > 160 || !isReddish(leaf.el)) continue;
                        add(leaf.el);
                        if (parts.length >= 2) break;
                    }
                }
            }
        }
        const t = parts.join(' | ').trim();
        return t || null;
    }

    // Section context: fieldset legend, ARIA group name, or the nearest
    // preceding heading. Cheap and good enough for "Billing" vs "Shipping".
    function section(el, headings) {
        const fs = el.closest ? el.closest('fieldset, [role="group"], [role="radiogroup"], section, [role="region"]') : null;
        if (fs) {
            const lg = fs.querySelector ? fs.querySelector(':scope > legend, :scope > [class*="legend" i], :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6') : null;
            if (lg) { const t = textWithoutControls(lg, 100); if (t) return t; }
            const lb = byIds(fs, 'aria-labelledby').map(n => textWithoutControls(n, 100)).filter(Boolean);
            if (lb.length) return lb.join(' ');
            const al = clean(fs.getAttribute('aria-label'));
            if (al) return al;
        }
        if (headings && headings.length) {
            // Nearest heading that precedes the field in document order.
            let best = null;
            for (const h of headings) {
                const pos = h.el.compareDocumentPosition(el);
                if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h; else break;
            }
            if (best) return best.text;
        }
        return null;
    }

    function collectHeadings(doc) {
        const out = [];
        try {
            for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, [role="heading"]')) {
                if (!visible(h)) continue;
                const t = textWithoutControls(h, 100);
                if (t) out.push({ el: h, text: t });
                if (out.length > 300) break;
            }
        } catch (_) {}
        return out;
    }

    const AccName = { compute, optionLabel, describe, errorText, section, collectHeadings, humanize, textWithoutControls, visible, clean, rootOf, ownContainer, rowContainer, clearCache, CONTROLS };

    if (typeof window !== 'undefined') window.AccName = AccName;
    else if (typeof global !== 'undefined') global.AccName = AccName;
    else if (typeof self !== 'undefined') self.AccName = AccName;

})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global :
   typeof self !== 'undefined' ? self : this);
