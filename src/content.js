// content.js -- the page side's switchboard.
//
// Runs in every frame. Takes the panel's (or the context menu's) requests and
// hands them to the module that does the work:
//
//   fillForm         -> FillAgent.run        (fillAgent.js: look, act, look again)
//   fillCredentials  -> CredentialFill.run   (credentialFill.js: KeePass user name and password)
//   stopFilling      -> stop whatever is running in this frame

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fillForm') {
    const profiles = message.profiles || (message.profile ? [message.profile] : []);
    FillAgent.run({
      profiles,
      customPrompt: message.customPrompt || '',
      sessionId: message.sessionId,
      vision: !!message.useVisualProcessing && window === window.top,
    }).then(sendResponse, error => {
      // Failed before it started filling: this frame no longer counts.
      Compat.notify({ action: 'fillFormLeave', sessionId: message.sessionId });
      sendResponse({ status: 'error', message: String(error) });
    });
    return true;
  }

  if (message.action === 'fillCredentials') {
    CredentialFill.run(message.sessionId).then(sendResponse, error => sendResponse({ status: 'error', message: String(error) }));
    return true;
  }

  if (message.action === 'stopFilling') {
    FillAgent.stop();
    CredentialFill.stop();
    Hands.dropTurn();
    OverlayUtils.clearAll();
    sendResponse({ status: 'stopped' });
    return true;
  }
});

// Leaving the page in the middle of a fill: tell the panel, so it stops
// waiting, and hand back this frame's turn at the keyboard.
window.addEventListener('pagehide', () => {
  const sessionId = FillAgent.sessionId() || CredentialFill.sessionId();
  if (!sessionId) return;
  Hands.dropTurn();
  Compat.notify({ action: 'fillFormComplete', filled: 0, total: 0, message: 'Page navigated during fill.', sessionId });
});
