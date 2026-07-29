// typingEngine.js — keystroke-level text entry.
//
// Why this exists: a growing share of forms validate that a field was actually
// *typed into*. They watch for keydown/keyup, for `beforeinput`/`input` events
// carrying an inputType and data, or simply for the field having been focused
// and blurred. Assigning `element.value` (even with a synthetic `input` event)
// leaves no such trail, so the form marks the field empty/untouched and shows
// "this field is required" in red even though the value is visibly there.
//
// So typing is now the DEFAULT path for every text-like field, not a fallback.
//
// A critical detail: `document.execCommand('insertText')` only works while the
// document has focus. When the fill is launched from the extension sidebar or
// popup the *page* is not focused, so every execCommand-based strategy silently
// no-ops. That is the main reason the old typing/"tickle" path was unreliable.
// We therefore check `document.hasFocus()` and fall back to a manual insertion
// that dispatches the same event sequence the browser would.
const TypingEngine = (function () {
    'use strict';

    const CFG = {
        minDelayMs: 18,       // per-character delay, randomised in [min,max]
        maxDelayMs: 55,
        pauseEveryChars: 7,   // occasional longer pause, like a human
        pauseMs: 90,
        maxChars: 400,        // safety bound on a single field
    };

    const rnd = (a, b) => a + Math.random() * (b - a);
    const wait = ms => new Promise(r => setTimeout(r, ms));

    function readValue(el) {
        return el.isContentEditable ? (el.textContent || '') : (el.value || '');
    }

    // Input types where synthetic keystrokes cannot produce a value (the widget
    // parses real key input internally, or has no text buffer at all).
    const NON_TYPABLE_TYPES = new Set([
        'checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button',
        'reset', 'image', 'hidden', 'date', 'datetime-local', 'month', 'week', 'time'
    ]);

    function isTypable(el) {
        if (!el) return false;
        if (el.disabled) return false;
        if (el.readOnly || el.hasAttribute('readonly')) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag !== 'INPUT') return false;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return !NON_TYPABLE_TYPES.has(type);
    }

    function keyInitFor(char) {
        const code = char.charCodeAt(0);
        let domCode = '';
        if (/[a-zA-Z]/.test(char)) domCode = 'Key' + char.toUpperCase();
        else if (/[0-9]/.test(char)) domCode = 'Digit' + char;
        else if (char === ' ') domCode = 'Space';
        return {
            key: char,
            code: domCode,
            keyCode: char.toUpperCase().charCodeAt(0),
            which: char.toUpperCase().charCodeAt(0),
            charCode: code,
            bubbles: true,
            cancelable: true,
            composed: true,
        };
    }

    function fire(el, Ctor, type, init) {
        try {
            const ev = new Ctor(type, init);
            el.dispatchEvent(ev);
            return ev;
        } catch (_) {
            return { defaultPrevented: false };
        }
    }

    function nativeSetter(el) {
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        if (tag === 'SELECT') return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    }

    function setValueNatively(el, v) {
        try { nativeSetter(el).call(el, v); return true; }
        catch (_) { try { el.value = v; return true; } catch (_) { return false; } }
    }

    function caretOf(el) {
        if (el.isContentEditable) return (el.textContent || '').length;
        try {
            const pos = el.selectionStart;
            return (pos === null || pos === undefined) ? (el.value || '').length : pos;
        } catch (_) {
            // Inputs like type=email/number throw on selectionStart in some browsers.
            return (el.value || '').length;
        }
    }

    function setCaret(el, start, end) {
        if (el.isContentEditable) {
            try {
                const sel = (el.ownerDocument.defaultView || window).getSelection();
                const range = el.ownerDocument.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (_) {}
            return;
        }
        try { el.setSelectionRange(start, end === undefined ? start : end); } catch (_) {}
    }

    // Insert one character at the caret without execCommand, dispatching the
    // event sequence a real keypress produces. Returns true if the value changed.
    function manualInsert(el, char) {
        const before = readValue(el);

        // Honour maxlength the way the browser does: a real keystroke past the
        // limit is dropped entirely (no beforeinput, no input). Writing through
        // the value setter would silently exceed it, leaving a value the user
        // could never have typed.
        if (!el.isContentEditable && typeof el.maxLength === 'number' && el.maxLength >= 0) {
            let selectionActive = false;
            try { selectionActive = el.selectionEnd > el.selectionStart; } catch (_) {}
            if (before.length >= el.maxLength && !selectionActive) return false;
        }

        const bi = fire(el, InputEvent, 'beforeinput', {
            inputType: 'insertText', data: char, bubbles: true, cancelable: true, composed: true
        });
        if (bi.defaultPrevented) return readValue(el) !== before;

        if (el.isContentEditable) {
            el.textContent = before + char;
            setCaret(el);
        } else {
            const start = caretOf(el);
            let end = start;
            try { end = el.selectionEnd == null ? start : el.selectionEnd; } catch (_) {}
            const next = before.slice(0, start) + char + before.slice(end);
            if (!setValueNatively(el, next)) return false;
            setCaret(el, start + 1);
        }

        fire(el, InputEvent, 'input', {
            inputType: 'insertText', data: char, bubbles: true, cancelable: false, composed: true
        });
        return readValue(el) !== before;
    }

    // Delete the character before the caret, event-complete. Returns true if the
    // value changed.
    function manualBackspace(el) {
        const before = readValue(el);
        if (!before) return false;

        const bi = fire(el, InputEvent, 'beforeinput', {
            inputType: 'deleteContentBackward', data: null, bubbles: true, cancelable: true, composed: true
        });
        if (bi.defaultPrevented) return readValue(el) !== before;

        if (el.isContentEditable) {
            el.textContent = before.slice(0, -1);
            setCaret(el);
        } else {
            const start = caretOf(el);
            let end = start;
            try { end = el.selectionEnd == null ? start : el.selectionEnd; } catch (_) {}
            let next, caret;
            if (end > start) {                    // a selection is active: delete it
                next = before.slice(0, start) + before.slice(end);
                caret = start;
            } else if (start > 0) {
                next = before.slice(0, start - 1) + before.slice(start);
                caret = start - 1;
            } else {
                return false;
            }
            if (!setValueNatively(el, next)) return false;
            setCaret(el, caret);
        }

        fire(el, InputEvent, 'input', {
            inputType: 'deleteContentBackward', data: null, bubbles: true, cancelable: false, composed: true
        });
        return readValue(el) !== before;
    }

    // execCommand fires beforeinput/input natively (highest fidelity) but only
    // works when the document actually has focus, which it does NOT when the
    // fill is driven from the sidebar/popup.
    function canUseExecCommand(el) {
        try {
            const doc = el.ownerDocument || document;
            return doc.hasFocus() && doc.activeElement === el;
        } catch (_) { return false; }
    }

    // Manual insertion is tried first: it produces beforeinput + input with the
    // correct inputType/data in every context, while execCommand needs page
    // focus (absent when filling from the sidebar) and in Chrome does not emit
    // beforeinput on <input> elements at all. execCommand remains the fallback
    // for inputs that reject a programmatic value write.
    function insertChar(el, char, useExec) {
        if (manualInsert(el, char)) return true;
        if (useExec) {
            const before = readValue(el);
            try {
                if ((el.ownerDocument || document).execCommand('insertText', false, char)) {
                    return readValue(el) !== before;
                }
            } catch (_) {}
        }
        return false;
    }

    // Press one key: keydown -> (keypress) -> insert -> keyup.
    // Honours preventDefault on keydown/keypress exactly like the browser does,
    // so masks that implement their own insertion keep working.
    async function pressChar(el, char, useExec) {
        const init = keyInitFor(char);
        const kd = fire(el, KeyboardEvent, 'keydown', init);
        let inserted = false;
        if (!kd.defaultPrevented) {
            const kp = fire(el, KeyboardEvent, 'keypress', init);
            if (!kp.defaultPrevented) inserted = insertChar(el, char, useExec);
        } else {
            // The page swallowed the keydown; it may have inserted the char itself.
            inserted = true;
        }
        fire(el, KeyboardEvent, 'keyup', { ...init, cancelable: true });
        return inserted;
    }

    async function pressBackspace(el, useExec) {
        const init = { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true, composed: true };
        const kd = fire(el, KeyboardEvent, 'keydown', init);
        let changed = false;
        if (!kd.defaultPrevented) {
            changed = manualBackspace(el);
            if (!changed && useExec) {
                const before = readValue(el);
                try { (el.ownerDocument || document).execCommand('delete', false); } catch (_) {}
                changed = readValue(el) !== before;
            }
        }
        fire(el, KeyboardEvent, 'keyup', init);
        return changed;
    }

    // Clear the field the way a person would: select-all + delete, then
    // per-character backspaces for anything a mask refused to drop.
    async function clearField(el) {
        if (!readValue(el)) return true;
        const useExec = canUseExecCommand(el);

        if (!el.isContentEditable) setCaret(el, 0, readValue(el).length);
        await pressBackspace(el, useExec);

        let guard = 0;
        while (readValue(el) && guard++ < CFG.maxChars) {
            const len = readValue(el).length;
            if (!el.isContentEditable) setCaret(el, len);
            const changed = await pressBackspace(el, useExec);
            if (!changed) break;
            await wait(8);
        }

        if (readValue(el)) {
            // A framework-controlled input that ignores keystroke deletion.
            setValueNatively(el, '');
            fire(el, InputEvent, 'input', { inputType: 'deleteContentBackward', bubbles: true });
        }
        return !readValue(el);
    }

    // Type `text` into an already-focused field, character by character.
    // opts.clearFirst (default true), opts.isCancelled, opts.onChar
    async function typeText(el, text, opts = {}) {
        const str = String(text);
        const useExec = canUseExecCommand(el);
        if (opts.clearFirst !== false) await clearField(el);

        let typed = 0;
        for (const char of str) {
            if (opts.isCancelled && opts.isCancelled()) throw new Error('Form filling stopped by user.');
            if (typed >= CFG.maxChars) break;
            await pressChar(el, char, useExec);
            typed++;
            if (opts.onChar) opts.onChar(typed, str);
            await wait(rnd(CFG.minDelayMs, CFG.maxDelayMs));
            if (typed % CFG.pauseEveryChars === 0) await wait(CFG.pauseMs);
        }
        return readValue(el);
    }

    // The manual fix users apply by hand: delete the last character and type it
    // again. Leaves the value unchanged but produces a fresh, complete keystroke
    // trail on a field that was filled some other way, and re-triggers
    // autocomplete widgets that only query on input.
    async function retypeLastChar(el) {
        const value = readValue(el);
        if (!value) return false;
        const last = value.slice(-1);
        const useExec = canUseExecCommand(el);
        if (!el.isContentEditable) setCaret(el, value.length);

        const removed = await pressBackspace(el, useExec);
        await wait(40);
        if (!removed) return false;
        await pressChar(el, last, useExec);
        await wait(40);

        if (readValue(el) !== value) {
            // A mask reformatted things; restore what we intended.
            setValueNatively(el, value);
            fire(el, InputEvent, 'input', { inputType: 'insertText', data: last, bubbles: true });
        }
        return true;
    }

    // Tell the page the field is finished: change + a real blur (which fires
    // trusted focusout/blur, what most validators actually listen for).
    function commitField(el) {
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        try { el.blur(); } catch (_) {}
        try { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); } catch (_) {}
    }

    return {
        CFG, isTypable, typeText, clearField, retypeLastChar, commitField,
        pressChar, pressBackspace, readValue, setValueNatively,
        canUseExecCommand,
        // Exposed for the autocomplete module (arrow keys / Enter / Escape).
        pressKey(el, key, extra = {}) {
            const codes = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9 };
            const init = {
                key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0,
                bubbles: true, cancelable: true, composed: true, ...extra
            };
            const kd = fire(el, KeyboardEvent, 'keydown', init);
            fire(el, KeyboardEvent, 'keypress', init);
            fire(el, KeyboardEvent, 'keyup', init);
            return !kd.defaultPrevented;
        },
    };
})();

if (typeof window !== 'undefined') window.TypingEngine = TypingEngine;
