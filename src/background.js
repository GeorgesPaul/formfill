let formFillProgress = {};
let formFillStart = null;
let totalFields = 0;
let isFilling = false;
let currentSessionId = null;
let activeFrames = new Set(); // Track frames that are actively filling
let completionTimer = null;  // Grace-period timer before signalling fillFormComplete to popup

function generateLoadingBar(percentage) {
  const barLength = 20;
  const filledLength = Math.round(percentage * barLength);
  const emptyLength = barLength - filledLength;
  return '[' + '█'.repeat(filledLength) + '░'.repeat(emptyLength) + ']';
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Fresh screenshot for the content script's mid-loop vision recall. Content
  // scripts can't call tabs.captureVisibleTab; background can. sendResponse +
  // `return true` is the one async-reply pattern both Firefox and Chrome MV3
  // support (returning a Promise works in Firefox only).
  if (message.action === "captureScreenshot") {
    const winId = sender && sender.tab ? sender.tab.windowId : null;
    Compat.captureVisibleTab(winId, { format: 'png' })
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(err => {
        console.error("captureScreenshot failed:", err);
        sendResponse({ dataUrl: null });
      });
    return true;
  }

  // Chrome MV3 can evict this service worker between messages, taking the
  // session state with it. Rather than dropping the rest of a fill in progress,
  // adopt the session the content script is reporting on.
  const isFillMessage = typeof message.action === 'string' && message.action.startsWith('fillForm');
  if (isFillMessage && currentSessionId === null && message.sessionId) {
    currentSessionId = message.sessionId;
    if (message.action !== "fillFormStart") {
      console.log("[Background] Adopting in-flight session after restart:", message.sessionId);
      isFilling = true;
      if (!formFillStart) formFillStart = Date.now();
      if (sender && sender.frameId !== undefined) activeFrames.add(sender.frameId);
    }
  }

  let computedMessage = '';
  let totalFilled = 0;
  let totalProcessed = 0;
  let percentage = 0;

  // Enforce session ID check for all messages except the start message (which sets it)
  if (message.action !== "fillFormStart" && message.sessionId && message.sessionId !== currentSessionId) {
    return;
  }

  switch (message.action) {
    case "fillFormStart":
      // Cancel any pending completion signal — a new frame is still registering
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      if (message.sessionId !== currentSessionId) {
        // New session - reset all tracking state
        currentSessionId = message.sessionId;
        formFillProgress = {};
        formFillStart = Date.now();
        totalFields = 0;
        activeFrames = new Set();
      }
      isFilling = true;
      activeFrames.add(sender.frameId);
      computedMessage = "Starting to fill form...\n" + generateLoadingBar(0) + " 0%";
      break;

    case "fillFormStopped": {
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      activeFrames.delete(sender.frameId);
      // Update this frame's final state
      formFillProgress[sender.frameId] = {
        processed: message.processed || (formFillProgress[sender.frameId] || {}).processed || 0,
        filled: message.filled || (formFillProgress[sender.frameId] || {}).filled || 0,
        total: message.total || (formFillProgress[sender.frameId] || {}).total || 0
      };
      if (activeFrames.size > 0) return; // Wait for other frames to finish
      isFilling = false;
      currentSessionId = null;
      const fill_duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
      totalFilled = Object.values(formFillProgress).reduce((sum, p) => sum + (p.filled || 0), 0);
      totalProcessed = Object.values(formFillProgress).reduce((sum, p) => sum + (p.processed || 0), 0);
      percentage = totalFields > 0 ? totalProcessed / totalFields : 0;
      computedMessage = `Form filling stopped by user.\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%\nFilled ${totalFilled} out of ${totalFields} fields in ${fill_duration} seconds.`;
      break;
    }

    case "fillFormProgress":
      if (!isFilling) return;
      if (!formFillProgress[sender.frameId]) {
        totalFields += message.total;
      } else if (formFillProgress[sender.frameId].total !== message.total) {
        totalFields -= formFillProgress[sender.frameId].total;
        totalFields += message.total;
      }
      // Clamp per-frame counts to the frame's total. The multi-pass refill
      // loop reports cumulative attempts that can exceed the field count;
      // without clamping the bar pins at 100% while filling is still running.
      {
        const t = message.total || 0;
        formFillProgress[sender.frameId] = {
          processed: Math.min(Math.max(0, message.processed || 0), t),
          filled: Math.min(Math.max(0, message.filled || 0), t),
          total: t
        };
      }
      totalProcessed = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.processed, 0);
      totalFilled = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      totalProcessed = Math.min(totalProcessed, totalFields);
      totalFilled = Math.min(totalFilled, totalFields);
      // Never report a full bar from a progress message -- only the explicit
      // fillFormComplete path is allowed to show 100%/done.
      percentage = totalFields > 0 ? Math.min(0.99, totalProcessed / totalFields) : 0;
      computedMessage = `Processing form...\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%`;
      break;

    case "fillFormComplete": {
      activeFrames.delete(sender.frameId);
      // Update this frame's final state
      formFillProgress[sender.frameId] = {
        processed: message.total || (formFillProgress[sender.frameId] || {}).processed || 0,
        filled: message.filled || (formFillProgress[sender.frameId] || {}).filled || 0,
        total: message.total || (formFillProgress[sender.frameId] || {}).total || 0
      };
      if (activeFrames.size > 0) return; // Wait for other frames to finish

      // Grace period: wait briefly before signalling completion to the popup.
      // This guards against a race where a concurrent frame's fillFormStart message
      // is still in-flight when we see the first fillFormComplete — without the delay,
      // background would incorrectly treat the session as finished.
      const _sid = currentSessionId;
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = setTimeout(() => {
        completionTimer = null;
        if (activeFrames.size > 0 || currentSessionId !== _sid) return; // state changed
        isFilling = false;
        const _filled = Object.values(formFillProgress).reduce((sum, p) => sum + (p.filled || 0), 0);
        const _duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
        // Compat.notify: the panel may be closed, and an unhandled rejection
        // per progress tick is noise, not a fault.
        Compat.notify({
          action: "fillFormComplete",
          filled: _filled,
          total: totalFields,
          message: `Form processing complete.\n${generateLoadingBar(1)} 100%\nFilled ${_filled} out of ${totalFields} fields in ${_duration} seconds.`,
          sessionId: _sid
        });
      }, 400);
      return; // Relay handled by timer above
    }

    case "fillFormError":
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      activeFrames.delete(sender.frameId);
      if (activeFrames.size > 0) return; // Wait for other frames to finish
      isFilling = false;
      computedMessage = `Error filling form: ${message.error || "undefined"}`;
      break;
  }

  if (computedMessage) {
    Compat.notify({
      action: message.action,
      filled: totalFilled,
      total: totalFields,
      message: computedMessage || message.message,
      sessionId: currentSessionId
    });
  }
});
