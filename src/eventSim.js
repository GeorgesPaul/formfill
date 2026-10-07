// eventSim.js -- the browser's own input event sequences, reproduced faithfully.
//
// WHY THIS EXISTS
//
// Events dispatched from a content script are `isTrusted: false`, and browsers
// run default actions only for trusted events. A synthetic keydown never
// inserts a character, a synthetic mousedown never moves focus, a synthetic
// Enter never submits. So an extension cannot make the browser type for it: it
// must reproduce, exactly, the events the browser would have emitted.
//
// The failure that motivated this module: when the fill is driven from the
// sidebar / side panel, the PAGE IS NOT FOCUSED. In that state `el.focus()`
// and `el.blur()` are pure bookkeeping in both engines (Gecko's nsFocusManager
// takes its inactive-window branch, Blink's Document::SetFocusedElement guards
// dispatch on page focus): `document.activeElement` changes but NO focus or
// blur event is dispatched. Every page that validates on blur therefore never
// validates. It looks like a correct fill (the value is there, no error shown)
// while the form still considers the field untouched and keeps its Continue
// button disabled. Chasing that one event would have been a patch; the class of
// bug is "an event the browser would have sent did not happen".
//
// THE APPROACH
//
// The sequences are finite and specified (UI Events, Input Events, HTML). They
// are written down here as tables. For every step we ask a different question
// than "should we dispatch this?": we ask "did this event actually happen?".
// Whatever the browser emitted (because the page happened to be focused, or
// because a widget did it itself) is left alone; only the missing steps are
// synthesized, in spec order. The same code is therefore correct whether the
// page is focused or not, no event is delivered twice, and a new gap shows up
// as a missing table entry instead of as another special case.
//
// What still cannot be reproduced: default actions the browser reserves for
// trusted events (form submission from Enter, native autofill UI, IME
// composition, clipboard access). Real input (trustedInput.js) has none of
// these limits; this module is what hands.js falls back to without it.
const EventSim = (function () {
    'use strict';

    // ---------------------------------------------------------------- tables

    // Mouse press on a control, in the order the browser emits it.
    // The focus change is the DEFAULT ACTION of mousedown, so it belongs
    // between these two halves, not before or after them.
    const SEQ_PRESS = [
        'pointerover', 'pointerenter', 'mouseover', 'mouseenter',
        'pointermove', 'mousemove',
        'pointerdown', 'mousedown',
    ];
    const SEQ_RELEASE = ['pointerup', 'mouseup', 'click'];

    // Focus arriving at / leaving a control. Order matters: the old element is
    // fully done (change, blur, focusout) before the new one is entered.
    const SEQ_FOCUS_IN = ['focus', 'focusin'];
    const SEQ_LEAVE = ['change', 'blur', 'focusout'];

    // One character of text entry (keyboard + input events).
    const SEQ_KEY = ['keydown', 'keypress', 'beforeinput', 'input', 'keyup'];

    const NON_BUBBLING = new Set(['focus', 'blur', 'mouseenter', 'mouseleave', 'pointerenter', 'pointerleave']);
    const CANCELABLE = new Set([
        'pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown',
        'pointerup', 'mouseup', 'click', 'keydown', 'keypress', 'keyup', 'beforeinput',
    ]);

    function ctorFor(type) {
        const W = typeof window !== 'undefined' ? window : {};
        switch (type) {
            case 'pointerover': case 'pointerenter': case 'pointermove':
            case 'pointerdown': case 'pointerup': case 'pointerleave':
                return W.PointerEvent || W.MouseEvent || W.Event;
            case 'mouseover': case 'mouseenter': case 'mousemove':
            case 'mousedown': case 'mouseup': case 'click': case 'mouseleave':
                return W.MouseEvent || W.Event;
            case 'keydown': case 'keypress': case 'keyup':
                return W.KeyboardEvent || W.Event;
            case 'beforeinput': case 'input':
                return W.InputEvent || W.Event;
            case 'focus': case 'blur': case 'focusin': case 'focusout':
                return W.FocusEvent || W.Event;
            default:
                return W.Event;
        }
    }

    // ------------------------------------------------------------- primitives

    // Dispatch one event with the flags the browser would use for it.
    function fire(el, type, init) {
        if (!el) return { defaultPrevented: false };
        const base = {
            bubbles: !NON_BUBBLING.has(type),
            cancelable: CANCELABLE.has(type),
            composed: true,
        };
        const Ctor = ctorFor(type);
        try {
            const ev = new Ctor(type, { ...base, ...(init || {}) });
            el.dispatchEvent(ev);
            return ev;
        } catch (_) {
            try {
                const ev = new Event(type, base);
                el.dispatchEvent(ev);
                return ev;
            } catch (_) { return { defaultPrevented: false }; }
        }
    }

    // Record which of `types` are dispatched at `el` from now until stop().
    // Listeners sit on the element itself (target phase), so an ancestor that
    // calls stopPropagation cannot hide an event from us. Our own dispatches
    // are recorded too, which is the point: the question is only ever "did
    // this event reach the page", not "who sent it".
    function witness(el, types) {
        const seen = new Set();
        const off = [];
        for (const t of types) {
            const h = () => seen.add(t);
            try { el.addEventListener(t, h, true); off.push([t, h]); } catch (_) {}
        }
        return {
            seen,
            has: t => seen.has(t),
            stop() { for (const [t, h] of off) { try { el.removeEventListener(t, h, true); } catch (_) {} } },
        };
    }

    // Dispatch every event of `types` that did not already happen, in order.
    function ensure(el, types, w, initFor) {
        for (const t of types) {
            if (w.has(t)) continue;
            fire(el, t, initFor ? initFor(t) : undefined);
        }
    }

    function centreOf(el) {
        let rect = { left: 0, top: 0, width: 0, height: 0 };
        try { rect = el.getBoundingClientRect(); } catch (_) {}
        return {
            clientX: Math.round(rect.left + rect.width / 2),
            clientY: Math.round(rect.top + rect.height / 2),
        };
    }

    // What a real mouse reports: a 1x1 contact with pressure while pressed,
    // detail 1 on the press/release/click events, 0 on hover and move. Some
    // accessibility toolkits use exactly these fields to tell a mouse from a
    // screen reader's "virtual click" and handle the two differently.
    function mouseInit(el, coords, extra) {
        const doc = el.ownerDocument || document;
        return {
            view: doc.defaultView || window,
            detail: 1,
            button: 0,
            buttons: 1,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            width: 1,
            height: 1,
            pressure: 0.5,
            screenX: coords ? coords.clientX : 0,
            screenY: coords ? coords.clientY : 0,
            ...coords,
            ...extra,
        };
    }
    const HOVER = new Set(['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']);

    // Value the control held when it was last focused, so that `change` can be
    // fired exactly when the HTML spec says it should: on losing focus after
    // the value was edited.
    const focusValue = new WeakMap();

    function readValue(el) {
        if (!el) return '';
        if (el.isContentEditable) return el.textContent || '';
        if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '';
        return el.value == null ? '' : String(el.value);
    }

    function remember(el) { try { focusValue.set(el, readValue(el)); } catch (_) {} }
    function wasEdited(el) {
        if (!focusValue.has(el)) return null;          // we never saw it focused
        return focusValue.get(el) !== readValue(el);
    }

    function isFocusable(el) {
        if (!el) return false;
        const doc = el.ownerDocument || document;
        return el !== doc.body && el !== doc.documentElement;
    }

    // ------------------------------------------------------------- sequences

    // Press: pointerover .. mousedown. Returns the mousedown event so callers
    // can honour preventDefault the way the browser does (a prevented mousedown
    // suppresses the focus change).
    function press(el, coords) {
        let md = { defaultPrevented: false };
        for (const t of SEQ_PRESS) {
            const extra = HOVER.has(t) ? { detail: 0, buttons: 0, pressure: 0 } : {};
            if (t === 'mouseenter' || t === 'pointerenter') extra.bubbles = false;
            const ev = fire(el, t, mouseInit(el, coords, extra));
            if (t === 'mousedown') md = ev;
        }
        return md;
    }

    function release(el, coords) {
        for (const t of SEQ_RELEASE) fire(el, t, mouseInit(el, coords, { buttons: 0, pressure: 0 }));
    }

    // A control loses focus. `change` first (only when its value was actually
    // edited, which is what the spec ties change to), then blur and focusout.
    //
    // opts.change: true forces the change event, false suppresses it,
    // undefined decides from the value seen at focus time.
    function leave(el, opts = {}) {
        if (!el) return false;
        const doc = el.ownerDocument || document;
        const w = witness(el, SEQ_LEAVE);
        try {
            const edited = wasEdited(el);
            // Checkboxes, radios and selects get their change at the moment of
            // the toggle/selection, not on the way out, so leaving must not
            // produce a second one.
            const togglesOnAction = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio';
            const wantChange = opts.change === true ||
                (opts.change !== false && !togglesOnAction && edited !== false);
            if (wantChange && !w.has('change')) fire(el, 'change');
            try { if (doc.activeElement === el) el.blur(); } catch (_) {}
            ensure(el, ['blur', 'focusout'], w, () => ({ relatedTarget: opts.relatedTarget || null }));
        } finally {
            w.stop();
            try { focusValue.delete(el); } catch (_) {}
        }
        return true;
    }

    // A control receives focus from a mouse click: the complete sequence, with
    // whoever held focus leaving first, exactly as the browser orders it.
    function focus(el, opts = {}) {
        if (!el) return false;
        const doc = el.ownerDocument || document;
        if (opts.scroll !== false) {
            try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
        }
        const coords = centreOf(el);

        const prev = doc.activeElement;
        const md = press(el, coords);

        // Default action of a trusted mousedown: the focus change. Ours is not
        // trusted, so we perform it and then make sure its events exist.
        if (!md.defaultPrevented) {
            if (prev && prev !== el && isFocusable(prev)) leave(prev, { relatedTarget: el });

            const w = witness(el, SEQ_FOCUS_IN);
            try { el.focus({ preventScroll: true }); }
            catch (_) { try { el.focus(); } catch (_) {} }
            ensure(el, SEQ_FOCUS_IN, w, () => ({ relatedTarget: prev && prev !== el ? prev : null }));
            w.stop();
        }

        release(el, coords);
        remember(el);
        return true;
    }

    // Focus without the mouse press: for controls where a click is meaningful
    // on its own (a checkbox toggles, a combobox opens its list) and the caller
    // performs that click itself. Whoever held focus still leaves first.
    function enter(el, opts = {}) {
        if (!el) return false;
        const doc = el.ownerDocument || document;
        const prev = doc.activeElement;
        if (prev && prev !== el && isFocusable(prev)) leave(prev, { relatedTarget: el });
        if (doc.activeElement === el) { remember(el); return true; }

        const w = witness(el, SEQ_FOCUS_IN);
        try { el.focus({ preventScroll: opts.scroll === false }); }
        catch (_) { try { el.focus(); } catch (_) {} }
        ensure(el, SEQ_FOCUS_IN, w, () => ({ relatedTarget: prev && prev !== el ? prev : null }));
        w.stop();
        remember(el);
        return true;
    }

    // Guarantee the input-event pair after something changed a control's value.
    // Used by the typing engine when a page handler swallowed the keystroke and
    // wrote the value itself without telling anyone.
    function ensureInput(el, before, w, init) {
        if (!el) return false;
        const changed = readValue(el) !== before;
        if (!changed) return false;
        if (!w || !w.has('input')) {
            fire(el, 'input', {
                inputType: (init && init.inputType) || 'insertText',
                data: init && init.data !== undefined ? init.data : null,
                bubbles: true,
                cancelable: false,
            });
        }
        return true;
    }

    return {
        // tables (exported so tests and future sequences can assert against them)
        SEQ_PRESS, SEQ_RELEASE, SEQ_FOCUS_IN, SEQ_LEAVE, SEQ_KEY,
        // primitives
        fire, witness, ensure, centreOf, mouseInit, readValue,
        // sequences
        press, release, focus, enter, leave, ensureInput,
        // focus-time bookkeeping (the typing engine re-arms it after a clear)
        remember, wasEdited,
    };
})();

if (typeof window !== 'undefined') window.EventSim = EventSim;
