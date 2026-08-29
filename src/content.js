// content.js -- message router for the page side.
// ff:logs:start
//
// In development builds it also keeps watching the page AFTER a fill: submit
// capture (what the form held when the user pressed the button, and what the
// browser packed into FormData), network bodies relayed from pageHook.js, and
// the page that followed. Store builds are packaged without all of that.
// ff:logs:end

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fillForm") {
    let profilesToUse = [];
    if (message.profiles) profilesToUse = message.profiles;
    else if (message.profile) profilesToUse = [message.profile];
    else {
      sendResponse({ status: "error", message: "No profile data received" });
      return true;
    }
    installPostFillWatchers();
    FillAgent.run({
      profiles: profilesToUse,
      customPrompt: message.customPrompt || '',
      sessionId: message.sessionId,
      vision: !!message.useVisualProcessing && window === window.top,
    }).then(result => sendResponse(result))
      .catch(error => sendResponse({ status: "error", message: error.toString() }));
    return true;
  }

  if (message.action === "fillCredentials") {
    fillCredentialsOnly(message.sessionId).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ status: "error", message: error.toString() });
    });
    return true;
  }

  if (message.action === "stopFilling") {
    window.stopFilling = true;
    window.currentFillSessionId = null;
    if (window.abortController) {
      try { window.abortController.abort(); } catch (_) {}
    }
    if (typeof OverlayUtils !== 'undefined') OverlayUtils.clearAll();
    if (typeof removeKeePassPicker === 'function') removeKeePassPicker();
    sendResponse({ status: "stopped" });
    return true;
  }

  if (message.action === "ffSnapshot") {
    // Debug helper: the panel (or a test) can ask what this frame sees.
    try { sendResponse({ snapshot: FormKit.snapshot() }); } catch (e) { sendResponse({ error: String(e) }); }
    return true;
  }
});

// ---------------------------------------------------------------------------
// Post-fill watchers: record what actually gets submitted.
// ---------------------------------------------------------------------------
let postFillWatchersInstalled = false;
let lastCaptureAt = { };

function installPostFillWatchers() {
  if (postFillWatchersInstalled) return;
  postFillWatchersInstalled = true;

  // Leaving the page mid-fill: tell the panel, so it stops waiting.
  window.addEventListener('pagehide', () => {
    try {
      if (window.currentFillSessionId) {
        Compat.notify({ action: 'fillFormComplete', filled: 0, total: 0, message: 'Page navigated during fill.', sessionId: window.currentFillSessionId });
      }
      // ff:logs:start
      if (typeof FillLogger !== 'undefined' && FillLogger.hasSession()) {
        FillLogger.event('pagehide', { url: location.href, values: FormKit.valuesSnapshot() });
        try { sessionStorage.setItem('ff-post-submit-pending', JSON.stringify({ sessionId: FillLogger.lastSessionId(), from: location.href, t: Date.now() })); } catch (_) {}
      }
      // ff:logs:end
    } catch (_) {}
  });

  // Everything below only exists to record what was submitted (fill logs).
  // ff:logs:start
  const SUBMITTISH = /\b(submit|send|pay|order|buy|purchase|register|sign ?up|create|confirm|book|checkout|apply|save|finish|complete|continue|next|proceed|verstuur|verzend|bestel|betaal|opslaan|bevestig|verder|volgende|abschicken|senden|bestellen|zahlen|weiter|speichern|envoyer|payer|commander|suivant|valider)\b/i;

  // Native form submission: this is exactly what the browser sends.
  document.addEventListener('submit', (e) => {
    try {
      const form = e.target && e.target.tagName === 'FORM' ? e.target : null;
      captureSubmission('submit-event', {
        formAction: form ? form.action : undefined,
        formMethod: form ? form.method : undefined,
        formData: form ? FormKit.formDataOf(form) : undefined,
        defaultPrevented: e.defaultPrevented,
      });
    } catch (_) {}
  }, true);

  // Clicks on anything that looks like a submit/next button (JS-driven forms
  // never fire a submit event).
  document.addEventListener('click', (e) => {
    try {
      const el = e.target && e.target.closest ? e.target.closest('button, input[type="submit"], input[type="button"], [role="button"], a') : null;
      if (!el) return;
      const text = (el.tagName === 'INPUT' ? el.value : (el.textContent || el.getAttribute('aria-label') || '')).trim().slice(0, 80);
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type !== 'submit' && !SUBMITTISH.test(text)) return;
      const form = el.form || (el.closest ? el.closest('form') : null);
      captureSubmission('button-click', {
        button: text, buttonType: type,
        formAction: form ? form.action : undefined,
        formData: form ? FormKit.formDataOf(form) : undefined,
      });
    } catch (_) {}
  }, true);

  // Enter in a field.
  document.addEventListener('keydown', (e) => {
    try {
      if (e.key !== 'Enter') return;
      const el = e.target;
      if (!el || !el.matches || !el.matches('input, [role="textbox"], [role="combobox"]')) return;
      const form = el.form || (el.closest ? el.closest('form') : null);
      captureSubmission('enter-key', { field: el.getAttribute('data-ff-ref') || el.name || el.id, formData: form ? FormKit.formDataOf(form) : undefined });
    } catch (_) {}
  }, true);

  // Request bodies, relayed from the page world (see pageHook.js).
  document.addEventListener('ff-net-capture', (e) => {
    try {
      if (typeof FillLogger === 'undefined' || !FillLogger.hasSession()) return;
      const rec = JSON.parse(e.detail);
      FillLogger.event('networkSubmit', rec);
    } catch (_) {}
  });

  // ff:logs:end
}

// ff:logs:start
function captureSubmission(trigger, extra) {
  if (typeof FillLogger === 'undefined' || !FillLogger.hasSession()) return;
  const now = Date.now();
  // Dedupe rapid repeats of the SAME trigger only; a submit event right after
  // a button click is kept, because it carries the authoritative FormData.
  if (now - (lastCaptureAt[trigger] || 0) < 300) return;
  lastCaptureAt[trigger] = now;
  FillLogger.event('submitCapture', { trigger, url: location.href, values: FormKit.valuesSnapshot(), ...extra });
}

// A previous page in this tab was submitted after a fill: record where we
// landed and what the page says (errors / success), then stop.
(function logPostSubmitPage() {
  try {
    const raw = sessionStorage.getItem('ff-post-submit-pending');
    if (!raw) return;
    sessionStorage.removeItem('ff-post-submit-pending');
    const pending = JSON.parse(raw);
    if (!pending || !pending.sessionId || Date.now() - pending.t > 10 * 60 * 1000) return;
    const collect = () => {
      const texts = [];
      try {
        const cands = document.querySelectorAll('[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [class*="success" i], [class*="thank" i], [class*="confirm" i], [class*="danger" i], [class*="warning" i], h1, h2');
        for (const c of cands) {
          const t = (c.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && t.length <= 300 && AccName.visible(c)) texts.push(t);
          if (texts.length >= 25) break;
        }
      } catch (_) {}
      let values = [];
      try { values = FormKit.valuesSnapshot(); } catch (_) {}
      try { sessionStorage.setItem('ff-last-session', pending.sessionId); } catch (_) {}
      FillLogger.event('postSubmitPage', { from: pending.from, url: location.href, title: document.title, texts, fieldsOnNewPage: values.length, values: values.slice(0, 60) });
    };
    if (document.readyState === 'complete') setTimeout(collect, 800);
    else window.addEventListener('load', () => setTimeout(collect, 800), { once: true });
  } catch (_) {}
})();
// ff:logs:end

// ---------------------------------------------------------------------------
// KeePass credential fill (unchanged behaviour: typed, never assigned).
// ---------------------------------------------------------------------------
async function fillCredentialsOnly(sessionId) {
  window.currentFillSessionId = sessionId;
  window.stopFilling = false;

  window.keepassCredentialFields = { username: null, password: null };
  window.keepassEntries = [];

  function isCancelled() {
    return window.stopFilling || window.currentFillSessionId !== sessionId;
  }

  try {
    Compat.notify({ action: "fillFormStart", sessionId: sessionId });
    Compat.notify({
      action: "fillFormProgress",
      processed: 0, filled: 0, total: 2,
      message: "Looking for credential fields...",
      sessionId: sessionId
    });

    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
    let usernameField = null;
    let passwordField = null;

    for (const input of inputs) {
      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(input);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      if (!passwordField && isPasswordField({ type: input.type, name: input.name, id: input.id })) {
        passwordField = input;
      } else if (!usernameField && isUsernameField({
        type: input.type,
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        autocomplete: input.autocomplete
      })) {
        usernameField = input;
      }
    }

    if (passwordField && !usernameField) {
      const allInputs = Array.from(inputs);
      const pwIndex = allInputs.indexOf(passwordField);
      for (let i = pwIndex - 1; i >= 0 && i >= pwIndex - 3; i--) {
        const inp = allInputs[i];
        const t = (inp.type || 'text').toLowerCase();
        if (t === 'text' || t === 'email') {
          usernameField = inp;
          break;
        }
      }
    }

    if (!usernameField && !passwordField) {
      Compat.notify({
        action: "fillFormComplete",
        filled: 0, total: 0,
        message: "No credential fields found on this page.",
        sessionId: sessionId
      });
      return { status: "success", message: "No credential fields found." };
    }

    window.keepassCredentialFields = { username: usernameField, password: passwordField };

    if (isCancelled()) throw new Error("Credential filling stopped by user.");

    Compat.notify({
      action: "fillFormProgress",
      processed: 1, filled: 0, total: 2,
      message: "Querying KeePass for credentials...",
      sessionId: sessionId
    });

    const keepassResult = await browser.runtime.sendMessage({
      action: "keepass-get-logins",
      url: window.location.href
    });

    if (!keepassResult.success || !keepassResult.entries || keepassResult.entries.length === 0) {
      Compat.notify({
        action: "fillFormComplete",
        filled: 0, total: (usernameField ? 1 : 0) + (passwordField ? 1 : 0),
        message: "No KeePass entries found for this site.",
        sessionId: sessionId
      });
      return { status: "success", message: "No KeePass entries found." };
    }

    if (isCancelled()) throw new Error("Credential filling stopped by user.");

    const entries = keepassResult.entries;
    window.keepassEntries = entries;

    if (entries.length === 1) {
      const filledCount = await fillCredentialEntry(entries[0], usernameField, passwordField);
      Compat.notify({
        action: "fillFormComplete",
        filled: filledCount,
        total: (usernameField ? 1 : 0) + (passwordField ? 1 : 0),
        message: `Filled ${filledCount} credential field(s) from KeePass.`,
        sessionId: sessionId
      });
      return { status: "success", message: `Filled ${filledCount} credential field(s).` };
    } else {
      showKeePassPicker(entries, usernameField, passwordField, sessionId);
      Compat.notify({
        action: "fillFormComplete",
        filled: 0,
        total: (usernameField ? 1 : 0) + (passwordField ? 1 : 0),
        message: `Found ${entries.length} KeePass entries. Click the icon to select.`,
        sessionId: sessionId
      });
      return { status: "success", message: `Found ${entries.length} entries. Select from picker.` };
    }

  } catch (error) {
    console.error('[Content] Credential fill error:', error);

    if (error.message.includes("stopped by user")) {
      Compat.notify({
        action: "fillFormStopped",
        filled: 0, processed: 0, total: 0,
        message: "Credential filling stopped by user.",
        sessionId: sessionId
      });
      window.stopFilling = false;
    } else {
      Compat.notify({
        action: "fillFormError",
        error: error.toString(),
        sessionId: sessionId
      });
    }

    return { status: "error", message: error.toString() };
  }
}

// Typed, not assigned: login forms are among the strictest about wanting real
// keystrokes, and an assigned password often leaves the submit button disabled.
async function fillCredentialEntry(entry, usernameField, passwordField) {
  let filledCount = 0;

  for (const [field, value] of [[usernameField, entry.login], [passwordField, entry.password]]) {
    if (!field || !value) continue;
    simulateRealisticFocus(field);
    await TypingEngine.typeText(field, value, { clearFirst: true });
    TypingEngine.commitField(field);
    field.setAttribute('data-filled-by-extension', 'true');
    filledCount++;
  }

  document.body.click();
  return filledCount;
}

// Show KeePass picker icon next to credential fields
function showKeePassPicker(entries, usernameField, passwordField, sessionId) {
  removeKeePassPicker();

  const iconUrl = browser.runtime.getURL('icons/icon16.png');
  const targetField = usernameField || passwordField;
  if (!targetField) return;

  const icon = document.createElement('img');
  icon.id = 'keepass-picker-icon';
  icon.src = iconUrl;
  icon.title = `${entries.length} KeePass entries found - click to select`;
  icon.style.cssText = `
    position: absolute;
    width: 20px;
    height: 20px;
    cursor: pointer;
    z-index: 2147483646;
    opacity: 0.9;
    transition: opacity 0.2s;
    background: #fff;
    border-radius: 3px;
    padding: 2px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  `;

  function positionIcon() {
    const rect = targetField.getBoundingClientRect();
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    icon.style.left = `${rect.right + scrollX + 4}px`;
    icon.style.top = `${rect.top + scrollY + (rect.height - 24) / 2}px`;
  }

  positionIcon();
  document.body.appendChild(icon);

  window.addEventListener('scroll', positionIcon, { passive: true });
  window.addEventListener('resize', positionIcon, { passive: true });

  window.keepassPickerCleanup = () => {
    window.removeEventListener('scroll', positionIcon);
    window.removeEventListener('resize', positionIcon);
  };

  icon.addEventListener('mouseenter', () => { icon.style.opacity = '1'; });
  icon.addEventListener('mouseleave', () => { icon.style.opacity = '0.9'; });

  icon.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showKeePassDropdown(entries, usernameField, passwordField, icon);
  });
}

function showKeePassDropdown(entries, usernameField, passwordField, icon) {
  const existing = document.getElementById('keepass-picker-dropdown');
  if (existing) existing.remove();

  const dropdown = document.createElement('div');
  dropdown.id = 'keepass-picker-dropdown';
  dropdown.style.cssText = `
    position: absolute;
    z-index: 2147483647;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    min-width: 220px;
    max-width: 350px;
    max-height: 300px;
    overflow-y: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    padding: 8px 12px;
    background: #f5f5f5;
    border-bottom: 1px solid #e0e0e0;
    font-weight: 600;
    color: #333;
  `;
  header.textContent = 'Select KeePass Entry';
  dropdown.appendChild(header);

  for (const entry of entries) {
    const item = document.createElement('div');
    item.style.cssText = `
      padding: 10px 12px;
      cursor: pointer;
      border-bottom: 1px solid #f0f0f0;
    `;

    const name = document.createElement('div');
    name.style.cssText = 'font-weight: 500; color: #333; margin-bottom: 2px;';
    name.textContent = entry.name || 'Unnamed Entry';

    const details = document.createElement('div');
    details.style.cssText = 'font-size: 11px; color: #888;';
    details.textContent = entry.login || entry.url || '';

    item.appendChild(name);
    if (entry.login || entry.url) item.appendChild(details);

    item.addEventListener('mouseenter', () => { item.style.background = '#e8f4fc'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });

    item.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeKeePassPicker();
      await fillCredentialEntry(entry, usernameField, passwordField);
    });

    dropdown.appendChild(item);
  }

  document.body.appendChild(dropdown);

  const iconRect = icon.getBoundingClientRect();
  const scrollX = window.scrollX || document.documentElement.scrollLeft;
  const scrollY = window.scrollY || document.documentElement.scrollTop;
  dropdown.style.left = `${iconRect.right + scrollX - dropdown.offsetWidth}px`;
  dropdown.style.top = `${iconRect.bottom + scrollY + 4}px`;

  const dropdownRect = dropdown.getBoundingClientRect();
  if (dropdownRect.right > window.innerWidth) {
    dropdown.style.left = `${window.innerWidth - dropdownRect.width - 10 + scrollX}px`;
  }
  if (dropdownRect.left < 0) {
    dropdown.style.left = `${10 + scrollX}px`;
  }

  function handleClickOutside(e) {
    if (!dropdown.contains(e.target) && e.target.id !== 'keepass-picker-icon') {
      dropdown.remove();
      document.removeEventListener('click', handleClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
}

function removeKeePassPicker() {
  const icon = document.getElementById('keepass-picker-icon');
  if (icon) icon.remove();
  const dropdown = document.getElementById('keepass-picker-dropdown');
  if (dropdown) dropdown.remove();
  if (window.keepassPickerCleanup) {
    window.keepassPickerCleanup();
    window.keepassPickerCleanup = null;
  }
}
