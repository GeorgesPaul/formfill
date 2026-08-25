// formKit.js -- the form primitive layer.
//
// Everything the agent loop (fillAgent.js) needs to see and touch a form goes
// through here, and every function returns structured data instead of side
// effects the caller has to go and inspect:
//
//   snapshot()            -> { url, title, fields:[...], buttons:[...] }
//                            every visible control with a stable ref ("f12"),
//                            its accessible name, options, current value,
//                            validation state, geometry; radio groups are
//                            collapsed into one "radio-group" field.
//   execute(actions)      -> per-action results: what the field holds now,
//                            whether the page flagged it invalid and what it
//                            said, which suggestion an autocomplete widget
//                            offered/picked.
//   diff(before, after)   -> added / removed / changed fields between two
//                            snapshots (what "appeared on the page").
//   capturePageHtml()     -> sanitized HTML of the form(s), for the fill logs.
//
// Refs are written on the elements as data-ff-ref so they stay stable across
// re-snapshots and DOM re-renders that keep the node.
(function (global) {
    'use strict';

    const FIELD_SELECTOR = [
        'input', 'select', 'textarea',
        '[contenteditable=""]', '[contenteditable="true"]',
        '[role="textbox"]', '[role="combobox"]', '[role="listbox"]',
        '[role="checkbox"]', '[role="switch"]', '[role="radio"]',
        '[role="spinbutton"]', '[role="slider"]'
    ].join(',');
    const BUTTON_SELECTOR = 'button, input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], [role="button"], summary, a[href]';
    const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
    const OURS = '[data-formfill-overlay], #keepass-picker-icon, #keepass-picker-dropdown';

    const SUBMIT_RE = /\b(submit|send|pay|order|buy|purchase|register|sign ?up|create (my )?account|confirm|book|checkout|place order|apply|save|finish|complete|done|agree and|verstuur|verzend|bestel|betaal|opslaan|bevestig|afronden|abschicken|absenden|senden|bestellen|zahlen|speichern|envoyer|payer|commander|enregistrer|valider)\b/i;
    const NEXT_RE = /\b(next|continue|proceed|go on|verder|volgende|doorgaan|weiter|fortfahren|suivant|continuer|siguiente)\b/i;
    const REVEAL_RE = /\b(add|show|more|edit|change|expand|different|another|other|manual|enter (it )?manually|toevoegen|wijzig|meer|anders|handmatig|hinzuf|ändern|mehr|ajouter|modifier|plus)\b/i;

    let refSeq = 0;
    let lastSnapshot = null;
    let refIndex = new Map();   // ref -> { el, field, members? }

    const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const wait = ms => new Promise(r => setTimeout(r, ms));

    function winOf(el) { return (el.ownerDocument && el.ownerDocument.defaultView) || window; }

    // ------------------------------------------------------------ discovery

    function collectControls(root, out, seen, depth) {
        if (!root || depth > 12) return;
        let nodes = [];
        try { nodes = root.querySelectorAll(FIELD_SELECTOR); } catch (_) { return; }
        for (const n of nodes) {
            if (seen.has(n)) continue;
            seen.add(n);
            out.push(n);
        }
        // Open shadow roots.
        let hosts = [];
        try { hosts = root.querySelectorAll('*'); } catch (_) {}
        let count = 0;
        for (const h of hosts) {
            if (++count > 20000) break;
            if (h.shadowRoot) collectControls(h.shadowRoot, out, seen, depth + 1);
        }
    }

    function collectButtons(root, out, seen, depth) {
        if (!root || depth > 12) return;
        let nodes = [];
        try { nodes = root.querySelectorAll(BUTTON_SELECTOR); } catch (_) { return; }
        for (const n of nodes) {
            if (seen.has(n)) continue;
            seen.add(n);
            out.push(n);
        }
        let hosts = [];
        try { hosts = root.querySelectorAll('*'); } catch (_) {}
        let count = 0;
        for (const h of hosts) {
            if (++count > 20000) break;
            if (h.shadowRoot) collectButtons(h.shadowRoot, out, seen, depth + 1);
        }
    }

    function labelElementsFor(el) {
        const out = [];
        try { if (el.labels) for (const l of el.labels) out.push(l); } catch (_) {}
        const wrapping = el.closest && el.closest('label');
        if (wrapping && !out.includes(wrapping)) out.push(wrapping);
        return out;
    }

    // Visibility with the custom-checkbox exception: an input hidden behind a
    // styled label (opacity 0, 1px, off-screen) is still operable through its
    // label, so it counts as visible with the label's box.
    function visibility(el) {
        const win = winOf(el);
        let rect, style;
        try { rect = el.getBoundingClientRect(); style = win.getComputedStyle(el); } catch (_) { return { visible: false }; }
        const type = (el.getAttribute('type') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const togglish = type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch';

        const hiddenStyle = style.display === 'none' || style.visibility === 'hidden';
        const tiny = rect.width < 2 || rect.height < 2;
        // Off-screen means outside the PAGE (the left:-9999px accessibility-
        // hiding pattern), not merely scrolled out of the viewport: rects are
        // viewport-relative, so add the scroll offset before judging.
        const pageRight = rect.right + win.scrollX;
        const pageBottom = rect.bottom + win.scrollY;
        const pageLeft = rect.left + win.scrollX;
        const offscreen = pageRight <= 0 || pageBottom <= 0 ||
                          pageLeft > Math.max(win.innerWidth, (el.ownerDocument.documentElement || {}).scrollWidth || 0) + 50;

        if (!hiddenStyle && !tiny && !offscreen) return { visible: true, rect };

        if (togglish) {
            for (const l of labelElementsFor(el)) {
                let lr, ls;
                try { lr = l.getBoundingClientRect(); ls = win.getComputedStyle(l); } catch (_) { continue; }
                if (ls.display !== 'none' && ls.visibility !== 'hidden' && lr.width >= 2 && lr.height >= 2) {
                    return { visible: true, rect: lr, viaLabel: true };
                }
            }
            // Custom checkbox with a sibling visual proxy (span.checkmark).
            const p = el.parentElement;
            if (p) {
                let pr, ps;
                try { pr = p.getBoundingClientRect(); ps = win.getComputedStyle(p); } catch (_) { pr = null; }
                if (pr && ps.display !== 'none' && ps.visibility !== 'hidden' && pr.width >= 2 && pr.height >= 2 && pr.width < 600 && pr.height < 200) {
                    return { visible: true, rect: pr, viaLabel: true };
                }
            }
        }
        return { visible: false, rect };
    }

    function inViewport(rect, win) {
        return rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
    }

    function box(rect) {
        return { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    }

    function nextRef(prefix) {
        refSeq++;
        return prefix + refSeq;
    }

    function ensureRef(el, prefix) {
        let r = el.getAttribute('data-ff-ref');
        if (!r || r[0] !== prefix) {
            r = nextRef(prefix);
            try { el.setAttribute('data-ff-ref', r); } catch (_) {}
        }
        return r;
    }

    function kindOf(el) {
        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (tag === 'select') return el.multiple ? 'multiselect' : 'select';
        if (tag === 'textarea') return 'textarea';
        if (tag === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox') return 'checkbox';
            if (t === 'radio') return 'radio';
            if (t === 'password') return 'password';
            if (t === 'file') return 'file';
            if (t === 'range') return 'range';
            if (t === 'color') return 'color';
            if (['date', 'datetime-local', 'month', 'week', 'time'].includes(t)) return t;
            if (['email', 'tel', 'url', 'number', 'search'].includes(t)) return t;
            if (role === 'combobox' || typeof isCustomCombobox === 'function' && isCustomCombobox(el)) return 'combobox';
            return 'text';
        }
        if (role === 'combobox') return 'combobox';
        if (role === 'listbox') return 'listbox';
        if (role === 'checkbox') return 'checkbox';
        if (role === 'switch') return 'switch';
        if (role === 'radio') return 'radio';
        if (role === 'spinbutton') return 'number';
        if (role === 'slider') return 'range';
        if (el.isContentEditable || role === 'textbox') return 'contenteditable';
        return 'text';
    }

    function readValue(el, kind) {
        try {
            if (kind === 'checkbox' || kind === 'switch' || kind === 'radio') return isCheckedControl(el);
            if (kind === 'select') {
                const o = el.options[el.selectedIndex];
                return o ? clean(o.text) : '';
            }
            if (kind === 'multiselect') {
                return Array.from(el.selectedOptions).map(o => clean(o.text));
            }
            if (kind === 'listbox') {
                const sel = el.querySelector('[role="option"][aria-selected="true"]');
                return sel ? clean(sel.textContent) : '';
            }
            if (kind === 'contenteditable') return clean(el.textContent).slice(0, 300);
            if (kind === 'password') return el.value ? '[password]' : '';
            if (typeof el.value === 'string') {
                if (el.value) return el.value.slice(0, 300);
                // Custom comboboxes show the chosen value as text, not .value.
                if (kind === 'combobox') {
                    const t = clean(el.textContent);
                    if (t && t.length <= 120) return t;
                }
                return '';
            }
            const t = clean(el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || el.textContent);
            return t.slice(0, 300);
        } catch (_) { return ''; }
    }

    function optionsOf(el, kind) {
        if (kind === 'select' || kind === 'multiselect') {
            const out = [];
            for (const o of el.options) {
                const text = clean(o.text);
                out.push(o.value !== text ? { text, value: o.value } : { text });
                if (out.length >= 300) break;
            }
            return out;
        }
        if (kind === 'listbox') {
            return Array.from(el.querySelectorAll('[role="option"]')).slice(0, 300).map(o => ({ text: clean(o.textContent) }));
        }
        return null;
    }

    function radioGroupKey(el) {
        const name = el.getAttribute('name');
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (el.tagName === 'INPUT' && name) {
            const form = el.form;
            const formKey = form ? (form.getAttribute('id') || form.getAttribute('name') || 'form@' + Array.prototype.indexOf.call(el.ownerDocument.forms, form)) : 'noform';
            return 'radio|' + formKey + '|' + name;
        }
        if (role === 'radio') {
            const grp = el.closest('[role="radiogroup"], fieldset');
            if (grp) return 'arole|' + ensureRef(grp, 'x');
        }
        return null;
    }

    function fieldInfoFor(el, headings) {
        const kind = kindOf(el);
        const acc = (typeof AccName !== 'undefined') ? AccName.compute(el) : { name: null, source: 'none' };
        const validation = (typeof readValidation === 'function') ? readValidation(el) : { invalid: false, message: '' };
        const f = {
            ref: null,
            kind,
            tag: el.tagName.toLowerCase(),
            type: (el.getAttribute('type') || '').toLowerCase() || undefined,
            name: el.getAttribute('name') || undefined,
            id: el.id || undefined,
            label: acc.name || undefined,
            labelSource: acc.source,
            description: (typeof AccName !== 'undefined') ? (AccName.describe(el) || undefined) : undefined,
            placeholder: clean(el.getAttribute('placeholder')) || undefined,
            autocomplete: el.getAttribute('autocomplete') || undefined,
            required: (el.required || el.getAttribute('aria-required') === 'true') || undefined,
            disabled: (el.disabled || el.getAttribute('aria-disabled') === 'true') || undefined,
            readonly: (el.readOnly || el.hasAttribute('readonly')) || undefined,
            maxlength: (typeof el.maxLength === 'number' && el.maxLength > 0) ? el.maxLength : undefined,
            pattern: el.getAttribute('pattern') || undefined,
            min: el.getAttribute('min') || undefined,
            max: el.getAttribute('max') || undefined,
            inputmode: el.getAttribute('inputmode') || undefined,
            value: readValue(el, kind),
            options: optionsOf(el, kind) || undefined,
            section: (typeof AccName !== 'undefined') ? (AccName.section(el, headings) || undefined) : undefined,
            invalid: validation.invalid || undefined,
            error: validation.message || undefined,
            filledByUs: el.hasAttribute('data-filled-by-extension') || undefined,
            acceptedFor: el.getAttribute('data-ff-accepted-for') || undefined,
        };
        if (kind === 'text' && (el.getAttribute('role') || '').toLowerCase() === 'combobox') f.kind = 'combobox';
        if (f.kind === 'text' || f.kind === 'combobox') {
            const aac = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
            if (aac === 'list' || aac === 'both' || (typeof AutocompleteFiller !== 'undefined' && AutocompleteFiller.looksLikeTypeahead(el))) {
                f.typeahead = true;
            }
        }
        return f;
    }

    function buttonInfoFor(el) {
        const tag = el.tagName.toLowerCase();
        let text = '';
        if (tag === 'input') text = clean(el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt'));
        else text = clean(el.getAttribute('aria-label')) || (typeof AccName !== 'undefined' ? AccName.textWithoutControls(el, 80) : clean(el.textContent)) || clean(el.getAttribute('title'));
        if (!text) return null;
        const type = tag === 'input' ? (el.getAttribute('type') || '').toLowerCase() : (el.getAttribute('type') || '').toLowerCase();
        let kind = 'other';
        if (type === 'submit' || SUBMIT_RE.test(text)) kind = 'submit';
        if (NEXT_RE.test(text)) kind = 'next';
        else if (kind !== 'submit' && REVEAL_RE.test(text)) kind = 'reveal';
        if (tag === 'a' && kind === 'other' && (el.getAttribute('role') || '') !== 'button') return null;
        return {
            ref: null,
            text: text.slice(0, 80),
            kind,
            tag,
            disabled: (el.disabled || el.getAttribute('aria-disabled') === 'true') || undefined,
        };
    }

    // The snapshot. Cheap enough to call after every batch of actions.
    function snapshot(opts = {}) {
        const doc = document;
        const win = window;
        // Fresh geometry for this snapshot; stale cached rects mislabel fields.
        if (typeof AccName !== 'undefined' && AccName.clearCache) AccName.clearCache();
        const headings = (typeof AccName !== 'undefined') ? AccName.collectHeadings(doc) : [];
        const controls = [];
        collectControls(doc, controls, new Set(), 0);

        const fields = [];
        const groups = new Map();   // groupKey -> group field
        const index = new Map();

        for (const el of controls) {
            if (el.closest && el.closest(OURS)) continue;
            if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase())) continue;
            // Nested controls of a composite widget (a combobox wrapper with
            // an inner input): keep the inner input, drop the wrapper only when
            // the wrapper is not itself the interactive element.
            if (el.hasAttribute('inert')) continue;
            const vis = visibility(el);
            if (!vis.visible) continue;

            const kind = kindOf(el);
            if (kind === 'radio') {
                const key = radioGroupKey(el);
                if (key) {
                    let g = groups.get(key);
                    const optLabel = (typeof AccName !== 'undefined') ? AccName.optionLabel(el) : clean(el.value);
                    const memberRef = ensureRef(el, 'f');
                    if (!g) {
                        g = {
                            ref: null, kind: 'radio-group', tag: 'radio-group',
                            name: el.getAttribute('name') || undefined,
                            label: undefined, section: undefined, required: undefined,
                            options: [], value: '', members: [], box: box(vis.rect), inViewport: inViewport(vis.rect, win),
                            _first: el,
                        };
                        groups.set(key, g);
                        fields.push(g);
                    }
                    g.options.push({ text: optLabel || clean(el.value), value: el.value !== optLabel ? el.value : undefined, checked: el.checked || undefined, ref: memberRef });
                    g.members.push({ el, ref: memberRef, text: optLabel || clean(el.value), value: el.value });
                    if (el.checked) g.value = optLabel || el.value;
                    if (el.required || el.getAttribute('aria-required') === 'true') g.required = true;
                    const v = (typeof readValidation === 'function') ? readValidation(el) : null;
                    if (v && v.invalid) { g.invalid = true; if (v.message) g.error = v.message; }
                    continue;
                }
            }

            const f = fieldInfoFor(el, headings);
            f.ref = ensureRef(el, 'f');
            f.box = box(vis.rect);
            f.inViewport = inViewport(vis.rect, win);
            if (vis.viaLabel) f.viaLabel = true;
            fields.push(f);
            index.set(f.ref, { el, field: f });
        }

        // Finish radio groups: group label/section from the first member's
        // surroundings, ref from the first member.
        for (const g of groups.values()) {
            const first = g._first;
            g.ref = 'g' + g.members[0].ref.slice(1);
            let lbl = null;
            try {
                const memberEls = new Set(g.members.map(m => m.el));
                const grp = first.closest('fieldset, [role="radiogroup"], [role="group"]');
                // A fieldset/group counts as the group's own only when every
                // control inside it is one of the group's radios; otherwise it
                // is the whole form section and its legend is not this label.
                let dedicated = false;
                if (grp) {
                    dedicated = true;
                    for (const c of grp.querySelectorAll(FIELD_SELECTOR)) {
                        if (!memberEls.has(c)) { dedicated = false; break; }
                    }
                }
                if (grp && dedicated && typeof AccName !== 'undefined') {
                    const lg = grp.querySelector(':scope > legend');
                    if (lg) lbl = AccName.textWithoutControls(lg, 120);
                    if (!lbl) {
                        const lb = grp.getAttribute('aria-labelledby');
                        if (lb) { const n = first.ownerDocument.getElementById(lb.split(/\s+/)[0]); if (n) lbl = AccName.textWithoutControls(n, 120); }
                    }
                    if (!lbl) lbl = clean(grp.getAttribute('aria-label')) || null;
                }
                if (!lbl && typeof AccName !== 'undefined') {
                    const memberLabels = new Set(g.members.map(m => m.text));
                    // The row containing the first radio; its parent holds the group.
                    const container = AccName.rowContainer(first, 6);
                    const parent = container && container.parentElement;
                    if (parent) {
                        // 1. Text inside the group's own block that precedes the radios.
                        let precedingText = null;
                        for (const c of parent.children) {
                            if (c === container || c.contains(first)) break;
                            if (c.querySelector && c.querySelector(FIELD_SELECTOR)) { precedingText = null; continue; }
                            const t = AccName.textWithoutControls(c, 120);
                            if (t && !memberLabels.has(t)) precedingText = t;
                        }
                        if (precedingText) lbl = precedingText;
                        // 2. A short, control-free element just before the block.
                        if (!lbl) {
                            let prev = parent.previousElementSibling;
                            for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling) {
                                if (prev.querySelector && prev.querySelector(FIELD_SELECTOR)) break;
                                const t = AccName.textWithoutControls(prev, 120);
                                if (t && !memberLabels.has(t)) { lbl = t; break; }
                            }
                        }
                    }
                    // 3. Whatever the accessible-name heuristics find for the
                    //    first radio, as long as it is not that radio's own label.
                    if (!lbl) {
                        const leafish = AccName.compute(first);
                        if (leafish.name && !memberLabels.has(leafish.name) && leafish.source !== 'label') lbl = leafish.name;
                    }
                }
                g.section = (typeof AccName !== 'undefined') ? (AccName.section(first, headings) || undefined) : undefined;
            } catch (_) {}
            g.label = lbl || undefined;
            g.filledByUs = g.members.some(m => m.el.hasAttribute('data-filled-by-extension')) || undefined;
            index.set(g.ref, { el: first, field: g, members: g.members });
            delete g._first;
        }

        // Buttons.
        const buttons = [];
        if (opts.buttons !== false) {
            const bEls = [];
            collectButtons(doc, bEls, new Set(), 0);
            for (const el of bEls) {
                if (el.closest && el.closest(OURS)) continue;
                const vis = visibility(el);
                if (!vis.visible) continue;
                const b = buttonInfoFor(el);
                if (!b) continue;
                b.ref = ensureRef(el, 'b');
                b.box = box(vis.rect);
                b.inViewport = inViewport(vis.rect, win);
                buttons.push(b);
                index.set(b.ref, { el, button: b });
            }
            // Keep the list short: prefer next/reveal/submit, then the rest in
            // document order.
            const prio = { next: 0, reveal: 1, submit: 2, other: 3 };
            buttons.sort((a, b) => prio[a.kind] - prio[b.kind]);
            if (buttons.length > 30) buttons.length = 30;
        }

        // Strip members (elements) from the field objects handed out.
        const cleanFields = fields.map(f => {
            const { members, ...rest } = f;
            return rest;
        });

        lastSnapshot = {
            url: location.href,
            title: document.title,
            frame: window === window.top ? 'top' : 'iframe',
            viewport: { w: win.innerWidth, h: win.innerHeight, scrollX: Math.round(win.scrollX), scrollY: Math.round(win.scrollY), pageH: Math.round((doc.documentElement || {}).scrollHeight || 0) },
            takenAt: Date.now(),
            fields: cleanFields,
            buttons,
        };
        refIndex = index;
        return lastSnapshot;
    }

    function resolveRef(ref) {
        return refIndex.get(ref) || null;
    }

    function fieldByRef(ref) {
        const r = refIndex.get(ref);
        return r ? (r.field || r.button) : null;
    }

    // Compact per-field view for prompts: drop geometry and internals, keep
    // what a person would use to decide.
    function describeField(f) {
        const o = { ref: f.ref, kind: f.kind };
        if (f.label) o.label = f.label;
        if (f.section) o.section = f.section;
        if (f.placeholder) o.placeholder = f.placeholder;
        if (f.description) o.description = f.description;
        if (f.name) o.name = f.name;
        if (f.id) o.id = f.id;
        if (f.autocomplete) o.autocomplete = f.autocomplete;
        if (f.required) o.required = true;
        if (f.disabled) o.disabled = true;
        if (f.readonly) o.readonly = true;
        if (f.maxlength) o.maxlength = f.maxlength;
        if (f.pattern) o.pattern = f.pattern;
        if (f.min) o.min = f.min;
        if (f.max) o.max = f.max;
        if (f.typeahead) o.typeahead = true;
        if (f.value !== '' && f.value !== undefined && f.value !== null && f.value !== false) o.value = f.value;
        if (f.options) {
            const opts = f.options.map(op => op.text + (op.checked ? ' (selected)' : ''));
            if (opts.length > 60) { o.options = opts.slice(0, 60); o.optionsTotal = opts.length; }
            else o.options = opts;
        }
        if (f.invalid) { o.invalid = true; if (f.error) o.error = f.error; }
        if (f.suggested) o.suggested = f.suggested;
        if (!f.inViewport) o.offscreen = true;
        return o;
    }

    function describeButton(b) {
        const o = { ref: b.ref, text: b.text, kind: b.kind };
        if (b.disabled) o.disabled = true;
        return o;
    }

    // ------------------------------------------------------------ execution

    function normalizeOp(op, field) {
        const o = String(op || 'fill').toLowerCase();
        if (!field) return o;
        const k = field.kind;
        if (o === 'fill' || o === 'type' || o === 'enter') {
            if (k === 'checkbox' || k === 'switch') return 'set';
            if (k === 'radio-group' || k === 'select' || k === 'multiselect' || k === 'listbox') return 'choose';
            return 'fill';
        }
        if (o === 'select' || o === 'pick' || o === 'choose') return 'choose';
        if (o === 'check' || o === 'uncheck' || o === 'toggle' || o === 'set') return 'set';
        if (o === 'click' || o === 'press') return 'click';
        if (o === 'clear' || o === 'empty') return 'clear';
        return o;
    }

    function matchGroupOption(members, value) {
        const want = clean(value).toLowerCase();
        if (!want) return null;
        const byText = m => clean(m.text).toLowerCase();
        const byVal = m => clean(m.value).toLowerCase();
        let m = members.find(x => byText(x) === want) || members.find(x => byVal(x) === want);
        if (m) return m;
        if (want.length >= 2) {
            m = members.find(x => byText(x).startsWith(want)) || members.find(x => want.startsWith(byText(x)) && byText(x).length >= 2);
            if (m) return m;
            m = members.find(x => byText(x).includes(want) || byVal(x).includes(want));
            if (m) return m;
        }
        const b = parseBoolean(value);
        if (b !== null) {
            const yes = /^(yes|ja|oui|si|true|y|agree|accept)\b/i, no = /^(no|nee|non|false|n|decline|disagree)\b/i;
            m = members.find(x => (b ? yes : no).test(x.text));
            if (m) return m;
        }
        if (typeof AutocompleteFiller !== 'undefined') {
            let best = null, bs = 0;
            for (const x of members) { const s = AutocompleteFiller.score(x.text, want); if (s > bs) { bs = s; best = x; } }
            if (best && bs >= 0.6) return best;
        }
        return null;
    }

    async function chooseListboxOption(el, value) {
        const opts = Array.from(el.querySelectorAll('[role="option"]'));
        const entries = opts.map(o => ({ text: clean(o.textContent), value: o.getAttribute('data-value') || o.getAttribute('value') || clean(o.textContent), el: o }));
        const m = findMatchingOption(entries, value);
        if (!m) return false;
        AutocompleteFiller.mouseSequence(m.el);
        await wait(60);
        return m.el.getAttribute('aria-selected') === 'true' || true;
    }

    async function chooseMulti(el, value) {
        const wanted = Array.isArray(value) ? value : String(value).split(/[;,|]/).map(s => s.trim()).filter(Boolean);
        const entries = Array.from(el.options).map(o => ({ text: o.text, value: o.value, el: o }));
        let any = false;
        for (const w of wanted) {
            const m = findMatchingOption(entries, w);
            if (m) { m.el.selected = true; any = true; }
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return any;
    }

    async function clearControl(el, kind) {
        if (kind === 'checkbox' || kind === 'switch') return setCheckbox(el, false);
        if (kind === 'select') {
            const empty = Array.from(el.options).find(o => o.value === '' || /^(select|choose|kies|wählen|choisir|--)/i.test(clean(o.text)));
            if (empty) { el.value = empty.value; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
            el.selectedIndex = -1; el.dispatchEvent(new Event('change', { bubbles: true })); return true;
        }
        simulateRealisticFocus(el);
        await wait(30);
        const ok = await TypingEngine.clearField(el);
        TypingEngine.commitField(el);
        el.removeAttribute('data-ff-accepted-for');
        return ok;
    }

    // Execute a batch of {ref, op, value} actions. Returns one result per
    // action with the field's state afterwards.
    async function execute(actions, opts = {}) {
        const results = [];
        const isCancelled = opts.isCancelled || (() => !!window.stopFilling);
        for (let i = 0; i < (actions || []).length; i++) {
            const a = actions[i] || {};
            if (isCancelled()) throw new Error('Form filling stopped by user.');
            const target = resolveRef(a.ref);
            const field = target && (target.field || target.button);
            const op = normalizeOp(a.op, target && target.field);
            const res = { ref: a.ref, op, value: a.value, ok: false };
            if (!target) {
                res.error = 'unknown ref';
                results.push(res);
                continue;
            }
            const el = target.el;
            if (!el || !el.isConnected) {
                res.error = 'element no longer in the page';
                results.push(res);
                continue;
            }
            if (opts.onBefore) { try { opts.onBefore(a, target); } catch (_) {} }
            const t0 = Date.now();
            try {
                if (target.button) {
                    if (op !== 'click') { res.error = 'buttons only accept op "click"'; results.push(res); continue; }
                    simulateRealisticFocus(el);
                    res.ok = true;
                    res.strategy = 'click';
                    await waitForDomSettle(300, 2500);
                } else if (op === 'click') {
                    simulateRealisticFocus(el);
                    res.ok = true;
                    res.strategy = 'click';
                    await waitForDomSettle(250, 2000);
                } else if (op === 'clear') {
                    res.ok = await clearControl(el, field.kind);
                    res.strategy = 'clear';
                } else if (field.kind === 'radio-group') {
                    const m = matchGroupOption(target.members, a.value);
                    if (!m) {
                        res.error = `No option matches "${a.value}". Options: ${target.members.map(x => x.text).join(' / ')}`;
                    } else {
                        res.ok = await selectRadio(m.el);
                        res.strategy = 'radio';
                        res.selected = m.text;
                        for (const mm of target.members) mm.el.setAttribute('data-filled-by-extension', 'true');
                    }
                } else if (field.kind === 'multiselect') {
                    res.ok = await chooseMulti(el, a.value);
                    res.strategy = 'multiselect';
                } else if (field.kind === 'listbox') {
                    res.ok = await chooseListboxOption(el, a.value);
                    res.strategy = 'listbox';
                } else if (field.kind === 'file') {
                    res.error = 'file inputs cannot be filled';
                } else if (field.kind === 'password') {
                    res.error = 'password fields are never filled by this tool';
                } else if (op === 'set') {
                    const b = parseBoolean(a.value);
                    if (b === null) res.error = `Not a boolean: ${a.value}`;
                    else { res.ok = await setCheckbox(el, b); res.strategy = 'checkbox'; }
                } else {
                    // fill / choose on text, select, combobox, date, etc.
                    const info = { label: field.label, placeholder: field.placeholder };
                    const r = await fillField(el, a.value, info, opts.attempt || 1);
                    res.ok = !!r.ok;
                    res.strategy = r.strategy;
                    if (r.handled) { res.autocomplete = { handled: true, selected: r.selected, reason: r.reason, optionsSeen: r.optionsSeen }; }
                    else if (r.reason && r.reason !== 'no-dom-change') { res.autocomplete = { handled: false, reason: r.reason, optionsSeen: r.optionsSeen }; }
                    if (r.error) res.error = r.error;
                }
            } catch (e) {
                if (e && e.message === 'Form filling stopped by user.') throw e;
                res.error = (e && e.message) || String(e);
            }
            res.ms = Date.now() - t0;
            // Read back.
            try {
                await wait(80);
                const k = field.kind;
                if (k === 'radio-group') {
                    const checked = target.members.find(m => m.el.checked);
                    res.finalValue = checked ? checked.text : '';
                } else {
                    res.finalValue = readValue(el, k);
                }
                if (!target.button && op !== 'click' && op !== 'clear') {
                    if (k === 'checkbox' || k === 'switch') {
                        res.accepted = (parseBoolean(a.value) === res.finalValue);
                    } else if (k === 'radio-group') {
                        res.accepted = !!res.ok && res.finalValue === res.selected;
                    } else {
                        res.accepted = elementHasCorrectValue(el, a.value);
                    }
                    if (!res.accepted && res.ok && res.autocomplete && res.autocomplete.handled) res.accepted = true;
                }
                const v = (typeof readValidation === 'function') ? readValidation(el) : null;
                if (v && (v.invalid || v.suspect)) res.validation = { invalid: !!v.invalid, message: v.message || undefined, suspect: v.suspect || undefined };
            } catch (_) {}
            if (opts.onAfter) { try { opts.onAfter(a, target, res); } catch (_) {} }
            results.push(res);
        }
        return results;
    }

    // ------------------------------------------------------------ diffing

    function valueKey(f) {
        const v = f.value;
        return Array.isArray(v) ? v.join('|') : String(v == null ? '' : v);
    }

    function diff(before, after) {
        const b = new Map((before && before.fields || []).map(f => [f.ref, f]));
        const a = new Map((after && after.fields || []).map(f => [f.ref, f]));
        const added = [], removed = [], changed = [];
        for (const [ref, f] of a) {
            const old = b.get(ref);
            if (!old) { added.push(f); continue; }
            const c = {};
            if (valueKey(old) !== valueKey(f)) { c.from = old.value; c.to = f.value; }
            if (!!old.invalid !== !!f.invalid || (old.error || '') !== (f.error || '')) { c.invalid = !!f.invalid; c.error = f.error; }
            if ((old.disabled || false) !== (f.disabled || false)) c.disabled = !!f.disabled;
            if (Object.keys(c).length) changed.push({ ref, label: f.label, ...c });
        }
        for (const [ref, f] of b) if (!a.has(ref)) removed.push({ ref, label: f.label, kind: f.kind });
        const bb = new Set((before && before.buttons || []).map(x => x.ref));
        const newButtons = (after && after.buttons || []).filter(x => !bb.has(x.ref));
        return { added, removed, changed, newButtons };
    }

    // ------------------------------------------------------------ capture

    // Sanitized HTML of the form(s) the fields live in, capped in size.
    function capturePageHtml(maxBytes = 300 * 1024) {
        const snap = lastSnapshot || snapshot({ buttons: false });
        const roots = new Set();
        for (const f of snap.fields) {
            const r = resolveRef(f.ref);
            if (!r || !r.el) continue;
            const form = r.el.closest ? r.el.closest('form') : null;
            roots.add(form || r.el);
        }
        // Non-form fields: use their common ancestor (bounded by body).
        const loose = Array.from(roots).filter(n => n.tagName !== 'FORM');
        const forms = Array.from(roots).filter(n => n.tagName === 'FORM');
        let containers = forms;
        if (loose.length) {
            let common = loose[0];
            for (const n of loose) {
                while (common && !common.contains(n)) common = common.parentElement;
            }
            if (common) containers = containers.concat([common]);
        }
        if (!containers.length) containers = [document.body];

        const parts = [];
        let total = 0;
        for (const c of containers) {
            let html = sanitizeHtml(c);
            if (total + html.length > maxBytes) html = html.slice(0, Math.max(0, maxBytes - total)) + '<!-- truncated -->';
            parts.push(html);
            total += html.length;
            if (total >= maxBytes) break;
        }
        return parts.join('\n<!-- ---- next container ---- -->\n');
    }

    function sanitizeHtml(node) {
        let clone;
        try { clone = node.cloneNode(true); } catch (_) { return ''; }
        try {
            clone.querySelectorAll('script, style, noscript, template, svg, canvas, video, audio, picture, iframe, link, meta, [data-formfill-overlay]').forEach(n => n.remove());
            const all = clone.querySelectorAll('*');
            for (const el of all) {
                for (const attr of Array.from(el.attributes)) {
                    const n = attr.name.toLowerCase();
                    if (n.startsWith('on') || n === 'srcdoc' || n === 'srcset') { el.removeAttribute(attr.name); continue; }
                    if (attr.value.length > 400) el.setAttribute(attr.name, attr.value.slice(0, 400) + '…');
                    if (n === 'src' && attr.value.startsWith('data:')) el.setAttribute(attr.name, 'data:…');
                }
                if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password') el.removeAttribute('value');
            }
        } catch (_) {}
        return clone.outerHTML || '';
    }

    // Values only: what the form holds right now, keyed by ref, for submit
    // capture. Includes the browser's own view of the submission (FormData).
    function valuesSnapshot() {
        const snap = snapshot({ buttons: false });
        return snap.fields.map(f => ({ ref: f.ref, label: f.label, kind: f.kind, name: f.name, value: f.value, invalid: f.invalid, error: f.error, filledByUs: f.filledByUs }));
    }

    function formDataOf(form) {
        const out = [];
        try {
            const fd = new FormData(form);
            for (const [k, v] of fd.entries()) {
                if (out.length >= 300) break;
                let val = typeof v === 'string' ? v : `[file ${v.name || ''} ${v.size || 0}B]`;
                if (/pass(word)?|pwd|secret|cvv|cvc|csc/i.test(k)) val = '[redacted]';
                if (val.length > 500) val = val.slice(0, 500) + '…';
                out.push([k, val]);
            }
        } catch (_) {}
        return out;
    }

    async function captureScreenshot() {
        try {
            const res = await browser.runtime.sendMessage({ action: 'captureScreenshot' });
            if (typeof res === 'string') return res;
            if (res && res.dataUrl) return res.dataUrl;
        } catch (e) {
            console.warn('[FormKit] screenshot failed:', e && e.message);
        }
        return null;
    }

    // Re-encode a data URL as a smaller JPEG (for logs / prompts).
    function shrinkImage(dataUrl, maxW = 1280, quality = 0.6) {
        return new Promise(resolve => {
            if (!dataUrl) return resolve(null);
            const img = new Image();
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxW / img.width);
                    const c = document.createElement('canvas');
                    c.width = Math.round(img.width * scale);
                    c.height = Math.round(img.height * scale);
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    resolve(c.toDataURL('image/jpeg', quality));
                } catch (_) { resolve(dataUrl); }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    const FormKit = {
        snapshot, execute, diff, describeField, describeButton, resolveRef, fieldByRef,
        capturePageHtml, valuesSnapshot, formDataOf, captureScreenshot, shrinkImage,
        get lastSnapshot() { return lastSnapshot; },
        normalizeOp, matchGroupOption,
    };

    if (typeof window !== 'undefined') window.FormKit = FormKit;
    else if (typeof global !== 'undefined') global.FormKit = FormKit;
    else if (typeof self !== 'undefined') self.FormKit = FormKit;

})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global :
   typeof self !== 'undefined' ? self : this);
