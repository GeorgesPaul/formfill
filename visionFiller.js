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

        // Fill Form only skips password fields. Everything else (including
        // email and username) fills from the profile. Credentials come from
        // the separate "Fill User/Pass" (KeePass) button.
        formFieldsInfo = formFieldsInfo.filter(f => !isPasswordField(f.info));

        // Draw detection overlays on every fillable field (purely cosmetic).
        if (typeof OverlayUtils !== 'undefined') {
            OverlayUtils.clearAll();
            for (const f of formFieldsInfo) {
                const labelText = f.info.label || f.info.placeholder || f.info.name || f.info.id || f.info.type || '';
                OverlayUtils.add(f.element, 'detected', labelText);
            }
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

        if (typeof OverlayUtils !== 'undefined') {
            for (const idxStr of Object.keys(heuristicMatches)) {
                const f = formFieldsInfo[Number(idxStr)];
                if (f) OverlayUtils.setStatus(f.element, 'heuristic');
            }
        }

        // --- Vision LLM call: send ALL fields so the model can override bad DOM metadata ---
        let llmMatches = {};
        updateFillProgress(0, 0, totalFields, `Asking vision LLM about ${formFieldsInfo.length} field(s)...`, sessionId);

        const allFields = formFieldsInfo.map((f, idx) => ({
            index: idx,
            ...stripFieldInfoForPrompt(f.info)
        }));

        const prompt = buildVisionPrompt(allFields, profiles, customPrompt);
        console.log('=== VISION PROMPT ===');
        console.log(prompt);

        const raw = await ApiUtils.promptLLMWithVision(prompt, screenshotDataUrl);

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        try {
            const cleaned = raw.replace(/```json\n?|```/g, '').trim();
            llmMatches = JSON.parse(cleaned);
        } catch (e) {
            console.error("Vision LLM did not return valid JSON:", raw.substring(0, 500));
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // Update overlays: LLM-matched fields turn blue, heuristic-only stay green, rest orange.
        if (typeof OverlayUtils !== 'undefined') {
            for (let i = 0; i < formFieldsInfo.length; i++) {
                const { element, info } = formFieldsInfo[i];
                const llmVal = resolveLLMOnly(i, info, llmMatches);
                if (llmVal !== undefined && llmVal !== null && llmVal !== '') {
                    OverlayUtils.setStatus(element, 'llm');
                } else if (!(i in heuristicMatches)) {
                    OverlayUtils.setStatus(element, 'nomatch');
                }
            }
        }

        // --- Build the cached signature->value map from the first pass ---
        const intended = new Map();
        for (let i = 0; i < formFieldsInfo.length; i++) {
            const { info } = formFieldsInfo[i];
            const value = resolveFieldValue(i, info, heuristicMatches, llmMatches);
            if (value !== undefined && value !== null && value !== '') {
                intended.set(fieldSignature(info), value);
            }
        }

        // Re-query ALL visible non-password fields (not filtered by the
        // data-filled marker) so the loop sees fields the form blanked and
        // fields that newly appeared.
        const buildFields = () => {
            const docs = findIframesWithForms();
            return getVisibleFormElements(docs)
                .map(getFormFieldInfo)
                .filter(f => !isPasswordField(f.info));
        };

        const cancelledOrTimedOut = () =>
            isCancelled() || (Date.now() - processStartTime > MAX_EXECUTION_TIME);

        // Vision recall: recapture the screenshot, re-ask the LLM about the
        // current fields so newly appeared ones get values. Keyed by signature.
        const recallForNewFields = async (fields) => {
            if (cancelledOrTimedOut()) throw new Error("Form filling stopped by user.");
            const shot = await captureFreshScreenshot();
            if (!shot) return null;
            const allFields = fields.map((f, idx) => ({
                index: idx, ...stripFieldInfoForPrompt(f.info)
            }));
            const recallPrompt = buildVisionPrompt(allFields, profiles, customPrompt);
            const raw = await ApiUtils.promptLLMWithVision(recallPrompt, shot);
            if (cancelledOrTimedOut()) throw new Error("Form filling stopped by user.");
            let m = {};
            try { m = JSON.parse(raw.replace(/```json\n?|```/g, '').trim()); }
            catch (e) {
                console.error('[VisionFiller] recall LLM returned invalid JSON:', raw.substring(0, 300));
                return null;
            }
            const out = new Map();
            fields.forEach((f, idx) => {
                const v = resolveLLMOnly(idx, f.info, m);
                if (v !== undefined && v !== null && v !== '') {
                    out.set(fieldSignature(f.info), v);
                }
            });
            return out;
        };

        let lastShown = 0;
        const loopResult = await runFillVerifyLoop({
            getFields: buildFields,
            initialValues: intended,
            recallForNewFields,
            isCancelled: cancelledOrTimedOut,
            onPass: ({ pass, wrong, filledCount: fc, newCount, done, intendedTotal }) => {
                filledCount = fc;
                // Report fields-correct as progress, and never let the bar
                // read 100% mid-loop -- the post-loop completion call below is
                // the only thing allowed to signal "done".
                lastShown = Math.min(done, Math.max(0, totalFields - 1));
                updateFillProgress(lastShown, lastShown, totalFields,
                    `Pass ${pass}: ${done}/${intendedTotal} correct, ${wrong} remaining` +
                    (newCount ? `, ${newCount} new field(s)` : '') + '...', sessionId);
            },
            // Keeps the bar/counter alive between pass boundaries (long iframe
            // fills and slow LLM recalls). Holds the bar position but refreshes
            // the status so it never looks frozen.
            onProgress: ({ phase, pass, filledCount: fc, newCount }) => {
                if (typeof fc === 'number') filledCount = fc;
                const msg = phase === 'recall'
                    ? `Pass ${pass}: asking LLM about ${newCount || ''} new field(s)...`
                    : `Pass ${pass}: filling (${filledCount} filled so far)...`;
                updateFillProgress(lastShown, lastShown, totalFields, msg, sessionId);
            },
        });
        filledCount = loopResult.filledCount;
        processed = totalFields;

        simulateMouseClick(document.body, true);

        updateFillProgress(totalFields, filledCount, totalFields,
            `Completed filling ${filledCount} out of ${totalFields} fields.`, sessionId);
        browser.runtime.sendMessage({
            action: "fillFormComplete",
            filled: filledCount, total: totalFields,
            message: `Completed filling ${filledCount} out of ${totalFields} fields.`,
            sessionId
        });

        // Leave overlays visible briefly so the user sees the final state, then clear.
        if (typeof OverlayUtils !== 'undefined') {
            setTimeout(() => OverlayUtils.clearAll(), 1200);
        }

        return { status: "success", message: `Processed ${filledCount}/${totalFields}.` };
    } catch (error) {
        console.error("[VisionFiller] Error:", error);
        if (typeof OverlayUtils !== 'undefined') OverlayUtils.clearAll();
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

function buildVisionPrompt(fields, profiles, customPrompt) {
    let userData = '';
    for (const p of profiles) {
        userData += `\n=== ${p.name || 'Profile'} ===\n${p.data || ''}\n`;
    }

    return `You are helping fill a web form. You have:
1) A screenshot of the form as the user sees it.
2) DOM metadata for every fillable field on the page.
3) The user's profile data in plain text.

IMPORTANT: Some forms have misleading HTML attributes. For example a field visually labeled "City" might carry autocomplete="address-line1", or a continuation line under "Street address" might have no label at all. When the visual label, position, or grouping in the screenshot conflicts with the DOM attributes (id, name, autocomplete), ALWAYS trust what you see in the screenshot. Use DOM metadata only for field targeting (keying your JSON output), not for deciding what a field means.

Match the value format to the field. If a placeholder shows a format pattern (e.g. "dd-mm-aaaa", "(XXX) XXX-XXXX", "$X,XXX.XX"), reformat the profile value to match that pattern exactly. If the field has an options list, pick the EXACT option text or value as given -- do not paraphrase.

Match each field to the most appropriate profile value based on what the field visually represents.

User profile data:${userData}

Fields to fill (JSON):
${JSON.stringify(fields)}

Respond with a single JSON object. Key each entry by its numeric 'index' value (e.g. "0", "4", "6"). Do NOT key by id or name because some forms reuse the same id on multiple fields. Value is the string to fill. Omit fields for which no suitable value exists in the profile. No markdown fences, no commentary -- JSON only.
${customPrompt ? `\nAdditional user instructions:\n${customPrompt}` : ''}`;
}

// LLM-only lookup (no heuristic fallback). Used for overlay coloring.
function resolveLLMOnly(i, info, llmMatches) {
    // Numeric index is the primary key (avoids duplicate-id collisions).
    if (String(i) in llmMatches) return llmMatches[String(i)];
    // Fallback keys in case the LLM used id/name instead of index.
    if (info.id && info.id in llmMatches) return llmMatches[info.id];
    if (info.name && info.name in llmMatches) return llmMatches[info.name];
    const classes = Array.isArray(info.classes) ? info.classes : String(info.classes || '').split(' ');
    const cls = classes.find(c => c && c in llmMatches);
    if (cls) return llmMatches[cls];
    if (info.label && info.label in llmMatches) return llmMatches[info.label];
    if (info.nearbyText && info.nearbyText in llmMatches) return llmMatches[info.nearbyText];
    return undefined;
}

function resolveFieldValue(i, info, heuristicMatches, llmMatches) {
    // Vision LLM sees screenshot + DOM, so it has more context than heuristics.
    // LLM wins; heuristic is fallback for fields the LLM didn't return.
    const llmVal = resolveLLMOnly(i, info, llmMatches);
    if (llmVal !== undefined && llmVal !== null && llmVal !== '') return llmVal;
    if (i in heuristicMatches) return heuristicMatches[i];
    return undefined;
}
