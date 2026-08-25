// domUtils.js -- low-level fill primitives shared by FormKit (and the KeePass
// credential fill): realistic focus, typed text entry with the autocomplete
// dance, native <select>, custom comboboxes, checkboxes/radios, and reading
// back what the page thinks of a field (its validation state).
//
// Field discovery, refs, snapshots and the fill loop live in formKit.js and
// fillAgent.js. Every function here works on one element at a time.

function cleanText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

// Root (document or shadow root) an element lives in. Radio-group lookups and
// label[for] resolution must stay inside it: document.querySelector cannot see
// into shadow trees and would silently miss the group.
function rootNodeOf(el) {
    try { const r = el.getRootNode(); return (r && r.querySelectorAll) ? r : (el.ownerDocument || document); }
    catch (_) { return el.ownerDocument || document; }
}

// --- Credential field detection ------------------------------------------

function isPasswordField(fieldInfo) {
    if (fieldInfo.type === 'password') return true;
    const combined = ((fieldInfo.name || '') + (fieldInfo.id || '')).toLowerCase();
    return /passw|pwd/.test(combined);
}

function isUsernameField(fieldInfo) {
    const ac = (fieldInfo.autocomplete || '').toLowerCase();
    if (ac === 'username' || ac === 'email') return true;
    const combined = ((fieldInfo.name || '') + (fieldInfo.id || '') +
                      (fieldInfo.placeholder || '')).toLowerCase();
    if (/username|user.?name|login|userid|user.?id/.test(combined)) return true;
    if (fieldInfo.type === 'email') return true;
    if (/email|e.?mail/.test(combined)) return true;
    return false;
}

// --- Value comparison -----------------------------------------------------

// Does the element hold `expectedValue`, allowing for what forms legitimately
// do to a value (masks, autocomplete widgets writing back a canonical form)?
function elementHasCorrectValue(element, expectedValue) {
    let currentValue = element.value || '';
    if (element.isContentEditable) currentValue = element.textContent;

    const normalizedExpected = String(expectedValue == null ? '' : expectedValue).trim();
    const normalizedCurrent = String(currentValue == null ? '' : currentValue).trim();

    // An autocomplete widget accepted a suggestion for this value. What the
    // widget wrote back ("Main Street 12, 1012 AB Amsterdam") legitimately
    // differs from what we typed, so treat it as correct instead of fighting
    // the widget. Only while the field is non-empty: if the form blanked it,
    // it genuinely needs filling again.
    const carriesText = typeof element.value === 'string' || element.isContentEditable;
    if ((normalizedCurrent || !carriesText) &&
        element.getAttribute('data-ff-accepted-for') === normalizedExpected) {
        return true;
    }

    if (element.tagName && element.tagName.toLowerCase() === 'select') {
        const selectedOption = element.options[element.selectedIndex];
        if (selectedOption) {
            const optionText = selectedOption.text.trim().toLowerCase();
            const optionValue = selectedOption.value.trim().toLowerCase();
            const expectedLower = normalizedExpected.toLowerCase();
            return optionText === expectedLower || optionValue === expectedLower;
        }
        return false;
    }

    if (normalizedCurrent === normalizedExpected) return true;
    if (normalizedCurrent.toLowerCase() === normalizedExpected.toLowerCase()) return true;

    // Tolerant compare for masked / auto-reformatted fields (phone, date,
    // currency): "1234567890" vs "(123) 456-7890", "18041985" vs "18-04-1985".
    const strip = s => s.replace(/[^0-9a-z]/gi, '').toLowerCase();
    const a = strip(normalizedCurrent);
    const e = strip(normalizedExpected);
    if (e.length >= 3 && a === e) return true;
    // Mask added a fixed prefix/suffix ("$1,234.00", "+31 ..."): the intended
    // value still appears as a contiguous run at the start or end. Requiring
    // an edge anchor (rather than any substring) stops "1985" from matching
    // "19851234".
    if (e.length >= 4 && (a.startsWith(e) || a.endsWith(e)) && a.length <= e.length + 6) return true;

    return false;
}

// --- Validation state -----------------------------------------------------

// What the page currently says about a field: HTML5 constraint validation,
// aria-invalid, and any visible error text tied to the field. This is what
// the old verify loop never looked at; a field can hold the right string and
// still be rejected (format, unpicked suggestion, custom validator).
function readValidation(element) {
    const out = { invalid: false, message: '', hints: [] };
    if (!element) return out;
    try {
        if (element.getAttribute('aria-invalid') === 'true') { out.invalid = true; out.hints.push('aria-invalid'); }
    } catch (_) {}
    try {
        if (typeof element.checkValidity === 'function' && element.willValidate && !element.checkValidity()) {
            out.invalid = true;
            out.hints.push('constraint');
            if (element.validationMessage) out.message = element.validationMessage;
        }
    } catch (_) {}
    try {
        if (typeof AccName !== 'undefined') {
            const t = AccName.errorText(element);
            if (t) {
                out.invalid = true;
                out.hints.push('error-text');
                out.message = out.message ? (out.message + ' | ' + t) : t;
            }
        }
    } catch (_) {}
    try {
        // Class-name hints alone are weak (Angular marks pristine fields
        // ng-invalid); report them as a suspicion, not a verdict.
        const cls = ((element.className || '') + ' ' + (element.parentElement ? element.parentElement.className || '' : '')).toLowerCase();
        if (/(^|\s)(is-invalid|has-error|field-error|input-error|error|invalid)(\s|$)/.test(cls)) {
            out.hints.push('class');
            if (!out.invalid) out.suspect = true;
        }
    } catch (_) {}
    if (out.message.length > 300) out.message = out.message.slice(0, 300);
    return out;
}

// --- Event simulation -----------------------------------------------------

function triggerEvents(element, eventTypes) {
    eventTypes.forEach(eventType => {
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        element.dispatchEvent(event);
    });
}

function simulateMouseClick(element, outsideClick = false) {
    const rect = element.getBoundingClientRect();
    let centerX, centerY;

    if (outsideClick) {
        centerX = rect.right + 1;
        centerY = rect.bottom + 1;
    } else {
        centerX = rect.left + rect.width / 2;
        centerY = rect.top + rect.height / 2;
    }

    const clickEvent = new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: centerX,
        clientY: centerY
    });

    if (outsideClick) {
        const doc = element.ownerDocument || document;
        const target = doc.elementFromPoint(centerX, centerY);
        (target || doc.body).dispatchEvent(clickEvent);
    } else {
        element.dispatchEvent(clickEvent);
    }
}

// Full pointer/mouse/focus/click sequence at the element's center. Bot-aware
// scripts watch for pointerdown/mousedown before input; a bare focus() does
// not satisfy them. Use this before mutating a text field's value, and to
// press buttons/options (most widgets react to mousedown, not click).
function simulateRealisticFocus(element) {
    try { element.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 };

    const fire = (Ctor, type, init) => {
        try { element.dispatchEvent(new Ctor(type, init)); } catch (_) {}
    };

    fire(PointerEvent, 'pointerover', { ...opts, pointerType: 'mouse' });
    fire(MouseEvent, 'mouseover', opts);
    fire(PointerEvent, 'pointermove', { ...opts, pointerType: 'mouse' });
    fire(MouseEvent, 'mousemove', opts);
    fire(PointerEvent, 'pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true });
    fire(MouseEvent, 'mousedown', opts);
    try { element.focus(); } catch (_) {}
    fire(FocusEvent, 'focus', { bubbles: false });
    fire(FocusEvent, 'focusin', { bubbles: true });
    fire(PointerEvent, 'pointerup', { ...opts, pointerType: 'mouse', isPrimary: true, buttons: 0 });
    fire(MouseEvent, 'mouseup', { ...opts, buttons: 0 });
    fire(MouseEvent, 'click', { ...opts, buttons: 0 });
}

// Delete the last character and type it back, producing a real keystroke
// trail on a field that was filled some other way. Net change is zero.
async function tickleField(element) {
    if (!element) return;
    try {
        await TypingEngine.retypeLastChar(element);
    } catch (e) {
        console.warn('[tickleField] failed:', e);
    }
}

// Native value setter, bypassing framework overrides.
function getNativeSetter(element) {
    const tag = element.tagName;
    if (tag === 'TEXTAREA') return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    if (tag === 'SELECT') return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
}

function verifyFieldValue(element, expected) {
    const actual = element.isContentEditable ? element.textContent.trim() : (element.value || '');
    return actual === String(expected);
}

// Strategy: React/Vue/Angular-aware fill via native prototype setter.
function fillWithNativeSetter(element, value) {
    try {
        const setter = getNativeSetter(element);
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch (_) { return false; }
}

// Strategy: execCommand insertText (only works while the page has focus).
function fillWithExecCommand(element, value) {
    try {
        element.focus();
        element.select();
        return document.execCommand('insertText', false, value);
    } catch (_) { return false; }
}

// Strategy: synthesized paste event, for inputs that only process value
// changes through their paste handler.
function fillWithPaste(element, value) {
    try {
        element.focus();
        try { element.select(); } catch (_) {}
        const dt = new DataTransfer();
        dt.setData('text/plain', String(value));
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const delivered = element.dispatchEvent(ev);
        if (!delivered || ev.defaultPrevented === false) {
            try { getNativeSetter(element).call(element, value); } catch (_) { element.value = value; }
        }
        element.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: String(value), bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch (_) { return false; }
}

// Per-character typing. See typingEngine.js.
async function fillWithCharByChar(element, value) {
    await TypingEngine.typeText(element, value, {
        clearFirst: true,
        isCancelled: () => window.stopFilling,
    });
}

// Relaxed verify for masked/formatted inputs: every alphanumeric of the
// expected value appears, in order, in the actual value.
function verifyFieldValueRelaxed(element, expected) {
    const actual = element.isContentEditable ? element.textContent : (element.value || '');
    const strip = s => String(s).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    const a = strip(actual), e = strip(expected);
    return e.length > 0 && a.includes(e);
}

// Fill a text/textarea/contenteditable field.
//
// Typing comes FIRST and is the normal path: most forms now check that a field
// was really typed into. The value-assignment strategies below exist only for
// fields keystrokes cannot drive (readonly/masked widgets, date inputs,
// framework-controlled inputs that reject synthetic keys).
//
// Returns { filled, typed, strategy }.
async function fillTextInput(element, value) {
    const typable = TypingEngine.isTypable(element);

    // A field with maxlength can only ever hold that many characters. The
    // marker tells the verify step that the truncated result is intended.
    const cap = (typeof element.maxLength === 'number' && element.maxLength > 0)
        ? element.maxLength : -1;
    if (cap > 0 && String(value).length > cap) {
        console.log(`[fillTextInput] Value longer than maxlength=${cap}; truncating.`);
        try { element.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {}
        value = String(value).slice(0, cap);
    }

    if (typable) {
        await fillWithCharByChar(element, value);
        await sleep(60);
        if (verifyFieldValue(element, value)) return { filled: true, typed: true, strategy: 'typed' };
        if (verifyFieldValueRelaxed(element, value)) {
            return { filled: true, typed: true, strategy: 'typed-masked' };
        }

        // Masks that insert their own separators and reject ours (dates,
        // phone numbers, card numbers): type the alphanumerics only.
        const alnum = String(value).replace(/[^0-9a-zA-Z]/g, '');
        if (alnum && alnum !== String(value)) {
            await fillWithCharByChar(element, alnum);
            await sleep(60);
            if (verifyFieldValue(element, value) || verifyFieldValueRelaxed(element, value)) {
                return { filled: true, typed: true, strategy: 'typed-alnum' };
            }
        }
    }

    fillWithNativeSetter(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false, strategy: 'native-setter' };

    fillWithExecCommand(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false, strategy: 'execCommand' };

    fillWithPaste(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false, strategy: 'paste' };
    if (verifyFieldValueRelaxed(element, value)) return { filled: true, typed: false, strategy: 'paste-masked' };

    console.warn('[fillTextInput] Value may not have stuck for:', element.id || element.name || element,
                 'expected:', value, 'got:', element.value);
    return { filled: false, typed: typable, strategy: 'none' };
}

// Type into a text-like field and deal with whatever the page does in
// response: a suggestion dropdown to pick from, a mask that reformats, or a
// validator waiting for change/blur.
//
// Returns { handled, selected, reason, optionsSeen, strategy, filled }.
async function fillTextLikeField(element, value, info, attempt = 1) {
    if (attempt > 1 && !TypingEngine.isTypable(element)) {
        try { getNativeSetter(element).call(element, ''); }
        catch (_) { try { element.value = ''; } catch (_) {} }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(20);
    }

    // Watch for a suggestion popup from the first keystroke onwards.
    const watcher = AutocompleteFiller.startWatch(element);
    let result;
    try {
        result = await fillTextInput(element, value);
    } catch (e) {
        watcher.stop();
        throw e;
    }

    let autocompleted = { handled: false };
    try {
        autocompleted = await AutocompleteFiller.resolve(watcher, element, value, info || {});
    } catch (e) {
        watcher.stop();
        console.warn('[fillTextLikeField] autocomplete handling failed:', e);
    }

    if (!autocompleted.handled) {
        if (result && result.filled && !result.typed) {
            await tickleField(element);
            await sleep(50);
        }
        TypingEngine.commitField(element);
    }
    return { ...autocompleted, strategy: result && result.strategy, filled: !!(result && result.filled) };
}

// Set a checkbox (or ARIA checkbox/switch) to `shouldCheck`.
function isCheckedControl(element) {
    if (typeof element.checked === 'boolean' && element.tagName === 'INPUT') return element.checked;
    const ac = element.getAttribute('aria-checked') || element.getAttribute('aria-pressed');
    return ac === 'true';
}

async function setCheckbox(element, shouldCheck) {
    if (isCheckedControl(element) === shouldCheck) return true;
    // Native checkbox: clicking its label toggles it too and is what people
    // do with visually-hidden custom checkboxes.
    simulateRealisticFocus(element);
    await sleep(40);
    if (isCheckedControl(element) !== shouldCheck) {
        // The realistic sequence may have toggled twice or not at all; use a
        // plain click as the second attempt.
        simulateMouseClick(element);
        await sleep(40);
    }
    if (isCheckedControl(element) !== shouldCheck && element.tagName === 'INPUT') {
        element.checked = shouldCheck;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return isCheckedControl(element) === shouldCheck;
}

// Click one radio button (a member of a group) the way a person would.
async function selectRadio(radio) {
    if (!radio) return false;
    if (radio.checked) return true;
    simulateRealisticFocus(radio);
    await sleep(40);
    if (!radio.checked) {
        simulateMouseClick(radio);
        await sleep(40);
    }
    if (!radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return radio.checked;
}

function parseBoolean(value) {
    if (value === true || value === false) return value;
    const s = String(value == null ? '' : value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on', 'checked', 'check', 'ja', 'oui', 'si'].includes(s)) return true;
    if (['false', '0', 'no', 'n', 'off', 'unchecked', 'uncheck', 'nee', 'non', ''].includes(s)) return false;
    return null;
}

// Fill any single element with a value. Dispatches on the control type.
// `info` carries label/placeholder for the autocomplete tiebreak.
// Returns a result object; see FormKit.execute for the shape it reports.
async function fillField(element, value, info, attempt = 1) {
    const sleep_between_events_ms = 50;
    const tag = element.tagName.toLowerCase();
    const inputType = (element.getAttribute('type') || '').toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();

    const isTextLike = !(
        tag === 'select' ||
        inputType === 'checkbox' || inputType === 'radio' ||
        role === 'checkbox' || role === 'switch' || role === 'radio' ||
        isCustomCombobox(element)
    );

    if (isTextLike) {
        simulateRealisticFocus(element);
    } else {
        try { element.focus(); } catch (_) {}
    }
    await sleep(sleep_between_events_ms);

    let result = { ok: false };
    if (tag === 'select') {
        const ok = await fillSelectField(element, value);
        result = { ok, strategy: 'select' };
        await sleep(delay_after_dropdown_selection_ms);
    } else if (inputType === 'checkbox' || role === 'checkbox' || role === 'switch') {
        const b = parseBoolean(value);
        if (b === null) {
            result = { ok: false, strategy: 'checkbox', error: `Not a boolean: ${value}` };
        } else {
            const ok = await setCheckbox(element, b);
            result = { ok, strategy: 'checkbox' };
        }
    } else if (inputType === 'radio' || role === 'radio') {
        // Direct radio fill: choose within this element's group. Groups are
        // normally handled by FormKit (choose on a radio-group ref).
        const root = rootNodeOf(element);
        const groupName = element.getAttribute('name');
        let target = null;
        if (groupName) {
            const radios = Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`));
            const want = String(value).trim().toLowerCase();
            target = radios.find(r => (r.value || '').trim().toLowerCase() === want) ||
                     radios.find(r => (AccName.optionLabel(r) || '').toLowerCase() === want) ||
                     radios.find(r => (AccName.optionLabel(r) || '').toLowerCase().includes(want));
        }
        if (!target) {
            const b = parseBoolean(value);
            if (b === true) target = element;
        }
        const ok = await selectRadio(target);
        result = { ok, strategy: 'radio', error: ok ? undefined : `No radio matched "${value}"` };
    } else if (isCustomCombobox(element)) {
        const ok = await fillCustomCombobox(element, value);
        if (ok) {
            result = { ok: true, strategy: 'combobox' };
        } else {
            // Free-text combobox, or one whose list never opened on click:
            // type into it and take whatever suggestions that produces.
            const r = await fillTextLikeField(element, value, info, attempt);
            result = { ok: r.handled || r.filled, ...r };
        }
    } else {
        const r = await fillTextLikeField(element, value, info, attempt);
        result = { ok: r.handled || r.filled, ...r };
    }

    await sleep(sleep_between_events_ms);
    element.setAttribute('data-filled-by-extension', 'true');
    return result;
}

// Multi-strategy option matcher over {text, value} entries.
// Order: exact > numeric equivalence > prefix > substring > token overlap.
function findMatchingOption(entries, value) {
    const target = String(value == null ? '' : value).trim().toLowerCase();
    if (!target) return null;
    const targetNum = Number(target);
    const isTargetNum = target !== '' && !isNaN(targetNum);

    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

    for (const e of entries) {
        if (norm(e.text) === target || norm(e.value) === target) return e;
    }
    if (isTargetNum) {
        for (const e of entries) {
            const tn = Number(norm(e.text));
            if (!isNaN(tn) && norm(e.text) !== '' && tn === targetNum) return e;
        }
        for (const e of entries) {
            const vn = Number(norm(e.value));
            if (!isNaN(vn) && norm(e.value) !== '' && vn === targetNum) return e;
        }
    }
    // Prefix either direction ("Apr" ~ "April"), but never match the empty
    // placeholder option and never let a 1-2 char target match everything.
    if (target.length >= 2) {
        for (const e of entries) {
            const t = norm(e.text);
            if (t && (t.startsWith(target) || (target.length >= 3 && target.startsWith(t) && t.length >= 3))) return e;
        }
        for (const e of entries) {
            const t = norm(e.text);
            if (t && target.length >= 3 && (t.includes(target) || (t.length >= 3 && target.includes(t)))) return e;
        }
    }
    // Token overlap ("United States of America" ~ "United States").
    if (typeof AutocompleteFiller !== 'undefined') {
        let best = null, bestScore = 0;
        for (const e of entries) {
            const s = AutocompleteFiller.score(e.text, target);
            if (s > bestScore) { bestScore = s; best = e; }
        }
        if (best && bestScore >= 0.6) return best;
    }
    return null;
}

async function fillSelectField(selectElement, value) {
    simulateMouseClick(selectElement);
    try { await waitForOptions(selectElement); } catch (e) { console.warn('[fillSelectField]', e.message); }

    const options = Array.from(selectElement.options);
    const optionToSelect = findMatchingOption(options, value);

    if (!optionToSelect) {
        console.warn(`[fillSelectField] No option matched "${value}" in`, selectElement);
        return false;
    }
    try { getNativeSetter(selectElement).call(selectElement, optionToSelect.value); }
    catch (_) { selectElement.value = optionToSelect.value; }
    selectElement.dispatchEvent(new Event('input', { bubbles: true }));
    selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    try { await waitForSelection(selectElement, optionToSelect.value); } catch (e) { return false; }
    return true;
}

// Widgets that look like list dropdowns but are not native <select>: MUI
// Autocomplete, Ant Design Select, Chakra Menu, ARIA comboboxes. Excludes date
// pickers and search-as-you-type inputs, which belong on the typing path.
function isCustomCombobox(element) {
    if (!element) return false;
    if (element.tagName === 'SELECT') return false;

    const ph = element.getAttribute('placeholder') || '';
    if (/(^|\W)(dd|mm|yy|yyyy|aa|aaaa|jj|tt)(\W|$)/i.test(ph)) return false;

    const hp = (element.getAttribute('aria-haspopup') || '').toLowerCase();
    if (hp === 'dialog' || hp === 'grid') return false;

    const aac = (element.getAttribute('aria-autocomplete') || '').toLowerCase();
    const typableInput = (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') &&
                         !element.readOnly && !element.hasAttribute('readonly');
    if (typableInput && (aac === 'list' || aac === 'both' || aac === 'inline')) return false;

    const role = (element.getAttribute('role') || '').toLowerCase();
    if (role === 'combobox' || role === 'listbox') return true;
    if (hp === 'listbox' || hp === 'menu' || hp === 'true') return true;
    if ((element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') &&
        (element.readOnly || element.hasAttribute('readonly')) &&
        (element.getAttribute('aria-controls') || element.getAttribute('aria-owns'))) {
        return true;
    }
    return false;
}

function findAssociatedListbox(element) {
    const root = rootNodeOf(element);
    const doc = element.ownerDocument || document;
    const ids = [element.getAttribute('aria-controls'), element.getAttribute('aria-owns')]
        .filter(Boolean).flatMap(s => s.split(/\s+/));
    for (const id of ids) {
        let el = null;
        try { el = root.getElementById ? root.getElementById(id) : null; } catch (_) {}
        if (!el) el = doc.getElementById(id);
        if (el && isVisible(el)) return el;
    }
    const candidates = Array.from(doc.querySelectorAll(
        '[role="listbox"], [role="menu"], [role="tree"], [role="grid"]'
    )).filter(el => isVisible(el) && el !== element && !el.contains(element));
    return candidates[candidates.length - 1] || null;
}

function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
}

// Open a custom combobox and click the matching option. Generic, no
// site-specific logic. Returns true when an option was picked.
async function fillCustomCombobox(element, value) {
    simulateRealisticFocus(element);

    let listbox = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        if (window.stopFilling) throw new Error("Form filling stopped by user.");
        listbox = findAssociatedListbox(element);
        if (listbox) break;
        await sleep(50);
    }
    if (!listbox) {
        console.warn('[fillCustomCombobox] No listbox appeared after clicking');
        return false;
    }

    const optionEls = Array.from(listbox.querySelectorAll(
        '[role="option"], [role="menuitem"], [role="treeitem"], [role="gridcell"], li, option'
    )).filter(isVisible);

    const entries = optionEls.map(el => ({
        text: cleanText(el.textContent || ''),
        value: el.getAttribute('data-value') || el.getAttribute('value') || cleanText(el.textContent || ''),
        el
    }));

    let match = findMatchingOption(entries, value);

    if (!match) {
        const scored = entries
            .map(e => ({ e, s: AutocompleteFiller.score(e.text, value) }))
            .sort((a, b) => b.s - a.s)[0];
        if (scored && scored.s >= 0.55) match = scored.e;
    }

    if (!match && TypingEngine.isTypable(element)) {
        // Searchable combobox (react-select, select2, MUI Autocomplete): the
        // full option list only appears after typing a query.
        const watcher = AutocompleteFiller.startWatch(element);
        await TypingEngine.typeText(element, value, {
            clearFirst: true, isCancelled: () => window.stopFilling
        });
        const res = await AutocompleteFiller.resolve(watcher, element, value, {});
        if (res.handled) return true;
    }

    if (!match) {
        console.warn('[fillCustomCombobox] No matching option for', value, 'among', entries.map(e => e.text));
        TypingEngine.pressKey(element, 'Escape');
        simulateMouseClick(document.body, true);
        return false;
    }

    match.el.scrollIntoView({ block: 'nearest' });
    AutocompleteFiller.mouseSequence(match.el);
    await sleep(50);
    match.el.dispatchEvent(new Event('change', { bubbles: true }));
    try { element.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {}
    return true;
}

async function waitForOptions(selectElement, timeout = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        if (window.stopFilling) {
            throw new Error("Form filling stopped by user.");
        }
        if (selectElement.options.length > 0) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timeout waiting for select options to load');
}

async function waitForSelection(selectElement, expectedValue, timeout = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        if (window.stopFilling) {
            throw new Error("Form filling stopped by user.");
        }
        if (selectElement.value === expectedValue) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timeout waiting for select value to be applied');
}

// Wait until the DOM has been quiet for `quietMs` (or `maxMs` elapsed). Used
// after a batch of actions so dependent fields, masks and validators have
// rendered before we look at the result.
function waitForDomSettle(quietMs = 350, maxMs = 3000) {
    return new Promise(resolve => {
        let timer = null;
        let obs = null;
        const done = () => {
            if (obs) { try { obs.disconnect(); } catch (_) {} }
            clearTimeout(timer);
            clearTimeout(hard);
            resolve();
        };
        const bump = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
        try {
            obs = new MutationObserver(bump);
            obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
        } catch (_) {}
        const hard = setTimeout(done, maxMs);
        bump();
    });
}
