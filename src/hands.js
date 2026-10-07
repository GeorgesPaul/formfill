// hands.js -- what a person's hands do to a page.
//
// Five actions, and nothing in them knows a widget by name:
//
//   type(el, text)     click into it, then type on the keyboard
//   choose(el, text)   click it, then click the entry with that text in
//                      whatever opened
//   check(el, on)      click a checkbox, switch or radio until it is on or off
//   click(el)          press it with the mouse
//   press(key)         one key on the keyboard, wherever the cursor is
//
// Input is real when the browser grants it (trustedInput.js): the click moves
// focus, the keystrokes go through the page's own masks and handlers, exactly
// as for a person. Without it the same gestures are reproduced as events
// (eventSim.js for the mouse and focus, typingEngine.js for the keyboard).
// This file is the only place that chooses between the two.
//
// Nothing is verified or repaired here. Each action reports what the control
// shows afterwards; whether that is right is for whoever reads the page (the
// model, in fillAgent.js) to judge. The only things set through the DOM
// instead of by hand are the controls whose pop-up belongs to the browser and
// cannot be clicked from inside the page: <select> and the native date, time,
// colour and range inputs.
const Hands = (function () {
    'use strict';

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const STOPPED = 'Form filling stopped by user.';
    const realInput = () => typeof TrustedInput !== 'undefined' && TrustedInput.active();

    const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'password']);
    const KEYS = {
        enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape',
        arrowdown: 'ArrowDown', down: 'ArrowDown', arrowup: 'ArrowUp', up: 'ArrowUp',
        arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
        backspace: 'Backspace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End',
        pagedown: 'PageDown', pageup: 'PageUp', space: 'Space', ' ': 'Space',
    };
    // Buttons that send or finalize a form are the user's to press. A button
    // that leads on to more of the form (the second list) is not one of them,
    // even when the page marks it up as a submit button.
    const SENDS = /\b(submit|send|pay|order|buy|purchase|register|sign ?up|sign ?in|log ?in|create (my )?account|confirm|book|checkout|place order|apply|save|finish|complete|done|agree and|verstuur|verzend|bestel|betaal|opslaan|bevestig|afronden|inloggen|aanmelden|abschicken|absenden|senden|bestellen|zahlen|speichern|anmelden|envoyer|payer|commander|enregistrer|valider|enviar|pagar|comprar|guardar|submeter|confirmar|entrar|autenticar|registar|registrar|invia|paga|conferma|accedi)\b/i;
    const LEADS_ON = /\b(next|continue|proceed|go on|verder|volgende|doorgaan|weiter|fortfahren|suivant|continuer|siguiente|continuar|prosseguir|avançar|avancar|seguinte|continua|avanti|prosegui|procedi|nästa|fortsätt|neste|næste|videre|dalej|další|tovább|devam)\b/i;

    // ------------------------------------------------------------ waiting for the page

    // Resolves once the document has stopped changing for `quiet` ms, or
    // after `max` ms at the latest.
    function settle(quiet, max) {
        return new Promise(resolve => {
            let timer = null, observer = null;
            const done = () => {
                if (observer) { try { observer.disconnect(); } catch (_) {} }
                clearTimeout(timer);
                clearTimeout(limit);
                resolve();
            };
            const bump = () => { clearTimeout(timer); timer = setTimeout(done, quiet); };
            try {
                observer = new MutationObserver(bump);
                observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            } catch (_) {}
            const limit = setTimeout(done, max);
            bump();
        });
    }

    // Animations that are on their way to an end: a menu fading out, a panel
    // sliding open. (Not the ones that run forever, like a spinner.)
    function moving() {
        try {
            return document.getAnimations().some(a => {
                if (a.playState !== 'running' || !a.effect) return false;
                const t = a.effect.getComputedTiming();
                return isFinite(t.endTime) && t.endTime <= 4000;
            });
        } catch (_) { return false; }
    }

    // Wait until nothing is moving on screen any more. A person does not
    // click into a page while a list is still closing; acting in that moment
    // lands on things that are about to vanish, or loses the cursor to
    // whatever the closing widget does when it is gone.
    async function whenStill(max = 1200) {
        const t0 = Date.now();
        let waited = false;
        while (moving() && Date.now() - t0 < max) { waited = true; await wait(50); }
        if (waited) await settle(80, 400);
    }

    // The page has reacted and come to rest: no changes for `quiet` ms, and
    // nothing still animating.
    async function atRest(quiet, max) {
        await settle(quiet, max);
        await whenStill();
    }

    // ------------------------------------------------------------ taking turns

    // Keyboard focus belongs to the tab, not to a frame, and every frame with
    // fields runs its own fill. An action holds the tab's turn (kept by the
    // background page) from the click into its field until it is done, so
    // the frames act one after another instead of typing into each other.
    const turn = (function () {
        let token = null, renew = null;
        const send = msg => {
            try { return Promise.resolve(browser.runtime.sendMessage({ action: 'ffInputLock', ...msg })); }
            catch (e) { return Promise.reject(e); }
        };
        const off = () => !!window.__ffNoInputLock;   // bench switch (floorp_rig --no-lock)
        async function take(isCancelled) {
            if (off()) return;
            token = Math.random().toString(36).slice(2) + Date.now().toString(36);
            // No answer from the background (reloaded, asleep): go ahead alone.
            try { await send({ op: 'acquire', token }); } catch (_) {}
            renew = setInterval(() => { send({ op: 'renew', token }).catch(() => {}); }, 5000);
            if (isCancelled()) { give(); throw new Error(STOPPED); }
        }
        function give() {
            if (off() || !token) return;
            clearInterval(renew);
            send({ op: 'release', token }).catch(() => {});
            token = null;
        }
        // The fill was stopped or the page is leaving: give up the turn and
        // the place in the queue.
        function drop() {
            clearInterval(renew);
            token = null;
            send({ op: 'drop' }).catch(() => {});
        }
        return { take, give, drop };
    })();

    // ------------------------------------------------------------ the cursor

    function deepActive() {
        let a = document.activeElement;
        for (let i = 0; i < 8 && a; i++) {
            let root = null;
            try { root = a.shadowRoot || a.openOrClosedShadowRoot || null; } catch (_) {}
            if (root && root.activeElement) a = root.activeElement; else break;
        }
        return a;
    }

    // Somewhere the keyboard writes into.
    function takesText(el) {
        if (!el || el.disabled) return false;
        if (el.isContentEditable) return true;
        if (el.tagName === 'TEXTAREA') return !el.readOnly;
        return el.tagName === 'INPUT' && !el.readOnly && TEXT_INPUT_TYPES.has(el.type);
    }

    function cursorTarget() {
        const a = deepActive();
        return takesText(a) ? a : null;
    }

    function cursorIn(el) {
        const a = cursorTarget();
        return !!a && (a === el || el.contains(a));
    }

    const isTextBox = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    const isDisabled = el => el.disabled || el.getAttribute('aria-disabled') === 'true';
    // The node a control lives in now, should the page have re-rendered it.
    const current = el => (el.isConnected ? el : TypingEngine.live(el));

    // ------------------------------------------------------------ click

    function describeCover(layer) {
        const text = PageView.plainText(layer, 80);
        return text ? '"' + text + '"' : 'a layer without text';
    }

    async function click(el) {
        if (!el || !el.isConnected) return { ok: false, error: 'it is no longer on the page' };
        // What is not showing cannot be clicked: not by a person, so not here.
        if (!PageView.onScreen(el)) {
            return { ok: false, error: 'it is not showing any more (a list entry disappears when its list closes: bring the list back first)' };
        }
        if (realInput()) {
            const r = await TrustedInput.click(el);
            if (r.ok) { await wait(40); return { ok: true, input: 'real' }; }
            if (r.reason === 'occluded') {
                const rect = el.getBoundingClientRect();
                const inWindow = rect.width >= 1 && rect.height >= 1 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
                if (inWindow) {
                    const cover = PageView.coverOf(el, rect, true);
                    if (cover) return { ok: false, covered: true, error: 'something on top of the page covers it: ' + describeCover(cover) };
                    // Part of its own widget is drawn over it (a placeholder
                    // over its input): the press lands there, as a person's would.
                    const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
                    const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
                    const press = await TrustedInput.run([
                        { kind: 'mouse', type: 'mousemove', x, y }, { kind: 'wait', ms: 15 },
                        { kind: 'mouse', type: 'mousedown', x, y }, { kind: 'wait', ms: 30 },
                        { kind: 'mouse', type: 'mouseup', x, y },
                    ]);
                    if (press.ok) { await wait(40); return { ok: true, input: 'real' }; }
                }
            }
        }
        EventSim.focus(el);
        await wait(30);
        return { ok: true, input: 'synthetic' };
    }

    // ------------------------------------------------------------ keys

    // Type on the keyboard, to wherever the cursor is. A field that hands the
    // cursor on while it is typed into (a date in three parts) keeps getting
    // the keys, as it would from a person who just keeps typing.
    async function keys(text, isCancelled) {
        if (realInput()) {
            const cursorSomewhere = async () => { const a = deepActive(); return !!a && a !== document.body && a !== document.documentElement; };
            const t = await TrustedInput.type(text, { isCancelled, ensureFocus: cursorSomewhere });
            if (t.ok) return { ok: true, input: 'real' };
            if (t.error === 'field lost focus') return { ok: false, error: 'the cursor left the page after ' + (t.typed || 0) + ' characters' };
            return { ok: false, error: 'typing failed: ' + (t.error || 'unknown') };
        }
        const typed = await TypingEngine.type(text, cursorTarget, isCancelled);
        return typed ? { ok: true, input: 'synthetic' } : { ok: false, error: 'nothing on the page takes the keystrokes' };
    }

    // One named key, to wherever the cursor is.
    async function pressKey(name) {
        const a = deepActive();
        const focused = !!a && a !== document.body && a !== document.documentElement;
        if (realInput() && focused && (await TrustedInput.key(name)).ok) return;
        TypingEngine.key(focused ? a : document.body, name);
    }

    function selectContents(el) {
        try { el.select(); } catch (_) { try { el.setSelectionRange(0, el.value.length); } catch (_) {} }
    }

    // ------------------------------------------------------------ type

    // What a control holds, unmasked (results show a password as hidden).
    const held = el => (isTextBox(el) ? el.value : PageView.valueOf(el));

    // The browser's own pickers cannot be operated from inside the page; the
    // value they stand for is set directly, in the format the control defines.
    function setNative(el, text, type) {
        EventSim.enter(el);
        TypingEngine.setValueNatively(el, text);
        if (text && !el.value) return { ok: false, now: '', error: 'this ' + type + ' field takes its value as ' + PageView.NATIVE_VALUE[type] };
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, now: el.value, input: 'value' };
    }

    async function type(el, value, isCancelled) {
        const text = String(value == null ? '' : value);
        if (el.tagName === 'SELECT') return choose(el, text, isCancelled);
        if (isDisabled(el)) return { ok: false, error: 'it is disabled' };
        if (el.tagName === 'INPUT' && PageView.NATIVE_VALUE[el.type]) return setNative(el, text, el.type);
        if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return check(el, isYes(text));
        if (isTextBox(el) && el.readOnly) {
            return { ok: false, error: 'it is read-only (it probably opens a picker when clicked: click it and look)' };
        }
        const before = held(el);
        const pageBefore = PageView.capture({ baseline: null });

        // The cursor goes into the field by clicking it, unless it is there.
        if (!cursorIn(el)) {
            const c = await click(el);
            if (!c.ok) return c;
            await settle(100, 700);
            el = current(el);
        }
        const target = cursorTarget();
        if (!target) {
            // Whatever the click did instead (opened a list, a picker) has to be looked at.
            return { ok: false, look: true, now: PageView.valueOf(el), error: 'clicking it did not put the cursor in anything that takes text' };
        }

        // What a text box already holds is replaced: selected, then typed over.
        if (isTextBox(target) && target.value !== '') {
            selectContents(target);
            if (text === '') { await pressKey('Backspace'); await wait(40); }
        }
        if (text === '') {
            await settle(80, 500);
            return { ok: held(current(el)) === '' || !isTextBox(target), now: PageView.valueOf(current(el)) };
        }

        let k = await keys(text, isCancelled);
        await settle(120, 900);
        if (k.ok && k.input === 'real' && held(current(el)) === before && before !== text) {
            // Real keystrokes that left no trace: say it with events instead.
            if (await TypingEngine.type(text, cursorTarget, isCancelled)) k = { ok: true, input: 'synthetic' };
            await settle(120, 900);
        }
        el = current(el);
        const now = PageView.valueOf(el);
        if (!k.ok) return { ok: false, now, error: k.error };
        if (held(el) === before && before !== text) return { ok: false, now, error: 'typing did not change what it shows' };

        const out = { ok: true, now, input: k.input };
        // A list of suggestions under the field is something a person stops
        // to look at. (Not the small things a field grows next to itself, and
        // not a calendar: the date is typed already.)
        const offered = appearedSince(pageBefore).filter(e => !besideField(e.el, target) && !inGrid(e.el));
        if (offered.length) { out.suggestions = offered.slice(0, 12).map(e => e.text); out.listOpen = true; }
        return out;
    }

    // An adornment of the field itself: a clear button, a status icon.
    function besideField(node, field) {
        const a = node.getBoundingClientRect(), b = field.getBoundingClientRect();
        return a.left >= b.left - 48 && a.right <= b.right + 48 && a.top >= b.top - 10 && a.bottom <= b.bottom + 10;
    }

    function inGrid(node) {
        return !!node.closest('table, [role="grid"]');
    }

    // ------------------------------------------------------------ choose

    // Text reduced to its words: case, accents, punctuation and emoji aside.
    const fold = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

    // The entry that says `want`: the same words, or the only one that
    // starts with them, or the only one that contains them.
    function matchEntry(entries, want) {
        const w = fold(want);
        if (!w) return null;
        const exact = entries.find(e => e.key === w);
        if (exact) return exact;
        if (w.length < 2) return null;
        const starts = entries.filter(e => e.key.startsWith(w) || (e.key.length >= 3 && w.startsWith(e.key)));
        if (starts.length === 1) return starts[0];
        const has = entries.filter(e => e.key.includes(w));
        return has.length === 1 ? has[0] : null;
    }

    // A native <select>: its list is drawn by the browser, so the option is
    // set directly, with the events a pick sends.
    function chooseNative(select, want) {
        const entries = Array.from(select.options).map(o => ({ option: o, text: o.text.replace(/\s+/g, ' ').trim(), key: fold(o.text) }));
        let m = matchEntry(entries, want);
        if (!m) {
            const byValue = entries.filter(e => fold(e.option.value) === fold(want));
            if (byValue.length === 1) m = byValue[0];
        }
        if (!m) return { ok: false, now: PageView.valueOf(select), error: 'no option "' + want + '"', shown: entries.map(e => e.text).filter(Boolean).slice(0, 120) };
        if (m.option.disabled) return { ok: false, now: PageView.valueOf(select), error: 'the option "' + m.text + '" is disabled' };
        EventSim.enter(select);
        if (select.multiple) m.option.selected = true;
        else TypingEngine.setValueNatively(select, m.option.value);
        if (!m.option.selected) m.option.selected = true;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, picked: m.text, now: PageView.valueOf(select), input: 'value' };
    }

    // Everything clickable that was not on the page at `before`.
    function appearedSince(before) {
        return PageView.capture({ baseline: before.baseline }).items
            .filter(i => i.isNew && i.pickable && (i.text || i.name))
            .map(i => ({ el: i.el, text: i.text || i.name, key: fold(i.text || i.name) }));
    }

    // Click the control, look at what appeared, click the entry that says
    // `want`. When no such entry is in sight and the cursor sits in a text
    // box (a search box in the list, or the control itself), type the words
    // and look again: that is what a person does with a long list.
    async function choose(el, value, isCancelled) {
        const want = String(value == null ? '' : value);
        if (el.tagName === 'SELECT') return chooseNative(el, want);
        if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) return check(el, true);
        if (isDisabled(el)) return { ok: false, error: 'it is disabled' };

        const before = PageView.capture({ baseline: null });
        const c = await click(el);
        if (!c.ok) return c;
        await atRest(150, 1200);
        let entries = appearedSince(before);
        let m = matchEntry(entries, want);
        const box = cursorTarget();
        if (!m && box) {
            if (isTextBox(box) && box.value !== '') selectContents(box);
            if ((await keys(want, isCancelled)).ok) {
                // The list may come from the network: look a few times.
                for (let i = 0; i < 6 && !m; i++) {
                    if (isCancelled && isCancelled()) throw new Error(STOPPED);
                    await settle(200, 700);
                    entries = appearedSince(before);
                    m = matchEntry(entries, want);
                }
            }
        }
        if (!m) {
            return {
                ok: false, now: PageView.valueOf(current(el)), listOpen: entries.length > 0,
                error: entries.length ? 'the list that opened has no entry "' + want + '"' : 'no list opened',
                shown: entries.map(e => e.text).slice(0, 60),
            };
        }
        const pick = await click(m.el);
        if (!pick.ok) return { ok: false, now: PageView.valueOf(current(el)), listOpen: true, error: 'the entry "' + m.text + '" could not be clicked: ' + pick.error };
        await atRest(150, 1200);
        const out = { ok: true, picked: m.text, input: pick.input };
        // Many list widgets show the choice beside their box, not in it.
        const now = PageView.valueOf(current(el));
        if (now) out.now = now;
        else out.note = 'the choice is shown in the box of the field, not as typed text';
        return out;
    }

    // ------------------------------------------------------------ check

    function isYes(value) {
        if (value === false) return false;
        return !['false', '0', 'no', 'n', 'off', 'unchecked', 'uncheck'].includes(String(value == null ? '' : value).trim().toLowerCase());
    }

    async function check(el, want) {
        const state = () => PageView.checkedState(current(el));
        const was = state();
        if (was === null) return { ok: false, error: 'it is not a checkbox, switch or radio' };
        if (was === want) return { ok: true, now: was, note: 'it already was' };
        if (el.tagName === 'INPUT' && el.type === 'radio' && !want) return { ok: false, now: was, error: 'a radio is cleared by selecting another one' };
        if (isDisabled(el)) return { ok: false, now: was, error: 'it is disabled' };
        const c = await click(el);
        if (!c.ok) return { ...c, now: was };
        await settle(80, 600);
        if (state() !== want && c.input === 'real') {
            // The press landed on its stand-in without toggling it.
            EventSim.focus(el);
            await settle(80, 600);
        }
        const now = state();
        return now === want ? { ok: true, now, input: c.input } : { ok: false, now, error: 'clicking it did not change it' };
    }

    // ------------------------------------------------------------ press

    // Enter in a form field is also how a form gets sent. Sending is left to
    // the user: a submission that starts while Enter is pressed is stopped.
    function submitGuard() {
        let blocked = false;
        const stop = e => { blocked = true; e.preventDefault(); e.stopImmediatePropagation(); };
        window.addEventListener('submit', stop, true);
        return () => { window.removeEventListener('submit', stop, true); return blocked; };
    }

    async function press(key) {
        const name = KEYS[String(key == null ? '' : key).trim().toLowerCase()];
        if (!name) return { ok: false, error: 'unknown key "' + key + '" (Tab, Escape, Enter, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Delete, Home, End, Space)' };
        const endGuard = name === 'Enter' ? submitGuard() : null;
        let sent = false;
        try {
            await pressKey(name);
            await atRest(120, 900);
        } finally {
            if (endGuard) sent = endGuard();
        }
        return sent ? { ok: false, error: 'Enter would have sent the form; that is left to the user' } : { ok: true };
    }

    // ------------------------------------------------------------ click, as an action

    // Does pressing this send or finalize the form?
    function sendsForm(el) {
        const isButton = el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' ||
            (el.tagName === 'INPUT' && /^(submit|button|image)$/.test(el.type));
        if (!isButton) return false;
        const text = PageView.label(el);
        return ((el.getAttribute('type') || '').toLowerCase() === 'submit' || SENDS.test(text)) && !LEADS_ON.test(text);
    }

    async function clickAction(el) {
        if (el.tagName === 'SELECT') return { ok: false, error: 'this is a dropdown: use choose with the option text' };
        if (isDisabled(el)) return { ok: false, error: 'it is disabled' };
        if (sendsForm(el)) return { ok: false, error: '"' + PageView.label(el) + '" sends or finalizes the form; pressing it is left to the user' };
        const before = PageView.capture({ baseline: null }).digest;
        const url = location.href;
        const c = await click(el);
        if (!c.ok) return c;
        await atRest(250, 2500);
        const out = { ok: true, input: c.input };
        // A click that leaves the page looking exactly as it did is worth
        // saying so: pressing it again will not do more.
        if (location.href === url && PageView.capture({ baseline: null }).digest === before) out.note = 'nothing visible on the page changed';
        return out;
    }

    // Let go of the field the cursor is still in, as moving on does: the page
    // gets its change and blur, and whatever validates on leaving runs.
    function letGo() {
        const a = deepActive();
        if (!a || a === document.body || a === document.documentElement) return false;
        if (!takesText(a) && a.tagName !== 'SELECT') return false;
        // A focused page that was really typed into sends its own change.
        EventSim.leave(a, { change: document.hasFocus() && realInput() ? false : undefined });
        return true;
    }

    // ------------------------------------------------------------ a batch

    const OPS = {
        fill: 'type', enter: 'type', input: 'type', write: 'type', clear: 'type',
        select: 'choose', pick: 'choose',
        set: 'check', toggle: 'check', tick: 'check', uncheck: 'check',
        key: 'press', keypress: 'press',
    };
    const opOf = a => { const o = String(a.op || '').toLowerCase().trim(); return OPS[o] || o; };

    // The element an action is about: by its number, or for a click on
    // something that carries none, by the words it shows. Code that has the
    // element already (the credential fill) passes it as `el`.
    function targetOf(a, op) {
        if (a.el) return { el: a.el };
        if (a.ref !== undefined && a.ref !== null && a.ref !== '') {
            const el = PageView.resolve(a.ref);
            return el ? { el } : { error: 'nothing on the page has this number any more' };
        }
        if (op === 'click' && typeof a.value === 'string' && a.value.trim()) return PageView.findText(a.value);
        return { error: 'no number given' };
    }

    function perform(op, a, el, isCancelled) {
        const said = String(a.op || '').toLowerCase().trim();
        if (op === 'type') return type(el, said === 'clear' ? '' : a.value, isCancelled);
        if (op === 'choose') return choose(el, a.value, isCancelled);
        if (op === 'check') return check(el, said === 'uncheck' ? false : isYes(a.value));
        if (op === 'click') return clickAction(el);
        if (op === 'press') return press(a.value !== undefined ? a.value : a.key);
        return { ok: false, error: 'unknown op "' + a.op + '" (type, choose, check, click, press)' };
    }

    // Run actions in order. The batch ends early when the page has to be
    // looked at again before anything else makes sense: a list is left open,
    // a click or a key brought up something new, or something covers the page.
    //
    // opts: isCancelled(), onBefore(action, el), onAfter(action, el, result).
    // Returns { results, stopped (the reason, or null), notExecuted }.
    async function run(actions, opts = {}) {
        const isCancelled = opts.isCancelled || (() => false);
        const startUrl = location.href.replace(/#.*$/, '');
        const results = [];
        let stopped = null;
        for (let i = 0; i < actions.length && !stopped; i++) {
            if (isCancelled()) throw new Error(STOPPED);
            if (location.href.replace(/#.*$/, '') !== startUrl) { stopped = 'the page went to another address'; break; }
            const a = actions[i] || {};
            const op = opOf(a);
            const res = { op, ok: false };
            if (a.ref !== undefined) res.ref = a.ref;
            if (a.value !== undefined) res.value = a.value;
            results.push(res);

            let el = null;
            if (op !== 'press') {
                const t = targetOf(a, op);
                if (!t.el) { res.error = t.error; continue; }
                el = t.el;
                res.what = PageView.label(el);
            }
            if (opts.onBefore) opts.onBefore(a, el);
            const t0 = Date.now();
            await whenStill();
            await turn.take(isCancelled);
            try {
                Object.assign(res, await perform(op, a, el, isCancelled));
            } catch (e) {
                if (e && e.message === STOPPED) throw e;
                res.ok = false;
                res.error = (e && e.message) || String(e);
            } finally {
                turn.give();
            }
            res.ms = Date.now() - t0;
            if (opts.onAfter) opts.onAfter(a, el, res);

            if (res.covered) stopped = 'something covers the page';
            else if (res.listOpen) stopped = 'a list is open';
            else if (res.look) stopped = 'the page changed in a way that has to be looked at';
            else if (((op === 'click' && res.ok) || op === 'press') && i + 1 < actions.length && opOf(actions[i + 1]) !== 'press') {
                // A click or a key is pressed to make something happen. When
                // it made something appear, that has to be looked at before
                // going on. When all it did was make something go away or
                // switch state, the batch carries on.
                if (PageView.capture().hasNew) stopped = 'the ' + op + ' brought up something new';
            }
        }
        return { results, stopped, notExecuted: actions.slice(results.length) };
    }

    return { run, letGo, atRest, dropTurn: turn.drop };
})();

if (typeof window !== 'undefined') window.Hands = Hands;
