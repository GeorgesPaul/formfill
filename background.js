// // background.js

// function runBackgroundTest() {
//   console.log("Running API test from background script...");
//   if (typeof ApiUtils !== 'undefined' && ApiUtils.testAPI) {
//     ApiUtils.testAPI().then(result => {
//       console.log("Background API test result:", result);
//     }).catch(error => {
//       console.error("Background API test error:", error);
//     });
//   } else {
//     console.error("ApiUtils is not defined in the background script context");
//   }
// }

// // Run the test every 6 seconds
// setInterval(runBackgroundTest, 6000);

// // Run once immediately
// runBackgroundTest();