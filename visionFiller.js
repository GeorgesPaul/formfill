// Vision-LLM form filler — replaces the OmniParser + merge pipeline.
// One round-trip: DOM field metadata + profile + screenshot → JSON mapping.
// Runs only in the top frame (screenshot is of the main page); iframes use
// the DOM-only formFiller.js path as before.

async function visionFillForm(screenshotDataUrl, profiles, customPrompt = '', sessionId = null) {
    // Abort any in-flight LLM request from a previous fill
    if (window.abortController) {
        window.abortController.abort();
        window.abortController = null;
    }
    window.currentFillSessionId = sessionId;

    function isCancelled() {
        return window.stopFilling || window.currentFillSessionId !== sessionId;
    }

    if (!Array.isArray(profiles) || profiles.length === 0) {
        const errorMsg = 'Invalid profiles: profiles should be a non-empty array';
        browser.runtime.sendMessage({ action: "fillFormError", error: errorMsg, sessionId });
        throw new Error(errorMsg);
    }

    let filledCount = 0;
    let processed = 0;
    let totalFields = 0;

    // Safety: hard timeout so nothing can loop forever
    const MAX_EXECUTION_TIME = 5 * 60 * 1000;
    const processStartTime = Date.now();

    try {
        await new Promise(resolve => {
            if (document.readyState === 'complete') resolve();
            else window.addEventListener('load', resolve, { once: true });
        });

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        const documents = findIframesWithForms();
        let formElements = getVisibleFormElements(documents);
        formElements = formElements.filter(el => !el.hasAttribute('data-filled-by-extension') || el.value === '');
        totalFields = formElements.length;

        if (totalFields === 0) {
            return { status: "success", message: "No form elements found." };
        }

        window.stopFilling = false;
        browser.runtime.sendMessage({ action: "fillFormStart", sessionId });
        updateFillProgress(0, 0, totalFields, "Analysing form...", sessionId);

        let formFieldsInfo = formElements.map(getFormFieldInfo);

        // Filter out credential fields (same logic as formFiller.js)
        if (isSignupPage()) {
            formFieldsInfo = formFieldsInfo.filter(f => !isPasswordField(f.info));
        } else {
            formFieldsInfo = formFieldsInfo.filter(f => !isPasswordField(f.info) && !isUsernameField(f.info));
        }

        if (formFieldsInfo.length === 0) {
            browser.runtime.sendMessage({
                action: "fillFormComplete", filled: 0, total: totalFields,
                message: 'No form fields to fill. Use "Fill User/Pass" for credentials.',
                sessionId
            });
            return { status: "success", message: "No form fields to fill." };
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // --- Heuristic pre-pass: deterministic matches via autocomplete/type/patterns ---
        const { matches: heuristicMatches, remainingIndices } =
            HeuristicFiller.applyHeuristics(formFieldsInfo, profiles);

        console.log(`[VisionFiller] Heuristics matched ${Object.keys(heuristicMatches).length}/${formFieldsInfo.length} fields; ${remainingIndices.length} remaining for vision LLM.`);

        // --- Vision LLM call for remaining fields ---
        let llmMatches = {};
        if (remainingIndices.length > 0) {
            updateFillProgress(0, 0, totalFields, `Asking vision LLM about ${remainingIndices.length} field(s)...`, sessionId);

            const remainingFields = remainingIndices.map(idx => ({
                index: idx,
                ...stripFieldInfoForPrompt(formFieldsInfo[idx].info)
            }));

            const prompt = buildVisionPrompt(remainingFields, profiles, customPrompt);
            console.log('=== VISION PROMPT ===');
            console.log(prompt);

            const raw = await ApiUtils.promptLLMWithVision(prompt, screenshotDataUrl);

            if (isCancelled()) throw new Error("Form filling stopped by user.");

            try {
                const cleaned = raw.replace(/```json\n?|```/g, '').trim();
                llmMatches = JSON.parse(cleaned);
            } catch (e) {
                console.error("Vision LLM did not return valid JSON:", raw.substring(0, 500));
                // Fall through: heuristic matches still get applied.
            }
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // --- Fill: merge heuristic + LLM, iterate fields ---
        for (let i = 0; i < formFieldsInfo.length; i++) {
            if (isCancelled()) throw new Error("Form filling stopped by user.");
            if (Date.now() - processStartTime > MAX_EXECUTION_TIME) {
                throw new Error("Form filling stopped: Safety timeout reached (5 minutes).");
            }

            const { element, info } = formFieldsInfo[i];
            const value = resolveFieldValue(i, info, heuristicMatches, llmMatches);

            if (value !== undefined && value !== null && value !== '') {
                if (elementHasCorrectValue(element, value)) {
                    element.setAttribute('data-filled-by-extension', 'true');
                } else {
                    await fillField(element, value, info);
                    filledCount++;
                }
            }

            processed++;
            updateFillProgress(processed, filledCount, totalFields,
                `Filled ${filledCount}/${totalFields} (${processed} processed)...`, sessionId);
            await sleep(10);
        }

        simulateMouseClick(document.body, true);

        updateFillProgress(totalFields, filledCount, totalFields,
            `Completed filling ${filledCount} out of ${totalFields} fields.`, sessionId);
        browser.runtime.sendMessage({
            action: "fillFormComplete",
            filled: filledCount, total: totalFields,
            message: `Completed filling ${filledCount} out of ${totalFields} fields.`,
            sessionId
        });

        return { status: "success", message: `Processed ${filledCount}/${totalFields}.` };
    } catch (error) {
        console.error("[VisionFiller] Error:", error);
        if (error.message === "Form filling stopped by user.") {
            browser.runtime.sendMessage({
                action: "fillFormStopped",
                filled: filledCount, processed, total: totalFields,
                message: "Form filling stopped by user.", sessionId
            });
            window.stopFilling = false;
        } else {
            browser.runtime.sendMessage({
                action: "fillFormError", error: error.toString(), sessionId
            });
        }
        return { status: "error", message: error.toString() };
    }
}

// Trim field info to the handful of fields the LLM actually needs, so prompt
// size stays reasonable on pages with many fields.
function stripFieldInfoForPrompt(info) {
    const out = {
        id: info.id || undefined,
        name: info.name || undefined,
        type: info.type || undefined,
        placeholder: info.placeholder || undefined,
        label: info.label || undefined,
        autocomplete: info.autocomplete || undefined,
        required: info.required || undefined,
    };
    if (info.options) out.options = info.options;
    // Clip nearbyText — often noisy
    if (info.nearbyText) {
        const t = String(info.nearbyText).trim();
        if (t.length > 0 && t.length <= 120) out.nearbyText = t;
        else if (t.length > 120) out.nearbyText = t.slice(0, 120);
    }
    // Drop undefined keys for a cleaner prompt
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
}

function buildVisionPrompt(remainingFields, profiles, customPrompt) {
    let userData = '';
    for (const p of profiles) {
        userData += `\n=== ${p.name || 'Profile'} ===\n${p.data || ''}\n`;
    }

    return `You are helping fill a web form. You have:
1) A screenshot of the form as the user sees it.
2) DOM metadata for the fields that still need values (already-handled fields are not shown).
3) The user's profile data in plain text.

Use the screenshot to understand the visual layout, grouping, and any labels the DOM doesn't expose cleanly. Use the DOM metadata for exact field targeting. Match each field to the most appropriate profile value.

User profile data:${userData}

Fields to fill (JSON):
${JSON.stringify(remainingFields)}

Respond with a single JSON object. Key each entry by the field's 'id' if non-empty, otherwise its 'name' if non-empty, otherwise its numeric 'index'. Value is the string to fill. Omit fields for which no suitable value exists in the profile. No markdown fences, no commentary — JSON only.
${customPrompt ? `\nAdditional user instructions:\n${customPrompt}` : ''}`;
}

function resolveFieldValue(i, info, heuristicMatches, llmMatches) {
    // Heuristic wins over LLM for fields the heuristic matched (cheaper + deterministic).
    if (i in heuristicMatches) return heuristicMatches[i];
    // LLM key lookup: id > name > class > label > nearbyText > numeric index.
    if (info.id && info.id in llmMatches) return llmMatches[info.id];
    if (info.name && info.name in llmMatches) return llmMatches[info.name];
    const classes = Array.isArray(info.classes) ? info.classes : String(info.classes || '').split(' ');
    const cls = classes.find(c => c && c in llmMatches);
    if (cls) return llmMatches[cls];
    if (info.label && info.label in llmMatches) return llmMatches[info.label];
    if (info.nearbyText && info.nearbyText in llmMatches) return llmMatches[info.nearbyText];
    if (String(i) in llmMatches) return llmMatches[String(i)];
    return undefined;
}
