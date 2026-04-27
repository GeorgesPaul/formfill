/*
Performance note: Traversing * for shadow hosts can be slow on very large pages. If needed, optimize by limiting recursion depth or scoping to known containers (e.g., pass document.getElementById('layout-container') as root if that's where content loads)
*/
function cleanText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

function getAllFormElements(root = document) {
    const elements = [];
    // Broadened selectors to include semantic roles and contenteditable
    const selectors = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="listbox"]';

    // Collect from the current root
    if (root.querySelectorAll) {
        elements.push(...root.querySelectorAll(selectors));
    }

    // Recurse into shadow DOM if present
    if (root.shadowRoot) {
        elements.push(...getAllFormElements(root.shadowRoot));
    }

    // Find all potential shadow hosts in this root and recurse
    const shadowHosts = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const host of shadowHosts) {
        if (host.shadowRoot) {
            elements.push(...getAllFormElements(host.shadowRoot));
        }
    }

    return elements;
}

// Form field processing functions
function getFormFieldInfo(input) {
    const info = getBasicFieldInfo(input);
    info.label = getAssociatedLabel(input);
    info.nearbyText = getNearbyText(input); // Now internally truncated
    info.attributes = getElementAttributes(input);
    // Remove the iframeInfo property

    if (input.tagName.toLowerCase() === 'select') {
        info.options = Array.from(input.options).map(option => cleanText(option.text));
    }

    // For contenteditable, adding a note
    if (input.isContentEditable) {
        info.type = 'contenteditable';
    }

    return { element: input, info: info };
}

function getBasicFieldInfo(input) {
    return {
        name: input.name,
        id: input.id,
        placeholder: cleanText(input.placeholder),
        type: input.type || (input.isContentEditable ? 'contenteditable' : input.getAttribute('role')),
        required: input.required || input.getAttribute('aria-required') === 'true',
        autocomplete: input.autocomplete,
        classes: input.className,
        // Only use textContent for contenteditable; otherwise trust .value (even if empty)
        value: input.isContentEditable ? cleanText(input.textContent) : input.value,
        parentElement: {
            tagName: input.parentElement ? input.parentElement.tagName : 'BODY',
            classes: input.parentElement ? input.parentElement.className : ''
        }
    };
}

function getAssociatedLabel(input) {
    let label = document.querySelector(`label[for="${input.id}"]`);

    // Try aria-labelledby
    if (!label && input.getAttribute('aria-labelledby')) {
        const labelledBy = document.getElementById(input.getAttribute('aria-labelledby'));
        if (labelledBy) return cleanText(labelledBy.textContent);
    }

    // Try aria-label
    if (!label && input.getAttribute('aria-label')) {
        return input.getAttribute('aria-label');
    }

    if (!label) {
        let element = input;
        for (let i = 0; i < 3; i++) {
            element = element.parentElement;
            if (!element) break;

            label = element.querySelector('label');
            if (label) break;

            if (element.tagName.toLowerCase() === 'label') {
                label = element;
                break;
            }
        }
    }

    return label ? (label.textContent ? cleanText(label.textContent) : label) : null;
}

function getNearbyText(element, maxDistance = 100) {
    let text = '';
    let currentNode = element;
    let distance = 0;

    // Helper to add text if not too long
    const addText = (t) => {
        if (text.length + t.length > 200) return false; // Hard truncate limit
        text += t + ' ';
        return true;
    };

    while (currentNode && distance < maxDistance) {
        if (currentNode.nodeType === Node.TEXT_NODE) {
            if (!addText(cleanText(currentNode.textContent))) break;
        } else if (currentNode.nodeType === Node.ELEMENT_NODE && currentNode.tagName.toLowerCase() === 'label') {
            if (!addText(cleanText(currentNode.textContent))) break;
        }

        currentNode = currentNode.previousSibling || currentNode.parentNode;
        distance++;
    }

    return text.trim().substring(0, 200); // Ensure final limit
}

function getElementAttributes(element) {
    const attributes = {};
    const whitelist = [
        'id', 'name', 'type', 'placeholder', 'required', 'pattern', 'min', 'max', 'step',
        'aria-label', 'aria-description', 'aria-required', 'role', 'title', 'class'
    ];

    for (let attr of element.attributes) {
        if (whitelist.includes(attr.name) || attr.name.startsWith('aria-')) {
            attributes[attr.name] = attr.value;
        }
    }
    return attributes;
}

function findIframesWithForms() {
    const iframesWithForms = [];
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
        try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
            // Relaxed check for iframes too
            if (getAllFormElements(iframeDocument).length > 0) {
                iframesWithForms.push(iframeDocument);
            }
        } catch (e) {
            console.warn('Error accessing iframe:', e);
        }
    }
    return iframesWithForms.length > 0 ? iframesWithForms : [document];
}

// Helper function to check if element already has the correct value
function elementHasCorrectValue(element, expectedValue) {
    let currentValue = element.value || '';
    if (element.isContentEditable) currentValue = element.textContent;

    const normalizedExpected = expectedValue.toString().trim();
    const normalizedCurrent = currentValue.toString().trim();

    // For select elements, check both the selected option's text and value
    if (element.tagName.toLowerCase() === 'select') {
        const selectedOption = element.options[element.selectedIndex];
        if (selectedOption) {
            const optionText = selectedOption.text.trim().toLowerCase();
            const optionValue = selectedOption.value.trim().toLowerCase();
            const expectedLower = normalizedExpected.toLowerCase();

            return optionText === expectedLower || optionValue === expectedLower;
        }
        return false;
    }

    // For other input types, do a direct comparison
    return normalizedCurrent === normalizedExpected;
}

function getVisibleFormElements(documents) {
    let allElements = [];
    documents.forEach(doc => {
        // Use the recursive function on each document (main or iframe)
        const elementsFromDoc = getAllFormElements(doc);

        // Filter for visibility (update to use doc's window for iframes)
        const filtered = elementsFromDoc.filter(el => {
            const win = el.ownerDocument.defaultView || window;  // Use iframe's window if applicable
            const style = win.getComputedStyle(el);
            const rect = el.getBoundingClientRect();  // Note: rect is relative to viewport; for iframes, adjust if needed by adding iframe offset

            // Relaxed visibility checks
            // We allow opacity 0 if it's an input (some file inputs or stylized inputs do this)
            // We allow small size if it's likely a custom control

            const isHidden = style.display === 'none' || style.visibility === 'hidden';
            // Exception: If it has opacity 0 but is an input, it might be a stylized overlay. 
            // Better to rely on display/visibility checks primarily.

            // However, truly hidden elements (display:none) are usually not interactable.
            // But we must catch elements that are technically visible but maybe transparent or clipped.

            if (isHidden) return false;

            // Size check: Relaxed to allow smaller hit targets (e.g. custom checkboxes)
            const hasSize = (rect.width > 0 && rect.height > 0) || (el.offsetWidth > 0 && el.offsetHeight > 0);

            return hasSize;
        });

        allElements = allElements.concat(filtered);
    });

    return allElements;
}

// Simulates fake manual events on an element to trick web pages into thinking they are being filled out by a human
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
        // Click slightly outside the element
        centerX = rect.right + 1;
        centerY = rect.bottom + 1;
    } else {
        // Click in the center of the element
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
        document.elementFromPoint(centerX, centerY)?.dispatchEvent(clickEvent);
    } else {
        element.dispatchEvent(clickEvent);
    }
}

// Full pointer/mouse/focus/click sequence at the field's center. Bot-detection
// scripts watch for pointerdown/mousedown before input -- a bare focus() does
// not satisfy them. Use this before mutating a text field's value.
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

// Append a single character then delete it, producing real keydown/keyup/
// beforeinput/input events. Used after non-typing fill strategies so that
// detection scripts which require keystroke evidence see them. Net change to
// the field's value is zero. Caller must already have focus on the element.
async function tickleField(element) {
    if (!element) return;
    const TICKLE_CHAR = 'a';
    const TICKLE_CODE = TICKLE_CHAR.charCodeAt(0);
    const isCE = !!element.isContentEditable;

    try {
        // Park the caret at the end so insertText appends.
        if (!isCE) {
            try {
                const len = (element.value || '').length;
                element.setSelectionRange(len, len);
            } catch (_) {}
        }

        // Insert the tickle char.
        element.dispatchEvent(new KeyboardEvent('keydown', {
            key: TICKLE_CHAR, code: 'Key' + TICKLE_CHAR.toUpperCase(),
            keyCode: TICKLE_CODE, charCode: TICKLE_CODE, bubbles: true, cancelable: true
        }));
        const inserted = document.execCommand('insertText', false, TICKLE_CHAR);
        if (!inserted && !isCE) {
            // execCommand blocked (CSP/Trusted Types). Append via native setter.
            try {
                const setter = getNativeSetter(element);
                setter.call(element, (element.value || '') + TICKLE_CHAR);
                element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: TICKLE_CHAR, bubbles: true }));
            } catch (_) {}
        }
        element.dispatchEvent(new KeyboardEvent('keyup', {
            key: TICKLE_CHAR, code: 'Key' + TICKLE_CHAR.toUpperCase(),
            keyCode: TICKLE_CODE, charCode: TICKLE_CODE, bubbles: true
        }));
        await sleep(15);

        // Delete it (Backspace).
        element.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true, cancelable: true
        }));
        const deleted = document.execCommand('delete', false);
        if (!deleted && !isCE) {
            try {
                const setter = getNativeSetter(element);
                const v = element.value || '';
                if (v.endsWith(TICKLE_CHAR)) setter.call(element, v.slice(0, -1));
                element.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
            } catch (_) {}
        }
        element.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true
        }));
    } catch (e) {
        console.warn('[tickleField] failed:', e);
    }
}


// Get the native value setter for an element, bypassing any framework overrides.
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

// Strategy 1: React/Vue/Angular-aware fill via native prototype setter.
function fillWithNativeSetter(element, value) {
    try {
        const setter = getNativeSetter(element);
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch (_) { return false; }
}

// Strategy 2: execCommand insertText (works in many contentEditable-like inputs).
function fillWithExecCommand(element, value) {
    try {
        element.focus();
        element.select();
        return document.execCommand('insertText', false, value);
    } catch (_) { return false; }
}

// Strategy 2b: Synthesized paste event. Some masked/formatted inputs only
// process value changes through their paste handler.
function fillWithPaste(element, value) {
    try {
        element.focus();
        try { element.select(); } catch (_) {}
        const dt = new DataTransfer();
        dt.setData('text/plain', String(value));
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const delivered = element.dispatchEvent(ev);
        if (!delivered || ev.defaultPrevented === false) {
            // Handler didn't set the value -- do it ourselves so the paste event's
            // downstream listeners (input/change) still fire against a populated field.
            try { getNativeSetter(element).call(element, value); } catch (_) { element.value = value; }
        }
        element.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: String(value), bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch (_) { return false; }
}

// Per-character insertText. Mimics real keyboard typing: each char flows
// through the browser's input pipeline, so masked/formatted inputs (Syncfusion,
// Cleave, IMask, etc.) can intercept and format naturally. The first char
// replaces any existing selection so previous strategies' partial state
// is overwritten.
async function fillWithCharByChar(element, value) {
    element.focus();
    // Select existing content so the first insertText overwrites it.
    try { element.setSelectionRange(0, (element.value || '').length); } catch (_) {}

    const str = String(value);
    for (const char of str) {
        if (window.stopFilling) throw new Error("Form filling stopped by user.");
        const code = char.charCodeAt(0);
        element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true, keyCode: code, charCode: code }));
        document.execCommand('insertText', false, char);
        element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, keyCode: code }));
        await sleep(5);
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
}

// Relaxed verify for masked/formatted inputs. Returns true if every
// alphanumeric character of the expected value appears in order somewhere
// in the actual value. Handles cases where the mask reformats the string
// (e.g. typed "18041985", displayed "18-04-1985").
function verifyFieldValueRelaxed(element, expected) {
    const actual = element.isContentEditable ? element.textContent : (element.value || '');
    const strip = s => String(s).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    const a = strip(actual), e = strip(expected);
    return e.length > 0 && a.includes(e);
}

// Fill a text/textarea/contenteditable field with verify-and-retry cascade.
// Returns { filled, typed } so the caller can decide whether to tickle.
async function fillTextInput(element, value) {
    const tag = element.tagName;

    // Strategy 1: Native setter (fast, works on React/Vue/Angular vanilla inputs)
    console.log('[fillTextInput] Strategy 1: native setter');
    fillWithNativeSetter(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false };

    // Strategy 2: execCommand insertText (whole value)
    console.log('[fillTextInput] Strategy 2: execCommand insertText (whole)');
    fillWithExecCommand(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false };

    // Strategy 3: Synthesized paste event
    console.log('[fillTextInput] Strategy 3: paste event');
    fillWithPaste(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false };

    // Strategy 4: Per-char insertText with full value. Masks can reject
    // separator chars but still accept digits -- this lets them format.
    console.log('[fillTextInput] Strategy 4: per-char insertText (full)');
    await fillWithCharByChar(element, value);
    await sleep(100);
    if (verifyFieldValue(element, value)) return { filled: true, typed: true };
    // Relaxed match: mask may have reformatted our input. Good enough.
    if (verifyFieldValueRelaxed(element, value)) {
        console.log('[fillTextInput] Strategy 4 succeeded with relaxed verify (masked input).');
        return { filled: true, typed: true };
    }

    // Strategy 5: Per-char insertText with separators stripped. For masks
    // that auto-insert their own separators and reject ours.
    const alnum = String(value).replace(/[^0-9a-zA-Z]/g, '');
    if (alnum && alnum !== String(value)) {
        console.log('[fillTextInput] Strategy 5: per-char insertText (alphanumerics only)');
        // Clear first so we don't accumulate on top of strategy 4 residue.
        try { getNativeSetter(element).call(element, ''); } catch (_) { element.value = ''; }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(20);
        await fillWithCharByChar(element, alnum);
        await sleep(100);
        if (verifyFieldValue(element, value) || verifyFieldValueRelaxed(element, value)) {
            console.log('[fillTextInput] Strategy 5 succeeded.');
            return { filled: true, typed: true };
        }
    }

    console.warn('[fillField] Value may not have stuck for:', element.id || element.name || element,
                 'expected:', value, 'got:', element.value);
    return { filled: false, typed: true };
}

async function fillField(element, value, info) {
    const sleep_between_events_ms = 50;
    console.log(`Filling field:`, element, `with value:`, value);

    const tag = element.tagName.toLowerCase();
    const inputType = (element.getAttribute('type') || '').toLowerCase();

    // Text-like fields go through the typing path: realistic click+focus first
    // (so detection scripts see pointer/mouse events), then fill, then a
    // single-char tickle if no per-char typing already happened.
    const isTextLike = !(
        tag === 'select' ||
        inputType === 'checkbox' ||
        inputType === 'radio' ||
        isCustomCombobox(element)
    );

    if (isTextLike) {
        simulateRealisticFocus(element);
    } else {
        element.focus();
    }
    await sleep(sleep_between_events_ms);

    if (tag === 'select') {
        await fillSelectField(element, value);
        await sleep(delay_after_dropdown_selection_ms); // 2-second delay after dropdown selection
    } else if (inputType === 'checkbox') {
        // Handle checkbox: value should be true/false or "true"/"false"
        const shouldCheck = value === true || value === 'true' || value === '1' || value === 'yes';
        if (element.checked !== shouldCheck) {
            simulateMouseClick(element);
            await sleep(sleep_between_events_ms);
            // Dispatch change event
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        console.log(`Checkbox ${element.name || element.id}: set to ${shouldCheck}`);
    } else if (inputType === 'radio') {
        // Handle radio button: find the radio in the group matching the value and click it
        const groupName = element.getAttribute('name');
        if (groupName) {
            // Find the radio button with matching value in the group
            const targetRadio = document.querySelector(
                `input[type="radio"][name="${CSS.escape(groupName)}"][value="${CSS.escape(String(value))}"]`
            );
            if (targetRadio && !targetRadio.checked) {
                targetRadio.focus();
                simulateMouseClick(targetRadio);
                await sleep(sleep_between_events_ms);
                targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
                console.log(`Radio ${groupName}: selected value "${value}"`);
            } else if (!targetRadio) {
                // Try matching by label text if value match failed
                const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`);
                for (const radio of radios) {
                    const label = getDomLabelForElement(radio);
                    if (label && label.toLowerCase().includes(String(value).toLowerCase())) {
                        if (!radio.checked) {
                            radio.focus();
                            simulateMouseClick(radio);
                            await sleep(sleep_between_events_ms);
                            radio.dispatchEvent(new Event('change', { bubbles: true }));
                            console.log(`Radio ${groupName}: selected by label match "${label}"`);
                        }
                        break;
                    }
                }
            }
        }
    } else if (isCustomCombobox(element)) {
        // ARIA combobox / custom dropdown (Syncfusion, MUI, Ant Design, etc.).
        // Open it, click the matching option.
        const ok = await fillCustomCombobox(element, value);
        if (!ok) {
            // Fall back to typing in case it's a combobox with free-text entry.
            await fillTextInput(element, value);
        }
    } else {
        // Verify-and-retry cascade: native setter, then execCommand, then keystrokes.
        // Handles React/Vue/Angular controlled inputs that ignore raw value assignment.
        const result = await fillTextInput(element, value);
        // If a non-typing strategy succeeded, leave a keystroke trail for
        // detection scripts that gate on real keyboard events.
        if (result && result.filled && !result.typed) {
            await tickleField(element);
            await sleep(sleep_between_events_ms);
        }
    }

    await sleep(sleep_between_events_ms);
    element.setAttribute('data-filled-by-extension', 'true'); // Mark as filled in case of re-filling to avoid filling same element
}

// Helper to get label for a form element (used by radio button matching)
function getDomLabelForElement(el) {
    // Check for associated <label> element
    if (el.id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (labelEl) return labelEl.textContent.trim();
    }
    // Check if wrapped in a <label>
    const parentLabel = el.closest('label');
    if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        const inputs = clone.querySelectorAll('input, select, textarea');
        inputs.forEach(inp => inp.remove());
        const text = clone.textContent.trim();
        if (text) return text;
    }
    // aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    return '';
}

// Multi-strategy option matcher. Works on arrays of {text, value} pairs so it
// can be reused for both native <select> options and ARIA listbox items.
// Order: exact > numeric equivalence > startsWith > substring. Returns the
// matched entry or null.
function findMatchingOption(entries, value) {
    const target = String(value).trim().toLowerCase();
    if (!target) return null;
    const targetNum = Number(target);
    const isTargetNum = target !== '' && !isNaN(targetNum);

    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

    // 1. Exact text or value match (case-insensitive, trimmed)
    for (const e of entries) {
        if (norm(e.text) === target || norm(e.value) === target) return e;
    }
    // 2. Numeric equivalence ("4" === "04" === " 4 ")
    if (isTargetNum) {
        for (const e of entries) {
            const tn = Number(norm(e.text));
            if (!isNaN(tn) && tn === targetNum) return e;
        }
        for (const e of entries) {
            const vn = Number(norm(e.value));
            if (!isNaN(vn) && vn === targetNum) return e;
        }
    }
    // 3. Prefix match either direction ("Apr" matches "April"; "April" matches "Apr")
    for (const e of entries) {
        const t = norm(e.text);
        if (t && (t.startsWith(target) || target.startsWith(t))) return e;
    }
    // 4. Substring fallback
    for (const e of entries) {
        const t = norm(e.text);
        if (t && (t.includes(target) || target.includes(t))) return e;
    }
    return null;
}

async function fillSelectField(selectElement, value) {
    console.log(`Filling select field ${selectElement.name} with value:`, value);

    // Simulate clicking the select element to open the dropdown
    simulateMouseClick(selectElement);

    // Wait for the dropdown to open and options to be available
    await waitForOptions(selectElement);

    const options = Array.from(selectElement.options);
    const optionToSelect = findMatchingOption(options, value);

    if (optionToSelect) {
        // Native setter so React-controlled <select> registers the change.
        try { getNativeSetter(selectElement).call(selectElement, optionToSelect.value); }
        catch (_) { selectElement.value = optionToSelect.value; }
        selectElement.dispatchEvent(new Event('input', { bubbles: true }));
        selectElement.dispatchEvent(new Event('change', { bubbles: true }));

        // Wait for the selection to be applied
        await waitForSelection(selectElement, optionToSelect.value);

        console.log(`Selected option in ${selectElement.name}:`, optionToSelect.text);
    } else {
        console.warn(`Could not find matching option for ${value} in`, selectElement);
    }
}

// Detects widgets that look like list dropdowns but are not native <select> —
// MUI Autocomplete, Ant Design Select, Chakra Menu, ARIA comboboxes. Excludes
// date pickers and other calendar/dialog popups, which should be typed into.
function isCustomCombobox(element) {
    if (!element) return false;
    if (element.tagName === 'SELECT') return false;

    // Placeholder with date-segment letters (dd/mm/yy/yyyy/aa/aaaa/jj) indicates
    // a date picker. These open a calendar, not a listbox -- type into them.
    const ph = element.getAttribute('placeholder') || '';
    if (/(^|\W)(dd|mm|yy|yyyy|aa|aaaa|jj|tt)(\W|$)/i.test(ph)) return false;

    // aria-haspopup="dialog" / "grid" / "tree" are calendars or dialogs, not listboxes.
    const hp = (element.getAttribute('aria-haspopup') || '').toLowerCase();
    if (hp === 'dialog' || hp === 'grid') return false;

    const role = (element.getAttribute('role') || '').toLowerCase();
    if (role === 'combobox' || role === 'listbox') return true;
    if (hp === 'listbox' || hp === 'menu' || hp === 'true') return true;
    // Readonly input with a popup anchor pointing to a listbox-style popup.
    if ((element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') &&
        (element.readOnly || element.hasAttribute('readonly')) &&
        (element.getAttribute('aria-controls') || element.getAttribute('aria-owns'))) {
        return true;
    }
    return false;
}

// Find the listbox/menu associated with a combobox. Tries aria-controls and
// aria-owns first, then scans newly-visible listbox popups in the document.
function findAssociatedListbox(element) {
    const ids = [element.getAttribute('aria-controls'), element.getAttribute('aria-owns')]
        .filter(Boolean).flatMap(s => s.split(/\s+/));
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el && isVisible(el)) return el;
    }
    // Any visible listbox/menu on the page (last opened usually).
    const candidates = Array.from(document.querySelectorAll(
        '[role="listbox"], [role="menu"], [role="tree"], [role="grid"]'
    )).filter(isVisible);
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

// Open a custom combobox, click the matching option. Generic — no site-specific logic.
async function fillCustomCombobox(element, value) {
    console.log('[fillCustomCombobox] Opening combobox for value:', value);
    element.focus();
    simulateMouseClick(element);

    // Wait for a listbox popup to appear.
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

    // Collect option-like descendants.
    const optionEls = Array.from(listbox.querySelectorAll(
        '[role="option"], [role="menuitem"], [role="treeitem"], [role="gridcell"], li, option'
    )).filter(isVisible);

    const entries = optionEls.map(el => ({
        text: cleanText(el.textContent || ''),
        value: el.getAttribute('data-value') || el.getAttribute('value') || cleanText(el.textContent || ''),
        el
    }));

    const match = findMatchingOption(entries, value);
    if (!match) {
        console.warn('[fillCustomCombobox] No matching option for', value, 'among', entries.map(e => e.text));
        // Close the popup so it doesn't stay open.
        simulateMouseClick(document.body, true);
        return false;
    }

    match.el.scrollIntoView({ block: 'nearest' });
    simulateMouseClick(match.el);
    await sleep(50);
    match.el.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[fillCustomCombobox] Clicked option:', match.text);
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
