let formFillProgress = {};
let formFillStart = null;
let totalFields = 0;
let isFilling = false;
let currentSessionId = null;
let activeFrames = new Set(); // Track frames that are actively filling

function generateLoadingBar(percentage) {
  const barLength = 20;
  const filledLength = Math.round(percentage * barLength);
  const emptyLength = barLength - filledLength;
  return '[' + '█'.repeat(filledLength) + '░'.repeat(emptyLength) + ']';
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      formFillProgress[sender.frameId] = {
        processed: message.processed,
        filled: message.filled,
        total: message.total
      };
      totalProcessed = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.processed, 0);
      totalFilled = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      percentage = totalFields > 0 ? totalProcessed / totalFields : 0;
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
      isFilling = false;
      const duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
      totalFilled = Object.values(formFillProgress).reduce((sum, p) => sum + (p.filled || 0), 0);
      percentage = 1;
      computedMessage = `Form processing complete.\n${generateLoadingBar(1)} 100%\nFilled ${totalFilled} out of ${totalFields} fields in ${duration} seconds.`;
      break;
    }

    case "fillFormError":
      activeFrames.delete(sender.frameId);
      if (activeFrames.size > 0) return; // Wait for other frames to finish
      isFilling = false;
      computedMessage = `Error filling form: ${message.error || "undefined"}`;
      break;
  }

  if (computedMessage) {
    browser.runtime.sendMessage({
      action: message.action,
      filled: totalFilled,
      total: totalFields,
      message: computedMessage || message.message,
      sessionId: currentSessionId
    }).catch(error => {
      console.error("Error sending message to popup:", error);
    });
  }
});
