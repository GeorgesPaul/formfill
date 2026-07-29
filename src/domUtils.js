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

// Text of a <label> minus any form controls nested inside it.
function labelTextWithoutControls(labelEl) {
    try {
        const clone = labelEl.cloneNode(true);
        clone.querySelectorAll('input, select, textarea, button').forEach(n => n.remove());
        const t = cleanText(clone.textContent);
        if (t) return t;
    } catch (_) {}
    return cleanText(labelEl.textContent) || null;
}

// Return ONLY the label a human visually associates with this exact field.
// Never borrow another field's label. The order below goes from least to
// most ambiguous; we deliberately stop rather than guess.
//
// Why this is strict: pages (including deliberate test traps) reuse the same
// id/name on multiple inputs. A global `label[for=ID]` lookup then returns the
// first matching label in the document, mislabelling every later duplicate.
// And climbing to the <form> to find "a label" borrows an unrelated field's
// label for label-less inputs. Both poison the heuristic AND the vision LLM
// (which is fed this label as DOM metadata).
function getAssociatedLabel(input) {
    const doc = input.ownerDocument || document;

    // 1. Wrapping <label> ancestor -- unambiguous, this input is inside it.
    const wrapping = input.closest('label');
    if (wrapping) {
        const t = labelTextWithoutControls(wrapping);
        if (t) return t;
    }

    // 2. Explicit for= association, but ONLY when the id is unique in the
    //    document. Duplicate ids make label[for] ambiguous/misleading.
    if (input.id) {
        let unique = false;
        try { unique = doc.querySelectorAll(`[id="${CSS.escape(input.id)}"]`).length === 1; }
        catch (_) { unique = false; }
        if (unique) {
            let l = null;
            try { l = doc.querySelector(`label[for="${CSS.escape(input.id)}"]`); } catch (_) {}
            if (l) {
                const t = labelTextWithoutControls(l);
                if (t) return t;
            }
        }
    }

    // 3. aria-labelledby / aria-label -- explicit and per-element, safe.
    const albl = input.getAttribute('aria-labelledby');
    if (albl) {
        const parts = albl.split(/\s+/)
            .map(id => { const n = doc.getElementById(id); return n ? cleanText(n.textContent) : ''; })
            .filter(Boolean);
        if (parts.length) return parts.join(' ');
    }
    const al = input.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();

    // 4. Proximity: the label inside the SMALLEST ancestor that contains this
    //    input and no other form control -- i.e. the field's own group/row.
    //    This mirrors the label a human sees next to the field and refuses to
    //    reach far enough to steal a different field's label.
    const CONTROLS = 'input, select, textarea';
    let el = input.parentElement;
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
        if (el.querySelectorAll(CONTROLS).length > 1) break; // group now spans other fields
        const lbl = el.querySelector('label');
        if (lbl) {
            const t = labelTextWithoutControls(lbl);
            if (t) return t;
        }
    }

    // No label this field unambiguously owns. Report none rather than guess.
    return null;
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

    // An autocomplete widget accepted a suggestion for this value. What the
    // widget wrote back ("Main Street 12, 1012 AB Amsterdam") legitimately
    // differs from what we typed, so treat it as correct instead of fighting
    // the widget on every refill pass. Only while the field is non-empty --
    // if the form blanked it, it genuinely needs filling again.
    const carriesText = typeof element.value === 'string' || element.isContentEditable;
    if ((normalizedCurrent || !carriesText) &&
        element.getAttribute('data-ff-accepted-for') === normalizedExpected) {
        return true;
    }

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

    // Exact, then case-insensitive.
    if (normalizedCurrent === normalizedExpected) return true;
    if (normalizedCurrent.toLowerCase() === normalizedExpected.toLowerCase()) return true;

    // Tolerant compare for masked / auto-reformatted fields (phone, date,
    // currency). The form may legitimately turn "1234567890" into
    // "(123) 456-7890" or "18041985" into "18-04-1985"; treat those as
    // correct so the refill loop does not fight the mask forever.
    const strip = s => s.replace(/[^0-9a-z]/gi, '').toLowerCase();
    const a = strip(normalizedCurrent);
    const e = strip(normalizedExpected);
    if (e.length >= 3 && a === e) return true;
    // Mask added a fixed prefix/suffix (e.g. "$1,234.00", "+1..."): the
    // intended value still appears as a contiguous run. Min length guards
    // against short false positives.
    if (e.length >= 4 && a.includes(e)) return true;

    return false;
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

// Delete the last character and type it back, producing a real
// keydown/keypress/beforeinput/input/keyup trail. This is exactly the manual
// fix people apply when a form insists a filled field is empty. Used after any
// fill strategy that did not itself type. Net change to the value is zero.
// Caller must already have focus on the element.
async function tickleField(element) {
    if (!element) return;
    try {
        await TypingEngine.retypeLastChar(element);
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

// Per-character typing. Every char flows through a full keydown/keypress/
// beforeinput/input/keyup sequence, so masked inputs (Cleave, IMask,
// Syncfusion) format naturally and bot/"was this typed?" checks see the
// keystrokes they require. Clears any existing content with real Backspace
// presses first. See typingEngine.js for the event details.
async function fillWithCharByChar(element, value) {
    await TypingEngine.typeText(element, value, {
        clearFirst: true,
        isCancelled: () => window.stopFilling,
    });
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

// Fill a text/textarea/contenteditable field.
//
// Typing comes FIRST and is the normal path: most forms now check that a field
// was really typed into, and a value assigned any other way is treated as
// empty ("this field is required", in red, next to a visibly filled field).
// The value-assignment strategies below it exist only for fields keystrokes
// cannot drive -- readonly/masked widgets, date inputs, framework-controlled
// inputs that reject synthetic keys.
//
// Returns { filled, typed } so the caller can decide whether to tickle.
async function fillTextInput(element, value) {
    const typable = TypingEngine.isTypable(element);

    // A field with maxlength can only ever hold that many characters, so cap the
    // value the way typing would. The marker tells the verify/refill loop that
    // the truncated result is the intended outcome, not a failed fill.
    const cap = (typeof element.maxLength === 'number' && element.maxLength > 0)
        ? element.maxLength : -1;
    if (cap > 0 && String(value).length > cap) {
        console.log(`[fillTextInput] Value longer than maxlength=${cap}; truncating.`);
        try { element.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {}
        value = String(value).slice(0, cap);
    }

    if (typable) {
        // Strategy 1: type it, character by character.
        console.log('[fillTextInput] Strategy 1: simulated typing');
        await fillWithCharByChar(element, value);
        await sleep(60);
        if (verifyFieldValue(element, value)) return { filled: true, typed: true };
        if (verifyFieldValueRelaxed(element, value)) {
            console.log('[fillTextInput] Strategy 1 succeeded with relaxed verify (masked input).');
            return { filled: true, typed: true };
        }

        // Strategy 2: type the alphanumerics only. For masks that insert their
        // own separators and reject ours (dates, phone numbers, card numbers).
        const alnum = String(value).replace(/[^0-9a-zA-Z]/g, '');
        if (alnum && alnum !== String(value)) {
            console.log('[fillTextInput] Strategy 2: simulated typing (alphanumerics only)');
            await fillWithCharByChar(element, alnum);
            await sleep(60);
            if (verifyFieldValue(element, value) || verifyFieldValueRelaxed(element, value)) {
                console.log('[fillTextInput] Strategy 2 succeeded.');
                return { filled: true, typed: true };
            }
        }
    } else {
        console.log('[fillTextInput] Field is not typable (readonly/date/custom); using value assignment.');
    }

    // Strategy 3: native setter (React/Vue/Angular vanilla inputs, date inputs).
    console.log('[fillTextInput] Strategy 3: native setter');
    fillWithNativeSetter(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false };

    // Strategy 4: execCommand insertText for the whole value. Only meaningful
    // when the page actually has focus (see typingEngine.js).
    console.log('[fillTextInput] Strategy 4: execCommand insertText (whole)');
    fillWithExecCommand(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false };

    // Strategy 5: synthesized paste event, for inputs that only accept a value
    // through their paste handler.
    console.log('[fillTextInput] Strategy 5: paste event');
    fillWithPaste(element, value);
    await sleep(30);
    if (verifyFieldValue(element, value)) return { filled: true, typed: false };
    if (verifyFieldValueRelaxed(element, value)) return { filled: true, typed: false };

    console.warn('[fillField] Value may not have stuck for:', element.id || element.name || element,
                 'expected:', value, 'got:', element.value);
    return { filled: false, typed: typable };
}

// Type into a text-like field and deal with whatever the page does in
// response: a suggestion dropdown to pick from, a mask that reformats, or a
// validator waiting for change/blur. Shared by the plain-text branch and by
// comboboxes that turn out to be free-text typeaheads.
async function fillTextLikeField(element, value, info, attempt = 1) {
    // On a retry pass the field may hold stale/partial text (a previous
    // attempt's residue, or a value the form reset). The typing path clears it
    // with real Backspace presses; this only covers the non-typable fields that
    // skip typing altogether.
    if (attempt > 1 && !TypingEngine.isTypable(element)) {
        try { getNativeSetter(element).call(element, ''); }
        catch (_) { try { element.value = ''; } catch (_) {} }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(20);
    }

    // Watch for a suggestion popup from the first keystroke onwards: many
    // widgets render their list once and reuse it, so it has to be observed
    // while typing rather than looked for afterwards.
    const watcher = AutocompleteFiller.startWatch(element);
    let result;
    try {
        // Typing first, then value-assignment fallbacks. See fillTextInput.
        result = await fillTextInput(element, value);
    } catch (e) {
        watcher.stop();
        throw e;
    }

    // Address/city/company lookups: pick the matching suggestion, otherwise the
    // form keeps treating the field as unset.
    let autocompleted = { handled: false };
    try {
        autocompleted = await AutocompleteFiller.resolve(watcher, element, value, info || {});
    } catch (e) {
        watcher.stop();
        console.warn('[fillField] autocomplete handling failed:', e);
    }

    if (!autocompleted.handled) {
        // If a non-typing strategy filled the field, leave a keystroke trail for
        // validators that gate on real keyboard events.
        if (result && result.filled && !result.typed) {
            await tickleField(element);
            await sleep(50);
        }
        // change + a real blur, which is what most "you must fill this in"
        // validators actually listen for.
        TypingEngine.commitField(element);
    }
    return autocompleted;
}

async function fillField(element, value, info, attempt = 1) {
    const sleep_between_events_ms = 50;
    console.log(`Filling field (attempt ${attempt}):`, element, `with value:`, value);

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
            // Free-text combobox, or one whose list never opened on click: type
            // into it and take whatever suggestions that produces.
            await fillTextLikeField(element, value, info, attempt);
        }
    } else {
        await fillTextLikeField(element, value, info, attempt);
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

    // A typable input with aria-autocomplete="list"/"both" is a search-as-you-
    // type field (address lookup, city search). Its list only appears in
    // response to typing, so clicking it and waiting for a listbox finds
    // nothing. Those belong on the typing path, which handles the suggestions.
    const aac = (element.getAttribute('aria-autocomplete') || '').toLowerCase();
    const typableInput = (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') &&
                         !element.readOnly && !element.hasAttribute('readonly');
    if (typableInput && (aac === 'list' || aac === 'both' || aac === 'inline')) return false;

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
    // Full pointer sequence, not a bare click: most dropdown widgets open on
    // mousedown/pointerdown and never see a lone click event.
    simulateRealisticFocus(element);

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

    let match = findMatchingOption(entries, value);

    if (!match) {
        // Fuzzy fallback: "Amsterdam, Noord-Holland" for "Amsterdam".
        const scored = entries
            .map(e => ({ e, s: AutocompleteFiller.score(e.text, value) }))
            .sort((a, b) => b.s - a.s)[0];
        if (scored && scored.s >= 0.55) match = scored.e;
    }

    if (!match && TypingEngine.isTypable(element)) {
        // Searchable combobox (react-select, select2, MUI Autocomplete): the
        // full option list only appears after typing a query.
        console.log('[fillCustomCombobox] No option matched; typing to filter.');
        const watcher = AutocompleteFiller.startWatch(element);
        await TypingEngine.typeText(element, value, {
            clearFirst: true, isCancelled: () => window.stopFilling
        });
        const res = await AutocompleteFiller.resolve(watcher, element, value, {});
        if (res.handled) return true;
    }

    if (!match) {
        console.warn('[fillCustomCombobox] No matching option for', value, 'among', entries.map(e => e.text));
        // Close the popup so it doesn't stay open.
        simulateMouseClick(document.body, true);
        return false;
    }

    match.el.scrollIntoView({ block: 'nearest' });
    // Same reason as opening: options are commonly selected on mousedown.
    AutocompleteFiller.mouseSequence(match.el);
    await sleep(50);
    match.el.dispatchEvent(new Event('change', { bubbles: true }));
    // Remember what the widget was asked for: its own display text may differ
    // from our value, and the verify loop must not read that as a failure.
    try { element.setAttribute('data-ff-accepted-for', String(value).trim()); } catch (_) {}
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

// ---------------------------------------------------------------------------
// Fill / verify / refill loop (shared by the vision and DOM-only fill paths).
// ---------------------------------------------------------------------------

// Stable identity for a field across DOM re-queries. id/name survive remounts;
// for fields with neither, fall back to structural attributes. This is what
// lets us re-fill a field the form blanked, and recognise a brand-new field.
function fieldSignature(info) {
    const i = info || {};
    // Combine identifiers rather than returning early on id/name: forms
    // (and test traps) reuse the same id/name on multiple inputs, and
    // returning 'id:'+id alone collapses distinct fields into one map entry
    // so they overwrite each other. The visible label is the human-
    // distinguishing signal, so include it; id/name keep it stable across
    // re-queries/remounts.
    return 'sig:' + [i.id, i.name, i.type, i.label, i.placeholder,
                     String(i.nearbyText || '').slice(0, 40)].join('|');
}

// Re-query the live page each pass, re-fill anything wrong/missing/reset from a
// cached signature->value map, and re-trigger the LLM when new fields appear.
//
// opts:
//   getFields()            -> [{element, info}] for all fillable fields NOW
//   initialValues          -> Map(signature -> value) from the first LLM pass
//   recallForNewFields(fields, newFields) -> Promise<Map sig->value> | null
//   isCancelled()          -> boolean (user stop / superseded session)
//   onPass({pass,wrong,changed,newCount,filledCount})  (optional)
//   onProgress({phase,pass,...})  (optional) -- fires per filled field and
//     before each LLM recall so the UI does not freeze mid-pass
//   maxPasses (default 3), maxRecalls (default 3), settleMs (default 300)
//
// Returns { filledCount }.
async function runFillVerifyLoop(opts) {
    const intended = opts.initialValues instanceof Map
        ? opts.initialValues : new Map();
    const maxPasses = opts.maxPasses || 3;
    const maxRecalls = opts.maxRecalls || 3;
    const settleMs = opts.settleMs == null ? 300 : opts.settleMs;
    // Seed with the fields present at loop start so pass 1 is the baseline:
    // the caller already ran the first LLM pass, so nothing here is "new" yet
    // and no recall fires until the form actually produces new fields.
    const seen = new Set();
    try {
        for (const f of opts.getFields()) seen.add(fieldSignature(f.info));
    } catch (_) {}
    let filledCount = 0;
    let recalls = 0;

    for (let pass = 1; pass <= maxPasses; pass++) {
        if (opts.isCancelled && opts.isCancelled()) {
            throw new Error("Form filling stopped by user.");
        }

        const fields = opts.getFields();

        // Newly appeared fields = signatures we have never processed before.
        const newFields = fields.filter(f => !seen.has(fieldSignature(f.info)));

        // Re-trigger the LLM only when new fields actually showed up, and only
        // up to maxRecalls times. No new fields -> no recall (cost guard).
        if (newFields.length > 0 && recalls < maxRecalls && opts.recallForNewFields) {
            recalls++;
            // Keep the UI alive: a recall is a (possibly slow) LLM round-trip
            // with no field activity, so without this the bar looks frozen.
            if (opts.onProgress) {
                opts.onProgress({ phase: 'recall', pass, newCount: newFields.length, filledCount });
            }
            try {
                const extra = await opts.recallForNewFields(fields, newFields);
                if (extra instanceof Map) {
                    for (const [k, v] of extra) {
                        if (v !== undefined && v !== null && v !== '') intended.set(k, v);
                    }
                }
            } catch (e) {
                if (e && e.message === "Form filling stopped by user.") throw e;
                console.warn('[runFillVerifyLoop] recall failed:', e);
            }
        }

        for (const f of fields) seen.add(fieldSignature(f.info));

        let changed = 0;
        for (const { element, info } of fields) {
            if (opts.isCancelled && opts.isCancelled()) {
                throw new Error("Form filling stopped by user.");
            }
            const value = intended.get(fieldSignature(info));
            if (value === undefined || value === null || value === '') continue;

            if (elementHasCorrectValue(element, value)) {
                element.setAttribute('data-filled-by-extension', 'true');
                if (typeof OverlayUtils !== 'undefined') OverlayUtils.setStatus(element, 'llm');
                continue;
            }

            if (typeof OverlayUtils !== 'undefined') OverlayUtils.pulseFilling(element);
            await fillField(element, value, info, pass);
            filledCount++;
            changed++;
            // Per-field tick so the bar/counter move during a pass instead of
            // freezing until the pass ends (slow iframes do many fills/sleeps).
            if (opts.onProgress) {
                opts.onProgress({ phase: 'filling', pass, changed, filledCount });
            }
        }

        // Let the form settle: masks reformat, dependent fields render/reset.
        await sleep(settleMs);

        // Re-verify against the (possibly mutated) DOM. intendedTotal counts
        // fields we have a value for; done = those now correct. These give a
        // true monotonic progress fraction (filledCount is cumulative across
        // passes and would overshoot the field count).
        let wrong = 0;
        let intendedTotal = 0;
        const after = opts.getFields();
        for (const { element, info } of after) {
            const value = intended.get(fieldSignature(info));
            if (value === undefined || value === null || value === '') continue;
            intendedTotal++;
            if (!elementHasCorrectValue(element, value)) {
                wrong++;
                if (typeof OverlayUtils !== 'undefined') OverlayUtils.setStatus(element, 'nomatch');
            }
        }
        const done = Math.max(0, intendedTotal - wrong);

        if (opts.onPass) {
            opts.onPass({ pass, wrong, changed, newCount: newFields.length,
                          filledCount, done, intendedTotal });
        }
        console.log(`[runFillVerifyLoop] pass ${pass}: filled ${changed} this pass, ` +
                    `${wrong} still wrong, ${newFields.length} new field(s).`);

        // Done when nothing is wrong and the form stopped producing new fields.
        if (wrong === 0 && newFields.length === 0) break;
    }

    return { filledCount };
}

// Ask the background script for a fresh screenshot of the page (content
// scripts cannot call browser.tabs.captureVisibleTab themselves). Used by the
// vision path mid-loop after the form has changed.
async function captureFreshScreenshot() {
    try {
        const res = await browser.runtime.sendMessage({ action: 'captureScreenshot' });
        if (typeof res === 'string') return res;
        if (res && res.dataUrl) return res.dataUrl;
        return null;
    } catch (e) {
        console.warn('[captureFreshScreenshot] failed:', e);
        return null;
    }
}
