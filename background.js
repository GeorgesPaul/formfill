let formFillProgress = {};
let formFillStart = null;
let totalFields = 0;

function generateLoadingBar(percentage) {
  const barLength = 20;
  const filledLength = Math.round(percentage * barLength);
  const emptyLength = barLength - filledLength;
  return '[' + '█'.repeat(filledLength) + '░'.repeat(emptyLength) + ']';
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let computedMessage = '';
  let totalFilled = 0;
  let percentage = 0;

  switch(message.action) {
    case "fillFormStart":
      formFillProgress = {};
      formFillStart = Date.now();
      totalFields = 0;
      computedMessage = "Starting to fill form...\n" + generateLoadingBar(0) + " 0%";
      break;

    case "fillFormProgress":
      if (!formFillProgress[sender.frameId]) {
        totalFields += message.total;
        formFillProgress[sender.frameId] = {
          filled: message.filled,
          total: message.total
        };
      } else {
        // If total has changed (e.g., due to bug or dynamic forms), adjust
        if (formFillProgress[sender.frameId].total !== message.total) {
          totalFields -= formFillProgress[sender.frameId].total;
          totalFields += message.total;
        }
        formFillProgress[sender.frameId].filled = message.filled;
        formFillProgress[sender.frameId].total = message.total;
      }
      totalFilled = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      percentage = totalFields > 0 ? totalFilled / totalFields : 0;
      computedMessage = `Filling form...\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%`;
    break;

    case "fillFormComplete":
      const duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
      totalFilled = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      percentage = totalFields > 0 ? totalFilled / totalFields : 0;
      computedMessage = `Form filling complete.\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%\nFilled ${totalFilled} out of ${totalFields} fields in ${duration} seconds.`;
      break;

    case "fillFormError":
      computedMessage = `Error filling form: ${message.error}`;
      break;
  }

  // Forward the original action to the popup, including computed message and data
  if (computedMessage) {
    browser.runtime.sendMessage({
      action: message.action,  // Keep the original action (e.g., "fillFormProgress")
      filled: totalFilled,
      total: totalFields,
      message: computedMessage || message.message
    }).catch(error => {
      console.error("Error sending message to popup:", error);
    });
  }
});