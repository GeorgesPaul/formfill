/*
Performance note: Traversing * for shadow hosts can be slow on very large pages. If needed, optimize by limiting recursion depth or scoping to known containers (e.g., pass document.getElementById('layout-container') as root if that's where content loads)
*/
function getAllFormElements(root = document) {
    const elements = [];
    const selectors = 'input:not([type="hidden"]), select, textarea';  // Matches your original selectors

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
    info.nearbyText = getNearbyText(input);
    info.attributes = getElementAttributes(input);
    // Remove the iframeInfo property

    if (input.tagName.toLowerCase() === 'select') {
        info.options = Array.from(input.options).map(option => option.text);
    }

    return { element: input, info: info };
}

function getBasicFieldInfo(input) {
    return {
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        type: input.type,
        required: input.required,
        autocomplete: input.autocomplete,
        classes: input.className,
        value: input.value,
        parentElement: {
            tagName: input.parentElement.tagName,
            classes: input.parentElement.className
        }
    };
}

function getAssociatedLabel(input) {
    let label = document.querySelector(`label[for="${input.id}"]`);

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

    return label ? label.textContent.trim() : null;
}

function getNearbyText(element, maxDistance = 100) {
    let text = '';
    let currentNode = element;
    let distance = 0;

    while (currentNode && distance < maxDistance) {
        if (currentNode.nodeType === Node.TEXT_NODE) {
            text += currentNode.textContent.trim() + ' ';
        } else if (currentNode.nodeType === Node.ELEMENT_NODE && currentNode.tagName.toLowerCase() === 'label') {
            text += currentNode.textContent.trim() + ' ';
        }

        currentNode = currentNode.previousSibling || currentNode.parentNode;
        distance++;
    }

    return text.trim();
}

function getElementAttributes(element) {
    const attributes = {};
    for (let attr of element.attributes) {
        attributes[attr.name] = attr.value;
    }
    return attributes;
}

function findIframesWithForms() {
    const iframesWithForms = [];
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
        try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDocument.querySelector('input, select, textarea')) {
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
    const currentValue = element.value || '';
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

            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 && rect.height > 0 &&
                rect.bottom > 0 &&
                rect.right > 0;
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

    element.focus(); // Bring the element into focus
    await sleep(sleep_between_events_ms);

    if (element.tagName.toLowerCase() === 'select') {
        await fillSelectField(element, value);
        await sleep(delay_after_dropdown_selection_ms); // 2-second delay after dropdown selection
    } else {
        // This is often the most reliable method for complex sites.
        await simulateHumanTyping(element, value);
    }

    // The blur event is already handled inside simulateHumanTyping and fillSelectField.
    // element.blur(); // You can add this for extra certainty if needed.

    await sleep(sleep_between_events_ms);
    element.setAttribute('data-filled-by-extension', 'true'); // Mark as filled in case of re-filling to avoid filling same element
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
