// pageView.js -- the page as a person reads it.
//
// capture() turns what is visible into lines of text, top to bottom in
// reading order, and puts a number on everything a person could act on:
//
//     Date of birth *
//     [4] text field "Day" = "" (placeholder "DD") / [5] text field "Month" = "" ...
//     [9] dropdown "Country *" = "Please choose" (4 options: ...)
//     [12] button "Continue" (disabled)
//
// That text is all the model is shown, and the numbers are how its answer is
// mapped back onto the page (resolve()).
//
// Nothing is interpreted here. A date picker is three small fields and a
// button, because that is what it is on screen. A custom dropdown is a field
// that opens a list; the list, once open, is a set of new lines with numbers
// of their own. Which label belongs to which field is not decided here
// either: the text around a control is shown where it stands, and the model
// reads it as a person does. The only things said about a control are the
// ones the page states outright (its name, placeholder, content, state).
//
// "New" is measured against the last look the model was given (commit()).
// That is how a list that opened, a field that appeared or an error message
// that showed up is pointed out, with no knowledge of what produced it.
const PageView = (function () {
    'use strict';

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE',
        'svg', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'MAP', 'OBJECT', 'EMBED', 'OPTION', 'OPTGROUP', 'DATALIST',
        'PICTURE', 'SOURCE', 'TRACK', 'WBR', 'IMG']);
    // Elements that may carry a shadow tree of their own making.
    const SHADOW_HOSTS = new Set(['ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DIV', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'HEADER', 'MAIN', 'NAV', 'P', 'SECTION', 'SPAN']);
    // Native inputs whose value has one fixed written form.
    const NATIVE_VALUE = {
        date: 'yyyy-mm-dd', time: 'hh:mm', 'datetime-local': 'yyyy-mm-ddThh:mm', month: 'yyyy-mm', week: 'yyyy-Www',
        color: '#rrggbb', range: 'a number',
    };
    const ROLE_NAMES = {
        textbox: 'text field', searchbox: 'search field', combobox: 'combobox', spinbutton: 'number field',
        slider: 'slider', listbox: 'list',
        checkbox: 'checkbox', switch: 'switch', radio: 'radio',
        button: 'button', link: 'link', tab: 'tab', option: 'option', menuitem: 'menu item',
        menuitemcheckbox: 'menu item', menuitemradio: 'menu item', treeitem: 'tree item', gridcell: 'cell',
    };
    const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox']);
    const TOGGLE_ROLES = new Set(['checkbox', 'switch', 'radio']);
    const NATIVE_CONTROLS = 'input:not([type="hidden"]), select, textarea, button';
    const INTERACTIVE = NATIVE_CONTROLS + ', a[href], [role], [tabindex], [contenteditable]';
    const HIDDEN_INPUT = {};

    // How much of the page is shown.
    const LINES_BEFORE_FIELD = 4, LINES_AFTER_FIELD = 3;   // the text around each field
    const BUTTONS_AFTER_FORM = 25;                         // lines after the last field searched for buttons
    const LIST_SHOWN = 30;                                 // entries of a long list
    const MAX_CHARS = 16000, MAX_ELEMENTS = 60000, MAX_ENTRIES = 150;

    const collapse = s => String(s == null ? '' : s).replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

    // ------------------------------------------------------------ numbers

    let seq = 0;
    const numberOf = new WeakMap();   // element -> its number
    const elementOf = new Map();      // number -> element
    const signatureOfNumber = new Map();   // number -> what the control is, to find it again after a re-render
    let known = null;                 // what was on the page at the model's last look
    let last = null;                  // the most recent capture

    function numberFor(el) {
        let n = numberOf.get(el);
        if (!n) { n = ++seq; numberOf.set(el, n); elementOf.set(n, el); }
        return n;
    }

    // "12", 12 and "[12]" all mean number 12.
    function parseRef(ref) {
        const m = String(ref == null ? '' : ref).match(/\d+/);
        return m ? Number(m[0]) : NaN;
    }

    // ------------------------------------------------------------ small helpers

    function rectOf(el) {
        try { return el.getBoundingClientRect(); } catch (_) { return null; }
    }

    function styleOf(el) {
        try { return (el.ownerDocument.defaultView || window).getComputedStyle(el); } catch (_) { return null; }
    }

    const boxed = r => !!r && r.width >= 2 && r.height >= 2;

    // The element's box when it is laid out and visible, else null.
    function shownBox(el) {
        const r = rectOf(el);
        if (!boxed(r)) return null;
        const s = styleOf(el);
        return (!s || s.display === 'none' || s.visibility !== 'visible') ? null : r;
    }

    function shadowOf(el) {
        if (!(SHADOW_HOSTS.has(el.tagName) || el.tagName.indexOf('-') > 0)) return null;
        try {
            if (el.openOrClosedShadowRoot) return el.openOrClosedShadowRoot;      // Firefox content scripts
            if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
        } catch (_) {}
        return el.shadowRoot || null;
    }

    // Text of a node without the text of controls nested in it.
    function plainText(node, limit) {
        let out = '';
        const visit = n => {
            if (out.length > limit) return;
            if (n.nodeType === 3) { out += n.nodeValue; return; }
            if (n.nodeType !== 1) return;
            const t = n.tagName;
            if (t === 'SELECT' || t === 'TEXTAREA' || t === 'INPUT' || t === 'SCRIPT' || t === 'STYLE' || t === 'svg') return;
            for (const c of n.childNodes) visit(c);
        };
        visit(node);
        return cut(collapse(out), limit);
    }

    // The text an element holds directly, not through its children.
    function ownText(el) {
        let out = '';
        for (const c of el.childNodes) if (c.nodeType === 3) out += c.nodeValue + ' ';
        return collapse(out);
    }

    // A word drawn as one glyph by an icon font: far narrower than the word
    // could be. People see a picture there, not the word.
    function isIconText(el, text, rect, cs) {
        if (el.children.length || !/^[a-z0-9_]{3,40}$/.test(text)) return false;
        const fontSize = parseFloat(cs && cs.fontSize) || 16;
        return rect.width > 0 && rect.width < text.length * fontSize * 0.3;
    }

    const isToggleInput = el => el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');

    // A checkbox or radio hidden behind its styled label is operated through
    // that label: the label's box is where a person sees and clicks it.
    function toggleProxy(el) {
        const labels = Array.from(el.labels || []);
        const wrap = el.closest('label');
        if (wrap && !labels.includes(wrap)) labels.push(wrap);
        for (const l of labels) { const r = shownBox(l); if (r) return r; }
        const r = el.parentElement && shownBox(el.parentElement);
        return (r && r.width < 600 && r.height < 200) ? r : null;
    }

    // Is there anything of `el` to see and click: its own box, or for a
    // checkbox or radio hidden behind a styled label, that label.
    function onScreen(el) {
        if (!el || !el.isConnected) return false;
        return !!shownBox(el) || (isToggleInput(el) && !!toggleProxy(el));
    }

    // ------------------------------------------------------------ what a control says about itself

    // The name the page itself gives a control: aria-labelledby, aria-label,
    // its <label>, its title. Stated facts only; nothing guessed from layout.
    function statedName(el) {
        const doc = el.ownerDocument || document;
        const root = el.getRootNode ? el.getRootNode() : doc;
        const parts = [];
        for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
            const n = (root.getElementById && root.getElementById(id)) || doc.getElementById(id);
            const t = n && n !== el ? plainText(n, 120) : '';
            if (t) parts.push(t);
        }
        if (parts.length) return cut(parts.join(' '), 160);
        const ariaLabel = collapse(el.getAttribute('aria-label'));
        if (ariaLabel) return cut(ariaLabel, 160);
        const labels = Array.from(el.labels || []);
        const wrap = el.closest('label');
        if (wrap && !labels.includes(wrap)) labels.push(wrap);
        // (A page that repeats an id gives a control every label written for that id.)
        const texts = Array.from(new Set(labels.map(l => plainText(l, 160)).filter(Boolean)));
        if (texts.length) return cut(texts.join(' '), 160);
        return cut(collapse(el.getAttribute('title')), 120);
    }

    // On or off, for anything that can be: null when it cannot.
    function checkedState(el) {
        if (isToggleInput(el)) return !!el.checked;
        for (const a of ['aria-checked', 'aria-pressed', 'aria-selected']) {
            const v = el.getAttribute(a);
            if (v === 'true') return true;
            if (v === 'false' || v === 'mixed') return false;
        }
        return null;
    }

    // What a control shows as its content right now.
    function valueOf(el) {
        if (el.tagName === 'SELECT') return Array.from(el.selectedOptions || []).map(o => collapse(o.text)).join(', ');
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            if (isToggleInput(el)) return el.checked ? 'checked' : '';
            if (el.type === 'password') return el.value ? '(hidden text)' : '';
            return String(el.value == null ? '' : el.value);
        }
        return collapse(el.innerText !== undefined ? el.innerText : el.textContent);
    }

    // What is drawn inside a control's own box while the control itself
    // holds no text: a list widget shows its choice (or a prompt) there
    // beside a blank input, a floating label sits there until it is typed
    // over. "Inside" is geometry: text that overlaps the control (or, for a
    // control drawn as a sliver inside a wider box, its wrapper). Never past
    // anything that holds a second control.
    function textInBox(el, exclude) {
        const own = rectOf(el);
        if (!own) return '';
        const targets = [own];
        const wrapper = el.parentElement && rectOf(el.parentElement);
        if (own.width < 24 && boxed(wrapper) && wrapper.height <= 90) targets.push(wrapper);
        const inside = r => targets.some(t => {
            const w = Math.min(r.right, t.right) - Math.max(r.left, t.left);
            const h = Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top);
            return w > 0 && h > 0 && w * h >= r.width * r.height * 0.5;
        });
        let node = el.parentElement;
        for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
            const r = rectOf(node);
            if (!boxed(r) || r.height > 90) break;
            if (node.querySelectorAll('input:not([type="hidden"]), select, textarea, [contenteditable="true"]').length > 1) break;
            const parts = [];
            for (const n of node.querySelectorAll('*')) {
                if (n === el || n.contains(el) || parts.length > 6) continue;
                const t = ownText(n);
                const box = t && shownBox(n);
                if (!box || !inside(box) || exclude.includes(t.toLowerCase())) continue;
                const cs = styleOf(n);
                if (cs && (Number(cs.opacity) === 0 || isIconText(n, t, box, cs))) continue;
                parts.push(t);
            }
            const text = cut(parts.join(' '), 100);
            if (text && !exclude.includes(text.toLowerCase())) return text;
        }
        return '';
    }

    // The page's internal name for a control, when it is a readable one.
    function internalName(el) {
        for (const raw of [el.getAttribute('name'), el.id]) {
            let v = collapse(raw);
            if (!v || v.length > 40) continue;
            v = v.replace(/[-_:.]?\d{5,}$/, '');            // generated suffixes
            if (/[a-z]{2,}/i.test(v)) return v;
        }
        return '';
    }

    // ------------------------------------------------------------ what an element is

    // What a person would take this element for, or null when it is just
    // part of the page. { role, field | toggle | frame, ... }
    function classify(el, cs, ctx) {
        const tag = el.tagName;
        const role = (el.getAttribute('role') || '').toLowerCase().trim().split(/\s+/)[0];
        if (tag === 'INPUT') {
            const type = el.type;   // the browser's own reading: an unknown type is a text box
            if (type === 'hidden') return HIDDEN_INPUT;
            if (type === 'checkbox') return { role: role === 'switch' ? 'switch' : 'checkbox', toggle: true };
            if (type === 'radio') return { role: 'radio', toggle: true };
            if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return { role: 'button' };
            if (type === 'file') return { role: 'file upload' };
            if (type === 'password') return { role: 'password field', field: true };
            if (NATIVE_VALUE[type]) return { role: type === 'range' ? 'slider' : type + ' field', field: true, native: type };
            let name = role === 'combobox' ? 'combobox' : (type === 'search' || role === 'searchbox' ? 'search field' : 'text field');
            if (type === 'email' || type === 'tel' || type === 'url' || type === 'number') name += ' (' + type + ')';
            return { role: name, field: true };
        }
        if (tag === 'TEXTAREA') return { role: 'text area', field: true };
        if (tag === 'SELECT') return { role: el.multiple ? 'multi-select list' : 'dropdown', field: true, select: true };
        if (tag === 'BUTTON' || tag === 'SUMMARY') return { role: 'button' };
        if (tag === 'IFRAME' || tag === 'FRAME') return { role: 'frame', frame: true };
        if (tag === 'A' && el.hasAttribute('href')) {
            const href = (el.getAttribute('href') || '').trim();
            // A link that leads away from the form is shown as the text it is,
            // with no number to click. One that only runs script is a button.
            return (role === 'button' || href === '' || href[0] === '#' || /^javascript:/i.test(href)) ? { role: 'button' } : null;
        }

        if (ROLE_NAMES[role]) {
            const field = FIELD_ROLES.has(role);
            // A native control inside an ARIA wrapper is the thing to act on,
            // and a list is acted on through its options.
            if (field && el.querySelector(NATIVE_CONTROLS)) return null;
            if (role === 'listbox' && el.querySelector('[role="option"]')) return null;
            if (role === 'gridcell' && !collapse(el.textContent)) return null;
            return { role: ROLE_NAMES[role], field, toggle: TOGGLE_ROLES.has(role) };
        }

        // An editing host: a box people type into.
        const editable = el.getAttribute('contenteditable');
        if (editable !== null && editable !== 'false' && el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) {
            return { role: 'text field', field: true };
        }

        // Things that only look clickable: a hand cursor, a tab stop, a click
        // handler. Taken as one clickable thing when nothing inside is itself
        // interactive (otherwise it is a container, and its contents count).
        if (tag === 'LABEL' || tag === 'BODY' || tag === 'HTML' || tag === 'FORM' || tag === 'A') return null;
        const tabindex = el.getAttribute('tabindex');
        const looksClickable = el.hasAttribute('onclick') || (tabindex !== null && Number(tabindex) >= 0) ||
            (cs.cursor === 'pointer' && ctx.cursor !== 'pointer');
        if (!looksClickable || el.querySelector(INTERACTIVE)) return null;
        const text = collapse(el.textContent);
        return ((text && text.length <= 100) || el.getAttribute('aria-label') || el.getAttribute('title')) ? { role: 'clickable' } : null;
    }

    // ------------------------------------------------------------ items

    // Everything known about one numbered thing on the page.
    function makeItem(el, kind, rect, base) {
        const frameName = () => cut(collapse(el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('name')), 80);
        const it = { ref: numberFor(el), el, role: kind.role, rect, name: kind.frame ? frameName() : statedName(el) };
        const required = el.required || el.getAttribute('aria-required') === 'true';

        if (kind.frame) {
            it.frame = true;
        } else if (kind.field) {
            it.field = true;
            it.value = valueOf(el);
            const placeholder = collapse(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
            if (placeholder) it.placeholder = cut(placeholder, 80);
            if (kind.native) it.format = NATIVE_VALUE[kind.native];
            if (kind.select) it.options = Array.from(el.options).map(o => collapse(o.text)).filter(Boolean);
            const spoken = collapse(el.getAttribute('aria-valuetext'));
            if (spoken && spoken !== it.value) it.reads = cut(spoken, 60);
            if (it.value === '' && !kind.select && !kind.native) {
                const shows = textInBox(el, [it.name.toLowerCase(), (it.placeholder || '').toLowerCase()]);
                if (shows) it.shows = shows;
            }
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                if (el.maxLength > 0 && el.maxLength < 1000) it.max = el.maxLength;
                if (el.readOnly) it.readonly = true;
                const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
                if (autocomplete && !/^(on|off|nope|false|none|new-password|chrome-off)$/.test(autocomplete)) it.autocomplete = autocomplete;
                if (/^(numeric|decimal|tel)$/.test((el.getAttribute('inputmode') || '').toLowerCase())) it.digits = true;
                if (el.type === 'password') it.secret = true;
            } else if (el.getAttribute('aria-readonly') === 'true') {
                it.readonly = true;
            }
            const hint = internalName(el);
            if (hint) it.hint = hint;
            if (required) it.required = true;
            // Marked invalid by the page, or holding something the browser
            // itself refuses (an empty required field is not that).
            let invalid = el.getAttribute('aria-invalid') === 'true';
            if (!invalid && el.validity && !el.validity.valid) invalid = !(el.validity.valueMissing && !it.value);
            if (invalid) it.invalid = true;
        } else if (kind.toggle) {
            it.toggle = true;
            it.checked = !!checkedState(el);
            if (required) it.required = true;
            if (el.getAttribute('aria-invalid') === 'true') it.invalid = true;
            if (!it.name) { const hint = internalName(el); if (hint) it.hint = hint; }
        } else {
            // Something to click: called by its stated name, else by its words.
            let text = el.tagName === 'INPUT' ? collapse(el.value || el.getAttribute('alt')) : plainText(el, 120);
            if (!text && !it.name) {
                const picture = el.querySelector('img[alt], svg title');
                text = picture ? collapse(picture.getAttribute('alt') || picture.textContent) : '';
            }
            it.text = text || it.name || '(no text)';
            if (checkedState(el) === true) it.checked = true;
        }
        // Anything that is not a field can be an entry to pick from a list.
        it.pickable = !kind.field && !kind.frame;

        if (!kind.frame && (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true')) it.disabled = true;
        const expanded = el.getAttribute('aria-expanded');
        if (expanded === 'true') it.open = true;
        else if (expanded === 'false' || el.hasAttribute('aria-haspopup')) it.open = false;
        if ((el.ownerDocument || document).activeElement === el) it.focused = true;

        // What it is and what it is called, whichever node renders it.
        it.sig = [el.tagName, kind.role, el.id && !/\d{4,}/.test(el.id) ? el.id : '', el.getAttribute('name') || '',
            it.placeholder || '', it.name, it.field ? '' : (it.text || '')].join('|').toLowerCase();
        if (base) {
            it.isNew = !base.els.has(el) && !base.sigs.has(it.sig);
            // What it showed at the last look, when that differs: a value
            // typed in since, or one the page filled in by itself.
            const was = base.vals.get(it.ref);
            const now = contentKey(it);
            if (was !== undefined && now !== undefined && was !== now) {
                it.changed = true;
                if (it.field && !it.secret && was !== '') it.was = was;
            }
        }
        return it;
    }

    // What a field or toggle holds, as one comparable string.
    const contentKey = it => (it.field ? it.value : (it.toggle ? String(it.checked) : undefined));

    // One item as the model reads it.
    function describe(it) {
        if (it.frame) return '(embedded frame' + (it.name ? ' "' + it.name + '"' : '') + ': its fields are filled separately)';
        if (it.entry) return '[' + it.ref + '] "' + cut(it.text, 100) + '"';
        let s = '[' + it.ref + '] ' + it.role;
        if (it.field) {
            if (it.name) s += ' "' + cut(it.name, 100) + '"';
            s += ' = "' + cut(it.value, 120) + '"';
            if (it.was !== undefined) s += ' (was "' + cut(it.was, 40) + '")';
        } else if (it.toggle) {
            if (it.name) s += ' "' + cut(it.name, 100) + '"';
        } else {
            s += ' "' + cut(it.name || it.text, 100) + '"';   // a stated name beats the drawn text, which may be an icon
        }
        const notes = [];
        if (it.toggle) notes.push(it.role === 'radio' ? (it.checked ? 'selected' : 'not selected') : (it.checked ? 'checked' : 'not checked'));
        else if (it.checked) notes.push('selected');
        if (it.shows) notes.push('shows "' + cut(it.shows, 80) + '"');
        if (it.reads) notes.push('reads "' + it.reads + '"');
        if (it.placeholder) notes.push('placeholder "' + it.placeholder + '"');
        if (it.format) notes.push('type it as ' + it.format);
        if (it.options) {
            const o = it.options;
            notes.push(o.length + ' options: ' + o.slice(0, 15).map(x => cut(x, 40)).join(' | ') + (o.length > 15 ? ' | … (' + (o.length - 15) + ' more, choose by name)' : ''));
        }
        if (it.open === true) notes.push('its list is open');
        else if (it.open === false) notes.push('opens a list');
        if (it.required) notes.push('required');
        if (it.disabled) notes.push('disabled');
        if (it.readonly) notes.push('read-only');
        if (it.invalid) notes.push('marked invalid');
        if (it.max) notes.push('max ' + it.max + ' chars');
        if (it.digits) notes.push('digits');
        if (it.autocomplete) notes.push('autocomplete=' + it.autocomplete);
        if (it.hint) notes.push('name=' + it.hint);
        if (it.focused) notes.push('has the cursor');
        if (it.covered) notes.push('covered by something on top');
        return notes.length ? s + ' (' + notes.join(', ') + ')' : s;
    }

    // ------------------------------------------------------------ reading the page into lines

    // A line holds text and items in the order they stand, and knows where on
    // screen it is (the union of the boxes of what is on it).
    const newLine = heading => ({ parts: [], items: [], heading: !!heading, box: null, el: null });

    function breakLine(st, heading) {
        if (st.line.parts.length) { st.lines.push(st.line); st.line = newLine(heading); }
        else st.line.heading = !!heading;
    }

    function grow(line, r) {
        if (!r || !(r.width > 0 && r.height > 0)) return;
        const b = line.box;
        if (!b) line.box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        else { b.left = Math.min(b.left, r.left); b.top = Math.min(b.top, r.top); b.right = Math.max(b.right, r.right); b.bottom = Math.max(b.bottom, r.bottom); }
    }

    // A block starts and ends a line; a table cell stays on its row's line.
    function openFlow(st, flow, heading) {
        if (flow === 'block') breakLine(st, heading);
        else if (flow === 'cell' && st.line.parts.length) st.line.parts.push('|');
    }
    function closeFlow(st, flow, heading) {
        if (flow === 'block') breakLine(st, heading);
    }

    function putText(node, st, ctx) {
        const text = ctx.textShown ? collapse(node.nodeValue) : '';
        if (!text) return;
        st.line.parts.push(cut(text, 300));
        grow(st.line, ctx.rect);
        if (!st.line.el) st.line.el = ctx.el;
        if (ctx.textNew) st.line.isNew = true;
        if (ctx.heading) st.line.heading = true;
    }

    function putItem(st, it, box, flow, heading, outerHeading) {
        openFlow(st, flow, heading);
        st.items.push(it);
        st.line.items.push(it);
        st.line.parts.push(it);
        grow(st.line, box);
        if (!st.line.el) st.line.el = it.el;
        if (it.isNew) st.line.isNew = true;
        if (it.changed) st.line.changed = true;
        if (heading) st.line.heading = true;
        closeFlow(st, flow, outerHeading);
    }

    // Was this text on the page, at about this place, at the last look?
    function textWasAt(base, text, x, y) {
        return (base.texts.get(text) || []).some(at => Math.abs(at.x - x) < 8 && Math.abs(at.y - y) < 8);
    }

    function walkNodes(nodes, st, ctx) {
        for (const n of nodes) {
            if (n.nodeType === 3) putText(n, st, ctx);
            else if (n.nodeType === 1) walk(n, st, ctx);
        }
    }

    // ctx carries what an element inherits from the ones around it:
    //   textShown, textNew, heading, hasBox, el, rect   for its text
    //   transparent, hidden                             for its visibility
    //   cursor, overlay                                 for what it may be
    function walk(el, st, ctx) {
        const tag = el.tagName;
        if (SKIP_TAGS.has(tag) || ++st.count > MAX_ELEMENTS) return;
        if (tag === 'BR') { breakLine(st, ctx.heading); return; }
        if (tag === 'SLOT') {
            const assigned = el.assignedNodes({ flatten: true });
            walkNodes(assigned.length ? assigned : el.childNodes, st, ctx);
            return;
        }
        // The extension's own overlays are not part of the page.
        if (el.hasAttribute('data-formfill-overlay') || el.id === 'keepass-picker-icon' || el.id === 'keepass-picker-dropdown') return;
        const cs = styleOf(el);
        if (!cs || el.hasAttribute('inert')) return;
        // Out of the layout altogether, unless it is a checkbox or radio that
        // people operate through its styled label.
        if (cs.display === 'none' && !(isToggleInput(el) && !ctx.hidden && toggleProxy(el))) return;

        const kind = classify(el, cs, ctx);
        if (kind === HIDDEN_INPUT) return;

        const rect = rectOf(el) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        const contents = cs.display === 'contents';
        const hasBox = boxed(rect) || (contents && ctx.hasBox);
        const transparent = ctx.transparent || Number(cs.opacity) === 0;
        const hidden = cs.visibility !== 'visible';
        const offPage = boxed(rect) && (rect.right + st.win.scrollX <= 0 || rect.bottom + st.win.scrollY <= 0);
        const seen = hasBox && !transparent && !hidden && !offPage;
        const flow = (contents || cs.display.indexOf('inline') === 0 || cs.display.indexOf('ruby') === 0) ? 'inline'
            : (cs.display === 'table-cell' ? 'cell' : 'block');
        const heading = ctx.heading || /^H[1-6]$/.test(tag) || tag === 'LEGEND' || el.getAttribute('role') === 'heading';

        if (kind) {
            let visible = seen, box = rect;
            if (!visible && isToggleInput(el) && !hidden && !ctx.hidden) {
                const proxy = toggleProxy(el);
                if (proxy) { visible = true; box = proxy; }
            }
            // A control the page itself marks as not for people (the hidden
            // twin a widget keeps for its form value) is not shown. One that
            // merely sits behind an open pop-up still is: people see it there.
            const notForPeople = el.getAttribute('aria-hidden') === 'true';
            // Drawn fully transparent yet taking clicks (a native input laid
            // over its styled stand-in) is still the thing a click lands on.
            if (!visible && kind.field && hasBox && !hidden && !offPage && cs.pointerEvents !== 'none') visible = true;
            if (notForPeople && (kind.field || kind.toggle)) visible = false;
            if (!visible) return;
            st.visible.add(el);
            putItem(st, makeItem(el, kind, box, st.base), boxed(rect) ? rect : box, flow, heading, ctx.heading);
            return;
        }

        // A box of no size that clips its content shows nothing: text for
        // screen readers only, a collapsed section. Checkboxes and radios
        // inside still count when their label is on screen.
        const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || (cs.clipPath && cs.clipPath !== 'none') || (cs.clip && cs.clip !== 'auto');
        if (!boxed(rect) && !contents && clips) {
            const toggles = el.querySelectorAll('input[type="checkbox"], input[type="radio"]');
            if (toggles.length <= 20) for (const t of toggles) walk(t, st, { ...ctx, hidden: false, textShown: false, transparent: false });
            return;
        }

        const textShown = seen || (contents && ctx.textShown);
        const own = textShown ? ownText(el) : '';
        const overlay = ctx.overlay || cs.position === 'absolute' || cs.position === 'fixed';
        let textNew = false;
        if (seen) st.visible.add(el);
        if (own) {
            if (isIconText(el, own, rect, cs)) return;
            const x = Math.round(rect.left + rect.width / 2 + st.win.scrollX), y = Math.round(rect.top + rect.height / 2 + st.win.scrollY);
            if (!st.texts.has(own)) st.texts.set(own, []);
            st.texts.get(own).push({ el, x, y });
            if (st.base) {
                textNew = !st.base.texts.has(own);
                // Text that appeared in a layer on top of the page (a list
                // that dropped open) is something to pick from: it gets a
                // number, whatever markup it is made of.
                const appeared = !st.base.els.has(el) && !textWasAt(st.base, own, x, y);
                if (appeared && overlay && st.entries < MAX_ENTRIES && own.length <= 120 && tag !== 'LABEL' && !el.querySelector(INTERACTIVE)) {
                    st.entries++;
                    const text = plainText(el, 120);
                    const entry = { ref: numberFor(el), el, role: 'entry', entry: true, text, name: '', rect, isNew: true, pickable: true, sig: 'entry|' + text.toLowerCase() };
                    putItem(st, entry, rect, flow, heading, ctx.heading);
                    return;
                }
            }
        }

        openFlow(st, flow, heading);
        const shadow = shadowOf(el);
        walkNodes(shadow ? shadow.childNodes : el.childNodes, st, {
            textShown, textNew, heading, hasBox, el,
            rect: boxed(rect) ? rect : ctx.rect,
            transparent, hidden: ctx.hidden || hidden,
            cursor: cs.cursor, overlay,
        });
        closeFlow(st, flow, ctx.heading);
    }

    // Two consecutive lines a person sees side by side: both short, level
    // with each other, the second not to the left of the first. (A radio
    // button and the word next to it are separate blocks in the markup.)
    function sameRow(a, b) {
        if (!a.box || !b.box) return false;
        const ha = a.box.bottom - a.box.top, hb = b.box.bottom - b.box.top;
        if (ha > 64 || hb > 64) return false;
        const overlap = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        return overlap >= Math.min(ha, hb) * 0.5 && (b.box.left + b.box.right) / 2 > a.box.left;
    }

    function mergeRows(lines) {
        const out = [];
        for (const l of lines) {
            const p = out[out.length - 1];
            if (p && !p.heading && !l.heading && p.parts.length + l.parts.length <= 40 && sameRow(p, l)) {
                p.parts.push(...l.parts);
                p.items.push(...l.items);
                p.isNew = p.isNew || l.isNew;
                p.changed = p.changed || l.changed;
                grow(p, { ...l.box, width: l.box.right - l.box.left, height: l.box.bottom - l.box.top });
            } else {
                out.push(l);
            }
        }
        return out;
    }

    // ------------------------------------------------------------ what lies on top

    // The layer lying on top of `el`: what a click on it would land on
    // instead (a menu and its backdrop, a pop-up, a banner). Returns the
    // root of that layer, the whole thing a person would see as "on top".
    //
    // While only looking (`strict` off), a bar that stays at the edge of the
    // window does not count: the field scrolls clear of it before it is
    // clicked. The hands ask with `strict` on, after scrolling.
    function coverOf(el, rect, strict) {
        const doc = el.ownerDocument || document, win = doc.defaultView || window;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= win.innerHeight || rect.left >= win.innerWidth) return null;
        const x = Math.min(Math.max(rect.left + rect.width / 2, 1), win.innerWidth - 1);
        const y = Math.min(Math.max(rect.top + rect.height / 2, 1), win.innerHeight - 1);
        const hit = doc.elementFromPoint(x, y);
        if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
        const label = hit.closest('label');
        if (label && (label.control === el || label.contains(el))) return null;
        // Part of the same widget (a placeholder drawn over its own input).
        for (let up = el.parentElement, i = 0; up && i < 3; up = up.parentElement, i++) if (up.contains(hit)) return null;
        let root = hit, positioned = null;
        for (let n = hit; n && n !== doc.documentElement && !n.contains(el); n = n.parentElement) {
            root = n;
            const s = styleOf(n);
            if (!positioned && s && (/^(fixed|absolute|sticky)$/.test(s.position) || n.tagName === 'DIALOG')) positioned = n;
        }
        if (!positioned) return strict ? root : null;
        if (!strict && /^(fixed|sticky)$/.test(styleOf(positioned).position)) {
            const r = rectOf(positioned), middle = win.innerHeight / 2;
            if (r && !(r.top <= middle && r.bottom >= middle)) return null;
        }
        return root;
    }

    // ------------------------------------------------------------ capture

    // The words of a line. A control's own name is always shown with it;
    // where the page prints the very same words next to the control (its
    // label), they are not repeated.
    function lineText(line, prev, next) {
        const said = new Set();
        for (const it of line.items) {
            if (it.name) said.add(it.name.toLowerCase());
            if (it.shows) said.add(it.shows.toLowerCase());
        }
        for (const other of [prev, next]) {
            if (other && !other.items.length && said.has(other.words.toLowerCase())) other.repeat = true;
        }
        return line.parts
            .filter(p => typeof p !== 'string' || !said.has(p.toLowerCase()))
            .map(p => (typeof p === 'string' ? p : describe(p)))
            .join(' ').replace(/\s+\|\s*$/, '');
    }

    // Which lines a person filling the form would look at: the fields, the
    // few lines around each, the section heading above, the buttons that
    // follow, anything new, and whatever lies on top.
    function chooseLines(lines, covers) {
        const keep = new Array(lines.length).fill(false);
        const fieldAt = [];
        lines.forEach((l, i) => { if (l.items.some(it => it.field || it.toggle)) fieldAt.push(i); });
        const first = fieldAt[0], lastField = fieldAt[fieldAt.length - 1];
        for (const i of fieldAt) {
            for (let j = Math.max(0, i - LINES_BEFORE_FIELD); j <= Math.min(lines.length - 1, i + LINES_AFTER_FIELD); j++) keep[j] = true;
            for (let j = i - 1; j >= 0 && j >= i - 40; j--) if (lines[j].heading) { keep[j] = true; break; }
        }
        const nearForm = i => fieldAt.length > 0 && i >= first - 10 && i <= lastField + 30;
        const inCover = n => { for (const c of covers) if (n && c.contains(n)) return true; return false; };
        let newsElsewhere = 12;
        lines.forEach((l, i) => {
            const clickable = l.items.some(it => it.pickable && !it.toggle);
            if (clickable && fieldAt.length && i >= first - LINES_BEFORE_FIELD && i <= lastField + BUTTONS_AFTER_FORM) keep[i] = true;
            // New things to act on are shown wherever they are (a list opens
            // at the end of the document); new plain text mostly near the form.
            if (l.isNew && !keep[i]) {
                if (l.items.length || nearForm(i) || newsElsewhere-- > 0) keep[i] = true;
                else l.isNew = false;
            }
            if (l.items.some(it => it.frame)) keep[i] = nearForm(i);
            // Everything in a layer that lies on top is shown, words
            // included: what it says is how a person decides what to do with it.
            if (inCover(l.el) || l.items.some(it => inCover(it.el))) { keep[i] = true; l.onTop = true; }
        });
        return keep;
    }

    function print(lines, keep, marked) {
        const out = [];
        let budget = MAX_CHARS, skipped = false, run = 0;
        // A long list (250 countries) is shown by its first entries: the rest
        // is reached by name, the way a person types to narrow it down.
        const endList = () => {
            if (run > LIST_SHOWN) out.push('  … (' + (run - LIST_SHOWN) + ' more entries in this list: choose by the text of the entry you want)');
            run = 0;
        };
        const emit = l => {
            const entry = l.items.length === 1 && l.parts.length === 1 && l.items[0].pickable;
            if (!entry) endList();
            if (entry && ++run > LIST_SHOWN) return;
            const t = (marked && (l.isNew || l.changed) ? '+ ' : '  ') + (l.heading && !l.items.length ? '# ' : '') + cut(l.text, l.items.length ? 1600 : 400);
            out.push(t);
            budget -= t.length;
            for (const it of l.items) it.shown = true;
        };
        const onTop = lines.filter((l, i) => keep[i] && l.onTop);
        if (onTop.length) {
            out.push('ON TOP OF THE PAGE (covering part of it):');
            onTop.forEach(emit);
            endList();
            out.push('THE PAGE UNDERNEATH:');
        }
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (!keep[i] || l.onTop || l.repeat) { skipped = skipped || (!!l.text && !l.repeat); continue; }
            if (budget <= 0) { endList(); out.push('  … (the page continues)'); break; }
            if (skipped && out.length) { endList(); out.push('  …'); }
            skipped = false;
            emit(l);
        }
        endList();
        return out;
    }

    // Look at the page. opts.baseline: what "new" is measured against (the
    // model's last look by default; null for a look with nothing marked).
    function capture(opts = {}) {
        const st = {
            win: window, base: opts.baseline === undefined ? known : opts.baseline,
            lines: [], line: newLine(false), items: [], visible: new Set(), texts: new Map(), count: 0, entries: 0,
        };
        if (document.body) {
            walk(document.body, st, { textShown: true, textNew: false, heading: false, hasBox: true, el: null, rect: null, transparent: false, hidden: false, cursor: 'auto', overlay: false });
        }
        if (st.line.parts.length) st.lines.push(st.line);
        const lines = mergeRows(st.lines);
        for (const l of lines) l.words = l.parts.filter(p => typeof p === 'string').join(' ');

        // Fields that something lies on top of, and the layers doing it.
        const covers = new Set();
        for (const it of st.items) {
            const cover = (it.field || it.toggle) && !it.disabled && coverOf(it.el, it.rect, false);
            if (cover) { it.covered = true; covers.add(cover); }
        }
        lines.forEach((l, i) => { l.text = lineText(l, lines[i - 1], lines[i + 1]); });

        const keep = chooseLines(lines, covers);
        const out = print(lines, keep, !!st.base);

        for (const it of st.items) signatureOfNumber.set(it.ref, it.sig);
        if (elementOf.size > 4000) {
            for (const [n, el] of elementOf) if (!el.isConnected) { elementOf.delete(n); signatureOfNumber.delete(n); }
        }
        last = {
            url: location.href, title: document.title,
            frame: window === window.top ? 'top' : 'iframe',
            text: out.join('\n'),
            // What is on show, without where the cursor happens to be: two
            // looks with the same digest show a person the same page.
            digest: out.map(t => t.slice(2).split(', has the cursor').join('').split(' (has the cursor)').join('')).join('|'),
            items: st.items,
            fields: st.items.filter(it => (it.field || it.toggle) && it.shown),
            hasNew: !!st.base && lines.some((l, i) => keep[i] && l.isNew),
            baseline: {
                els: st.visible, texts: st.texts,
                sigs: new Set(st.items.map(it => it.sig)),
                vals: new Map(st.items.filter(it => it.field || it.toggle).map(it => [it.ref, contentKey(it)])),
            },
        };
        return last;
    }

    // The model has been shown `view`: from here on, "new" is measured against it.
    function commit(view) {
        known = view.baseline;
    }

    function reset() { known = null; last = null; }

    // ------------------------------------------------------------ from the model's answer back to the page

    // The element a number stands for now. A control the page re-rendered
    // into a fresh node is found again by what it is and what it is called.
    function resolve(ref) {
        const n = parseRef(ref);
        const el = elementOf.get(n);
        if (el && el.isConnected) return el;
        const sig = signatureOfNumber.get(n);
        if (!sig) return null;
        const same = capture({ baseline: null }).items.filter(it => it.sig === sig);
        if (same.length !== 1) return null;
        elementOf.set(n, same[0].el);
        return same[0].el;
    }

    // The thing on the page that shows these words: for clicking something
    // that carries no number (a card, a tile, a row), the way a person clicks
    // "the one that says Express". Returns { el } or { error }.
    function findText(text) {
        const want = collapse(text).toLowerCase();
        const view = capture({ baseline: null });
        const found = new Set();
        for (const it of view.items) {
            if (!it.frame && collapse(it.text || it.name).toLowerCase() === want) found.add(it.el);
        }
        const texts = Array.from(view.baseline.texts);
        for (const [words, at] of texts) if (words.toLowerCase() === want) at.forEach(a => found.add(a.el));
        if (!found.size) {
            for (const [words, at] of texts) if (words.toLowerCase().startsWith(want)) at.forEach(a => found.add(a.el));
        }
        const quoted = '"' + cut(collapse(text), 60) + '"';
        if (!found.size) return { error: 'nothing on the page shows the text ' + quoted };
        if (found.size > 1) return { error: found.size + ' things on the page show the text ' + quoted + '; use a number, or longer text' };
        return { el: found.values().next().value };
    }

    // What a control is called, in a few words (for results and messages).
    function label(el) {
        const it = last && last.items.find(i => i.el === el);
        if (it) return it.name || it.text || it.placeholder || it.hint || it.role;
        return statedName(el) || collapse(el.getAttribute('placeholder')) || plainText(el, 80) || el.tagName.toLowerCase();
    }

    return { capture, commit, reset, resolve, findText, parseRef, label, valueOf, checkedState, onScreen, coverOf, plainText, NATIVE_VALUE };
})();

if (typeof window !== 'undefined') window.PageView = PageView;
