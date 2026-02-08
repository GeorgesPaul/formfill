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
        browser.runtime.sendMessage({
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
        browser.runtime.sendMessage({ action: "fillFormStart", sessionId: sessionId });

        updateFillProgress(processed, filledCount, totalFields, "Starting to fill form... This will take at least a few seconds.", sessionId);

        let formFieldsInfo = formElements.map(getFormFieldInfo);

        // --- Filter credential fields ---
        // Password fields are never filled by LLM (use "Fill User/Pass" button for KeePass)
        // Username/email fields: keep for LLM on signup pages (profile data), remove on login pages
        if (isSignupPage()) {
            // Signup: keep username/email for LLM (profile data), remove only passwords
            formFieldsInfo = formFieldsInfo.filter(f => !isPasswordField(f.info));
            console.log('[FormFiller] Signup page detected. Removed password fields, keeping username for LLM.');
        } else {
            // Login: remove all credential fields (use "Fill User/Pass" button instead)
            formFieldsInfo = formFieldsInfo.filter(f => !isPasswordField(f.info) && !isUsernameField(f.info));
            console.log('[FormFiller] Login page detected. Removed credential fields (use Fill User/Pass button).');
        }

        if (isCancelled()) throw new Error("Form filling stopped by user.");

        // If no fields remain after filtering, we're done
        if (formFieldsInfo.length === 0) {
            console.log('[FormFiller] No non-credential fields to fill.');
            simulateMouseClick(document.body, true);
            updateFillProgress(totalFields, filledCount, totalFields, `No form fields to fill (login page - use Fill User/Pass).`, sessionId);
            browser.runtime.sendMessage({
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

        for (const { element, info } of formFieldsInfo) {

            if (isCancelled()) {
                throw new Error("Form filling stopped by user.");
            }

            // 2. Check Safety Timeout (TTL)
            if (Date.now() - processStartTime > MAX_EXECUTION_TIME) {
                throw new Error("Form filling stopped: Safety timeout reached (5 minutes).");
            }

            const classes = Array.isArray(info.classes) ? info.classes : info.classes.split(' ');
            const matchingClass = classes.find(cls => cls in filledFields);

            let matched = false;
            if (filledFields[info.id] || filledFields[info.name] || matchingClass) {
                const value = filledFields[info.id] || filledFields[info.name] || filledFields[matchingClass];

                // Check if element already has the correct value (whether it was previously filled or not)
                if (elementHasCorrectValue(element, value)) {
                    console.log('Skipping field with correct value:', info.id || info.name);
                    // Ensure it's marked as filled
                    element.setAttribute('data-filled-by-extension', 'true');
                    processed++;
                    continue;
                }

                await fillField(element, value, info);

                filledCount++;
                matched = true;
            } else {
                console.log('No match found for:', info.id, info.name, classes.join(' '));
            }

            processed++;
            updateFillProgress(processed, filledCount, totalFields, `Processing ${processed} out of ${totalFields} fields (filled ${filledCount})...`, sessionId);

            await sleep(10);
        }

        simulateMouseClick(document.body, true);

        // Final forced update to ensure 100%
        updateFillProgress(totalFields, filledCount, totalFields, `Completed filling ${filledCount} out of ${totalFields} fields.`, sessionId);

        browser.runtime.sendMessage({
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
            browser.runtime.sendMessage({
                action: "fillFormStopped",
                filled: filledCount,
                processed: processed,
                total: totalFields,
                message: "Form filling stopped by user.",
                sessionId: sessionId
            });
            window.stopFilling = false; // Reset the stop action
        } else {
            browser.runtime.sendMessage({
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
    const formFieldsString = JSON.stringify(formFieldsInfo);

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
  Form Fields Info:
  ${formFieldsString}

  Your output should be a JSON object where keys are the 'id' or 'name' of the form fields and values are the extracted data. 
  Do not include any other text or formatting. If no suitable value can be determined for a field, return an empty string for that field.
  ${customPrompt ? `\nAdditional instructions from user:\n${customPrompt}` : ''}
  `;

    return { staticPart, dynamicPart };
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
