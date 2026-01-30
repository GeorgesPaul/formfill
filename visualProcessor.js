// Visual Form Processing Pipeline
// Captures screenshot → OmniParser v2 → Filter interactive elements → Draw overlay

async function visualFillForm(screenshotDataUrl, profiles, customPrompt, sessionId) {
    console.log('[VisualProcessor] Starting visual form processing...');

    window.currentFillSessionId = sessionId;
    window.stopFilling = false;

    function isCancelled() {
        return window.stopFilling || window.currentFillSessionId !== sessionId;
    }

    try {
        // Notify background that we're starting
        browser.runtime.sendMessage({ action: "fillFormStart", sessionId: sessionId });
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 0, filled: 0, total: 1,
            message: "Starting visual form processing...",
            sessionId: sessionId
        });

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // Step 1: Get Replicate API key and OmniParser settings
        const storageData = await browser.storage.local.get(['replicateApiKey', 'omniParserSettings']);
        const apiKey = storageData.replicateApiKey;
        if (!apiKey) {
            throw new Error("Replicate API key not configured. Set it in LLM API Config.");
        }
        const omniSettings = storageData.omniParserSettings || {};

        // Step 2: Call OmniParser
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 0, filled: 0, total: 4,
            message: "Sending screenshot to OmniParser v2...",
            sessionId: sessionId
        });

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        const omniParserResults = await callOmniParser(screenshotDataUrl, apiKey, omniSettings, isCancelled);

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // Step 3: Filter to interactive elements
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 1, filled: 0, total: 4,
            message: "Filtering interactive elements...",
            sessionId: sessionId
        });

        const interactiveElements = filterInteractiveElements(omniParserResults);
        console.log('[VisualProcessor] Interactive elements:', interactiveElements.length, interactiveElements);

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // Step 4: Probe DOM elements at each bounding box center
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 2, filled: 0, total: 5,
            message: "Probing DOM elements...",
            sessionId: sessionId
        });

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        probeDomElements(interactiveElements, viewportWidth, viewportHeight);

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // Step 5: Build LLM-ready data and draw overlay
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 3, filled: 0, total: 5,
            message: `Drawing overlay for ${interactiveElements.length} interactive elements...`,
            sessionId: sessionId
        });

        // Store the structured element data for later LLM consumption
        window.visualProcessorData = buildLlmData(interactiveElements);
        console.log('[VisualProcessor] LLM-ready data:', window.visualProcessorData);

        drawBoundingBoxOverlay(interactiveElements, viewportWidth, viewportHeight);

        // Done
        browser.runtime.sendMessage({
            action: "fillFormComplete",
            filled: interactiveElements.length,
            total: interactiveElements.length,
            message: `Visual processing complete. Found ${interactiveElements.length} interactive elements.`,
            sessionId: sessionId
        });

        return { status: "success", message: `Found ${interactiveElements.length} interactive elements.` };

    } catch (error) {
        console.error('[VisualProcessor] Error:', error);

        if (error.message === "Form filling stopped by user.") {
            browser.runtime.sendMessage({
                action: "fillFormStopped",
                processed: 0, filled: 0, total: 0,
                message: "Visual processing stopped by user.",
                sessionId: sessionId
            });
            window.stopFilling = false;
        } else {
            browser.runtime.sendMessage({
                action: "fillFormError",
                error: error.toString(),
                sessionId: sessionId
            });
        }

        return { status: "error", message: error.toString() };
    }
}

async function callOmniParser(screenshotDataUrl, apiKey, omniSettings, isCancelled) {
    const boxThreshold = omniSettings.omniBoxThreshold ?? 0.50;
    const iouThreshold = omniSettings.omniIouThreshold ?? 0.10;

    // Auto-detect resolution: use the screenshot's actual pixel width (viewport * devicePixelRatio), clamped to API range
    const screenshotPixelWidth = Math.round(window.innerWidth * (window.devicePixelRatio || 1));
    const imgsz = Math.min(1920, Math.max(640, screenshotPixelWidth));

    console.log(`[VisualProcessor] Calling OmniParser v2 API (box=${boxThreshold}, iou=${iouThreshold}, imgsz=${imgsz}, viewport=${window.innerWidth}, dpr=${window.devicePixelRatio})...`);

    const requestBody = {
        version: "49cf3d41b8d3aca1360514e83be4c97131ce8f0d99abfc365526d8384caa88df",
        input: {
            image: screenshotDataUrl,
            box_threshold: boxThreshold,
            iou_threshold: iouThreshold,
            imgsz: imgsz
        }
    };

    const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Prefer': 'wait'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`OmniParser API error (${response.status}): ${errorData.detail || response.statusText}`);
    }

    const result = await response.json();
    console.log('[VisualProcessor] OmniParser raw response:', JSON.stringify(result, null, 2));

    // Parse the output - OmniParser v2 returns output with parsed_content_list and/or label_coordinates
    if (!result.output) {
        throw new Error("OmniParser returned no output. Status: " + result.status);
    }

    return parseOmniParserOutput(result.output);
}

function parseOmniParserOutput(output) {
    console.log('[VisualProcessor] Parsing OmniParser output:', typeof output, output);

    let elements = [];

    // OmniParser v2 on Replicate returns output.elements as a string of Python-formatted dicts:
    //   "icon 0: {'type': 'text', 'bbox': [...], 'interactivity': False, 'content': 'Credit Card'}\n..."
    if (typeof output.elements === 'string') {
        elements = parsePythonDictString(output.elements);
    } else if (output.parsed_content_list && Array.isArray(output.parsed_content_list)) {
        elements = output.parsed_content_list.map((item, index) => ({
            index: index,
            label: item.content || item.label || item.text || `Element ${index}`,
            type: item.type || 'unknown',
            bbox: item.bbox || item.bounding_box || null,
            interactivity: item.interactivity || item.is_interactive || null
        }));
    } else if (Array.isArray(output.elements)) {
        elements = output.elements.map((item, index) => ({
            index: index,
            label: item.content || item.label || item.text || `Element ${index}`,
            type: item.type || 'unknown',
            bbox: item.bbox || item.bounding_box || null,
            interactivity: item.interactivity || item.is_interactive || null
        }));
    } else if (Array.isArray(output)) {
        elements = output.map((item, index) => ({
            index: index,
            label: item.content || item.label || item.text || `Element ${index}`,
            type: item.type || 'unknown',
            bbox: item.bbox || item.bounding_box || null,
            interactivity: item.interactivity || item.is_interactive || null
        }));
    } else {
        console.warn('[VisualProcessor] Unexpected OmniParser output format:', Object.keys(output));
    }

    console.log('[VisualProcessor] Parsed elements:', elements.length, elements);
    return elements;
}

function parsePythonDictString(elementsString) {
    // Parses the OmniParser v2 Replicate format:
    // "icon 0: {'type': 'text', 'bbox': [0.226, 0.133, 0.298, 0.155], 'interactivity': False, 'content': 'Credit Card'}"
    // Lines separated by \n

    const lines = elementsString.split('\n').filter(line => line.trim());
    const elements = [];

    for (const line of lines) {
        try {
            // Strip the "icon N: " prefix to get the Python dict string
            const dictMatch = line.match(/^icon \d+:\s*(.+)$/);
            if (!dictMatch) {
                console.warn('[VisualProcessor] Could not match line format:', line);
                continue;
            }

            let dictStr = dictMatch[1];

            // Convert Python dict syntax to JSON:
            // 1. Replace Python booleans (as standalone values) with JSON booleans
            dictStr = dictStr.replace(/:\s*True\b/g, ': true');
            dictStr = dictStr.replace(/:\s*False\b/g, ': false');
            dictStr = dictStr.replace(/:\s*None\b/g, ': null');

            // 2. Replace single quotes with double quotes
            //    Handle content that may contain apostrophes by using a targeted approach:
            //    Replace ': ' patterns and boundary quotes
            dictStr = dictStr.replace(/'/g, '"');

            const parsed = JSON.parse(dictStr);

            elements.push({
                index: elements.length,
                label: parsed.content || `Element ${elements.length}`,
                type: parsed.type || 'unknown',
                bbox: parsed.bbox || null,
                interactivity: parsed.interactivity
            });
        } catch (e) {
            console.warn('[VisualProcessor] Failed to parse element line:', line, e.message);
        }
    }

    return elements;
}

function filterInteractiveElements(elements) {
    if (!elements || elements.length === 0) return [];

    // OmniParser v2 returns two kinds of elements:
    //   type:'text', interactivity:false  — visible text labels on the page ("Name on card", "CVV", etc.)
    //   type:'icon', interactivity:true   — interactive controls (inputs, buttons, dropdowns)
    // The 'content' of interactive elements is their current VALUE or an accessibility hint,
    // NOT the field label. We spatially match each interactive element to its nearest
    // text label, checking all directions with priority: left > above > below > right.

    const textLabels = elements.filter(el => el.interactivity === false && el.bbox);
    const interactive = elements.filter(el => el.interactivity === true && el.bbox);

    // Preserve original content as currentValue for all interactive elements
    for (const el of interactive) {
        el.currentValue = (el.label || '').trim();
    }

    // Collect all actual visible text on the page (from text labels) for cross-referencing
    const visibleTexts = new Set(textLabels.map(t => t.label.trim().toLowerCase()));

    for (const el of interactive) {
        const [elX1, elY1, elX2, elY2] = el.bbox;
        const elXCenter = (elX1 + elX2) / 2;
        const elYCenter = (elY1 + elY2) / 2;
        const elW = elX2 - elX1;
        const elH = elY2 - elY1;

        // Classify each text label by its spatial relationship to this element,
        // then pick the best from the highest-priority direction.
        // Priority: left(0) > above(1) > below(2) > right(3)
        const candidates = []; // { priority, dist, txt }

        for (const txt of textLabels) {
            const [tX1, tY1, tX2, tY2] = txt.bbox;
            const tXCenter = (tX1 + tX2) / 2;
            const tYCenter = (tY1 + tY2) / 2;

            // LEFT: text's right edge is to the left of element, vertically aligned
            const isLeft = tX2 <= elX1 + 0.02;
            const yAligned = Math.abs(tYCenter - elYCenter) < Math.max(0.06, elH * 0.8);

            // ABOVE: text's bottom edge is above element, horizontally overlapping
            const isAbove = tY2 <= elY1 + 0.02;
            const xOverlap = tX2 > elX1 - 0.02 && tX1 < elX2 + 0.02;

            // BELOW: text's top edge is below element, horizontally overlapping
            const isBelow = tY1 >= elY2 - 0.02;

            // RIGHT: text's left edge is to the right of element, vertically aligned
            const isRight = tX1 >= elX2 - 0.02;

            if (isLeft && yAligned) {
                const dist = Math.abs(tYCenter - elYCenter);
                candidates.push({ priority: 0, dist, txt });
            } else if (isAbove && xOverlap) {
                const dist = Math.abs(tYCenter - elYCenter);
                candidates.push({ priority: 1, dist, txt });
            } else if (isBelow && xOverlap) {
                const dist = Math.abs(tYCenter - elYCenter);
                candidates.push({ priority: 2, dist, txt });
            } else if (isRight && yAligned) {
                const dist = Math.abs(tXCenter - elXCenter);
                candidates.push({ priority: 3, dist, txt });
            }
        }

        if (candidates.length > 0) {
            // Sort by priority first, then by distance within same priority
            candidates.sort((a, b) => a.priority - b.priority || a.dist - b.dist);
            el.fieldLabel = candidates[0].txt.label;
        }
    }

    // For elements without a matched fieldLabel, the currentValue is often a hallucinated
    // description ("Refresh or reload the page", "increase", etc.) rather than actual text
    // visible on the page. Scrub these so they don't mislead the LLM later.
    for (const el of interactive) {
        if (!el.fieldLabel && el.currentValue) {
            if (looksLikeHallucination(el.currentValue, visibleTexts)) {
                console.log(`[VisualProcessor] Scrubbed hallucinated value: "${el.currentValue}"`);
                el.currentValue = '';
            }
        }
    }

    console.log('[VisualProcessor] Matched labels:', interactive.map(el =>
        `"${el.fieldLabel || '(unlabeled)'}" ← value: "${el.currentValue || '(empty)'}"`
    ));

    return interactive;
}

function looksLikeHallucination(text, visibleTexts) {
    const lower = text.toLowerCase().trim();

    // If this exact text appears as a detected text label on the page, it's real
    if (visibleTexts.has(lower)) return false;

    // Short numeric or date-like values are likely real field contents
    if (/^\d[\d\s\-\/\.\,]*$/.test(lower)) return false;

    // Email, phone, URL patterns — real data
    if (/@/.test(lower) || /^\+?\d[\d\s\-\(\)]+$/.test(lower) || /^https?:\/\//.test(lower)) return false;

    // Known OmniParser hallucination patterns for empty/unfamiliar fields
    const hallucinationPatterns = [
        'refresh', 'reload', 'fullscreen', 'full screen',
        'increase', 'decrease', 'zoom', 'scroll',
        'view as', 'switch to', 'toggle', 'expand',
        'collapse', 'minimize', 'maximize', 'close window',
        'open in', 'navigate', 'go to', 'go back',
        'play', 'pause', 'stop', 'mute', 'unmute',
        'download', 'upload file', 'drag', 'resize',
        'more options', 'settings', 'preferences',
        'previous page', 'next page',
    ];

    for (const pattern of hallucinationPatterns) {
        if (lower.includes(pattern)) return true;
    }

    return false;
}

function probeDomElements(elements, viewportWidth, viewportHeight) {
    // Use elementFromPoint() on each bounding box center to identify the real DOM element.
    // NOTE: This only works for standard HTML/DOM-based forms. Canvas-rendered UIs,
    // Flash, or other non-DOM content will return the canvas/embed element itself,
    // not the individual controls drawn within it.

    for (const el of elements) {
        if (!el.bbox) continue;

        const [bx1, by1, bx2, by2] = el.bbox;
        const isNormalized = (bx1 <= 1 && by1 <= 1 && bx2 <= 1 && by2 <= 1);

        let cx, cy;
        if (isNormalized) {
            cx = ((bx1 + bx2) / 2) * viewportWidth;
            cy = ((by1 + by2) / 2) * viewportHeight;
        } else {
            cx = (bx1 + bx2) / 2;
            cy = (by1 + by2) / 2;
        }

        // Temporarily hide our overlay so elementFromPoint hits the actual page
        const overlay = document.getElementById('visual-processor-overlay');
        if (overlay) overlay.style.display = 'none';

        const domEl = document.elementFromPoint(cx, cy);

        if (overlay) overlay.style.display = '';

        if (!domEl) {
            el.domInfo = null;
            el.elementType = 'unknown';
            continue;
        }

        const tag = domEl.tagName.toLowerCase();
        const inputType = domEl.getAttribute('type') || '';
        const role = domEl.getAttribute('role') || '';

        el.domInfo = {
            tagName: tag,
            inputType: inputType,
            id: domEl.id || '',
            name: domEl.name || domEl.getAttribute('name') || '',
            placeholder: domEl.placeholder || domEl.getAttribute('placeholder') || '',
            role: role,
            ariaLabel: domEl.getAttribute('aria-label') || '',
            value: domEl.value || '',
            className: domEl.className || ''
        };

        // For select elements, capture available options
        if (tag === 'select') {
            el.domInfo.options = Array.from(domEl.options).map(opt => ({
                value: opt.value,
                text: opt.textContent.trim(),
                selected: opt.selected
            }));
        }

        // For checkboxes/radios, capture checked state
        if (inputType === 'checkbox' || inputType === 'radio') {
            el.domInfo.checked = domEl.checked;
        }

        // Infer a human-readable element type
        el.elementType = inferElementType(tag, inputType, role);

        // If DOM gives us a better current value than OmniParser, use it
        if (domEl.value && !el.currentValue) {
            el.currentValue = domEl.value;
        }

        // If DOM gives us a label we missed visually (placeholder, aria-label), use as fallback
        if (!el.fieldLabel) {
            const domLabel = getDomLabel(domEl);
            if (domLabel) {
                el.fieldLabel = domLabel;
            }
        }
    }

    console.log('[VisualProcessor] DOM probe results:', elements.map(el =>
        `[${el.index}] ${el.elementType} | label="${el.fieldLabel || ''}" | dom-id="${el.domInfo?.id || ''}" dom-name="${el.domInfo?.name || ''}"`
    ));
}

function inferElementType(tag, inputType, role) {
    if (tag === 'select') return 'dropdown';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';

    if (tag === 'input') {
        switch (inputType.toLowerCase()) {
            case 'text': case '': return 'text input';
            case 'password': return 'password input';
            case 'email': return 'email input';
            case 'number': return 'number input';
            case 'tel': return 'phone input';
            case 'url': return 'url input';
            case 'search': return 'search input';
            case 'date': return 'date input';
            case 'datetime-local': return 'datetime input';
            case 'time': return 'time input';
            case 'month': return 'month input';
            case 'week': return 'week input';
            case 'color': return 'color picker';
            case 'range': return 'slider';
            case 'checkbox': return 'checkbox';
            case 'radio': return 'radio button';
            case 'file': return 'file upload';
            case 'submit': return 'submit button';
            case 'reset': return 'reset button';
            case 'button': return 'button';
            case 'hidden': return 'hidden';
            default: return 'input (' + inputType + ')';
        }
    }

    // Roles for custom elements (div/span acting as controls)
    if (role) {
        switch (role.toLowerCase()) {
            case 'button': return 'button';
            case 'textbox': return 'text input';
            case 'checkbox': return 'checkbox';
            case 'radio': return 'radio button';
            case 'combobox': case 'listbox': return 'dropdown';
            case 'slider': return 'slider';
            case 'switch': return 'toggle';
            case 'tab': return 'tab';
            case 'link': return 'link';
            case 'menuitem': return 'menu item';
            default: return role;
        }
    }

    // Contenteditable divs
    if (tag === 'div' || tag === 'span') {
        const el = document.querySelector(`${tag}[contenteditable]`);
        return 'element';
    }

    return tag;
}

function getDomLabel(domEl) {
    // Try to find a label from the DOM that OmniParser might have missed

    // 1. Check for an associated <label> element
    if (domEl.id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(domEl.id)}"]`);
        if (labelEl) return labelEl.textContent.trim();
    }

    // 2. Check if wrapped in a <label>
    const parentLabel = domEl.closest('label');
    if (parentLabel) {
        // Get label text excluding the input's own text
        const clone = parentLabel.cloneNode(true);
        const inputs = clone.querySelectorAll('input, select, textarea');
        inputs.forEach(el => el.remove());
        const text = clone.textContent.trim();
        if (text) return text;
    }

    // 3. aria-label or aria-labelledby
    const ariaLabel = domEl.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    const ariaLabelledBy = domEl.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
        const labelEl = document.getElementById(ariaLabelledBy);
        if (labelEl) return labelEl.textContent.trim();
    }

    // 4. placeholder as last resort
    const placeholder = domEl.getAttribute('placeholder');
    if (placeholder) return placeholder;

    return '';
}

function buildLlmData(elements) {
    // Build a structured array that the LLM will consume to decide how to fill each field.
    // Each entry contains everything we know about the element from both OmniParser and the DOM.
    return elements.map((el, index) => {
        const entry = {
            index: index,
            fieldLabel: el.fieldLabel || null,
            currentValue: el.currentValue || null,
            elementType: el.elementType || 'unknown',
            bbox: el.bbox
        };

        if (el.domInfo) {
            entry.dom = {
                tagName: el.domInfo.tagName,
                inputType: el.domInfo.inputType || undefined,
                id: el.domInfo.id || undefined,
                name: el.domInfo.name || undefined,
                placeholder: el.domInfo.placeholder || undefined,
                ariaLabel: el.domInfo.ariaLabel || undefined,
                value: el.domInfo.value || undefined
            };
            // Include select options if present
            if (el.domInfo.options) {
                entry.dom.options = el.domInfo.options;
            }
            // Include checked state if relevant
            if (el.domInfo.checked !== undefined) {
                entry.dom.checked = el.domInfo.checked;
            }
            // Clean out undefined keys
            Object.keys(entry.dom).forEach(k => {
                if (entry.dom[k] === undefined) delete entry.dom[k];
            });
        }

        return entry;
    });
}

function drawBoundingBoxOverlay(interactiveElements, viewportWidth, viewportHeight) {
    // Remove any previous overlay
    removeOverlay();

    const container = document.createElement('div');
    container.id = 'visual-processor-overlay';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';

    interactiveElements.forEach((element, index) => {
        if (!element.bbox) return;

        // OmniParser bboxes can be:
        // - Normalized [x1, y1, x2, y2] where values are 0-1
        // - Pixel values [x1, y1, x2, y2]
        // - Object with {x1,y1,x2,y2} or {left,top,right,bottom} or {x,y,width,height}
        let x1, y1, x2, y2;

        if (Array.isArray(element.bbox)) {
            [x1, y1, x2, y2] = element.bbox;
        } else if (typeof element.bbox === 'object') {
            if ('x1' in element.bbox) {
                x1 = element.bbox.x1;
                y1 = element.bbox.y1;
                x2 = element.bbox.x2;
                y2 = element.bbox.y2;
            } else if ('left' in element.bbox) {
                x1 = element.bbox.left;
                y1 = element.bbox.top;
                x2 = element.bbox.right;
                y2 = element.bbox.bottom;
            } else if ('x' in element.bbox && 'width' in element.bbox) {
                x1 = element.bbox.x;
                y1 = element.bbox.y;
                x2 = element.bbox.x + element.bbox.width;
                y2 = element.bbox.y + element.bbox.height;
            } else {
                console.warn('[VisualProcessor] Unknown bbox format for element:', element);
                return;
            }
        } else {
            console.warn('[VisualProcessor] Unexpected bbox type:', typeof element.bbox, element.bbox);
            return;
        }

        // Determine if coordinates are normalized (0-1) or pixel values
        const isNormalized = (x1 <= 1 && y1 <= 1 && x2 <= 1 && y2 <= 1);

        let left, top, width, height;
        if (isNormalized) {
            left = x1 * viewportWidth;
            top = y1 * viewportHeight;
            width = (x2 - x1) * viewportWidth;
            height = (y2 - y1) * viewportHeight;
        } else {
            // Assume pixel values relative to the screenshot dimensions
            // Since screenshot matches the viewport, use as-is
            left = x1;
            top = y1;
            width = x2 - x1;
            height = y2 - y1;
        }

        // Bounding box
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;border:2px solid #00CED1;background:transparent;box-sizing:border-box;`;

        // Label — show element type + matched field label + current value, truncated
        const label = document.createElement('div');
        const elType = element.elementType || '';
        const fieldName = element.fieldLabel || '';
        const curVal = element.currentValue || '';
        const typeTag = elType && elType !== 'unknown' ? `<${elType}> ` : '';
        let labelText;
        if (fieldName && curVal && fieldName !== curVal) {
            const fn = fieldName.length > 20 ? fieldName.slice(0, 18) + '..' : fieldName;
            const cv = curVal.length > 15 ? curVal.slice(0, 13) + '..' : curVal;
            labelText = `[${index}] ${typeTag}${fn} = "${cv}"`;
        } else if (fieldName) {
            labelText = `[${index}] ${typeTag}${fieldName.length > 35 ? fieldName.slice(0, 33) + '..' : fieldName}`;
        } else if (curVal) {
            labelText = `[${index}] ${typeTag}${curVal.length > 35 ? curVal.slice(0, 33) + '..' : curVal}`;
        } else {
            labelText = `[${index}] ${typeTag || ''}(unlabeled)`;
        }
        label.textContent = labelText;
        label.style.cssText = `position:absolute;left:${left}px;top:${Math.max(0, top - 16)}px;color:#00CED1;background:#000;font-size:11px;padding:1px 4px;white-space:nowrap;font-family:monospace;line-height:14px;`;

        container.appendChild(box);
        container.appendChild(label);
    });

    document.documentElement.appendChild(container);
    console.log(`[VisualProcessor] Overlay drawn with ${interactiveElements.length} elements.`);
}

function removeOverlay() {
    const existing = document.getElementById('visual-processor-overlay');
    if (existing) {
        existing.remove();
        console.log('[VisualProcessor] Overlay removed.');
    }
}
