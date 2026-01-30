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
      console.log("Using visual form processing pipeline...");
      visualFillForm(message.screenshot, profilesToUse, message.customPrompt, message.sessionId).then(result => {
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