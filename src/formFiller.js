let currentProfile = null;

async function fillForm(profiles, customPrompt = '', sessionId = null) {
    // Abort any in-flight LLM request from a previous fill
    if (window.abortController) {
        window.abortController.abort();
        window.abortController = null;
    }

    // Take ownership of the fill session - automatically invalidates any concurrent fill
    window.currentFillSessionId = sessionId;
    currentProfile = profiles;

    // Helper: check if this fill has been cancelled (by user stop OR by a newer fill)
    function isCancelled() {
        return window.stopFilling || window.currentFillSessionId !== sessionId;
    }

    // Validate profiles parameter - now expecting array of text objects
    if (!Array.isArray(profiles) || profiles.length === 0) {
        const errorMsg = 'Invalid profiles: profiles should be a non-empty array';
        console.error(errorMsg);
        Compat.notify({
            action: "fillFormError",
            error: errorMsg,
            sessionId: sessionId
        });
        throw new Error(errorMsg);
    }

    let filledCount = 0;
    let processed = 0;
    let totalFields = 0;

    // Safety: Hard timeout to prevent infinite loops (5 minutes)
    const MAX_EXECUTION_TIME = 5 * 60 * 1000;
    const processStartTime = Date.now();

    try {
        // No object processing needed - use raw text directly
        const profileData = profiles;

        // Log the raw profile texts being used
        console.log('=== RAW PROFILE TEXTS FOR FORM FILLING ===');
        profileData.forEach((profile, index) => {
            console.log(`Profile ${index + 1}: ${profile.name}`);
            console.log('Raw text:');
            console.log(profile.data);
            console.log('');
        });
        console.log('=====================================');

        // Wait for full page load if not already complete (handles async JS loading content)
        await new Promise(resolve => {
            if (document.readyState === 'complete') {
                resolve();
            } else {
                window.addEventListener('load', resolve, { once: true });
            }
        });

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        const documents = findIframesWithForms();
        let formElements = getVisibleFormElements(documents);
        formElements = formElements.filter(el => !el.hasAttribute('data-filled-by-extension') || el.value === ''); // Filter marked but re-fill if cleared
        totalFields = formElements.length;
        console.log('found formElements on page (filtered):', formElements);

        // If no form elements found in this frame, skip silently
        if (totalFields === 0) {
            console.log("No form elements found in this frame, skipping.");
            return { status: "success", message: "No form elements found." };
        }

        // Only register with background AFTER confirming we have elements to fill
        window.stopFilling = false;
        Compat.notify({ action: "fillFormStart", sessionId: sessionId });

        updateFillProgress(processed, filledCount, totalFields, "Starting to fill form... This will take at least a few seconds.", sessionId);

        let formFieldsInfo = formElements.map(getFormFieldInfo);

        // Fill Form only skips password fields. Everything else (including
        // email and username) fills from the profile. Credentials come from
        // the separate "Fill User/Pass" (KeePass) button.
        formFieldsInfo = formFieldsInfo.filter(f => !isPasswordField(f.info));
        console.log('[FormFiller] Removed password fields; email/username filled from profile.');

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // If no fields remain after filtering, we're done
        if (formFieldsInfo.length === 0) {
            console.log('[FormFiller] No non-credential fields to fill.');
            simulateMouseClick(document.body, true);
            updateFillProgress(totalFields, filledCount, totalFields, `No form fields to fill (login page - use Fill User/Pass).`, sessionId);
            Compat.notify({
                action: "fillFormComplete",
                filled: filledCount,
                total: totalFields,
                message: `No form fields to fill. Use "Fill User/Pass" for credentials.`,
                sessionId: sessionId
            });
            return { status: "success", message: `No form fields to fill.` };
        }

        // Always use Single Prompt Strategy
        const filledFields = await fillFormSinglePrompt(formFieldsInfo, profileData, customPrompt, sessionId);

        console.log('Fields to fill:', filledFields);

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // --- Build the cached signature->value map from the first pass ---
        const intended = new Map();
        for (let i = 0; i < formFieldsInfo.length; i++) {
            const { info } = formFieldsInfo[i];
            const value = resolveDomValue(i, info, filledFields);
            if (value !== undefined && value !== null && value !== '') {
                intended.set(fieldSignature(info), value);
            }
        }

        // Re-query ALL visible non-password fields each pass so the loop sees
        // fields the form blanked and fields that newly appeared.
        const buildFields = () => {
            const docs = findIframesWithForms();
            return getVisibleFormElements(docs)
                .map(getFormFieldInfo)
                .filter(f => !isPasswordField(f.info));
        };

        const cancelledOrTimedOut = () =>
            isCancelled() || (Date.now() - processStartTime > MAX_EXECUTION_TIME);

        // DOM-only recall: re-ask the text LLM about the current fields so
        // newly appeared ones get values. Keyed by signature.
        const recallForNewFields = async (fields) => {
            if (cancelledOrTimedOut()) throw new Error("Form filling stopped by user.");
            const infos = fields.map(f => ({ info: f.info }));
            const more = await fillFormSinglePrompt(infos, profileData, customPrompt, sessionId);
            if (cancelledOrTimedOut()) throw new Error("Form filling stopped by user.");
            const out = new Map();
            fields.forEach((f, idx) => {
                const v = resolveDomValue(idx, f.info, more);
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
                processed = lastShown;
                updateFillProgress(lastShown, lastShown, totalFields,
                    `Pass ${pass}: ${done}/${intendedTotal} correct, ${wrong} remaining` +
                    (newCount ? `, ${newCount} new field(s)` : '') + '...', sessionId);
            },
            // Keeps the bar/counter alive between pass boundaries (long iframe
            // fills and slow LLM recalls) so it never looks frozen.
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

        // Final forced update to ensure 100%
        updateFillProgress(totalFields, filledCount, totalFields, `Completed filling ${filledCount} out of ${totalFields} fields.`, sessionId);

        Compat.notify({
            action: "fillFormComplete",
            filled: filledCount,
            total: totalFields,
            message: `Completed filling ${filledCount} out of ${totalFields} fields.`,
            sessionId: sessionId
        });

        return { status: "success", message: `Processed ${filledCount} out of ${totalFields} fields.` };
    } catch (error) {
        console.error("Error filling form:", error);

        if (error.message === "Form filling stopped by user.") {
            Compat.notify({
                action: "fillFormStopped",
                filled: filledCount,
                processed: processed,
                total: totalFields,
                message: "Form filling stopped by user.",
                sessionId: sessionId
            });
            window.stopFilling = false; // Reset the stop action
        } else {
            Compat.notify({
                action: "fillFormError",
                error: error.toString() || "undefined",
                sessionId: sessionId
            });
        }

        return { status: "error", message: error.toString() };
    } finally {
        // No finally disconnect, as we want it active post-fill for future changes
    }
}

async function fillFormSinglePrompt(formFieldsInfo, profileData, customPrompt = '', sessionId = null) {
    const { staticPart, dynamicPart } = generateSinglePromptForAllFields(formFieldsInfo, profileData, customPrompt);

    // Log the prompt components
    console.log('=== STATIC PROMPT PART (Cacheable) ===');
    console.log(staticPart);
    console.log('=== DYNAMIC PROMPT PART ===');
    console.log(dynamicPart);
    console.log('=================================');

    let llmContentString = '';

    try {
        if (window.stopFilling || window.currentFillSessionId !== sessionId) throw new Error("Form filling stopped by user.");

        // promptLLM now takes (dynamicPrompt, staticPrompt) to enable caching
        llmContentString = await promptLLM(dynamicPart, staticPart);

        if (window.stopFilling || window.currentFillSessionId !== sessionId) throw new Error("Form filling stopped by user.");

        // Clean it up just in case the LLM wrapped it in markdown.
        const cleanedJsonString = llmContentString.replace(/```json\n|```/g, '').trim();

        // Now, parse the LLM's output.
        return JSON.parse(cleanedJsonString);

    } catch (error) {
        if (error.message === "Form filling stopped by user.") throw error;

        if (error.name === 'SyntaxError') {
            // This catch is now ONLY for when the LLM's output itself is not valid JSON.
            logToUser(
                "LLM FORMATTING ERROR: The model did not return a valid JSON string.",
                "\nLLM's response (first 250 chars):",
                `\n>>>\n${llmContentString.substring(0, 250)}\n<<<`,
                "\nFull Error:", error
            );
        } else {
            // This will catch the new, clearer error from handleLlmResponse.
            console.error("An error occurred in fillFormSinglePrompt:", error);
        }

        return {};
    }
}

function generateSinglePromptForAllFields(formFieldsInfo, profileData, customPrompt = '') {
    // Trim each field to the human-meaningful bits (label/placeholder/type/
    // options) plus the identifiers needed only for keying. Reuses the vision
    // path's trimmer when available so both paths see the same shape.
    const strip = (typeof stripFieldInfoForPrompt === 'function')
        ? stripFieldInfoForPrompt
        : (info => info);
    const formFieldsForPrompt = formFieldsInfo.map(({ info }, idx) => ({
        index: idx, ...strip(info)
    }));
    const formFieldsString = JSON.stringify(formFieldsForPrompt);

    // Use raw profile text directly
    let userDataString = '';
    if (Array.isArray(profileData)) {
        profileData.forEach((profile, index) => {
            userDataString += `\n=== ${profile.name} ===\n`;
            userDataString += profile.data + '\n'; // Raw text as-is
        });
    } else {
        // Handle case where profileData might be a single object or a string directly
        userDataString = profileData.data || profileData; // Fallback for single profile
    }

    const staticPart = `You are an AI assistant specialized in filling out web forms. 
  Given the available user profile data and the following form field information, determine the most appropriate value to fill into the form fields. 
  The user profile data is provided as raw text, and you need to extract the most relevant information from it.

  User Profile Data:
  ${userDataString}`;

    const dynamicPart = `
  Form Fields Info (JSON):
  ${formFieldsString}

  Decide what each field is from what a human SEES: its visible 'label'
  (and 'placeholder'/'nearbyText'). Treat 'id', 'name', and 'autocomplete'
  as UNRELIABLE -- some forms deliberately set them to the wrong thing or
  reuse the same id/name on several fields. When 'label' conflicts with
  'id'/'name'/'autocomplete', the label wins. If a field has no label and
  nothing visible identifies it, omit it.

  Output a single JSON object keyed STRICTLY by each field's numeric
  'index' (e.g. "0", "5"). Never key by id or name -- ids are not unique
  on some forms and that collapses distinct fields. Value is the string to
  fill; for a <select> use the exact option text. Omit fields with no
  suitable profile value. No markdown, no commentary -- JSON only.
  ${customPrompt ? `\nAdditional instructions from user:\n${customPrompt}` : ''}
  `;

    return { staticPart, dynamicPart };
}


// Resolve the LLM value for a field. Numeric index FIRST: the prompt tells
// the model to key strictly by index, and index is the only collision-free
// key (id/name are reused across fields on some forms, which would map one
// field's value onto another). id/name/label remain as defensive fallbacks
// only for models that ignored the instruction. 'in' so falsy values match.
function resolveDomValue(i, info, filledFields) {
    if (String(i) in filledFields) return filledFields[String(i)];
    if (info.id && info.id in filledFields) return filledFields[info.id];
    if (info.name && info.name in filledFields) return filledFields[info.name];
    const classes = Array.isArray(info.classes)
        ? info.classes : String(info.classes || '').split(' ');
    const matchingClass = classes.find(cls => cls && cls in filledFields);
    if (matchingClass) return filledFields[matchingClass];
    if (info.label && info.label in filledFields) return filledFields[info.label];
    if (info.nearbyText && info.nearbyText in filledFields) return filledFields[info.nearbyText];
    return undefined;
}

function trimAndRemoveQuotes(str) {
    // First, trim leading and trailing whitespace
    str = str.trim();

    // Then, remove leading and trailing double quotes if they exist
    if (str.startsWith('"') && str.endsWith('"')) {
        str = str.slice(1, -1);
    }

    return str;
}

// --- Credential field detection ---

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

function isSignupPage() {
    const url = window.location.href.toLowerCase();
    if (/signup|sign.up|register|create.?account|join/.test(url)) return true;
    // Check for "confirm password" field
    if (document.querySelector('input[type="password"][name*="confirm"], input[type="password"][id*="confirm"], input[type="password"][name*="verify"]')) return true;
    // Check button/submit text
    const btns = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
    for (const btn of btns) {
        if (/sign.?up|register|create.?account|join\b/i.test(btn.textContent)) return true;
    }
    return false;
}
