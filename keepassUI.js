// KeePass Credential Picker UI
// Shows icons next to credential fields with a dropdown to select from multiple entries

(function() {
    'use strict';

    const ICON_SIZE = 20;
    const ICON_OFFSET = 4; // Gap between icon and field edge
    let activeDropdown = null;
    let credentialFields = { username: null, password: null };
    let cachedEntries = [];
    let iconsInjected = false;

    // Get the extension's icon URL
    function getIconUrl() {
        return browser.runtime.getURL('icons/icon16.png');
    }

    // Check if an element is a username/email field
    function isUsernameField(el) {
        const type = (el.type || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const autocomplete = (el.autocomplete || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();

        if (type === 'email') return true;
        if (autocomplete === 'username' || autocomplete === 'email') return true;
        if (/username|user.?name|login|userid|user.?id|email|e.?mail|account/.test(name + id + placeholder)) return true;

        return false;
    }

    // Check if an element is a password field
    function isPasswordField(el) {
        const type = (el.type || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const id = (el.id || '').toLowerCase();

        if (type === 'password') return true;
        if (/passw|pwd/.test(name + id)) return true;

        return false;
    }

    // Find credential fields on the page
    function findCredentialFields() {
        const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
        let usernameField = null;
        let passwordField = null;

        for (const input of inputs) {
            // Skip invisible fields
            const rect = input.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            if (!passwordField && isPasswordField(input)) {
                passwordField = input;
            } else if (!usernameField && isUsernameField(input)) {
                usernameField = input;
            }

            // Also check for username field near password field
            if (passwordField && !usernameField) {
                // Look for text/email input before the password field
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
        }

        return { username: usernameField, password: passwordField };
    }

    // Create the KeePass icon element
    function createIcon(field, fieldType) {
        const icon = document.createElement('img');
        icon.src = getIconUrl();
        icon.className = 'keepass-picker-icon';
        icon.dataset.fieldType = fieldType;
        icon.title = 'Fill from KeePass';
        icon.style.cssText = `
            width: ${ICON_SIZE}px;
            height: ${ICON_SIZE}px;
            cursor: pointer;
            position: absolute;
            z-index: 2147483646;
            opacity: 0.8;
            transition: opacity 0.2s;
        `;

        icon.addEventListener('mouseenter', () => {
            icon.style.opacity = '1';
        });

        icon.addEventListener('mouseleave', () => {
            icon.style.opacity = '0.8';
        });

        icon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showDropdown(icon, field);
        });

        return icon;
    }

    // Position the icon next to the field
    function positionIcon(icon, field) {
        const rect = field.getBoundingClientRect();
        const scrollX = window.scrollX || document.documentElement.scrollLeft;
        const scrollY = window.scrollY || document.documentElement.scrollTop;

        // Position inside the field on the right side
        icon.style.left = `${rect.right + scrollX - ICON_SIZE - ICON_OFFSET}px`;
        icon.style.top = `${rect.top + scrollY + (rect.height - ICON_SIZE) / 2}px`;
    }

    // Create and show the dropdown menu
    function showDropdown(icon, field) {
        // Close any existing dropdown
        closeDropdown();

        if (cachedEntries.length === 0) {
            console.log('[KeePassUI] No entries to show');
            return;
        }

        const dropdown = document.createElement('div');
        dropdown.className = 'keepass-picker-dropdown';
        dropdown.style.cssText = `
            position: absolute;
            z-index: 2147483647;
            background: #fff;
            border: 1px solid #ccc;
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            min-width: 200px;
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
        header.textContent = 'KeePass Credentials';
        dropdown.appendChild(header);

        // Entry list
        for (const entry of cachedEntries) {
            const item = document.createElement('div');
            item.className = 'keepass-picker-item';
            item.style.cssText = `
                padding: 10px 12px;
                cursor: pointer;
                border-bottom: 1px solid #f0f0f0;
                transition: background 0.15s;
            `;

            const name = document.createElement('div');
            name.style.cssText = 'font-weight: 500; color: #333; margin-bottom: 2px;';
            name.textContent = entry.name || 'Unnamed Entry';

            const details = document.createElement('div');
            details.style.cssText = 'font-size: 11px; color: #888;';
            const username = entry.login || '';
            const url = entry.url || '';
            details.textContent = username + (url ? ` - ${url}` : '');

            item.appendChild(name);
            if (username || url) {
                item.appendChild(details);
            }

            item.addEventListener('mouseenter', () => {
                item.style.background = '#e8f4fc';
            });

            item.addEventListener('mouseleave', () => {
                item.style.background = '';
            });

            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fillCredentials(entry);
                closeDropdown();
            });

            dropdown.appendChild(item);
        }

        document.body.appendChild(dropdown);
        activeDropdown = dropdown;

        // Position dropdown below the icon
        const iconRect = icon.getBoundingClientRect();
        const scrollX = window.scrollX || document.documentElement.scrollLeft;
        const scrollY = window.scrollY || document.documentElement.scrollTop;

        dropdown.style.left = `${iconRect.left + scrollX - dropdown.offsetWidth + ICON_SIZE}px`;
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
        setTimeout(() => {
            document.addEventListener('click', handleClickOutside);
        }, 0);
    }

    function handleClickOutside(e) {
        if (activeDropdown && !activeDropdown.contains(e.target) && !e.target.classList.contains('keepass-picker-icon')) {
            closeDropdown();
        }
    }

    function closeDropdown() {
        if (activeDropdown) {
            activeDropdown.remove();
            activeDropdown = null;
            document.removeEventListener('click', handleClickOutside);
        }
    }

    // Fill the credentials into the fields
    async function fillCredentials(entry) {
        console.log('[KeePassUI] Filling credentials:', entry.name);

        if (credentialFields.username && entry.login) {
            await fillField(credentialFields.username, entry.login);
        }

        if (credentialFields.password && entry.password) {
            await fillField(credentialFields.password, entry.password);
        }
    }

    // Fill a single field with realistic events
    async function fillField(field, value) {
        // Focus the field
        field.focus();
        await sleep(50);

        // Clear existing value
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));

        // Set the value
        field.value = value;

        // Dispatch events
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));

        // Blur
        await sleep(50);
        field.blur();

        // Mark as filled
        field.setAttribute('data-keepass-filled', 'true');
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Inject icons next to credential fields
    function injectIcons() {
        // Remove any existing icons
        document.querySelectorAll('.keepass-picker-icon').forEach(el => el.remove());

        const fields = findCredentialFields();
        credentialFields = fields;

        if (!fields.username && !fields.password) {
            console.log('[KeePassUI] No credential fields found');
            return false;
        }

        // Create icons for each field
        if (fields.username) {
            const icon = createIcon(fields.username, 'username');
            document.body.appendChild(icon);
            positionIcon(icon, fields.username);

            // Update position on scroll/resize
            const updatePos = () => positionIcon(icon, fields.username);
            window.addEventListener('scroll', updatePos, { passive: true });
            window.addEventListener('resize', updatePos, { passive: true });
        }

        if (fields.password) {
            const icon = createIcon(fields.password, 'password');
            document.body.appendChild(icon);
            positionIcon(icon, fields.password);

            // Update position on scroll/resize
            const updatePos = () => positionIcon(icon, fields.password);
            window.addEventListener('scroll', updatePos, { passive: true });
            window.addEventListener('resize', updatePos, { passive: true });
        }

        return true;
    }

    // Main initialization
    async function init() {
        // Check if KeePass is available and has entries for this URL
        try {
            const status = await browser.runtime.sendMessage({ action: 'keepass-status' });
            if (!status.connected || !status.associated) {
                console.log('[KeePassUI] KeePass not connected/unlocked');
                return;
            }

            const result = await browser.runtime.sendMessage({
                action: 'keepass-get-logins',
                url: window.location.href
            });

            if (!result.success || !result.entries || result.entries.length === 0) {
                console.log('[KeePassUI] No KeePass entries for this URL');
                return;
            }

            cachedEntries = result.entries;
            console.log(`[KeePassUI] Found ${cachedEntries.length} KeePass entries for this URL`);

            // Inject icons
            if (injectIcons()) {
                iconsInjected = true;
                console.log('[KeePassUI] Icons injected');
            }

        } catch (err) {
            console.log('[KeePassUI] Error:', err.message);
        }
    }

    // Run on page load and also observe for dynamically added forms
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Re-check when page content changes significantly (SPA navigation, dynamic forms)
    let initTimeout = null;
    const observer = new MutationObserver((mutations) => {
        // Debounce
        if (initTimeout) clearTimeout(initTimeout);
        initTimeout = setTimeout(() => {
            // Check if we need to re-inject (fields might have changed)
            const fields = findCredentialFields();
            const hasFields = fields.username || fields.password;
            const iconsExist = document.querySelector('.keepass-picker-icon');

            if (hasFields && !iconsExist && cachedEntries.length > 0) {
                injectIcons();
            } else if (iconsExist) {
                // Update positions in case fields moved
                document.querySelectorAll('.keepass-picker-icon').forEach(icon => {
                    const fieldType = icon.dataset.fieldType;
                    const field = fieldType === 'password' ? credentialFields.password : credentialFields.username;
                    if (field) {
                        positionIcon(icon, field);
                    }
                });
            }
        }, 500);
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Clean up icons if they become orphaned (field removed)
    setInterval(() => {
        document.querySelectorAll('.keepass-picker-icon').forEach(icon => {
            const fieldType = icon.dataset.fieldType;
            const field = fieldType === 'password' ? credentialFields.password : credentialFields.username;
            if (!field || !document.body.contains(field)) {
                icon.remove();
            }
        });
    }, 2000);

})();
