// dateField.js -- dates are their own kind of control.
//
// A date field is rarely a plain text box. It is a masked input that places
// its own separators ("dd-mm-aaaa": typing the dashes yourself corrupts it), a
// native <input type=date> that only takes ISO through its value, or a text
// box paired with a calendar popup that validates against the calendar's own
// state. Typing the profile's date string into any of these and hoping is what
// produced "01-01-1900" on a health portal and ten rejected submits on an
// immigration portal, where even a hand-typed value was refused until a day
// was clicked in the calendar. And a calendar grid, seen by the suggestion
// resolver, looks like a list of options: a week row got "selected".
//
//   detect(el, info) -> { isDate, native, mask, hasPicker, hint }
//   fill(el, value, info) -> { ok, strategy, tried, finalValue }
//
// fill tries, in order: native value, the format the field itself asks for
// (mask, placeholder, the page's own error example), digits only into a mask,
// the page language's convention, and finally the calendar: month/year
// selects or prev/next navigation, then the day cell.
const DateField = (function () {
    'use strict';

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const fold = s => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const digits = s => String(s == null ? '' : s).replace(/\D+/g, '');

    const MONTHS = [
        ['january', 'januari', 'januar', 'janvier', 'janeiro', 'enero', 'gennaio', 'jan'],
        ['february', 'februari', 'februar', 'fevrier', 'fevereiro', 'febrero', 'febbraio', 'feb', 'fev'],
        ['march', 'maart', 'marz', 'mars', 'marco', 'marzo', 'mar'],
        ['april', 'avril', 'abril', 'aprile', 'apr', 'abr'],
        ['may', 'mei', 'mai', 'maio', 'mayo', 'maggio', 'mag'],
        ['june', 'juni', 'juin', 'junho', 'junio', 'giugno', 'jun', 'giu'],
        ['july', 'juli', 'juillet', 'julho', 'julio', 'luglio', 'jul', 'lug'],
        ['august', 'augustus', 'aout', 'agosto', 'aug', 'ago'],
        ['september', 'septembre', 'setembro', 'septiembre', 'settembre', 'sep', 'sept', 'set'],
        ['october', 'oktober', 'octobre', 'outubro', 'octubre', 'ottobre', 'oct', 'okt', 'out', 'ott'],
        ['november', 'novembre', 'novembro', 'noviembre', 'nov'],
        ['december', 'dezember', 'decembre', 'dezembro', 'diciembre', 'dicembre', 'dec', 'dez', 'dic'],
    ];

    function monthIndex(word) {
        const w = fold(word).replace(/\.$/, '');
        if (!w || w.length < 3) return -1;
        for (let i = 0; i < 12; i++) {
            for (const name of MONTHS[i]) {
                if (name === w || (w.length >= 3 && name.startsWith(w) && w.length >= 3)) return i + 1;
            }
        }
        return -1;
    }

    // Word matching on attribute soup ("P71_DATA_NASCIMENTO_CC_input"): split
    // on anything that is not a letter, so "Update" and "candidate" stay out.
    const DATE_WORDS = /(^| )(date|birthdate|birthday|dob|born|nascimento|nasc|geboorte|geboortedatum|geburt|geburtsdatum|naissance|fecha|datum|data|anniversaire|cumpleanos|compleanno|verjaardag|bday)( |$)/;
    const NOT_DATE_WORDS = /(^| )(exp|expiry|expiration|expires|validade|vervaldatum|ablauf|cc)( |$)/;
    const MASK_RE = /(dd|jj|tt|mm|yyyy|yy|aaaa|aa|jjjj)/i;

    function words(s) {
        return ' ' + fold(s).replace(/[^\p{L}]+/gu, ' ').trim() + ' ';
    }

    // ------------------------------------------------------------ parsing

    // {y, m, d} from anything a profile or a model hands us.
    function parse(value, prefer = 'dmy') {
        const s = clean(value);
        if (!s) return null;
        let m;
        if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return valid(+m[1], +m[2], +m[3]);
        if ((m = s.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{4}|\d{2})$/))) {
            const a = +m[1], b = +m[2];
            let y = +m[3];
            if (m[3].length === 2) y += y > 30 ? 1900 : 2000;
            if (a > 12) return valid(y, b, a);
            if (b > 12) return valid(y, a, b);
            return prefer === 'mdy' ? valid(y, a, b) : valid(y, b, a);
        }
        if ((m = s.match(/^(\d{8})$/))) {
            const t = m[1];
            if (/^(19|20)\d{2}/.test(t) && +t.slice(4, 6) <= 12) return valid(+t.slice(0, 4), +t.slice(4, 6), +t.slice(6, 8));
            const a = +t.slice(0, 2), b = +t.slice(2, 4), y = +t.slice(4);
            if (a > 12) return valid(y, b, a);
            if (b > 12) return valid(y, a, b);
            return prefer === 'mdy' ? valid(y, a, b) : valid(y, b, a);
        }
        // "18 April 1985", "April 18, 1985", "18 de abril de 1985", "1985-Apr-18"
        const tokens = s.split(/[\s,./\-]+/).filter(Boolean);
        let mi = -1, d = null, y = null;
        for (const t of tokens) {
            if (/^\d{4}$/.test(t)) { y = +t; continue; }
            if (/^\d{1,2}$/.test(t)) { if (d === null) d = +t; else if (mi < 0 && +t <= 12) mi = +t; continue; }
            const k = monthIndex(t);
            if (k > 0) mi = k;
        }
        if (mi > 0 && d !== null && y !== null) return valid(y, mi, d);
        return null;
    }

    function valid(y, m, d) {
        if (!(y >= 1000 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
        return { y, m, d };
    }

    const pad = n => (n < 10 ? '0' : '') + n;

    // Render {y,m,d} in a format description {order:'dmy'|'mdy'|'ymd', sep, pad}.
    function render(p, f) {
        const parts = { d: f.pad === false ? String(p.d) : pad(p.d), m: f.pad === false ? String(p.m) : pad(p.m), y: f.yearLen === 2 ? String(p.y).slice(-2) : String(p.y) };
        return f.order.split('').map(c => parts[c]).join(f.sep);
    }

    // ------------------------------------------------------------ detection

    // A format the field describes itself with: placeholder "dd-mm-aaaa",
    // pattern, data-mask, an existing value, or the page's own error example
    // ("for example 9/3/2026", read against today's date).
    function maskFrom(text) {
        const t = fold(text);
        if (!t || !MASK_RE.test(t)) return null;
        const pos = [];
        const dayAt = t.search(/dd|jj|tt/), monAt = t.search(/mm/), yrAt = t.search(/yyyy|aaaa|jjjj|yy|aa/);
        if (dayAt < 0 || monAt < 0 || yrAt < 0) return null;
        pos.push(['d', dayAt], ['m', monAt], ['y', yrAt]);
        pos.sort((a, b) => a[1] - b[1]);
        const order = pos.map(x => x[0]).join('');
        const sepM = t.match(/[a-z]+([^a-z0-9\s])/);
        const yearLen = /yyyy|aaaa|jjjj/.test(t) ? 4 : 2;
        return { order, sep: sepM ? sepM[1] : '', yearLen, pad: true, from: 'mask' };
    }

    function formatFromExample(text) {
        const m = String(text || '').match(/(\d{1,2})([-\/.])(\d{1,2})\2(\d{4})/);
        if (!m) return null;
        const a = +m[1], b = +m[3], sep = m[2];
        const today = new Date();
        const dd = today.getDate(), mm = today.getMonth() + 1;
        const padded = m[1].length === 2 || m[3].length === 2;
        if (a === dd && b === mm && dd !== mm) return { order: 'dmy', sep, yearLen: 4, pad: padded, from: 'example' };
        if (a === mm && b === dd && dd !== mm) return { order: 'mdy', sep, yearLen: 4, pad: padded, from: 'example' };
        if (a > 12) return { order: 'dmy', sep, yearLen: 4, pad: padded, from: 'example' };
        if (b > 12) return { order: 'mdy', sep, yearLen: 4, pad: padded, from: 'example' };
        return null;
    }

    function formatFromValue(text) {
        const m = String(text || '').match(/^(\d{1,4})([-\/.])(\d{1,2})\2(\d{1,4})$/);
        if (!m) return null;
        if (m[1].length === 4) return { order: 'ymd', sep: m[2], yearLen: 4, pad: m[3].length === 2, from: 'value' };
        if (+m[1] > 12) return { order: 'dmy', sep: m[2], yearLen: m[4].length, pad: m[1].length === 2, from: 'value' };
        if (+m[3] > 12) return { order: 'mdy', sep: m[2], yearLen: m[4].length, pad: m[1].length === 2, from: 'value' };
        return null;
    }

    function pickerButtonFor(el) {
        const scopes = [];
        if (typeof ChoiceWidget !== 'undefined') { const w = ChoiceWidget.wrapperOf(el); if (w) scopes.push(w); }
        if (typeof AccName !== 'undefined') { const r = AccName.rowContainer(el, 4); if (r) scopes.push(r); }
        if (el.parentElement) scopes.push(el.parentElement);
        for (const s of scopes) {
            let cands = [];
            try { cands = s.querySelectorAll('button, [role="button"], a, svg, i, span[class*="icon" i]'); } catch (_) {}
            for (const c of cands) {
                if (c === el || c.contains(el)) continue;
                const txt = ((c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '') + ' ' + (c.className && typeof c.className === 'string' ? c.className : '') + ' ' + clean(c.textContent).slice(0, 40)).toLowerCase();
                if (/calendar|datepicker|date-picker|select date|choose date|pick|kalender|calendario|calendário|agenda|selecionar data|escolher data|apex-item-datepicker|ui-datepicker-trigger/.test(txt)) return c;
            }
        }
        return null;
    }

    function detect(el, info = {}) {
        const out = { isDate: false, native: false, mask: null, hasPicker: false, hint: false };
        if (!el || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return out;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (el.tagName === 'INPUT' && ['date', 'datetime-local', 'month', 'week', 'time'].includes(type)) {
            out.isDate = type !== 'time' && type !== 'week';
            out.native = true;
            return out;
        }
        if (el.tagName === 'INPUT' && !['text', 'tel', 'number', 'search'].includes(type)) return out;
        if (el.isContentEditable) return out;

        const ph = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '';
        out.mask = maskFrom(ph) || maskFrom(el.getAttribute('data-mask') || el.getAttribute('data-format') || el.getAttribute('data-date-format') || el.getAttribute('format') || '');
        const attrs = words([el.getAttribute('autocomplete'), el.name, el.id, el.className, el.getAttribute('aria-label'), ph, info.label, info.placeholder, el.getAttribute('data-type')].filter(Boolean).join(' '));
        // Card expiry ("MM/YY") is a date-shaped field that is not a date.
        if (NOT_DATE_WORDS.test(attrs) && !DATE_WORDS.test(words(info.label || ''))) return out;
        out.hint = DATE_WORDS.test(attrs) || /^bday/.test(el.getAttribute('autocomplete') || '');
        const hp = (el.getAttribute('aria-haspopup') || '').toLowerCase();
        const cls = ((el.className && typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + ((el.parentElement && el.parentElement.className) || '')).toLowerCase();
        out.hasPicker = hp === 'dialog' || hp === 'grid' || /datepicker|date-picker|daypicker|calendar|flatpickr|pikaday|dp__|rdp/.test(cls) || !!pickerButtonFor(el);
        out.isDate = !!out.mask || out.hint;
        return out;
    }

    // Describe the format for the model ("dd-mm-yyyy").
    function describeFormat(f) {
        if (!f) return null;
        const parts = { d: 'dd', m: 'mm', y: f.yearLen === 2 ? 'yy' : 'yyyy' };
        return f.order.split('').map(c => parts[c]).join(f.sep || '');
    }

    // ------------------------------------------------------------ typing

    function formatsFor(el, det, info) {
        const lang = (info.lang || document.documentElement.lang || navigator.language || '').toLowerCase();
        const list = [];
        const push = f => { if (f && !list.some(x => x.order === f.order && x.sep === f.sep && x.yearLen === f.yearLen && x.pad === f.pad)) list.push(f); };
        push(det.mask);
        push(formatFromExample(info.errorText));
        push(formatFromValue(el.getAttribute('value') || el.defaultValue));
        const usOrder = /^en-us/.test(lang) || lang === 'en';
        if (usOrder) push({ order: 'mdy', sep: '/', yearLen: 4, pad: true, from: 'lang' });
        push({ order: 'dmy', sep: '/', yearLen: 4, pad: true, from: 'lang' });
        push({ order: 'dmy', sep: '-', yearLen: 4, pad: true, from: 'lang' });
        if (!usOrder) push({ order: 'mdy', sep: '/', yearLen: 4, pad: true, from: 'lang' });
        push({ order: 'ymd', sep: '-', yearLen: 4, pad: true, from: 'iso' });
        return list.slice(0, 5);
    }

    function invalidNow(el) {
        try {
            if (typeof readValidation === 'function') {
                const v = readValidation(el);
                return v.invalid ? (v.message || 'invalid') : null;
            }
        } catch (_) {}
        return null;
    }

    function calendarOpen(el) {
        const doc = el.ownerDocument || document;
        const cands = [];
        const push = n => { if (n && n.nodeType === 1 && n !== el && !n.contains(el) && visible(n) && !cands.includes(n)) cands.push(n); };
        for (const attr of ['aria-controls', 'aria-owns']) {
            const v = el.getAttribute(attr);
            if (v) for (const id of v.split(/\s+/)) push(doc.getElementById(id));
        }
        let all = [];
        try { all = doc.querySelectorAll('[role="dialog"], [role="grid"], [role="application"], [class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i], [class*="daypicker" i], [class*="flatpickr" i], [class*="pika" i], [class*="picker" i], [id*="datepicker" i], [id*="calendar" i]'); } catch (_) {}
        for (const n of all) push(n);
        const hits = cands.filter(n => typeof ChoiceWidget !== 'undefined' ? ChoiceWidget.isCalendarish(n) || n.querySelector('[role="grid"], table') : true)
            .filter((n, _i, arr) => !arr.some(o => o !== n && n.contains(o)));
        return hits.length ? hits[hits.length - 1] : null;
    }

    function visible(n) {
        if (!n || !n.isConnected) return false;
        let r;
        try { r = n.getBoundingClientRect(); } catch (_) { return false; }
        if (r.width < 2 || r.height < 2) return false;
        const s = (n.ownerDocument.defaultView || window).getComputedStyle(n);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    function closePopup(el) {
        try { TypingEngine.pressKey(el, 'Escape'); } catch (_) {}
    }

    function valueMatches(el, p) {
        const v = TypingEngine.readValue(el);
        const dv = digits(v);
        if (!dv) return false;
        // Every rendering of the same date has the same digit multiset in some order.
        const want = [pad(p.d), pad(p.m), String(p.y)];
        const alts = [
            want[0] + want[1] + want[2], want[1] + want[0] + want[2], want[2] + want[1] + want[0],
            String(p.d) + String(p.m) + want[2], String(p.m) + String(p.d) + want[2],
            want[0] + want[1] + want[2].slice(-2), want[1] + want[0] + want[2].slice(-2),
            String(p.d) + String(p.m) + want[2].slice(-2), String(p.m) + String(p.d) + want[2].slice(-2),
        ];
        return alts.includes(dv);
    }

    async function typeAttempt(el, str, digitsOnly) {
        if (typeof EventSim !== 'undefined') EventSim.focus(el); else { try { el.focus(); } catch (_) {} }
        await wait(50);
        await TypingEngine.typeText(el, digitsOnly ? digits(str) : str, { clearFirst: true, isCancelled: () => window.stopFilling });
        await wait(120);
    }

    // ------------------------------------------------------------ calendar

    function classifySelect(sel) {
        const opts = Array.from(sel.options).map(o => clean(o.text));
        if (opts.length >= 12 && opts.length <= 14 && opts.filter(t => monthIndex(t) > 0).length >= 12) return 'month';
        if (opts.length >= 12 && opts.length <= 13 && opts.every(t => /^\d{1,2}$/.test(t) || t === '')) return 'month';
        if (opts.length >= 5 && opts.filter(t => /^\d{4}$/.test(t)).length >= opts.length - 1) return 'year';
        const lbl = ((sel.getAttribute('aria-label') || '') + ' ' + (sel.className || '') + ' ' + (sel.id || '')).toLowerCase();
        if (/month|mes|mês|maand|monat|mois/.test(lbl)) return 'month';
        if (/year|ano|jaar|jahr|annee|año/.test(lbl)) return 'year';
        return null;
    }

    async function setSelectTo(sel, wanted) {
        const entries = Array.from(sel.options).map(o => ({ text: clean(o.text), value: o.value, el: o }));
        let hit = entries.find(e => e.text === String(wanted) || e.value === String(wanted));
        if (!hit && typeof wanted === 'number') hit = entries.find(e => Number(e.text) === wanted || Number(e.value) === wanted);
        if (!hit) return false;
        try { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, hit.value); } catch (_) { sel.value = hit.value; }
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(150);
        return sel.value === hit.value;
    }

    function headerMonthYear(popup) {
        // "September 2026", "setembro de 2026", "2026年9月", "Sep 2026"
        let texts = [];
        try { texts = Array.from(popup.querySelectorAll('[class*="caption" i], [class*="title" i], [class*="header" i], [class*="month" i], [class*="year" i], [aria-live], th, h2, h3, h4, div, span')).filter(visible).map(n => clean(n.textContent)).filter(t => t && t.length <= 40); } catch (_) {}
        for (const t of texts) {
            const ym = t.match(/(\d{4})/);
            if (!ym) continue;
            for (const w of t.replace(/\d{4}/, ' ').split(/[\s,.]+/)) {
                const mi = monthIndex(w);
                if (mi > 0) return { m: mi, y: +ym[1] };
            }
            const num = t.match(/(\d{1,2})\s*[\/\-.]\s*(\d{4})|(\d{4})\s*[\/\-.年]\s*(\d{1,2})/);
            if (num) return num[1] ? { m: +num[1], y: +num[2] } : { m: +num[4], y: +num[3] };
        }
        return null;
    }

    function navButton(popup, dir) {
        let cands = [];
        try { cands = Array.from(popup.querySelectorAll('button, [role="button"], a, span, div')).filter(visible); } catch (_) {}
        // Real buttons first; a header div whose text happens to contain the
        // arrow glyphs must not win over the arrow button inside it.
        const isBtn = c => c.tagName === 'BUTTON' || c.tagName === 'A' || c.getAttribute('role') === 'button';
        cands = cands.filter(c => !c.querySelector('button, [role="button"], a'));
        cands.sort((a, b) => (isBtn(b) ? 1 : 0) - (isBtn(a) ? 1 : 0));
        const re = dir < 0 ? /prev|previous|back|anterior|vorige|zurück|precedent|précédent|earlier|‹|«|<|←|▲|chevron-left|arrow-left/i
                           : /next|forward|seguinte|próximo|proximo|volgende|weiter|suivant|later|›|»|>|→|▼|chevron-right|arrow-right/i;
        for (const c of cands) {
            const key = ((c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '') + ' ' + (c.className && typeof c.className === 'string' ? c.className : '') + ' ' + clean(c.textContent).slice(0, 20)).toLowerCase();
            if (/month|mes|mês|maand|monat|mois|›|‹|«|»|<|>|←|→/.test(key) || /prev|next|anterior|seguinte|vorige|volgende|zurück|weiter|precedent|suivant/.test(key)) {
                if (re.test(key) && !/year|ano|jaar|jahr|annee|année|año/.test(key)) return c;
            }
        }
        return null;
    }

    function dayCell(popup, d) {
        let cells = [];
        try { cells = Array.from(popup.querySelectorAll('[role="gridcell"], [role="gridcell"] > *, td, td > *, button, [class*="day" i], [class*="date" i]')).filter(visible); } catch (_) {}
        const want = String(d);
        const hits = cells.filter(c => clean(c.textContent) === want || c.getAttribute('aria-label') && new RegExp('(^|\\D)' + want + '(\\D|$)').test(c.getAttribute('aria-label')))
            .filter(c => clean(c.textContent) === want || /^\d{1,2}$/.test(clean(c.textContent)))
            .filter(c => !c.matches('[aria-disabled="true"], [disabled], .disabled'))
            .filter(c => !/(^|[\s_-])(other|outside|out-of-month|prev|next|adjacent|muted|disabled|hidden|placeholder|empty|blank)([\s_-]|$)/i.test((c.className || '') + ' ' + ((c.parentElement && c.parentElement.className) || '')))
            .filter(c => !c.querySelector || !c.querySelector('[role="gridcell"], td'));
        // Innermost only.
        const leaves = hits.filter(c => !hits.some(o => o !== c && c.contains(o)));
        if (!leaves.length) return null;
        if (leaves.length === 1) return leaves[0];
        // Duplicates are the neighbouring months' days: low numbers belong at the top, high ones at the bottom.
        leaves.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        return d <= 15 ? leaves[0] : leaves[leaves.length - 1];
    }

    async function driveCalendar(el, popup, p) {
        // Month / year selects.
        const selects = Array.from(popup.querySelectorAll('select')).filter(visible);
        let monthSel = null, yearSel = null;
        for (const s of selects) { const k = classifySelect(s); if (k === 'month' && !monthSel) monthSel = s; else if (k === 'year' && !yearSel) yearSel = s; }
        if (yearSel) await setSelectTo(yearSel, p.y);
        if (monthSel) {
            const entries = Array.from(monthSel.options).map(o => clean(o.text));
            const idx = entries.findIndex(t => monthIndex(t) === p.m || Number(t) === p.m);
            if (idx >= 0) {
                const o = monthSel.options[idx];
                try { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(monthSel, o.value); } catch (_) { monthSel.selectedIndex = idx; }
                monthSel.dispatchEvent(new Event('input', { bubbles: true }));
                monthSel.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(150);
            }
        }
        // Prev / next navigation for what the selects did not cover.
        // A picker without a year select is paged month by month; a birth
        // date is hundreds of pages away, so keep the pace up and the cap high.
        let live = calendarOpen(el) || popup;
        for (let i = 0; i < 720; i++) {
            if (window.stopFilling) throw new Error('Form filling stopped by user.');
            const h = headerMonthYear(live);
            if (!h) break;
            const delta = (p.y - h.y) * 12 + (p.m - h.m);
            if (delta === 0) break;
            const btn = navButton(live, delta < 0 ? -1 : 1);
            if (!btn) break;
            AutocompleteFiller.mouseSequence(btn);
            await wait(Math.abs(delta) > 24 ? 25 : 120);
            live = calendarOpen(el) || live;
            if (!live.isConnected) break;
        }
        live = calendarOpen(el) || live;
        const cell = dayCell(live, p.d);
        if (!cell) return false;
        AutocompleteFiller.mouseSequence(cell);
        await wait(250);
        if (!valueMatches(el, p)) { try { cell.click(); } catch (_) {} await wait(200); }
        return valueMatches(el, p) || (typeof ChoiceWidget !== 'undefined' && (() => { const s = ChoiceWidget.readSelection(el); return !!(s && valueMatchesText(s.text, p)); })());
    }

    function valueMatchesText(t, p) {
        const dv = digits(t);
        return dv.includes(String(p.y)) && dv.includes(pad(p.d)) || dv.includes(String(p.y)) && new RegExp('(^|\\D)' + p.d + '(\\D|$)').test(t);
    }

    // ------------------------------------------------------------ fill

    async function fill(el, value, info = {}) {
        const det = detect(el, info);
        const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
        const p = parse(value, /^en-us/.test(lang) ? 'mdy' : 'dmy');
        const tried = [];
        const done = (ok, strategy, extra) => ({ ok, strategy, tried, finalValue: TypingEngine.readValue(el), ...extra });
        if (!p) return done(false, 'date', { error: `Not a date: ${value}` });

        if (det.native) {
            const type = (el.getAttribute('type') || '').toLowerCase();
            const iso = type === 'month' ? `${p.y}-${pad(p.m)}` : `${p.y}-${pad(p.m)}-${pad(p.d)}` + (type === 'datetime-local' ? 'T00:00' : '');
            if (typeof EventSim !== 'undefined') EventSim.focus(el);
            TypingEngine.setValueNatively(el, iso);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            tried.push(iso);
            await wait(60);
            const ok = el.value === iso;
            TypingEngine.commitField(el, { change: false });
            if (ok) { try { el.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {} }
            return done(ok, 'date-native');
        }

        const formats = formatsFor(el, det, info);
        const typable = TypingEngine.isTypable(el);
        // A field with its own calendar button usually wants the calendar;
        // give typing two chances, not seven, before opening it.
        const maxTyped = det.hasPicker && !det.mask ? 2 : 6;
        if (typable) {
            for (const f of formats) {
                if (tried.length >= maxTyped) break;
                const str = render(p, f);
                // A mask places its own separators: give it the digits first.
                const modes = det.mask && f.sep ? [true, false] : (f.sep ? [false, true] : [false]);
                for (const digitsOnly of modes) {
                    const label = digitsOnly ? digits(str) : str;
                    if (tried.includes(label)) continue;
                    tried.push(label);
                    await typeAttempt(el, str, digitsOnly);
                    closePopup(el);
                    if (!valueMatches(el, p)) continue;
                    TypingEngine.commitField(el);
                    await wait(200);
                    const err = invalidNow(el);
                    if (!err) {
                        try { el.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {}
                        return done(true, digitsOnly ? 'date-digits' : 'date-typed', { format: describeFormat(f) });
                    }
                }
                if (tried.length >= maxTyped) break;
            }
        }

        // The calendar. Open it through the field or its button.
        if (typeof EventSim !== 'undefined') EventSim.focus(el);
        await wait(150);
        let popup = calendarOpen(el);
        if (!popup) {
            const btn = pickerButtonFor(el);
            if (btn) { AutocompleteFiller.mouseSequence(btn); await wait(300); popup = calendarOpen(el); }
        }
        if (!popup && typable) {
            // Some pickers open on typing; others on ArrowDown.
            TypingEngine.pressKey(el, 'ArrowDown');
            await wait(250);
            popup = calendarOpen(el);
        }
        if (popup) {
            tried.push('calendar');
            const ok = await driveCalendar(el, popup, p);
            await wait(150);
            closePopup(el);
            TypingEngine.commitField(el, { change: ok ? undefined : false });
            if (ok) {
                try { el.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {}
                return done(true, 'date-calendar');
            }
        }

        // Nothing convinced the field; leave the best-formatted text in it so
        // the person sees what was meant.
        if (typable && formats.length) {
            const str = render(p, formats[0]);
            await typeAttempt(el, str, !!det.mask);
            closePopup(el);
            TypingEngine.commitField(el);
        }
        return done(valueMatches(el, p) && !invalidNow(el), 'date-typed', { format: describeFormat(formats[0]) });
    }

    return { detect, parse, fill, render, describeFormat, maskFrom, formatFromExample, monthIndex, MONTHS };
})();

if (typeof window !== 'undefined') window.DateField = DateField;
