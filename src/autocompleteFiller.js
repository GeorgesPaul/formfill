// autocompleteFiller.js — handles fields that answer typing with a dynamic
// suggestion list you are expected to pick from (address/street lookups, city
// and country pickers, Google Places, react-select, select2, awesomplete, ...).
//
// Typing the whole value into such a field is not enough: the form keeps its own
// state and only accepts the value once a suggestion is chosen, so submitting
// reports the field as empty.
//
// Flow, driven from domUtils.fillField:
//   1. startWatch(el)  -- before typing, start observing the DOM for popups
//   2. (caller types the value with TypingEngine)
//   3. resolve(...)    -- find the popup, score the options against the value,
//                         pick the best one via keyboard or mouse, verify.
//
// Everything is generic: no site-specific selectors beyond a few well-known
// container class names used as extra hints.
const AutocompleteFiller = (function () {
    'use strict';

    const wait = ms => new Promise(r => setTimeout(r, ms));

    const POPUP_SELECTOR = [
        '[role="listbox"]', '[role="menu"]', '[role="grid"]', '[role="tree"]',
        '.pac-container',                 // Google Places
        '[class*="autocomplete"]', '[class*="typeahead"]', '[class*="suggestion"]',
        '[class*="Suggestion"]', '[class*="dropdown-menu"]', '[class*="menu-list"]',
        '[id*="autocomplete"]', '[id*="suggest"]'
    ].join(',');

    const OPTION_SELECTOR = [
        '[role="option"]', '[role="menuitem"]', '[role="treeitem"]', '[role="row"]',
        'li', '.pac-item', '[class*="option"]', '[class*="Option"]',
        '[class*="suggestion"]', '[class*="item"]'
    ].join(',');

    const HIGHLIGHT_HINTS = /(^|[-_ ])(selected|active|highlight|highlighted|focused|current)([-_ ]|$)/i;

    function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        const s = win.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    function text(el) {
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // ---------------------------------------------------------------- watching

    // Record every element the page adds or reveals while we type, so a popup
    // can be recognised even when it carries no recognisable role or class.
    function startWatch(element) {
        const doc = element.ownerDocument || document;
        const added = new Set();
        let observer = null;
        try {
            observer = new MutationObserver(muts => {
                for (const m of muts) {
                    for (const n of m.addedNodes) {
                        if (n.nodeType === 1) added.add(n);
                    }
                    if (m.type === 'attributes' && m.target.nodeType === 1) added.add(m.target);
                }
                if (added.size > 400) added.clear();   // runaway page, stop hoarding
            });
            observer.observe(doc.documentElement || doc, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-expanded']
            });
        } catch (_) {}
        return {
            element, added,
            stop() { try { observer && observer.disconnect(); } catch (_) {} }
        };
    }

    // ---------------------------------------------------------------- finding

    function near(popup, field) {
        const p = popup.getBoundingClientRect();
        const f = field.getBoundingClientRect();
        if (p.width < 40 || p.height < 10) return false;
        const horizontallyOverlapping = p.right > f.left - 80 && p.left < f.right + 80;
        const verticallyClose = p.top > f.top - 500 && p.top < f.bottom + 500;
        return horizontallyOverlapping && verticallyClose;
    }

    function optionsIn(popup) {
        let candidates = Array.from(popup.querySelectorAll(OPTION_SELECTOR)).filter(visible);
        if (candidates.length === 0) {
            // Popups built from plain divs: take visible leaf-ish children with text.
            candidates = Array.from(popup.children).filter(el => visible(el) && text(el));
        }
        // Keep the innermost candidates only (a wrapper <li> containing the real
        // option div would otherwise be scored and clicked instead of the option).
        const leaves = candidates.filter(c => !candidates.some(o => o !== c && c.contains(o)));
        const seen = new Set();
        const out = [];
        for (const el of leaves) {
            const t = text(el);
            if (!t || t.length > 200) continue;
            if (seen.has(t)) continue;
            seen.add(t);
            out.push({ el, text: t });
        }
        return out;
    }

    function candidatePopups(element, watcher) {
        const doc = element.ownerDocument || document;
        const found = new Set();

        const consider = el => {
            if (!el || el.nodeType !== 1) return;
            if (el === element || el.contains(element)) return;   // not a popup for this field
            if (!visible(el)) return;
            found.add(el);
        };

        // 1. Explicit ARIA wiring is the most reliable signal.
        for (const attr of ['aria-controls', 'aria-owns']) {
            const v = element.getAttribute(attr);
            if (!v) continue;
            for (const id of v.split(/\s+/)) {
                const el = doc.getElementById(id);
                if (el) consider(el);
            }
        }
        const activeDesc = element.getAttribute('aria-activedescendant');
        if (activeDesc) {
            const el = doc.getElementById(activeDesc);
            if (el) consider(el.closest('[role="listbox"], [role="menu"], ul, div') || el.parentElement);
        }

        // 2. Anything that appeared or became visible while we were typing.
        if (watcher) {
            for (const node of watcher.added) {
                if (!node.isConnected) continue;
                if (node.matches && node.matches(POPUP_SELECTOR)) consider(node);
                else if (node.querySelector) {
                    const inner = node.querySelector(POPUP_SELECTOR);
                    if (inner) consider(inner);
                    else if (visible(node) && optionsIn(node).length >= 1 && near(node, element)) consider(node);
                }
            }
        }

        // 3. Known popup shapes anywhere in the document.
        for (const el of doc.querySelectorAll(POPUP_SELECTOR)) consider(el);

        return Array.from(found)
            .filter(el => near(el, element))
            .filter(el => optionsIn(el).length > 0)
            // Prefer the innermost popup (a wrapper div plus its listbox both match).
            .filter((el, _i, all) => !all.some(o => o !== el && el.contains(o)));
    }

    // Does this field look like something that *requires* picking a suggestion?
    // Used only to decide how long to wait and whether to retrigger.
    function looksLikeTypeahead(element) {
        const attrs = [
            element.getAttribute('role'), element.getAttribute('aria-autocomplete'),
            element.getAttribute('aria-haspopup'), element.getAttribute('aria-expanded'),
            element.getAttribute('aria-controls'), element.getAttribute('aria-owns'),
            element.className, element.id, element.getAttribute('placeholder')
        ].filter(Boolean).join(' ').toLowerCase();
        if (/combobox|autocomplete|typeahead|suggest|lookup|search|select2|react-select|pac-target/.test(attrs)) return true;
        if (element.getAttribute('autocomplete') === 'off' && /address|street|city|postcode|zip/.test(attrs)) return true;
        return false;
    }

    // ---------------------------------------------------------------- scoring

    function normalise(s) {
        return String(s == null ? '' : s).toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    function tokens(s) {
        return normalise(s).split(' ').filter(Boolean);
    }

    // 0..1 similarity of an option's text to the value we intended to enter.
    // Digit tokens (house numbers, postcodes) count double: they are what
    // distinguishes "Main Street 12" from "Main Street 120".
    function score(optionText, value) {
        const vt = tokens(value);
        const ot = tokens(optionText);
        if (!vt.length || !ot.length) return 0;

        let total = 0, hit = 0;
        for (const t of vt) {
            const w = /\d/.test(t) ? 2 : 1;
            total += w;
            const matched = ot.some(o => o === t || (t.length >= 4 && (o.startsWith(t) || t.startsWith(o))));
            if (matched) hit += w;
        }
        let s = hit / total;

        const on = normalise(optionText), vn = normalise(value);
        if (on === vn) return 1;
        if (on.startsWith(vn) || vn.startsWith(on)) s = Math.min(1, s + 0.2);
        // A value with digits that the option lacks entirely is a poor match.
        if (/\d/.test(vn) && !/\d/.test(on)) s *= 0.6;
        return s;
    }

    function rank(options, value) {
        return options
            .map((o, index) => ({ ...o, index, s: score(o.text, value) }))
            .sort((a, b) => b.s - a.s);
    }

    // Last resort when nothing scores well: ask the text LLM which suggestion
    // the user meant. Cheap (a few dozen tokens) and only fires on ambiguity.
    async function askLLM(fieldLabel, value, options) {
        if (typeof promptLLM !== 'function') return -1;
        const list = options.map((o, i) => `${i + 1}. ${o.text}`).join('\n');
        const prompt =
            `A web form field${fieldLabel ? ` labelled "${fieldLabel}"` : ''} shows an autocomplete ` +
            `suggestion list after typing: "${value}".\n\nSuggestions:\n${list}\n\n` +
            `Which suggestion corresponds to the typed value? Answer with the number only, ` +
            `or 0 if none of them match.`;
        try {
            const raw = await promptLLM(prompt);
            const n = parseInt(String(raw).replace(/[^0-9]/g, ' ').trim().split(/\s+/)[0], 10);
            if (!isNaN(n) && n >= 1 && n <= options.length) return n - 1;
        } catch (e) {
            console.warn('[Autocomplete] LLM tiebreak failed:', e && e.message);
        }
        return -1;
    }

    // -------------------------------------------------------------- selecting

    function highlightedIndex(options) {
        for (let i = 0; i < options.length; i++) {
            const el = options[i].el;
            if (el.getAttribute('aria-selected') === 'true') return i;
            if (HIGHLIGHT_HINTS.test(el.className || '')) return i;
            if (el.getAttribute('data-highlighted') != null) return i;
        }
        return -1;
    }

    async function selectByKeyboard(element, popup, options, targetIndex) {
        const presses = options.length + 2;
        for (let i = 0; i < presses; i++) {
            TypingEngine.pressKey(element, 'ArrowDown');
            await wait(70);
            const live = optionsIn(popup);
            const hi = highlightedIndex(live);
            const activeDesc = element.getAttribute('aria-activedescendant');
            const onTargetById = activeDesc && live[targetIndex] && live[targetIndex].el.id === activeDesc;
            if (hi === -1 && !activeDesc && i === 0) return false;  // widget ignores arrows
            if (onTargetById || hi === targetIndex) {
                TypingEngine.pressKey(element, 'Enter');
                await wait(250);
                return true;
            }
        }
        return false;
    }

    function mouseSequence(el) {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const base = { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
        const fire = (Ctor, type, init) => { try { el.dispatchEvent(new Ctor(type, init)); } catch (_) {} };
        try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
        fire(PointerEvent, 'pointerover', { ...base, pointerType: 'mouse' });
        fire(MouseEvent, 'mouseover', base);
        fire(PointerEvent, 'pointermove', { ...base, pointerType: 'mouse' });
        fire(MouseEvent, 'mousemove', base);
        fire(PointerEvent, 'pointerdown', { ...base, pointerType: 'mouse', buttons: 1, isPrimary: true });
        fire(MouseEvent, 'mousedown', { ...base, buttons: 1 });
        fire(PointerEvent, 'pointerup', { ...base, pointerType: 'mouse', isPrimary: true });
        fire(MouseEvent, 'mouseup', base);
        fire(MouseEvent, 'click', base);
    }

    // ---------------------------------------------------------------- resolve

    async function waitForPopup(element, watcher, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const popups = candidatePopups(element, watcher);
            if (popups.length) return popups[popups.length - 1];
            if (Date.now() >= deadline) return null;
            await wait(90);
        }
    }

    // Returns { handled, selected, reason }.
    //   handled: true  -> a suggestion was chosen; the field's value is now
    //                     whatever the widget put there, and the caller must
    //                     not treat a mismatch with `value` as a failure.
    async function resolve(watcher, element, value, info = {}, opts = {}) {
        const isTypeahead = looksLikeTypeahead(element);

        // Fast path for ordinary fields: showing a suggestion list always
        // mutates the DOM (nodes added, or style/class/aria-expanded flipped on
        // an existing container), and the watcher has been running since before
        // the first keystroke. Nothing recorded means there is no list to wait
        // for, so don't spend half a second per field finding that out.
        if (!isTypeahead && watcher && watcher.added.size === 0) {
            watcher.stop();
            return { handled: false, reason: 'no-dom-change' };
        }

        let popup = await waitForPopup(element, watcher, isTypeahead ? 1500 : 450);

        // Nothing yet, but this really looks like a lookup field: apply the trick
        // people use by hand -- delete the last character and type it again --
        // which re-fires the widget's input handler.
        if (!popup && isTypeahead) {
            await TypingEngine.retypeLastChar(element);
            popup = await waitForPopup(element, watcher, 1500);
        }

        if (watcher) watcher.stop();
        if (!popup) return { handled: false, reason: 'no-popup' };

        const options = optionsIn(popup);
        if (!options.length) return { handled: false, reason: 'no-options' };

        const ranked = rank(options, value);
        const best = ranked[0];
        console.log('[Autocomplete] popup with', options.length, 'option(s); best:',
                    best.text, 'score', best.s.toFixed(2));

        let chosen = null;
        if (best.s >= 0.55) chosen = best;
        else if (options.length === 1 && best.s >= 0.3) chosen = best;

        if (!chosen && opts.allowLLM !== false && options.length > 1) {
            const idx = await askLLM(info.label || info.placeholder || '', value, options);
            if (idx >= 0) chosen = { ...options[idx], index: idx, s: 1 };
        }
        if (!chosen && options.length === 1) chosen = best;

        if (!chosen) {
            // Leave the typed text and close the popup so it does not swallow
            // the next field's clicks.
            TypingEngine.pressKey(element, 'Escape');
            return { handled: false, reason: 'no-match' };
        }

        const before = TypingEngine.readValue(element);
        let ok = await selectByKeyboard(element, popup, options, chosen.index);
        if (!ok || (visible(popup) && TypingEngine.readValue(element) === before)) {
            const live = optionsIn(popup);
            const target = (live[chosen.index] && live[chosen.index].text === chosen.text)
                ? live[chosen.index].el
                : (live.find(o => o.text === chosen.text) || {}).el || chosen.el;
            if (target && target.isConnected) {
                mouseSequence(target);
                await wait(300);
            }
        }
        await wait(150);

        const after = TypingEngine.readValue(element);
        const accepted = !visible(popup) || after !== before;
        if (accepted) {
            // Record what the widget settled on so the verify/refill loop does
            // not keep "correcting" a field that is already accepted.
            try {
                element.setAttribute('data-ff-accepted-for', String(value).trim());
                element.setAttribute('data-filled-by-extension', 'true');
            } catch (_) {}
        }
        console.log('[Autocomplete] selected:', chosen.text, '-> field now:', after, 'accepted:', accepted);
        return { handled: accepted, selected: chosen.text, reason: accepted ? 'selected' : 'not-accepted' };
    }

    return { startWatch, resolve, looksLikeTypeahead, score, optionsIn, candidatePopups, mouseSequence };
})();

if (typeof window !== 'undefined') window.AutocompleteFiller = AutocompleteFiller;
