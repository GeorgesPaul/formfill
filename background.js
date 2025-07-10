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
  let totalProcessed = 0;
  let percentage = 0;

  switch(message.action) {
    case "fillFormStart":
      formFillProgress = {};
      formFillStart = Date.now();
      totalFields = 0;
      computedMessage = "Starting to fill form...\n" + generateLoadingBar(0) + " 0%";
      break;
    case "fillFormStopped":
        const fill_duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
        totalFilled = message.filled;
        totalProcessed = message.processed || Object.values(formFillProgress).reduce((sum, progress) => sum + progress.processed, 0);
        percentage = totalFields > 0 ? totalProcessed / totalFields : 0;
        computedMessage = `Form filling stopped by user.\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%\nFilled ${totalFilled} out of ${totalFields} fields in ${fill_duration} seconds.`;
      break;
    case "fillFormProgress":
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

    case "fillFormComplete":
      const duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
      totalFilled = message.filled || Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      percentage = 1;
      computedMessage = `Form processing complete.\n${generateLoadingBar(1)} 100%\nFilled ${totalFilled} out of ${message.total || totalFields} fields in ${duration} seconds.`;
      break;

    case "fillFormError":
      computedMessage = `Error filling form: ${message.error || "undefined"}`;
      break;
  }

  if (computedMessage) {
    browser.runtime.sendMessage({
      action: message.action,
      filled: totalFilled,
      total: totalFields,
      message: computedMessage || message.message
    }).catch(error => {
      console.error("Error sending message to popup:", error);
    });
  }
});