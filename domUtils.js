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


async function simulateHumanTyping(element, value) {
    const specialChars = {
        ' ': 'Space',
        '.': 'Period',
        '/': 'Slash',
        '-': 'Dash'
    };

    element.focus();

    // Clear existing value
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    for (let i = 0; i < value.length; i++) {
        if (window.stopFilling) {
            throw new Error("Form filling stopped by user.");
        }
        const char = value[i];
        const keyChar = specialChars[char] || char;

        // Simulate keydown
        const keydownEvent = new KeyboardEvent('keydown', {
            key: char,
            code: `Key${keyChar.toUpperCase()}`,
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(keydownEvent);

        // Simulate keypress
        const keypressEvent = new KeyboardEvent('keypress', {
            key: char,
            code: `Key${keyChar.toUpperCase()}`,
            bubbles: true,
            cancelable: true,
            charCode: char.charCodeAt(0),
        });
        element.dispatchEvent(keypressEvent);

        // Update value and dispatch input event
        element.value += char;
        const inputEvent = new InputEvent('input', {
            inputType: 'insertText',
            data: char,
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(inputEvent);

        // Simulate keyup
        const keyupEvent = new KeyboardEvent('keyup', {
            key: char,
            code: `Key${keyChar.toUpperCase()}`,
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(keyupEvent);

        // Random delay between keystrokes (50-150ms)
        await sleep(1 + Math.random() * 10);
    }

    // Final events
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function simulateInput(element, value) {
    // Try different methods to set the value
    const methods = [
        // Method 1: Direct value assignment
        () => {
            element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        },
        // Method 2: Using Object.getOwnPropertyDescriptor
        () => {
            const propertyDescriptor = Object.getOwnPropertyDescriptor(element.__proto__, 'value');
            propertyDescriptor.set.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        },
        // Method 3: Using defineProperty
        () => {
            Object.defineProperty(element, 'value', { writable: true, value: value });
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        },
        // Method 4: Simulated human typing
        () => simulateHumanTyping(element, value)
    ];

    triggerEvents(element, ['input', 'change', 'blur']);

    for (const method of methods) {
        await method();
        await sleep(100);  // Wait a bit to see if the value sticks
        if (element.value === value) {
            console.log("Input successful with method:", method.name);
            return;
        }
    }

    console.error("Failed to set input value after trying all methods");
}

async function fillField(element, value, info) {
    const sleep_between_events_ms = 50;
    console.log(`Filling field:`, element, `with value:`, value);

    const tag = element.tagName.toLowerCase();
    const inputType = (element.getAttribute('type') || '').toLowerCase();

    element.focus(); // Bring the element into focus
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
    } else {
        // This is often the most reliable method for complex sites.
        await simulateHumanTyping(element, value);
    }

    // The blur event is already handled inside simulateHumanTyping and fillSelectField.
    // element.blur(); // You can add this for extra certainty if needed.

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

async function fillSelectField(selectElement, value) {
    console.log(`Filling select field ${selectElement.name} with value:`, value);

    // Simulate clicking the select element to open the dropdown
    simulateMouseClick(selectElement);

    // Wait for the dropdown to open and options to be available
    await waitForOptions(selectElement);

    const options = Array.from(selectElement.options);
    const optionToSelect = options.find(option =>
        option.text.trim().toLowerCase() === value.toString().toLowerCase() ||
        option.value.trim().toLowerCase() === value.toString().toLowerCase()
    );

    if (optionToSelect) {
        selectElement.value = optionToSelect.value;
        selectElement.dispatchEvent(new Event('change', { bubbles: true }));

        // Wait for the selection to be applied
        await waitForSelection(selectElement, optionToSelect.value);

        console.log(`Selected option in ${selectElement.name}:`, optionToSelect.text);
    } else {
        console.warn(`Could not find matching option for ${value} in`, selectElement);
    }
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
