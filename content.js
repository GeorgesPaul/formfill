// Event listeners
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Content script received message:", message);

  if (message.action === "fillForm") {
    console.log("Filling form with profiles:", message.profiles || message.profile);

    // Handle both new format (profiles array) and old format (single profile)
    let profilesToUse = [];
    if (message.profiles) {
      // New format: array of profiles
      profilesToUse = message.profiles;
    } else if (message.profile) {
      // Old format: single profile, wrap in array for consistency
      profilesToUse = [message.profile];
    } else {
      console.error("No profile data received");
      sendResponse({ status: "error", message: "No profile data received" });
      return true;
    }

    if (message.useVisualProcessing && message.screenshot) {
      // Visual processing only makes sense in the top frame (screenshot is of the main page)
      if (window.self !== window.top) {
        // Iframe: fall back to non-visual filling (handles cross-origin iframe forms)
        console.log("[Content] Iframe detected with visual processing enabled - using non-visual fallback");
        fillForm(profilesToUse, message.customPrompt, message.sessionId).then(result => {
          sendResponse(result);
        }).catch(error => {
          sendResponse({ status: "error", message: error.toString() });
        });
        return true;
      }
      console.log("Using merged visual + source analysis pipeline...");
      mergedFillForm(message.screenshot, profilesToUse, message.customPrompt, message.sessionId).then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({ status: "error", message: error.toString() });
      });
    } else {
      fillForm(profilesToUse, message.customPrompt, message.sessionId).then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({ status: "error", message: error.toString() });
      });
    }

    return true; // Indicate that we will send a response asynchronously
  }

  if (message.action === "fillCredentials") {
    console.log("[Content] Filling credentials from KeePass...");
    fillCredentialsOnly(message.sessionId).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ status: "error", message: error.toString() });
    });
    return true;
  }

  if (message.action === "stopFilling") {
    console.log("Stopping form filling...");
    window.stopFilling = true;
    window.currentFillSessionId = null; // Invalidate session so isCancelled() triggers
    if (window.abortController) {
      window.abortController.abort();
    }
    // Clean up visual processor overlay if present
    if (typeof removeOverlay === 'function') {
      removeOverlay();
    }
    sendResponse({ status: "stopped" });
    return true;
  }
});

// Fill only credentials from KeePass (username and password fields)
async function fillCredentialsOnly(sessionId) {
  window.currentFillSessionId = sessionId;
  window.stopFilling = false;

  function isCancelled() {
    return window.stopFilling || window.currentFillSessionId !== sessionId;
  }

  try {
    browser.runtime.sendMessage({ action: "fillFormStart", sessionId: sessionId });
    browser.runtime.sendMessage({
      action: "fillFormProgress",
      processed: 0, filled: 0, total: 2,
      message: "Looking for credential fields...",
      sessionId: sessionId
    });

    // Find credential fields
    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
    let usernameField = null;
    let passwordField = null;

    for (const input of inputs) {
      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(input);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      if (!passwordField && isPasswordField({ type: input.type, name: input.name, id: input.id })) {
        passwordField = input;
      } else if (!usernameField && isUsernameField({
        type: input.type,
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        autocomplete: input.autocomplete
      })) {
        usernameField = input;
      }
    }

    // If we found password but not username, look for text/email input before it
    if (passwordField && !usernameField) {
      const allInputs = Array.from(inputs);
      const pwIndex = allInputs.indexOf(passwordField);
      for (let i = pwIndex - 1; i >= 0 && i >= pwIndex - 3; i--) {
        const inp = allInputs[i];
        const t = (inp.type || 'text').toLowerCase();
        if (t === 'text' || t === 'email') {
          usernameField = inp;
          break;
        }
      }
    }

    if (!usernameField && !passwordField) {
      browser.runtime.sendMessage({
        action: "fillFormComplete",
        filled: 0, total: 0,
        message: "No credential fields found on this page.",
        sessionId: sessionId
      });
      return { status: "success", message: "No credential fields found." };
    }

    if (isCancelled()) throw new Error("Credential filling stopped by user.");

    browser.runtime.sendMessage({
      action: "fillFormProgress",
      processed: 1, filled: 0, total: 2,
      message: "Querying KeePass for credentials...",
      sessionId: sessionId
    });

    // Query KeePass
    const keepassResult = await browser.runtime.sendMessage({
      action: "keepass-get-logins",
      url: window.location.href
    });

    if (!keepassResult.success || !keepassResult.entries || keepassResult.entries.length === 0) {
      browser.runtime.sendMessage({
        action: "fillFormComplete",
        filled: 0, total: (usernameField ? 1 : 0) + (passwordField ? 1 : 0),
        message: "No KeePass entries found for this site.",
        sessionId: sessionId
      });
      return { status: "success", message: "No KeePass entries found." };
    }

    if (isCancelled()) throw new Error("Credential filling stopped by user.");

    // Use the first matching entry
    const entry = keepassResult.entries[0];
    console.log('[Content] Filling credentials from KeePass entry:', entry.name);

    let filledCount = 0;

    if (usernameField && entry.login) {
      usernameField.focus();
      usernameField.value = entry.login;
      usernameField.dispatchEvent(new Event('input', { bubbles: true }));
      usernameField.dispatchEvent(new Event('change', { bubbles: true }));
      usernameField.setAttribute('data-filled-by-extension', 'true');
      filledCount++;
    }

    if (passwordField && entry.password) {
      passwordField.focus();
      passwordField.value = entry.password;
      passwordField.dispatchEvent(new Event('input', { bubbles: true }));
      passwordField.dispatchEvent(new Event('change', { bubbles: true }));
      passwordField.setAttribute('data-filled-by-extension', 'true');
      filledCount++;
    }

    // Click outside to trigger any validation
    document.body.click();

    browser.runtime.sendMessage({
      action: "fillFormComplete",
      filled: filledCount,
      total: (usernameField ? 1 : 0) + (passwordField ? 1 : 0),
      message: `Filled ${filledCount} credential field(s) from KeePass.`,
      sessionId: sessionId
    });

    return { status: "success", message: `Filled ${filledCount} credential field(s).` };

  } catch (error) {
    console.error('[Content] Credential fill error:', error);

    if (error.message.includes("stopped by user")) {
      browser.runtime.sendMessage({
        action: "fillFormStopped",
        filled: 0, processed: 0, total: 0,
        message: "Credential filling stopped by user.",
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