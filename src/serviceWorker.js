// Chrome MV3 entry point. Firefox (MV2) loads the same files as a persistent
// background page via the manifest's `background.scripts` array instead.
//
// Everything here is classic (non-module) script so importScripts works and the
// shared files stay identical between the two browsers.
importScripts(
    'browserCompat.js',
    'apiUtils.js',
    'lib/kdbxweb.min.js',
    'keepassClient.js',
    'background.js'
);

// Chrome has no sidebar_action. The side panel is the equivalent, and this
// makes clicking the toolbar icon open it (Firefox opens the sidebar itself).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
        .catch(err => console.warn('[SW] setPanelBehavior failed:', err));
}
