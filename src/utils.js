// Global State
window.stopFilling = false;
window.abortController = null;
window.currentFillSessionId = null;

// Constants
var response_Timeout_ms = 15000;
var delay_after_dropdown_selection_ms = 100;

// Utility functions
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logToUser(message, ...args) {
    let fullMessage = message;
    if (args.length > 0) {
        fullMessage += " " + args.map(arg => {
            if (typeof arg === 'object') { // Check if arg is an object
                return JSON.stringify(arg);
            } else {
                return String(arg);
            }
        }).join(" ");
    }

    // Compat.notify, not sendMessage: nobody awaits these, and with the panel
    // closed (or a sleeping MV3 service worker) Chrome turns every one of them
    // into an unhandled promise rejection in the page console.
    Compat.notify({
        action: "updateProgress",
        message: fullMessage
    });
}

function updateFillProgress(processed, filled, total, message, sessionId = null) {
    Compat.notify({
        action: "fillFormProgress",
        processed: processed,
        filled: filled,
        total: total,
        message: message,
        sessionId: sessionId
    });
}

function generateFieldInfoString(fieldInfo) {
    let jsonObject = JSON.parse(JSON.stringify(fieldInfo));
    removeEmptyValues(jsonObject);
    return JSON.stringify(jsonObject, null, 2);
}

function removeEmptyValues(obj) {
    for (let key in obj) {
        if (obj[key] === null || obj[key] === undefined) {
            delete obj[key];
        } else if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            removeEmptyValues(obj[key]);
            if (Object.keys(obj[key]).length === 0) {
                delete obj[key];
            }
        }
    }
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
