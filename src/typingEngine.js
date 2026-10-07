// typingEngine.js -- the keyboard, reproduced as events.
//
// The fallback for browsers that do not grant real input (trustedInput.js):
// Chrome, the store builds, a Firefox without the experiment. A keystroke a
// script dispatches inserts nothing by itself, so each one is played out in
// full, the way the browser would have: keydown, keypress, beforeinput, the
// change to the text, input, keyup. The page's own handlers are honoured at
// every step (a mask that prevents the keydown and writes the text itself
// keeps working).
//
// Two details that decide whether a page believes the typing:
//   - execCommand('insertText') only works while the document has focus, and
//     a fill started from the side panel leaves the page unfocused. The text
//     is therefore changed by hand first, with execCommand as the second try.
//   - A typed character replaces the selection. Widgets that select a part
//     of themselves when it is clicked (a date in sections) rely on that.
const TypingEngine = (function () {
    'use strict';

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const STOPPED = 'Form filling stopped by user.';
    const KEY_CODES = {
        ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27, Tab: 9, End: 35, Home: 36,
        PageDown: 34, PageUp: 33, Backspace: 8, Delete: 46, Space: 32,
    };

    function fire(el, Ctor, type, init) {
        try {
            const ev = new Ctor(type, init);
            el.dispatchEvent(ev);
            return ev;
        } catch (_) {
            return { defaultPrevented: false };
        }
    }

    // A framework may re-render a control while it is typed into: a fresh
    // node per keystroke, the old one detached. What it shows now is read
    // from the node that took its place.
    function live(el) {
        if (!el || el.isConnected) return el;
        const doc = el.ownerDocument || document;
        const same = n => n && n !== el && n.isConnected && n.tagName === el.tagName &&
            ((el.id && n.id === el.id) || (el.name && n.name === el.name) || (!el.id && !el.name));
        if (same(doc.activeElement)) return doc.activeElement;
        try {
            if (el.id && same(doc.getElementById(el.id))) return doc.getElementById(el.id);
            if (el.name) {
                const n = doc.querySelector(el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]');
                if (same(n)) return n;
            }
        } catch (_) {}
        return el;
    }

    function textOf(el) {
        return el.isContentEditable ? (el.textContent || '') : (el.value || '');
    }

    // Set a value past any setter a framework put on the element itself.
    function setValueNatively(el, value) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
            : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); return true; }
        catch (_) { try { el.value = value; return true; } catch (_) { return false; } }
    }

    function hasPageFocus(el) {
        try {
            const doc = el.ownerDocument || document;
            return doc.hasFocus() && doc.activeElement === el;
        } catch (_) { return false; }
    }

    // The selection of an input, or the caret at its end when the input type
    // does not expose one (email, number).
    function selectionOf(el) {
        const len = (el.value || '').length;
        try {
            if (el.selectionStart === null || el.selectionStart === undefined) return [len, len];
            return [el.selectionStart, el.selectionEnd === null ? el.selectionStart : el.selectionEnd];
        } catch (_) { return [len, len]; }
    }

    function setCaret(el, pos) {
        try { el.setSelectionRange(pos, pos); } catch (_) {}
    }

    // ------------------------------------------------------------ one character

    function insertIntoInput(el, char) {
        const before = el.value || '';
        const [start, end] = selectionOf(el);
        // A keystroke past maxlength is dropped by the browser: no events.
        if (typeof el.maxLength === 'number' && el.maxLength >= 0 && before.length >= el.maxLength && end === start) return;
        const bi = fire(el, InputEvent, 'beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true, composed: true });
        if (bi.defaultPrevented) return;
        if (!setValueNatively(el, before.slice(0, start) + char + before.slice(end))) return;
        setCaret(el, start + 1);
        fire(el, InputEvent, 'input', { inputType: 'insertText', data: char, bubbles: true, composed: true });
    }

    function insertIntoEditable(el, char) {
        const doc = el.ownerDocument || document;
        const bi = fire(el, InputEvent, 'beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true, composed: true });
        if (bi.defaultPrevented) return;
        const sel = (doc.defaultView || window).getSelection();
        let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (!range || !el.contains(range.commonAncestorContainer)) {
            range = doc.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
        }
        range.deleteContents();
        const node = doc.createTextNode(char);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        try { sel.removeAllRanges(); sel.addRange(range); } catch (_) {}
        fire(el, InputEvent, 'input', { inputType: 'insertText', data: char, bubbles: true, composed: true });
    }

    // keydown, keypress, the insertion, keyup. A page handler that prevents
    // the keydown has taken the key for itself; if it then changed the text
    // without saying so, the missing input event is supplied.
    function pressChar(el, char) {
        const init = {
            key: char, code: /[a-z]/i.test(char) ? 'Key' + char.toUpperCase() : (/\d/.test(char) ? 'Digit' + char : (char === ' ' ? 'Space' : '')),
            keyCode: char.toUpperCase().charCodeAt(0), which: char.toUpperCase().charCodeAt(0), charCode: char.charCodeAt(0),
            bubbles: true, cancelable: true, composed: true,
        };
        const before = textOf(el);
        const sim = typeof EventSim !== 'undefined' ? EventSim : null;
        const seen = sim ? sim.witness(el, ['input']) : null;
        try {
            const down = fire(el, KeyboardEvent, 'keydown', init);
            if (!down.defaultPrevented && !fire(el, KeyboardEvent, 'keypress', init).defaultPrevented) {
                let done = false;
                // The browser's own editor, when the page really has focus.
                if (el.isContentEditable && hasPageFocus(el)) {
                    try { done = (el.ownerDocument || document).execCommand('insertText', false, char); } catch (_) {}
                }
                if (!done) (el.isContentEditable ? insertIntoEditable : insertIntoInput)(el, char);
                if (!done && textOf(el) === before && hasPageFocus(el)) {
                    try { (el.ownerDocument || document).execCommand('insertText', false, char); } catch (_) {}
                }
            }
            if (sim) sim.ensureInput(el, before, seen, { inputType: 'insertText', data: char });
            fire(el, KeyboardEvent, 'keyup', init);
        } finally {
            if (seen) seen.stop();
        }
    }

    // ------------------------------------------------------------ public

    // Type `text` to wherever the cursor is, one key at a time. `target()` is
    // asked before every key: a field that hands the cursor on while it is
    // typed into keeps getting the keys, as it would from a person.
    async function type(text, target, isCancelled) {
        for (const char of Array.from(String(text))) {
            if (isCancelled && isCancelled()) throw new Error(STOPPED);
            const el = target();
            if (!el) return false;
            pressChar(el, char);
            await wait(18 + Math.random() * 30);
        }
        return true;
    }

    // Backspace: deletes the selection, or the character before the caret.
    function backspace(el) {
        const init = { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true, composed: true };
        const before = textOf(el);
        const down = fire(el, KeyboardEvent, 'keydown', init);
        if (!down.defaultPrevented && before) {
            const bi = fire(el, InputEvent, 'beforeinput', { inputType: 'deleteContentBackward', data: null, bubbles: true, cancelable: true, composed: true });
            if (!bi.defaultPrevented) {
                if (el.isContentEditable) {
                    el.textContent = before.slice(0, -1);
                } else {
                    const [start, end] = selectionOf(el);
                    const from = end > start ? start : Math.max(0, start - 1);
                    setValueNatively(el, before.slice(0, from) + before.slice(end));
                    setCaret(el, from);
                }
                fire(el, InputEvent, 'input', { inputType: 'deleteContentBackward', data: null, bubbles: true, composed: true });
            }
        }
        fire(el, KeyboardEvent, 'keyup', init);
    }

    // One named key (Enter, Tab, Escape, the arrows...) as events on `el`.
    // The page's handlers see it; the browser's own reaction to the key (a
    // form sent by Enter, focus moved by Tab) does not happen for a
    // scripted key, except for Backspace, which is played out above.
    function key(el, name) {
        if (name === 'Backspace' && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return backspace(el);
        const init = {
            key: name === 'Space' ? ' ' : name, code: name, keyCode: KEY_CODES[name] || 0, which: KEY_CODES[name] || 0,
            bubbles: true, cancelable: true, composed: true,
        };
        fire(el, KeyboardEvent, 'keydown', init);
        fire(el, KeyboardEvent, 'keypress', init);
        fire(el, KeyboardEvent, 'keyup', init);
    }

    return { type, backspace, key, live, setValueNatively };
})();

if (typeof window !== 'undefined') window.TypingEngine = TypingEngine;
