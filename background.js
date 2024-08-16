browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "performAPITest") { // got a request from the config page
    performAPITesting()
      .then(result => sendResponse(result))
      .catch(error => sendResponse(error)); 
    return true; // keep the message channel open for response
  }
});

function performAPITesting() {
  console.log("Performing API test, bg to content msg.");
  return new Promise((resolve, reject) => {
    browser.tabs.query({active: true, currentWindow: true})
      .then(tabs => {
        if (tabs.length > 0) {
          console.log("Sending message to tab:", tabs[0].id);
          return browser.tabs.sendMessage(tabs[0].id, { action: "performAPITeste" });
        } else {
          throw new Error('No active tab found');
        }
      })
      .then(response => {
        resolve(response);
      })
      .catch(error => {
        reject(error);
      });
  });
}
