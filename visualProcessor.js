// Visual Form Processing Pipeline
// Captures screenshot → OmniParser v2 → Filter interactive elements → Draw overlay

// Merged pipeline: combines visual (OmniParser) + source (DOM) analysis for maximum coverage
async function mergedFillForm(screenshotDataUrl, profiles, customPrompt, sessionId) {
    console.log('[MergedProcessor] Starting merged visual + source analysis...');

    window.currentFillSessionId = sessionId;
    window.stopFilling = false;

    function isCancelled() {
        return window.stopFilling || window.currentFillSessionId !== sessionId;
    }

    let filledCount = 0;
    let totalFields = 0;

    try {
        // Notify background that we're starting
        browser.runtime.sendMessage({ action: "fillFormStart", sessionId: sessionId });
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 0, filled: 0, total: 1,
            message: "Starting merged visual + source analysis...",
            sessionId: sessionId
        });

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // === Run both analyses in parallel ===
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 0, filled: 0, total: 6,
            message: "Running visual + source analysis in parallel...",
            sessionId: sessionId
        });

        // Source analysis (fast) - get DOM elements directly
        const documents = findIframesWithForms();
        let sourceElements = getVisibleFormElements(documents);
        sourceElements = sourceElements.filter(el => !el.hasAttribute('data-filled-by-extension') || el.value === '');

        // Assign unique IDs to each DOM element for robust deduplication and tracking
        // This handles the same element appearing multiple times (from iframes or page quirks)
        sourceElements.forEach((el, i) => {
            if (!el.dataset.formfillerUid) {
                el.dataset.formfillerUid = `ff-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`;
            }
        });

        // Deduplicate by unique ID (handles same element appearing multiple times)
        // NOTE: We do NOT deduplicate by id/name because some forms intentionally have
        // multiple elements with the same id/name (e.g., test forms, multi-step forms)
        const seenUids = new Set();
        sourceElements = sourceElements.filter(el => {
            const uid = el.dataset.formfillerUid;
            if (seenUids.has(uid)) {
                console.log(`[MergedProcessor] Removed duplicate element (same UID): id="${el.id}" name="${el.name}"`);
                return false;
            }
            seenUids.add(uid);
            return true;
        });

        console.log(`[MergedProcessor] After dedup: ${sourceElements.length} unique DOM elements`);

        const sourceFieldsInfo = sourceElements.map(getFormFieldInfo);
        console.log(`[MergedProcessor] Source analysis found ${sourceFieldsInfo.length} elements`);

        // NOTE: If sourceFieldsInfo.length === 0, the form might be in a cross-origin iframe.
        // This is handled by content.js which runs non-visual filling in iframes concurrently.
        // The merged pipeline continues here for the top frame (may find visual-only elements).

        // Visual analysis (slow) - OmniParser
        let visualElements = [];
        try {
            const storageData = await browser.storage.local.get(['replicateApiKey', 'omniParserSettings']);
            const apiKey = storageData.replicateApiKey;
            if (apiKey) {
                browser.runtime.sendMessage({
                    action: "fillFormProgress",
                    processed: 1, filled: 0, total: 6,
                    message: "Sending screenshot to OmniParser v2...",
                    sessionId: sessionId
                });

                const omniSettings = storageData.omniParserSettings || {};
                const omniParserResults = await callOmniParser(screenshotDataUrl, apiKey, omniSettings, isCancelled);

                if (isCancelled()) throw new Error("Form filling stopped by user.");

                const interactiveElements = filterInteractiveElements(omniParserResults);
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;
                probeDomElements(interactiveElements, viewportWidth, viewportHeight);
                visualElements = filterToFillableElements(interactiveElements);

                // Add any form elements that OmniParser missed (dropdowns, checkboxes, radios)
                visualElements = addMissedFormElements(visualElements, viewportWidth, viewportHeight);
                console.log(`[MergedProcessor] Visual analysis found ${visualElements.length} fillable elements (including fallback)`);

                // Draw overlay for visual elements
                drawBoundingBoxOverlay(visualElements, viewportWidth, viewportHeight);
            } else {
                console.log('[MergedProcessor] No Replicate API key, skipping visual analysis');
            }
        } catch (visualErr) {
            console.warn('[MergedProcessor] Visual analysis failed, continuing with source only:', visualErr.message);
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 2, filled: 0, total: 6,
            message: "Merging element data...",
            sessionId: sessionId
        });

        // === Merge the two element sets ===
        // NEW STRATEGY: Use DOM element UIDs for exact matching instead of IoU approximation
        // 1. For each visual element → probe DOM at center → get actual DOM element → assign UID
        // 2. For each source element → assign UID
        // 3. Match by UID (exact match based on actual DOM element identity)

        console.log(`[MergedProcessor] Starting UID-based merge: ${sourceFieldsInfo.length} source elements, ${visualElements.length} visual elements`);

        // Step 1: Assign UIDs to all source elements
        let uidCounter = 0;
        const getNextUid = () => `ff-${Date.now()}-${uidCounter++}-${Math.random().toString(36).substr(2, 5)}`;

        for (const fieldObj of sourceFieldsInfo) {
            if (!fieldObj.element.dataset.formfillerUid) {
                fieldObj.element.dataset.formfillerUid = getNextUid();
            }
        }

        // Step 2: For each visual element, probe DOM at its center to get the actual DOM element
        // This gives us the REAL element under each visual label, not an IoU approximation
        const visualToUidAndDom = new Map(); // visual element index → { uid, domEl }
        for (let i = 0; i < visualElements.length; i++) {
            const visualEl = visualElements[i];
            const domEl = getDomElementForVisualElement(visualEl);
            if (domEl) {
                if (!domEl.dataset.formfillerUid) {
                    domEl.dataset.formfillerUid = getNextUid();
                }
                visualToUidAndDom.set(i, { uid: domEl.dataset.formfillerUid, domEl });
                console.log(`[MergedProcessor] Visual [${i}] "${visualEl.fieldLabel || '(unlabeled)'}" → DOM UID=${domEl.dataset.formfillerUid.slice(-10)} id="${domEl.id}" name="${domEl.name}"`);
            } else {
                console.log(`[MergedProcessor] Visual [${i}] "${visualEl.fieldLabel || '(unlabeled)'}" → no DOM element found`);
            }
        }

        // Step 3: Build merged list - start with all unique source elements (by UID)
        let mergedElements = [];
        const uidToMergedIndex = new Map(); // UID → index in mergedElements

        for (const fieldObj of sourceFieldsInfo) {
            const uid = fieldObj.element.dataset.formfillerUid;

            // Check if already added (dedup by UID = same actual DOM element)
            if (uidToMergedIndex.has(uid)) {
                console.log(`[MergedProcessor] Skipping duplicate source (same DOM element): UID=${uid.slice(-10)} id="${fieldObj.info.id}"`);
                continue;
            }

            const idx = mergedElements.length;
            mergedElements.push({
                element: fieldObj.element,
                info: fieldObj.info,
                source: 'dom',
                visualData: null,
                uid: uid
            });
            uidToMergedIndex.set(uid, idx);
        }

        console.log(`[MergedProcessor] Unique source elements: ${mergedElements.length}`);
        console.log('[MergedProcessor] Source elements:', mergedElements.map(m =>
            `UID:${m.uid.slice(-6)}→id="${m.info.id}" name="${m.info.name}"`
        ).join(' | '));

        // Step 4: Match visual elements to source elements by UID
        // This is an EXACT match - visual element's DOM probe found the same element as source
        for (let vIdx = 0; vIdx < visualElements.length; vIdx++) {
            const visualEl = visualElements[vIdx];
            const mapping = visualToUidAndDom.get(vIdx);
            if (!mapping) continue;

            const { uid, domEl } = mapping;

            if (uidToMergedIndex.has(uid)) {
                // Found matching source element by UID
                const mIdx = uidToMergedIndex.get(uid);
                const merged = mergedElements[mIdx];

                if (!merged.visualData) {
                    // First visual element to claim this source element
                    merged.visualData = visualEl;
                    merged.source = 'both';
                    console.log(`[MergedProcessor] UID match: visual "${visualEl.fieldLabel || '(unlabeled)'}" → source id="${merged.info.id}" name="${merged.info.name}"`);
                } else {
                    // Source element already has visual data - this is a second visual pointing to same DOM
                    console.log(`[MergedProcessor] Source id="${merged.info.id}" already has visual "${merged.visualData.fieldLabel}", skipping visual "${visualEl.fieldLabel}"`);
                }
            } else {
                // Visual element points to DOM element NOT in source list
                // This could be an element missed by source analysis - add it
                if (visualEl.fieldLabel) {
                    const newIdx = mergedElements.length;
                    mergedElements.push({
                        element: domEl,
                        info: getFormFieldInfo(domEl).info,
                        source: 'visual',
                        visualData: visualEl,
                        uid: uid
                    });
                    uidToMergedIndex.set(uid, newIdx);
                    console.log(`[MergedProcessor] Added visual-only element: "${visualEl.fieldLabel}" id="${domEl.id}" name="${domEl.name}"`);
                }
            }
        }

        totalFields = mergedElements.length;
        console.log(`[MergedProcessor] Merged total: ${totalFields} unique elements (source: ${sourceFieldsInfo.length}, visual: ${visualElements.length})`);

        if (totalFields === 0) {
            removeOverlay();
            browser.runtime.sendMessage({
                action: "fillFormComplete",
                filled: 0, total: 0,
                message: "No fillable elements found on page.",
                sessionId: sessionId
            });
            return { status: "success", message: "No fillable elements found." };
        }

        // === Filter credential fields ===
        // Password fields are never filled by LLM (use "Fill User/Pass" button for KeePass)
        // Username/email fields: keep for LLM on signup pages, remove on login pages
        if (isSignupPage()) {
            mergedElements = mergedElements.filter(item => !isPasswordField(item.info));
            console.log('[MergedProcessor] Signup page detected. Removed password fields, keeping username for LLM.');
        } else {
            mergedElements = mergedElements.filter(item => !isPasswordField(item.info) && !isUsernameField(item.info));
            console.log('[MergedProcessor] Login page detected. Removed credential fields (use Fill User/Pass button).');
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        if (mergedElements.length === 0) {
            removeOverlay();
            simulateMouseClick(document.body, true);
            browser.runtime.sendMessage({
                action: "fillFormComplete",
                filled: filledCount, total: totalFields,
                message: `No form fields to fill. Use "Fill User/Pass" for credentials.`,
                sessionId: sessionId
            });
            return { status: "success", message: `No form fields to fill.` };
        }

        // === Build merged LLM prompt ===
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 4, filled: filledCount, total: 6,
            message: "Asking LLM for fill values...",
            sessionId: sessionId
        });

        const llmData = buildMergedLlmData(mergedElements);
        console.log('[MergedProcessor] LLM-ready data:', llmData);

        const fillInstructions = await mergedPromptLlm(llmData, profiles, customPrompt, sessionId);
        console.log('[MergedProcessor] LLM fill instructions:', fillInstructions);

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // === Fill fields ===
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 5, filled: filledCount, total: 6,
            message: "Filling form fields...",
            sessionId: sessionId
        });

        for (let i = 0; i < mergedElements.length; i++) {
            if (isCancelled()) throw new Error("Form filling stopped by user.");

            const item = mergedElements[i];
            const instruction = fillInstructions[item.info.id] ||
                                fillInstructions[item.info.name] ||
                                fillInstructions[String(i)];

            if (instruction !== undefined && instruction !== null && instruction !== '') {
                await fillField(item.element, instruction, item.info);
                filledCount++;
            }
        }

        // Clean up
        removeOverlay();
        simulateMouseClick(document.body, true);

        browser.runtime.sendMessage({
            action: "fillFormComplete",
            filled: filledCount, total: totalFields,
            message: `Merged processing complete. Filled ${filledCount} of ${totalFields} fields.`,
            sessionId: sessionId
        });

        return { status: "success", message: `Filled ${filledCount} of ${totalFields} fields.` };

    } catch (error) {
        console.error('[MergedProcessor] Error:', error);
        removeOverlay();

        if (error.message === "Form filling stopped by user.") {
            browser.runtime.sendMessage({
                action: "fillFormStopped",
                processed: 0, filled: filledCount, total: totalFields,
                message: "Form filling stopped by user.",
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

function getElementKey(element) {
    // Create a unique key for an element to detect duplicates
    if (element.id) return `id:${element.id}`;
    if (element.name) return `name:${element.name}`;
    // Fallback: use position in DOM
    const path = [];
    let el = element;
    while (el && el !== document.body) {
        const idx = Array.from(el.parentNode?.children || []).indexOf(el);
        path.unshift(`${el.tagName}[${idx}]`);
        el = el.parentNode;
    }
    return `path:${path.join('>')}`;
}

function buildMergedLlmData(elements) {
    return elements.map((item, index) => {
        // Visual data takes precedence when available (more accurate for what user sees)
        let visualLabel = item.visualData?.fieldLabel || null;
        const visualType = item.visualData?.elementType || null;
        let domLabel = item.info.label || null;

        // Ensure labels are strings (could be objects/arrays in edge cases)
        if (visualLabel && typeof visualLabel !== 'string') {
            visualLabel = String(visualLabel);
        }
        if (domLabel && typeof domLabel !== 'string') {
            domLabel = String(domLabel);
        }

        // Determine final label: visual takes precedence, but only if visual element was matched
        const finalLabel = visualLabel || domLabel;

        // Debug: detailed logging of label resolution
        const fieldId = item.info.id || item.info.name || `[${index}]`;
        if (item.visualData) {
            if (visualLabel && domLabel && visualLabel.toLowerCase() !== domLabel.toLowerCase()) {
                console.log(`[MergedProcessor] Field ${fieldId}: Visual label "${visualLabel}" overrides DOM label "${domLabel}"`);
            } else if (visualLabel) {
                console.log(`[MergedProcessor] Field ${fieldId}: Using visual label "${visualLabel}"`);
            } else {
                console.log(`[MergedProcessor] Field ${fieldId}: Visual matched but no visual label, using DOM label "${domLabel || '(none)'}"`);
            }
        } else {
            console.log(`[MergedProcessor] Field ${fieldId}: No visual match, using DOM label "${domLabel || '(none)'}"`);
        }

        const entry = {
            index: index,
            id: item.info.id || null,
            name: item.info.name || null,
            // Prefer visual type if available, fall back to DOM type
            type: visualType || item.info.type || 'text',
            // Prefer visual label if available, fall back to DOM label
            label: finalLabel,
            placeholder: item.info.placeholder || null,
            value: item.info.value || null,
            required: item.info.required || false,
            autocomplete: item.info.autocomplete || null,
        };

        // Add options for select elements
        if (item.info.options) {
            entry.options = item.info.options;
        }

        // Log final entry for debugging
        console.log(`[MergedProcessor] LLM entry ${index}: id="${entry.id}" name="${entry.name}" label="${entry.label}" hasVisualData=${!!item.visualData}`);

        return entry;
    });
}

async function mergedPromptLlm(llmData, profiles, customPrompt, sessionId) {
    // Build profile text
    let profileText = '';
    if (Array.isArray(profiles)) {
        profiles.forEach(profile => {
            profileText += `\n=== ${profile.name} ===\n${profile.data}\n`;
        });
    }

    const fieldsJson = JSON.stringify(llmData, null, 2);

    const staticPart = `You are an AI assistant that fills web forms based on user profile data.

User Profile Data:
${profileText}`;

    const dynamicPart = `Below are the detected form fields from the page, found using both DOM analysis and visual screen analysis. Each field has an index, id, name, type, label, and other attributes.

Form Fields:
${fieldsJson}

Instructions:
- Return a JSON object mapping field identifier (id, name, or index as string) to the value to fill.
- For text inputs: provide the appropriate text value from the user profile.
- For dropdowns/selects: provide the exact text of the option to select.
- For checkboxes: provide true or false.
- Skip fields where no suitable value exists (omit them from the output).
- Use field labels, names, ids, placeholders, and autocomplete hints to determine what data goes where.
${customPrompt ? `\nAdditional user instructions:\n${customPrompt}` : ''}

Return ONLY a JSON object, no markdown, no explanation. Example:
{"username": "johndoe", "email": "john@example.com", "country": "United States"}`;

    let llmResponse = '';
    try {
        llmResponse = await promptLLM(dynamicPart, staticPart);

        if (window.stopFilling || window.currentFillSessionId !== sessionId) {
            throw new Error("Form filling stopped by user.");
        }

        const cleaned = llmResponse.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (error) {
        if (error.message === "Form filling stopped by user.") throw error;

        if (error instanceof SyntaxError) {
            console.error('[MergedProcessor] LLM returned invalid JSON:', llmResponse.substring(0, 500));
        } else {
            console.error('[MergedProcessor] LLM error:', error);
        }
        return {};
    }
}

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

        // Step 5: Filter to fillable elements only (remove buttons, links, tabs, etc.)
        let fillableElements = filterToFillableElements(interactiveElements);

        // Add any form elements that OmniParser missed (dropdowns, checkboxes, radios)
        fillableElements = addMissedFormElements(fillableElements, viewportWidth, viewportHeight);
        console.log(`[VisualProcessor] Fillable elements: ${fillableElements.length} (filtered out ${interactiveElements.length - fillableElements.length} non-fillable, added fallback)`);

        // --- Filter credential fields ---
        // Password fields are never filled by LLM (use "Fill User/Pass" button for KeePass)
        // Username/email fields: keep for LLM on signup pages, remove on login pages
        const isSignup = isVisualSignupPage();
        if (isSignup) {
            fillableElements = fillableElements.filter(el => {
                return el.elementType !== 'password input' &&
                    !(el.domInfo && /passw|pwd/i.test((el.domInfo.name || '') + (el.domInfo.id || '')));
            });
            console.log('[VisualProcessor] Signup page detected. Removed password fields, keeping username for LLM.');
        } else {
            fillableElements = fillableElements.filter(el => {
                const isPassword = el.elementType === 'password input' ||
                    (el.domInfo && /passw|pwd/i.test((el.domInfo.name || '') + (el.domInfo.id || '')));
                const isUsername = el.elementType === 'email input' ||
                    (el.domInfo && /username|user.?name|login|userid|user.?id|email|e.?mail/i.test(
                        (el.domInfo.name || '') + (el.domInfo.id || '') + (el.domInfo.placeholder || '')));
                return !isPassword && !isUsername;
            });
            console.log('[VisualProcessor] Login page detected. Removed credential fields (use Fill User/Pass button).');
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 3, filled: 0, total: 5,
            message: `Drawing overlay for ${fillableElements.length} fillable elements...`,
            sessionId: sessionId
        });

        // Build the structured element data for the LLM
        const llmData = buildLlmData(fillableElements);
        window.visualProcessorData = llmData;
        console.log('[VisualProcessor] LLM-ready data:', llmData);

        drawBoundingBoxOverlay(fillableElements, viewportWidth, viewportHeight);

        if (fillableElements.length === 0) {
            removeOverlay();
            browser.runtime.sendMessage({
                action: "fillFormComplete",
                filled: 0, total: 0,
                message: `No form fields to fill. Use "Fill User/Pass" for credentials.`,
                sessionId: sessionId
            });
            return { status: "success", message: "No form fields to fill." };
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // Step 6: Ask the LLM what values to fill
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 4, filled: 0, total: fillableElements.length + 5,
            message: "Asking LLM for fill values...",
            sessionId: sessionId
        });

        const fillInstructions = await visualPromptLlm(llmData, profiles, customPrompt, sessionId);
        console.log('[VisualProcessor] LLM fill instructions:', fillInstructions);

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // Step 7: Fill each field using DOM interaction
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 5, filled: 0, total: fillableElements.length + 5,
            message: "Filling form fields...",
            sessionId: sessionId
        });

        const filledCount = await visualFillFields(fillableElements, fillInstructions, sessionId, isCancelled);

        // Clean up overlay and click outside to dismiss dropdowns / trigger validation
        removeOverlay();
        simulateMouseClick(document.body, true);

        browser.runtime.sendMessage({
            action: "fillFormComplete",
            filled: filledCount,
            total: fillableElements.length,
            message: `Visual processing complete. Filled ${filledCount} of ${fillableElements.length} fields.`,
            sessionId: sessionId
        });

        return { status: "success", message: `Filled ${filledCount} of ${fillableElements.length} fields.` };

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

    let result = await response.json();
    console.log('[VisualProcessor] OmniParser initial response status:', result.status);

    // Poll for completion if not done yet (cold start or timeout on Prefer: wait)
    if (result.status === 'starting' || result.status === 'processing') {
        console.log('[VisualProcessor] OmniParser still processing, polling for completion...');
        const pollUrl = result.urls?.get || `https://api.replicate.com/v1/predictions/${result.id}`;
        const maxPolls = 60; // Max 60 polls (2 minutes with 2s intervals)

        for (let i = 0; i < maxPolls; i++) {
            if (isCancelled()) throw new Error("Form filling stopped by user.");

            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

            const pollResponse = await fetch(pollUrl, {
                headers: { 'Authorization': 'Bearer ' + apiKey }
            });

            if (!pollResponse.ok) {
                throw new Error(`OmniParser poll error (${pollResponse.status})`);
            }

            result = await pollResponse.json();
            console.log(`[VisualProcessor] Poll ${i + 1}: status=${result.status}`);

            if (result.status === 'succeeded') {
                break;
            } else if (result.status === 'failed' || result.status === 'canceled') {
                throw new Error(`OmniParser prediction ${result.status}: ${result.error || 'Unknown error'}`);
            }
        }
    }

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

            // The 'content' value may contain double-quotes which would break JSON.parse
            // after the blanket single→double quote conversion. Extract it first, replace
            // with a safe placeholder, then restore after parsing.
            const CONTENT_PLACEHOLDER = '\x00CONTENT\x00';
            let savedContent = null;
            const contentExtract = dictStr.match(/'content':\s*'((?:[^'\\]|\\.)*)'/);
            if (contentExtract) {
                savedContent = contentExtract[1];
                dictStr = dictStr.replace(contentExtract[0], `'content': '${CONTENT_PLACEHOLDER}'`);
            }

            // Convert Python dict syntax to JSON
            dictStr = dictStr.replace(/:\s*True\b/g, ': true');
            dictStr = dictStr.replace(/:\s*False\b/g, ': false');
            dictStr = dictStr.replace(/:\s*None\b/g, ': null');
            dictStr = dictStr.replace(/'/g, '"');

            const parsed = JSON.parse(dictStr);

            // Restore original content (may contain double-quotes or other characters)
            if (savedContent !== null) {
                parsed.content = savedContent;
            }

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
    //
    // IMPORTANT: Each text label should be assigned to AT MOST ONE interactive element.
    // We match FROM labels TO elements (not the other way around) to ensure each label
    // is used only once. Priority: label is LEFT of element > ABOVE > BELOW > RIGHT.

    const textLabels = elements.filter(el => el.interactivity === false && el.bbox);
    const interactive = elements.filter(el => el.interactivity === true && el.bbox);

    // Preserve original content as currentValue for all interactive elements
    for (const el of interactive) {
        el.currentValue = (el.label || '').trim();
    }

    // Collect all actual visible text on the page (from text labels) for cross-referencing
    const visibleTexts = new Set(textLabels.map(t => t.label.trim().toLowerCase()));

    // For each TEXT LABEL, find the ONE best interactive element to assign it to
    // This ensures each label is only used once
    const labelAssignments = []; // { label, element, priority, dist }

    for (const txt of textLabels) {
        const [tX1, tY1, tX2, tY2] = txt.bbox;
        const tXCenter = (tX1 + tX2) / 2;
        const tYCenter = (tY1 + tY2) / 2;

        let bestMatch = null;
        let bestPriority = 999;
        let bestDist = Infinity;

        for (const el of interactive) {
            const [elX1, elY1, elX2, elY2] = el.bbox;
            const elXCenter = (elX1 + elX2) / 2;
            const elYCenter = (elY1 + elY2) / 2;
            const elH = elY2 - elY1;

            // Check spatial relationship: where is the label relative to this element?
            // Label LEFT of element: label's right edge is to the left of element, vertically aligned
            const isLabelLeft = tX2 <= elX1 + 0.02;
            const yAligned = Math.abs(tYCenter - elYCenter) < Math.max(0.06, elH * 0.8);

            // Label ABOVE element: label's bottom edge is above element, horizontally overlapping
            const isLabelAbove = tY2 <= elY1 + 0.02;
            const xOverlap = tX2 > elX1 - 0.02 && tX1 < elX2 + 0.02;

            // Label BELOW element: label's top edge is below element, horizontally overlapping
            const isLabelBelow = tY1 >= elY2 - 0.02;

            // Label RIGHT of element: label's left edge is to the right of element, vertically aligned
            const isLabelRight = tX1 >= elX2 - 0.02;

            let priority = 999;
            let dist = Infinity;

            if (isLabelLeft && yAligned) {
                priority = 0; // Highest priority - label to left of element
                dist = elX1 - tX2; // Horizontal distance
            } else if (isLabelAbove && xOverlap) {
                priority = 1; // Label above element
                dist = elY1 - tY2; // Vertical distance
            } else if (isLabelBelow && xOverlap) {
                priority = 2; // Label below element (unusual but possible)
                dist = tY1 - elY2;
            } else if (isLabelRight && yAligned) {
                priority = 3; // Label to right of element
                dist = tX1 - elX2;
            }

            // Only consider valid positions with reasonable distance
            if (priority < 999 && dist >= 0 && dist < 0.15) {
                if (priority < bestPriority || (priority === bestPriority && dist < bestDist)) {
                    bestPriority = priority;
                    bestDist = dist;
                    bestMatch = el;
                }
            }
        }

        if (bestMatch) {
            labelAssignments.push({
                label: txt.label,
                element: bestMatch,
                priority: bestPriority,
                dist: bestDist
            });
        }
    }

    // Sort assignments by priority then distance (best matches first)
    labelAssignments.sort((a, b) => a.priority - b.priority || a.dist - b.dist);

    // Assign labels - each element gets at most one label (first/best match wins)
    // Each label is also used only once (we track used labels)
    const assignedElements = new Set();
    const usedLabels = new Set();
    for (const assignment of labelAssignments) {
        const labelKey = assignment.label.toLowerCase();
        if (!assignedElements.has(assignment.element) && !usedLabels.has(labelKey)) {
            assignment.element.fieldLabel = assignment.label;
            assignedElements.add(assignment.element);
            usedLabels.add(labelKey);
            console.log(`[VisualProcessor] Label "${assignment.label}" → element (priority=${assignment.priority}, dist=${assignment.dist.toFixed(3)})`);
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
            id: domEl.id || '',
            name: domEl.name || domEl.getAttribute('name') || '',
            placeholder: domEl.placeholder || domEl.getAttribute('placeholder') || '',
        };

        // Validation constraints
        if (domEl.required) el.domInfo.required = true;
        if (domEl.readOnly) el.domInfo.readOnly = true;
        if (domEl.disabled) el.domInfo.disabled = true;
        const maxLength = domEl.getAttribute('maxlength');
        if (maxLength) el.domInfo.maxLength = parseInt(maxLength);
        const pattern = domEl.getAttribute('pattern');
        if (pattern) el.domInfo.pattern = pattern;
        const autocomplete = domEl.getAttribute('autocomplete');
        if (autocomplete && autocomplete !== 'off') el.domInfo.autocomplete = autocomplete;

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

        // For radios, capture all options in the group
        if (inputType === 'radio' && el.domInfo.name) {
            const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.domInfo.name)}"]`);
            el.domInfo.groupOptions = Array.from(radios).map(r => ({
                value: r.value,
                label: getDomLabel(r) || r.value,
                checked: r.checked
            }));
        }

        // For number/range inputs, capture min/max/step
        if (inputType === 'number' || inputType === 'range') {
            const min = domEl.getAttribute('min');
            const max = domEl.getAttribute('max');
            const step = domEl.getAttribute('step');
            if (min) el.domInfo.min = min;
            if (max) el.domInfo.max = max;
            if (step) el.domInfo.step = step;
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

function filterToFillableElements(elements) {
    // Keep only elements that can be filled/changed: text inputs, textareas,
    // dropdowns, checkboxes, radio buttons, date pickers, etc.
    // Remove buttons, links, tabs, menu items, and other non-fillable controls.
    const nonFillableTypes = new Set([
        'button', 'submit button', 'reset button', 'link',
        'tab', 'menu item', 'hidden', 'file upload', 'element'
    ]);

    return elements.filter(el => {
        // If we have DOM-based type info, use it (most reliable)
        if (el.elementType && el.elementType !== 'unknown') {
            if (nonFillableTypes.has(el.elementType)) return false;
            return true;
        }

        // Fallback for non-DOM elements (canvas, etc.): use OmniParser label heuristics
        const label = (el.currentValue || '').toLowerCase();
        const buttonKeywords = ['submit', 'cancel', 'close', 'back', 'next', 'sign in',
            'log in', 'login', 'register', 'sign up', 'pay', 'save', 'send', 'ok'];
        for (const kw of buttonKeywords) {
            if (label === kw || label === kw + ' ') return false;
        }

        return true;
    });
}

function addMissedFormElements(visualElements, viewportWidth, viewportHeight) {
    // OmniParser often misses certain form elements:
    // - <select> dropdowns (look like plain text when closed)
    // - Checkboxes (small icons, often custom-styled)
    // - Radio buttons (small icons, often custom-styled)
    // Find any DOM elements not covered by visual analysis and add them.

    // Helper to check if element is visible and in viewport
    function isVisibleInViewport(el) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        if (rect.bottom < 0 || rect.top > viewportHeight) return false;
        if (rect.right < 0 || rect.left > viewportWidth) return false;
        return true;
    }

    // Build a set of DOM elements already covered by visual analysis
    const coveredElements = new Set();
    for (const ve of visualElements) {
        if (ve.bbox) {
            const domEl = getDomElementForVisualElement(ve);
            if (domEl) coveredElements.add(domEl);
        }
    }

    let addedCount = 0;

    // === 1. Find missed <select> dropdowns ===
    const allSelects = Array.from(document.querySelectorAll('select')).filter(sel => {
        if (!isVisibleInViewport(sel)) return false;
        if (sel.disabled) return false;
        if (sel.hasAttribute('data-filled-by-extension') && sel.value) return false;
        return true;
    });

    for (const sel of allSelects) {
        if (coveredElements.has(sel)) continue;

        const rect = sel.getBoundingClientRect();
        const normBbox = [
            rect.left / viewportWidth,
            rect.top / viewportHeight,
            rect.right / viewportWidth,
            rect.bottom / viewportHeight
        ];

        const label = getDomLabel(sel);
        const options = Array.from(sel.options).map(opt => ({
            value: opt.value,
            text: opt.textContent.trim(),
            selected: opt.selected
        }));

        visualElements.push({
            index: visualElements.length,
            label: label || sel.name || sel.id || 'Dropdown',
            type: 'icon',
            bbox: normBbox,
            interactivity: true,
            fieldLabel: label,
            currentValue: sel.options[sel.selectedIndex]?.text || '',
            elementType: 'dropdown',
            domInfo: {
                id: sel.id || '',
                name: sel.name || '',
                required: sel.required,
                disabled: sel.disabled,
                options: options
            },
            _addedByFallback: true
        });
        addedCount++;
        console.log(`[VisualProcessor] Added missed dropdown: id="${sel.id}" name="${sel.name}" label="${label}"`);
    }

    // === 2. Find missed checkboxes ===
    const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(cb => {
        if (!isVisibleInViewport(cb)) return false;
        if (cb.disabled) return false;
        if (cb.hasAttribute('data-filled-by-extension')) return false;
        return true;
    });

    for (const cb of allCheckboxes) {
        if (coveredElements.has(cb)) continue;

        const rect = cb.getBoundingClientRect();
        const normBbox = [
            rect.left / viewportWidth,
            rect.top / viewportHeight,
            rect.right / viewportWidth,
            rect.bottom / viewportHeight
        ];

        const label = getDomLabel(cb);

        visualElements.push({
            index: visualElements.length,
            label: label || cb.name || cb.id || 'Checkbox',
            type: 'icon',
            bbox: normBbox,
            interactivity: true,
            fieldLabel: label,
            currentValue: cb.checked ? 'checked' : 'unchecked',
            elementType: 'checkbox',
            domInfo: {
                id: cb.id || '',
                name: cb.name || '',
                required: cb.required,
                disabled: cb.disabled,
                checked: cb.checked
            },
            _addedByFallback: true
        });
        addedCount++;
        console.log(`[VisualProcessor] Added missed checkbox: id="${cb.id}" name="${cb.name}" label="${label}"`);
    }

    // === 3. Find missed radio buttons ===
    // Group radios by name to avoid duplicates and provide all options
    const radioGroups = new Map(); // name -> array of radio elements
    const allRadios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(rb => {
        if (!isVisibleInViewport(rb)) return false;
        if (rb.disabled) return false;
        if (rb.hasAttribute('data-filled-by-extension')) return false;
        return true;
    });

    for (const rb of allRadios) {
        const name = rb.name || rb.id || 'unnamed';
        if (!radioGroups.has(name)) {
            radioGroups.set(name, []);
        }
        radioGroups.get(name).push(rb);
    }

    for (const [groupName, radios] of radioGroups) {
        // Check if ANY radio in this group is already covered
        const anyCovered = radios.some(rb => coveredElements.has(rb));
        if (anyCovered) continue;

        // Use the first radio for positioning, but include all options
        const firstRadio = radios[0];
        const rect = firstRadio.getBoundingClientRect();
        const normBbox = [
            rect.left / viewportWidth,
            rect.top / viewportHeight,
            rect.right / viewportWidth,
            rect.bottom / viewportHeight
        ];

        // Get group options with labels
        const groupOptions = radios.map(rb => ({
            value: rb.value,
            label: getDomLabel(rb) || rb.value,
            checked: rb.checked
        }));

        // Find the group label (often a fieldset legend or nearby text)
        let groupLabel = '';
        const fieldset = firstRadio.closest('fieldset');
        if (fieldset) {
            const legend = fieldset.querySelector('legend');
            if (legend) groupLabel = legend.textContent.trim();
        }
        if (!groupLabel) {
            // Try to find a common label
            groupLabel = getDomLabel(firstRadio) || groupName;
        }

        const checkedOption = radios.find(rb => rb.checked);

        visualElements.push({
            index: visualElements.length,
            label: groupLabel,
            type: 'icon',
            bbox: normBbox,
            interactivity: true,
            fieldLabel: groupLabel,
            currentValue: checkedOption ? (getDomLabel(checkedOption) || checkedOption.value) : '',
            elementType: 'radio button',
            domInfo: {
                id: firstRadio.id || '',
                name: groupName,
                required: firstRadio.required,
                disabled: firstRadio.disabled,
                checked: firstRadio.checked,
                groupOptions: groupOptions
            },
            _addedByFallback: true
        });
        addedCount++;
        console.log(`[VisualProcessor] Added missed radio group: name="${groupName}" label="${groupLabel}" options=${groupOptions.length}`);
    }

    if (addedCount > 0) {
        console.log(`[VisualProcessor] Added ${addedCount} form elements that OmniParser missed.`);
    } else {
        console.log('[VisualProcessor] No additional form elements found on page.');
    }

    return visualElements;
}

// Keep old function name as alias for backwards compatibility
function addMissedDropdowns(visualElements, viewportWidth, viewportHeight) {
    return addMissedFormElements(visualElements, viewportWidth, viewportHeight);
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
    // Build a structured array for LLM consumption.
    // Flat, no redundancy, only actionable info.
    return elements.map((el, index) => {
        const entry = {
            index: index,
            type: el.elementType || 'unknown',
            label: el.fieldLabel || null,
            value: el.currentValue || null,
        };

        // Position as percentage of viewport (top-left corner + size) so the LLM
        // can reason about spatial layout ("field below X", "group of fields on the right")
        if (el.bbox) {
            const [x1, y1, x2, y2] = el.bbox;
            const isNorm = (x1 <= 1 && y1 <= 1 && x2 <= 1 && y2 <= 1);
            if (isNorm) {
                entry.position = {
                    x: Math.round(x1 * 100) + '%',
                    y: Math.round(y1 * 100) + '%',
                    width: Math.round((x2 - x1) * 100) + '%',
                    height: Math.round((y2 - y1) * 100) + '%'
                };
            }
        }

        if (el.domInfo) {
            if (el.domInfo.id) entry.id = el.domInfo.id;
            if (el.domInfo.name) entry.name = el.domInfo.name;
            if (el.domInfo.placeholder) entry.placeholder = el.domInfo.placeholder;
            if (el.domInfo.autocomplete) entry.autocomplete = el.domInfo.autocomplete;
            if (el.domInfo.required) entry.required = true;
            if (el.domInfo.readOnly) entry.readOnly = true;
            if (el.domInfo.disabled) entry.disabled = true;
            if (el.domInfo.maxLength) entry.maxLength = el.domInfo.maxLength;
            if (el.domInfo.pattern) entry.pattern = el.domInfo.pattern;
            if (el.domInfo.min) entry.min = el.domInfo.min;
            if (el.domInfo.max) entry.max = el.domInfo.max;
            if (el.domInfo.step) entry.step = el.domInfo.step;
            if (el.domInfo.options) entry.options = el.domInfo.options;
            if (el.domInfo.checked !== undefined) entry.checked = el.domInfo.checked;
            if (el.domInfo.groupOptions) entry.groupOptions = el.domInfo.groupOptions;
        }

        return entry;
    });
}

async function visualPromptLlm(llmData, profiles, customPrompt, sessionId) {
    // Build profile text
    let profileText = '';
    if (Array.isArray(profiles)) {
        profiles.forEach(profile => {
            profileText += `\n=== ${profile.name} ===\n${profile.data}\n`;
        });
    }

    // Build the fields description, including dropdown options inline
    const fieldsJson = JSON.stringify(llmData, null, 2);

    const staticPart = `You are an AI assistant that fills web forms based on user profile data.

User Profile Data:
${profileText}`;

    const dynamicPart = `Below are the detected form fields from a screenshot of the page. Each field has an index, type, label, current value, and position on the page. For dropdowns, the available options are listed.

Form Fields:
${fieldsJson}

Instructions:
- Return a JSON object mapping field index (as string) to the value to fill.
- For text inputs: provide the appropriate text value from the user profile.
- For dropdowns: provide the exact text of the option to select (must match one of the listed options).
- For checkboxes: provide true or false.
- For radio buttons: provide the value of the option to select.
- Skip fields that are disabled, readOnly, or where no suitable value exists (omit them from the output).
- If a field already has the correct value, omit it from the output.
- Use field labels, names, ids, placeholders, and autocomplete hints to determine what data goes where.
- Use position info to understand layout context (fields near each other likely belong to the same section).
${customPrompt ? `\nAdditional user instructions:\n${customPrompt}` : ''}

Return ONLY a JSON object, no markdown, no explanation. Example:
{"0": "John", "1": "Doe", "3": "johndoe@email.com", "5": "January"}`;

    console.log('[VisualProcessor] LLM prompt (static):', staticPart);
    console.log('[VisualProcessor] LLM prompt (dynamic):', dynamicPart);

    let llmResponse = '';
    try {
        llmResponse = await promptLLM(dynamicPart, staticPart);

        if (window.stopFilling || window.currentFillSessionId !== sessionId) {
            throw new Error("Form filling stopped by user.");
        }

        const cleaned = llmResponse.replace(/```json\n?|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        return parsed;
    } catch (error) {
        if (error.message === "Form filling stopped by user.") throw error;

        if (error instanceof SyntaxError) {
            console.error('[VisualProcessor] LLM returned invalid JSON:', llmResponse.substring(0, 500));
            logToUser("LLM returned invalid JSON. First 250 chars: " + llmResponse.substring(0, 250));
        } else {
            console.error('[VisualProcessor] LLM error:', error);
        }
        return {};
    }
}

async function visualFillFields(elements, fillInstructions, sessionId, isCancelled) {
    let filledCount = 0;
    const totalFields = elements.length;

    for (let i = 0; i < elements.length; i++) {
        if (isCancelled()) throw new Error("Form filling stopped by user.");

        const el = elements[i];
        const instruction = fillInstructions[String(i)] ?? fillInstructions[String(el.index)];

        if (instruction === undefined || instruction === null || instruction === '') continue;

        // Find the DOM element at this bounding box center
        const domEl = getDomElementForVisualElement(el);
        if (!domEl) {
            console.warn(`[VisualProcessor] Could not find DOM element for field [${i}]`, el.fieldLabel);
            continue;
        }

        const tag = domEl.tagName.toLowerCase();
        const inputType = (domEl.getAttribute('type') || '').toLowerCase();

        try {
            if (tag === 'select') {
                await fillSelectField(domEl, String(instruction));
            } else if (inputType === 'checkbox') {
                const shouldCheck = instruction === true || instruction === 'true';
                if (domEl.checked !== shouldCheck) {
                    simulateMouseClick(domEl);
                    await sleep(50);
                }
            } else if (inputType === 'radio') {
                // Find the radio in the group that matches the instruction value
                const groupName = domEl.getAttribute('name');
                if (groupName) {
                    const targetRadio = document.querySelector(
                        `input[type="radio"][name="${CSS.escape(groupName)}"][value="${CSS.escape(String(instruction))}"]`
                    );
                    if (targetRadio && !targetRadio.checked) {
                        simulateMouseClick(targetRadio);
                        await sleep(50);
                    }
                }
            } else if (domEl.isContentEditable) {
                // Contenteditable elements
                domEl.focus();
                domEl.textContent = '';
                document.execCommand('insertText', false, String(instruction));
                domEl.dispatchEvent(new Event('input', { bubbles: true }));
                domEl.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                // Text inputs, textareas, etc.
                await simulateHumanTyping(domEl, String(instruction));
            }

            domEl.setAttribute('data-filled-by-extension', 'true');
            filledCount++;

            console.log(`[VisualProcessor] Filled [${i}] "${el.fieldLabel || '(unlabeled)'}" with "${String(instruction).substring(0, 50)}"`);
        } catch (err) {
            if (err.message === "Form filling stopped by user.") throw err;
            console.error(`[VisualProcessor] Error filling field [${i}]:`, err);
        }

        // Update progress
        browser.runtime.sendMessage({
            action: "fillFormProgress",
            processed: 5 + i + 1,
            filled: filledCount,
            total: totalFields + 5,
            message: `Filling fields... ${filledCount} of ${totalFields}`,
            sessionId: sessionId
        });

        await sleep(50);
    }

    return filledCount;
}

function getDomElementForVisualElement(el) {
    // Re-probe the DOM element at the bounding box center
    if (!el.bbox) return null;

    const [bx1, by1, bx2, by2] = el.bbox;
    const isNormalized = (bx1 <= 1 && by1 <= 1 && bx2 <= 1 && by2 <= 1);
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let cx, cy;
    if (isNormalized) {
        cx = ((bx1 + bx2) / 2) * vw;
        cy = ((by1 + by2) / 2) * vh;
    } else {
        cx = (bx1 + bx2) / 2;
        cy = (by1 + by2) / 2;
    }

    // Hide overlay so we hit the actual page element
    const overlay = document.getElementById('visual-processor-overlay');
    if (overlay) overlay.style.display = 'none';

    let domEl = document.elementFromPoint(cx, cy);

    if (overlay) overlay.style.display = '';

    // Cross-origin iframes: elementFromPoint() returns the <iframe> wrapper, not the
    // inputs inside. We cannot fill across the frame boundary from the top frame —
    // the iframe's own content script handles those fields via the non-visual path.
    if (domEl && domEl.tagName.toLowerCase() === 'iframe') {
        return null;
    }

    // If we hit a label or wrapper, try to find the actual input inside
    if (domEl) {
        const tag = domEl.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'textarea' && !domEl.isContentEditable) {
            // Check for a form control inside
            const inner = domEl.querySelector('input, select, textarea, [contenteditable="true"]');
            if (inner) domEl = inner;

            // Check if it's a label pointing to an input
            if (tag === 'label') {
                const forId = domEl.getAttribute('for');
                if (forId) {
                    const target = document.getElementById(forId);
                    if (target) domEl = target;
                } else {
                    const innerInput = domEl.querySelector('input, select, textarea');
                    if (innerInput) domEl = innerInput;
                }
            }
        }
    }

    return domEl;
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

function isVisualSignupPage() {
    const url = window.location.href.toLowerCase();
    if (/signup|sign.up|register|create.?account|join/.test(url)) return true;
    if (document.querySelector('input[type="password"][name*="confirm"], input[type="password"][id*="confirm"], input[type="password"][name*="verify"]')) return true;
    const btns = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
    for (const btn of btns) {
        if (/sign.?up|register|create.?account|join\b/i.test(btn.textContent)) return true;
    }
    return false;
}
