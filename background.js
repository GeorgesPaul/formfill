let formFillProgress = {};
let formFillStart = null;
let totalFields = 0;

function generateLoadingBar(percentage) {
  const barLength = 10;
  const filledLength = Math.round(percentage * barLength);
  const emptyLength = barLength - filledLength;
  return '[' + '█'.repeat(filledLength) + '░'.repeat(emptyLength) + ']';
}

browser.runtime.onMessage.addListener((message, sender) => {
  switch(message.action) {
    case "fillFormStart":
      formFillProgress = {};
      formFillStart = Date.now();
      totalFields = 0;  // We'll sum this up as we receive progress from each frame
      browser.runtime.sendMessage({ 
        action: "updateStatus", 
        message: "Starting to fill form...\n" + generateLoadingBar(0) + " 0%"
      });
      break;

    case "fillFormProgress":
      if (!formFillProgress[sender.frameId]) {
        totalFields += message.total;  // Add to total fields only on first message from each frame
      }
      formFillProgress[sender.frameId] = {
        filled: message.filled,
        total: message.total
      };
      let totalFilled = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      let percentage = totalFields > 0 ? totalFilled / totalFields : 0;
      browser.runtime.sendMessage({ 
        action: "updateStatus", 
        message: `Filling form...\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%`
      });
      break;

    case "fillFormComplete":
      const duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
      let finalFilled = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      let finalPercentage = totalFields > 0 ? finalFilled / totalFields : 0;
      browser.runtime.sendMessage({ 
        action: "updateStatus", 
        message: `Form filling complete.\n${generateLoadingBar(finalPercentage)} ${Math.round(finalPercentage * 100)}%\nFilled ${finalFilled} out of ${totalFields} fields in ${duration} seconds.`
      });
      break;

    case "fillFormError":
      browser.runtime.sendMessage({ 
        action: "updateStatus", 
        message: `Error filling form: ${message.error}`
      });
      break;
  }
});