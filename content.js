// Event listeners
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Content script received message:", message);

  if (message.action === "fillForm") {
    console.log("Filling form with profiles:", message.profiles || message.profile);

    // Handle both new format (profiles array) and old format (single profile)
    let profilesToUse = [];
    if (message.profiles) {
      // New format: array of profiles
      profilesToUse = message.profiles;
    } else if (message.profile) {
      // Old format: single profile, wrap in array for consistency
      profilesToUse = [message.profile];
    } else {
      console.error("No profile data received");
      sendResponse({ status: "error", message: "No profile data received" });
      return true;
    }

    if (message.useVisualProcessing && message.screenshot) {
      // Visual processing only makes sense in the top frame (screenshot is of the main page)
      if (window.self !== window.top) {
        // Iframe: fall back to non-visual filling (handles cross-origin iframe forms)
        console.log("[Content] Iframe detected with visual processing enabled - using non-visual fallback");
        fillForm(profilesToUse, message.customPrompt, message.sessionId).then(result => {
          sendResponse(result);
        }).catch(error => {
          sendResponse({ status: "error", message: error.toString() });
        });
        return true;
      }
      console.log("Using merged visual + source analysis pipeline...");
      mergedFillForm(message.screenshot, profilesToUse, message.customPrompt, message.sessionId).then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({ status: "error", message: error.toString() });
      });
    } else {
      fillForm(profilesToUse, message.customPrompt, message.sessionId).then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({ status: "error", message: error.toString() });
      });
    }

    return true; // Indicate that we will send a response asynchronously
  }

  if (message.action === "fillCredentials") {
    console.log("[Content] Filling credentials from KeePass...");
    fillCredentialsOnly(message.sessionId).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ status: "error", message: error.toString() });
    });
    return true;
  }

  if (message.action === "stopFilling") {
    console.log("Stopping form filling...");
    window.stopFilling = true;
    window.currentFillSessionId = null; // Invalidate session so isCancelled() triggers
    if (window.abortController) {
      window.abortController.abort();
    }
    // Clean up visual processor overlay if present
    if (typeof removeOverlay === 'function') {
      removeOverlay();
    }
    // Clean up KeePass picker if present
    if (typeof removeKeePassPicker === 'function') {
      removeKeePassPicker();
    }
    sendResponse({ status: "stopped" });
    return true;
  }
});

// Fill only credentials from KeePass (username and password fields)
async function fillCredentialsOnly(sessionId) {
  window.currentFillSessionId = sessionId;
  window.stopFilling = false;

  // Store credential fields globally for the picker
  window.keepassCredentialFields = { username: null, password: null };
  window.keepassEntries = [];

  function isCancelled() {
    return window.stopFilling || window.currentFillSessionId !== sessionId;
  }

  try {
    browser.runtime.sendMessage({ action: "fillFormStart", sessionId: sessionId });
    browser.runtime.sendMessage({
      action: "fillFormProgress",
      processed: 0, filled: 0, total: 2,
      message: "Looking for credential fields...",
      sessionId: sessionId
    });

    // Find credential fields
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

    // If we found password but not username, look for text/email input before it
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
      browser.runtime.sendMessage({
        action: "fillFormComplete",
        filled: 0, total: 0,
        message: "No credential fields found on this page.",
        sessionId: sessionId
      });
      return { status: "success", message: "No credential fields found." };
    }

    window.keepassCredentialFields = { username: usernameField, password: passwordField };

    if (isCancelled()) throw new Error("Credential filling stopped by user.");

    browser.runtime.sendMessage({
      action: "fillFormProgress",
      processed: 1, filled: 0, total: 2,
      message: "Querying KeePass for credentials...",
      sessionId: sessionId
    });

    // Query KeePass
    const keepassResult = await browser.runtime.sendMessage({
      action: "keepass-get-logins",
      url: window.location.href
    });

    if (!keepassResult.success || !keepassResult.entries || keepassResult.entries.length === 0) {
      browser.runtime.sendMessage({
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
    console.log(`[Content] Found ${entries.length} KeePass entries for this site`);

    // If single match, auto-fill. If multiple matches, show picker.
    if (entries.length === 1) {
      const filledCount = fillCredentialEntry(entries[0], usernameField, passwordField);
      browser.runtime.sendMessage({
        action: "fillFormComplete",
        filled: filledCount,
        total: (usernameField ? 1 : 0) + (passwordField ? 1 : 0),
        message: `Filled ${filledCount} credential field(s) from KeePass.`,
        sessionId: sessionId
      });
      return { status: "success", message: `Filled ${filledCount} credential field(s).` };
    } else {
      // Multiple matches - show picker icon
      showKeePassPicker(entries, usernameField, passwordField, sessionId);
      browser.runtime.sendMessage({
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
      browser.runtime.sendMessage({
        action: "fillFormStopped",
        filled: 0, processed: 0, total: 0,
        message: "Credential filling stopped by user.",
        sessionId: sessionId
      });
      window.stopFilling = false;
    } else {
      browser.runtime.sendMessage({
        action: "fillFormError",
        error: error.toString(),
        sessionId: sessionId
      });
    }

    return { status: "error", message: error.toString() };
  }
}

// Fill credentials from a single entry
function fillCredentialEntry(entry, usernameField, passwordField) {
  let filledCount = 0;

  if (usernameField && entry.login) {
    usernameField.focus();
    usernameField.value = entry.login;
    usernameField.dispatchEvent(new Event('input', { bubbles: true }));
    usernameField.dispatchEvent(new Event('change', { bubbles: true }));
    usernameField.setAttribute('data-filled-by-extension', 'true');
    filledCount++;
  }

  if (passwordField && entry.password) {
    passwordField.focus();
    passwordField.value = entry.password;
    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
    passwordField.dispatchEvent(new Event('change', { bubbles: true }));
    passwordField.setAttribute('data-filled-by-extension', 'true');
    filledCount++;
  }

  // Click outside to trigger validation
  document.body.click();
  console.log(`[Content] Filled ${filledCount} credential field(s) from entry: ${entry.name}`);
  return filledCount;
}

// Show KeePass picker icon next to credential fields
function showKeePassPicker(entries, usernameField, passwordField, sessionId) {
  // Remove any existing picker
  removeKeePassPicker();

  const iconUrl = browser.runtime.getURL('icons/icon16.png');
  const targetField = usernameField || passwordField;
  if (!targetField) return;

  // Create picker icon
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

  // Position icon to the right of the field (left side of icon aligns with right side of field)
  function positionIcon() {
    const rect = targetField.getBoundingClientRect();
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    icon.style.left = `${rect.right + scrollX + 4}px`;
    icon.style.top = `${rect.top + scrollY + (rect.height - 24) / 2}px`;
  }

  positionIcon();
  document.body.appendChild(icon);

  // Update position on scroll/resize
  window.addEventListener('scroll', positionIcon, { passive: true });
  window.addEventListener('resize', positionIcon, { passive: true });

  // Store cleanup function
  window.keepassPickerCleanup = () => {
    window.removeEventListener('scroll', positionIcon);
    window.removeEventListener('resize', positionIcon);
  };

  // Handle icon hover
  icon.addEventListener('mouseenter', () => { icon.style.opacity = '1'; });
  icon.addEventListener('mouseleave', () => { icon.style.opacity = '0.9'; });

  // Handle icon click - show dropdown
  icon.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showKeePassDropdown(entries, usernameField, passwordField, icon);
  });
}

// Show dropdown menu with KeePass entries
function showKeePassDropdown(entries, usernameField, passwordField, icon) {
  // Remove existing dropdown
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

  // Header
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

  // Entry list
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

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillCredentialEntry(entry, usernameField, passwordField);
      removeKeePassPicker();
    });

    dropdown.appendChild(item);
  }

  document.body.appendChild(dropdown);

  // Position dropdown below icon
  const iconRect = icon.getBoundingClientRect();
  const scrollX = window.scrollX || document.documentElement.scrollLeft;
  const scrollY = window.scrollY || document.documentElement.scrollTop;
  dropdown.style.left = `${iconRect.right + scrollX - dropdown.offsetWidth}px`;
  dropdown.style.top = `${iconRect.bottom + scrollY + 4}px`;

  // Adjust if off-screen
  const dropdownRect = dropdown.getBoundingClientRect();
  if (dropdownRect.right > window.innerWidth) {
    dropdown.style.left = `${window.innerWidth - dropdownRect.width - 10 + scrollX}px`;
  }
  if (dropdownRect.left < 0) {
    dropdown.style.left = `${10 + scrollX}px`;
  }

  // Close on click outside
  function handleClickOutside(e) {
    if (!dropdown.contains(e.target) && e.target.id !== 'keepass-picker-icon') {
      dropdown.remove();
      document.removeEventListener('click', handleClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
}

// Remove KeePass picker icon and dropdown
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