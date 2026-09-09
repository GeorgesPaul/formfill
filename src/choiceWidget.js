// choiceWidget.js -- one way to read and operate every list-like control.
//
// Native <select>, ARIA comboboxes, react-select, MUI Autocomplete, select2,
// Ant Design, plain div dropdowns: they all present a list, let the person pick
// one entry, and then show the pick somewhere. Where they differ is in what
// `input.value` holds afterwards. react-select clears its search input and
// renders the pick in a sibling "single-value" element; a hidden input carries
// the model; a div combobox holds it as text. Reading `input.value` therefore
// reports a correct pick as an empty required field, and the loop retries a
// choice the page already accepted (seen on a hotel booking form: the widget
// announced "option Portugal, selected", the input read "", and the model was
// told to fill Country three times).
//
// Two things live here:
//
//   readSelection(el) -> { text, source } | null
//       What the widget shows as its current choice, wherever it keeps it.
//       This is the value the snapshot reports and the verify step compares.
//
//   choose(el, value, info) -> { ok, selected, optionsSeen, reason, strategy }
//       Open the list, enumerate the options, pick the matching one, and
//       confirm through readSelection. Typing to filter is a step inside this,
//       not a different code path.
//
// Also the safety rule every popup finder shares (isSafePopup): a suggestion
// list never contains the form's own fields or its Continue/Submit buttons, and
// a calendar is never a suggestion list. Without it, a re-rendered container
// around a "Continue" button was taken for a one-option popup and "selected",
// which pressed the button and submitted a verification step.
const ChoiceWidget = (function () {
    'use strict';

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

    // Words that make an element a progression control rather than an option.
    const PROGRESS_RE = /^\s*(continue|next|proceed|submit|send|pay|order|buy|confirm|book|finish|complete|done|apply|save|register|sign ?up|create account|verder|volgende|doorgaan|verstuur|verzend|bestel|betaal|opslaan|bevestig|weiter|fortfahren|absenden|senden|bestellen|zahlen|speichern|suivant|continuer|envoyer|payer|commander|enregistrer|valider|siguiente|continuar|prosseguir|avançar|avancar|enviar|pagar|guardar|confirmar|avanti|prosegui|invia|paga|salva)\b/i;

    const PLACEHOLDER_RE = /^(select|choose|pick|search|kies|selecteer|zoek|wählen|auswählen|suchen|choisir|sélectionner|rechercher|selecione|escolha|pesquis|seleccion|elegir|buscar|scegli|seleziona|cerca|välj|vælg|velg|wybierz|válassz|-+|\.\.\.|…)/i;

    const CALENDAR_RE = /(^|[\s_-])(calendar|datepicker|date-picker|daypicker|day-picker|picker__|flatpickr|pika-|dp__|rdp-|rdp$|react-datepicker|mat-calendar|ui-datepicker|air-datepicker|vdp-|datetimepicker|mbsc-calendar|apex-item-datepicker|a-DatePicker)/i;

    // Emoji and other pictographs (flag pairs in country lists) are not text a
    // person types and never part of what the form stores.
    function plainText(s) {
        return clean(String(s == null ? '' : s)
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, ''));
    }

    function visible(el) {
        if (!el || el.nodeType !== 1 || !el.isConnected) return false;
        let r;
        try { r = el.getBoundingClientRect(); } catch (_) { return false; }
        if (r.width < 2 || r.height < 2) return false;
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        let s;
        try { s = win.getComputedStyle(el); } catch (_) { return false; }
        return !!s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    function text(el) { return clean(el && el.textContent); }

    function textWithoutControls(el, maxLen) {
        if (typeof AccName !== 'undefined') return AccName.textWithoutControls(el, maxLen);
        return text(el).slice(0, maxLen || 200);
    }

    // ------------------------------------------------------------ the widget

    // Other interactive controls that make an ancestor "not this widget's box".
    const OTHER_CONTROLS = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="textbox"], [role="listbox"], [contenteditable="true"]';

    // The box the widget draws around its input: the smallest ancestor that
    // holds no other field. Indicator buttons (clear, open) may live in it.
    function wrapperOf(el) {
        if (!el) return null;
        let best = null;
        let node = el.parentElement;
        let elRect = null;
        try { elRect = el.getBoundingClientRect(); } catch (_) {}
        for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
            if (node.tagName === 'FORM' || node.tagName === 'BODY' || node.tagName === 'HTML') break;
            let others = 0;
            try {
                for (const c of node.querySelectorAll(OTHER_CONTROLS)) {
                    if (c === el || el.contains(c) || c.contains(el)) continue;
                    // A hidden search input of the same widget does not count.
                    if (c.tagName === 'INPUT' && !visible(c)) continue;
                    others++;
                    break;
                }
            } catch (_) {}
            if (others) break;
            let r = null;
            try { r = node.getBoundingClientRect(); } catch (_) {}
            if (r && elRect && r.height > Math.max(160, elRect.height * 4)) break;
            best = node;
        }
        return best;
    }

    function looksLikePlaceholder(t, el) {
        if (!t) return true;
        if (PLACEHOLDER_RE.test(t)) return true;
        const ph = el && clean(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
        if (ph && t.toLowerCase() === ph.toLowerCase()) return true;
        return false;
    }

    function labelTextOf(el) {
        try {
            if (typeof AccName !== 'undefined') {
                const n = AccName.compute(el).name;
                return n ? n.toLowerCase() : '';
            }
        } catch (_) {}
        return '';
    }

    // What the widget currently shows as its choice, wherever it keeps it.
    function readSelection(el) {
        if (!el) return null;
        const tag = el.tagName;
        if (tag === 'SELECT') {
            const o = el.options && el.options[el.selectedIndex];
            if (!o) return null;
            const t = clean(o.text);
            if (o.value === '' && (!t || looksLikePlaceholder(t, el))) return null;
            return t ? { text: t, source: 'select' } : null;
        }
        if (typeof el.value === 'string' && el.value.trim() && tag !== 'BUTTON') {
            return { text: el.value.trim().slice(0, 300), source: 'value' };
        }
        const label = labelTextOf(el);
        // A choice has letters or digits in it; an arrow glyph or a star does not.
        const isReal = t => t && t.length <= 160 && /[\p{L}\p{N}]/u.test(t) && !looksLikePlaceholder(t, el) && t.toLowerCase() !== label;

        const wrap = wrapperOf(el);
        if (wrap) {
            // 1. Hidden input carrying the widget's model (react-select with a
            //    name, select2, Ant Design's hidden field).
            for (const h of wrap.querySelectorAll('input[type="hidden"]')) {
                const v = clean(h.value);
                if (v && v.length <= 200 && !/^(\[\]|\{\}|null|undefined|false|0)$/.test(v)) {
                    return { text: v, source: 'hidden' };
                }
            }
            // 2. An element whose job is to display the chosen value.
            const DISPLAY = '[class*="single-value" i], [class*="singleValue" i], [class*="selected-value" i], [class*="selected-item" i], [class*="selection__rendered" i], [class*="selection-item" i], [class*="select-selection" i], [class*="chosen-single" i], [class*="__value" i], [class*="-value" i], [class*="value-text" i], [class*="chip" i], [class*="token" i], [class*="tag" i], [class*="display" i], [aria-selected="true"], [data-selected]';
            let nodes = [];
            try { nodes = wrap.querySelectorAll(DISPLAY); } catch (_) {}
            for (const n of nodes) {
                if (n === el || n.contains(el) || !visible(n)) continue;
                if (/placeholder|label|indicator|caret|arrow/i.test(n.className || '')) continue;
                const t = plainText(textWithoutControls(n, 160));
                if (isReal(t)) return { text: t, source: 'display' };
            }
            // 3. The box's own text once label, placeholder and hint text are
            //    taken out. Only for widgets that hide their choice from the
            //    input: an input with its own value never gets here.
            try {
                const cl = wrap.cloneNode(true);
                cl.querySelectorAll('input, select, textarea, button, svg, label, legend, [class*="placeholder" i], [class*="label" i], [id*="label" i], [class*="hint" i], [class*="help" i], [class*="description" i], [class*="indicator" i], [class*="arrow" i], [class*="caret" i], [class*="chevron" i], [class*="icon" i], [aria-live], [role="status"], [role="alert"], [class*="error" i], [class*="a11y" i], [class*="sr-only" i], [class*="visually-hidden" i]').forEach(n => n.remove());
                const t = plainText(clean(cl.textContent));
                if (isReal(t) && t.length <= 80) return { text: t, source: 'wrapper-text' };
            } catch (_) {}
        }
        // 4. A combobox that is itself an element with text (div/button).
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
            const t = plainText(textWithoutControls(el, 160));
            if (isReal(t)) return { text: t.slice(0, 120), source: 'text' };
        }
        return null;
    }

    // ------------------------------------------------------------ matching

    function normalise(s) {
        return plainText(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    // Does the widget's displayed choice correspond to what we meant?
    function matches(shown, wanted) {
        const a = normalise(shown), b = normalise(wanted);
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.startsWith(b + ' ') || b.startsWith(a + ' ')) return true;
        if (typeof AutocompleteFiller !== 'undefined' && AutocompleteFiller.score(a, b) >= 0.8) return true;
        return false;
    }

    // Pick the option for `value` among {el, text}: exact > prefix > token
    // score. A bare substring is not enough ("Netherlands" is inside
    // "Caribbean Netherlands"); the exact entry wins when it exists.
    function matchOption(options, value) {
        const want = normalise(value);
        if (!want || !options.length) return null;
        const norm = options.map(o => ({ o, n: normalise(o.text) }));
        let m = norm.find(x => x.n === want);
        if (m) return m.o;
        if (typeof findMatchingOption === 'function') {
            const fm = findMatchingOption(options.map(o => ({ text: plainText(o.text), value: o.value !== undefined ? o.value : plainText(o.text), el: o.el })), plainText(value));
            if (fm) {
                const hit = options.find(o => o.el === fm.el) || options.find(o => plainText(o.text) === fm.text);
                if (hit) return hit;
            }
        }
        m = norm.find(x => x.n.startsWith(want + ' ')) || norm.find(x => want.startsWith(x.n + ' ') && x.n.length >= 3);
        if (m) return m.o;
        if (typeof AutocompleteFiller !== 'undefined') {
            let best = null, bs = 0;
            for (const x of norm) { const s = AutocompleteFiller.score(x.n, want); if (s > bs) { bs = s; best = x.o; } }
            if (best && bs >= 0.6) return best;
        }
        return null;
    }

    // ------------------------------------------------------------ lists

    function isCalendarish(node) {
        if (!node || node.nodeType !== 1) return false;
        try {
            const id = (node.id || '') + ' ' + (node.className && typeof node.className === 'string' ? node.className : '');
            if (CALENDAR_RE.test(id)) return true;
            if (node.matches('[role="grid"], [role="application"]') && node.querySelector('[role="gridcell"], td')) {
                // A grid of small numbers is a calendar; a grid of addresses is not.
                let nums = 0, cells = 0;
                for (const c of node.querySelectorAll('[role="gridcell"], td')) {
                    cells++;
                    if (/^\d{1,2}$/.test(text(c))) nums++;
                    if (cells > 60) break;
                }
                if (cells >= 20 && nums / cells > 0.6) return true;
            }
            const inner = node.querySelector('[role="grid"], table');
            if (inner && inner !== node) {
                let nums = 0, cells = 0;
                for (const c of inner.querySelectorAll('[role="gridcell"], td, button')) {
                    cells++;
                    if (/^\d{1,2}$/.test(text(c))) nums++;
                    if (cells > 60) break;
                }
                if (cells >= 20 && nums / cells > 0.6) return true;
            }
        } catch (_) {}
        return false;
    }

    // A suggestion list is a list: no form fields of its own, no progression
    // buttons, no calendar. The field itself is never inside it.
    function isSafePopup(node, field) {
        if (!node || node.nodeType !== 1) return false;
        if (node === field || node.contains(field)) return false;
        const tag = node.tagName;
        if (tag === 'FORM' || tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') return false;
        if (isCalendarish(node)) return false;
        try {
            // Other fields of the form inside the "popup" mean it is the form.
            if (node.querySelector('[data-ff-ref^="f"], [data-ff-ref^="g"]')) return false;
            let inputs = 0;
            for (const c of node.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea')) {
                if (visible(c)) inputs++;
                if (inputs > 1) return false;   // one search box is fine, a form is not
            }
            for (const b of node.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[href]')) {
                const t = plainText(b.tagName === 'INPUT' ? b.value : b.textContent);
                if (t && PROGRESS_RE.test(t)) return false;
            }
        } catch (_) {}
        return true;
    }

    const OPTION_SELECTOR = [
        '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="treeitem"]',
        'li', '.pac-item', '[class*="option" i]', '[class*="suggestion" i]', '[class*="item" i]'
    ].join(',');

    // {el, text} entries of a list, innermost elements only, without headers,
    // placeholders and anything that is really a button.
    function optionsIn(popup) {
        if (!popup) return [];
        let candidates = [];
        try { candidates = Array.from(popup.querySelectorAll(OPTION_SELECTOR)).filter(visible); } catch (_) {}
        if (candidates.length === 0) {
            candidates = Array.from(popup.children).filter(el => visible(el) && text(el));
        }
        const leaves = candidates.filter(c => !candidates.some(o => o !== c && c.contains(o)));
        const seen = new Set();
        const out = [];
        for (const el of leaves) {
            if (el.getAttribute('aria-disabled') === 'true' || el.getAttribute('role') === 'presentation') continue;
            if (/(^|[\s_-])(group|header|heading|divider|separator|placeholder|no-results|noresults|empty|loading)([\s_-]|$)/i.test(el.className || '')) continue;
            const raw = text(el);
            if (!raw || raw.length > 200) continue;
            const t = plainText(raw);
            if (!t) continue;
            if (PROGRESS_RE.test(t) && (el.closest('button, [role="button"], a[href], input[type="submit"]') || el.querySelector('button, [role="button"], a[href], input[type="submit"]'))) continue;
            if (seen.has(t)) continue;
            seen.add(t);
            out.push({ el, text: t, value: el.getAttribute('data-value') || el.getAttribute('value') || undefined });
        }
        return out;
    }

    // The list a field currently owns: explicit ARIA wiring first, then any
    // visible listbox-shaped popup near it.
    function findList(el, opts = {}) {
        const doc = el.ownerDocument || document;
        const seen = new Set();
        const consider = n => { if (n && n.nodeType === 1 && visible(n) && isSafePopup(n, el)) seen.add(n); };
        const wrap = wrapperOf(el);
        for (const attr of ['aria-controls', 'aria-owns']) {
            let v = el.getAttribute(attr);
            if (!v && wrap) {
                // The wiring may sit on the widget's box or its toggle, not the input.
                const carrier = wrap.hasAttribute(attr) ? wrap : wrap.querySelector('[' + attr + ']');
                if (carrier) v = carrier.getAttribute(attr);
            }
            if (!v) continue;
            for (const id of String(v).split(/\s+/)) { const n = doc.getElementById(id); if (n) consider(n); }
        }
        const ad = el.getAttribute('aria-activedescendant');
        if (ad) { const n = doc.getElementById(ad); if (n) consider(n.closest('[role="listbox"], [role="menu"], ul') || n.parentElement); }
        if (opts.watcher) {
            for (const n of opts.watcher.added) {
                if (!n.isConnected || !n.matches) continue;
                if (n.matches('[role="listbox"], [role="menu"], [role="tree"]')) consider(n);
                else { const inner = n.querySelector && n.querySelector('[role="listbox"], [role="menu"], [role="tree"]'); if (inner) consider(inner); }
            }
        }
        if (typeof AutocompleteFiller !== 'undefined' && AutocompleteFiller.candidatePopups) {
            for (const n of AutocompleteFiller.candidatePopups(el, opts.watcher || null)) consider(n);
        }
        const list = Array.from(seen)
            .filter(n => optionsIn(n).length > 0)
            .filter((n, _i, all) => !all.some(o => o !== n && n.contains(o)));
        return list.length ? list[list.length - 1] : null;
    }

    async function waitForList(el, timeoutMs, opts = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const l = findList(el, opts);
            if (l) return l;
            if (Date.now() >= deadline) return null;
            await wait(80);
        }
    }

    // ------------------------------------------------------------ picking

    function highlightedIndex(options) {
        for (let i = 0; i < options.length; i++) {
            const el = options[i].el;
            if (el.getAttribute('aria-selected') === 'true') return i;
            if (/(^|[-_ ])(selected|active|highlight|highlighted|focused|current)([-_ ]|$)/i.test(el.className || '')) return i;
            if (el.hasAttribute('data-highlighted') || el.hasAttribute('data-focused') || el.hasAttribute('data-active')) return i;
        }
        return -1;
    }

    function listClosed(popup) { return !popup || !popup.isConnected || !visible(popup); }

    function selectionMatches(el, option, value) {
        const sel = readSelection(el);
        if (!sel) return false;
        return matches(sel.text, option.text) || matches(sel.text, value) || (option.value !== undefined && normalise(sel.text) === normalise(option.value));
    }

    async function pickByKeyboard(el, popup, option) {
        const live = optionsIn(popup);
        const target = live.findIndex(o => o.text === option.text);
        if (target < 0) return false;
        const presses = live.length + 2;
        for (let i = 0; i < presses; i++) {
            TypingEngine.pressKey(el, 'ArrowDown');
            await wait(70);
            const now = optionsIn(popup);
            const hi = highlightedIndex(now);
            const ad = el.getAttribute('aria-activedescendant');
            const onTarget = (ad && now[target] && now[target].el.id === ad) || hi === target;
            if (i === 0 && hi === -1 && !ad) return false;          // widget ignores arrows
            if (onTarget) {
                TypingEngine.pressKey(el, 'Enter');
                await wait(200);
                return true;
            }
        }
        return false;
    }

    function liveOption(popup, option) {
        if (option.el && option.el.isConnected) return option.el;
        const now = optionsIn(popup);
        const hit = now.find(o => o.text === option.text);
        return hit ? hit.el : null;
    }

    async function pick(el, popup, option, value) {
        const done = () => listClosed(popup) || selectionMatches(el, option, value);
        // 1. Arrow keys + Enter, for widgets that track a highlight.
        if (await pickByKeyboard(el, popup, option)) { if (done()) return true; }
        // 2. A real pointer press on the option (most widgets select on mousedown).
        let target = liveOption(popup, option);
        if (target) {
            AutocompleteFiller.mouseSequence(target);
            await wait(250);
            if (done()) return true;
        }
        // 3. The innermost element under the option's centre, then the DOM click.
        target = liveOption(popup, option);
        if (target) {
            try {
                const r = target.getBoundingClientRect();
                const deep = (el.ownerDocument || document).elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                if (deep && deep !== target && target.contains(deep)) { AutocompleteFiller.mouseSequence(deep); await wait(200); if (done()) return true; }
            } catch (_) {}
            try { target.click(); } catch (_) {}
            await wait(200);
            if (done()) return true;
        }
        return false;
    }

    function openIndicator(el) {
        const wrap = wrapperOf(el);
        if (!wrap) return null;
        let cands = [];
        try { cands = wrap.querySelectorAll('[class*="indicator" i], [class*="arrow" i], [class*="caret" i], [class*="toggle" i], [class*="chevron" i], [aria-haspopup], button'); } catch (_) {}
        for (const c of cands) {
            if (c === el || c.contains(el) || !visible(c)) continue;
            if (/clear|remove|close/i.test((c.getAttribute('aria-label') || '') + ' ' + (c.className || ''))) continue;
            return c;
        }
        return null;
    }

    // Open the list, enumerate, pick, verify.
    async function choose(el, value, info = {}, opts = {}) {
        const want = plainText(value);
        const seen = [];
        const noteSeen = list => { for (const o of list) if (seen.length < 25 && !seen.includes(o.text)) seen.push(o.text); };
        const result = (ok, extra) => ({ ok, optionsSeen: seen.slice(), ...extra });
        if (!want) return result(false, { reason: 'empty-value' });

        const current = readSelection(el);
        if (current && matches(current.text, want)) {
            try { el.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {}
            return result(true, { strategy: 'already', selected: current.text, reason: 'selected' });
        }

        if (el.tagName === 'SELECT') {
            const ok = await fillSelectField(el, want);
            const sel = readSelection(el);
            return result(ok, { strategy: 'select', selected: sel ? sel.text : undefined, reason: ok ? 'selected' : 'no-match' });
        }

        // Open by clicking into it, like a person.
        if (typeof EventSim !== 'undefined') EventSim.focus(el); else { try { el.focus(); } catch (_) {} }
        await wait(90);
        let popup = await waitForList(el, 600);
        if (!popup) {
            const ind = openIndicator(el);
            if (ind) { AutocompleteFiller.mouseSequence(ind); popup = await waitForList(el, 600); }
        }
        if (!popup && !TypingEngine.isTypable(el)) {
            TypingEngine.pressKey(el, 'ArrowDown');
            popup = await waitForList(el, 500);
        }

        let picked = null;
        if (popup) {
            const options = optionsIn(popup);
            noteSeen(options);
            picked = matchOption(options, want);
        }

        // Type to filter (searchable widgets show the full list only for a query).
        if (!picked && TypingEngine.isTypable(el)) {
            const watcher = AutocompleteFiller.startWatch(el);
            try {
                await TypingEngine.typeText(el, want, { clearFirst: true, isCancelled: () => window.stopFilling });
                popup = await waitForList(el, 1500, { watcher });
                if (!popup) {
                    await TypingEngine.retypeLastChar(el);
                    popup = await waitForList(el, 1200, { watcher });
                }
            } finally { watcher.stop(); }
            if (popup) {
                const options = optionsIn(popup);
                noteSeen(options);
                picked = matchOption(options, want);
                if (!picked && options.length > 1 && opts.allowLLM !== false && typeof AutocompleteFiller.askLLM === 'function') {
                    const idx = await AutocompleteFiller.askLLM(info.label || info.placeholder || '', want, options);
                    if (idx >= 0) picked = options[idx];
                }
                if (!picked && options.length === 1 && AutocompleteFiller.score(options[0].text, want) >= 0.3) picked = options[0];
            }
        }

        if (!picked) {
            TypingEngine.pressKey(el, 'Escape');
            return result(false, { strategy: 'choose', reason: popup ? 'no-match' : 'no-list' });
        }

        const ok = await pick(el, popup, picked, want);
        await wait(120);
        const sel = readSelection(el);
        const accepted = ok && (listClosed(popup) || selectionMatches(el, picked, want));
        if (accepted) {
            try {
                el.setAttribute('data-ff-accepted-for', String(value).trim());
                el.setAttribute('data-ff-selected', picked.text);
                el.setAttribute('data-filled-by-extension', 'true');
            } catch (_) {}
        } else {
            TypingEngine.pressKey(el, 'Escape');
        }
        return result(accepted, {
            strategy: 'choose', selected: picked.text, reason: accepted ? 'selected' : 'not-accepted',
            shown: sel ? sel.text : undefined,
        });
    }

    return { readSelection, choose, matches, matchOption, optionsIn, isSafePopup, isCalendarish, findList, wrapperOf, plainText, normalise, PROGRESS_RE };
})();

if (typeof window !== 'undefined') window.ChoiceWidget = ChoiceWidget;
