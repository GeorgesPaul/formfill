// credentialFill.js -- the page side of "Fill User/Pass".
//
// Finds the login fields of this frame, asks the background page for the
// KeePass entries that belong to the site, and types the chosen one in with
// the same hands the form filler uses (hands.js): login forms are among the
// strictest about wanting real keystrokes. No model is involved. With more
// than one matching entry, a small picker is shown next to the field.
const CredentialFill = (function () {
    'use strict';

    const STOPPED = 'Form filling stopped by user.';   // the same words the hands throw

    // The fill running in this frame, if any: { sessionId, stopped }.
    let current = null;
    let removePickerListeners = null;

    function stop() {
        if (current) current.stopped = true;
        removePicker();
    }

    // ------------------------------------------------------------ finding the fields

    function isPasswordField(input) {
        return input.type === 'password' || /passw|pwd/.test((input.name + input.id).toLowerCase());
    }

    function isUsernameField(input) {
        const autocomplete = (input.autocomplete || '').toLowerCase();
        if (autocomplete === 'username' || autocomplete === 'email' || input.type === 'email') return true;
        return /username|user.?name|login|userid|user.?id|email|e.?mail/.test((input.name + input.id + input.placeholder).toLowerCase());
    }

    // The first visible password field and the user name field that goes
    // with it: one that says so, else the text box just before the password.
    function findFields() {
        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'))
            .filter(input => PageView.onScreen(input));
        const password = inputs.find(isPasswordField) || null;
        let username = inputs.find(input => input !== password && !isPasswordField(input) && isUsernameField(input)) || null;
        if (password && !username) {
            const at = inputs.indexOf(password);
            username = inputs.slice(Math.max(0, at - 3), at).reverse().find(input => input.type === 'text' || input.type === 'email') || null;
        }
        return { username, password };
    }

    // ------------------------------------------------------------ filling

    async function fillEntry(entry, fields, isCancelled) {
        const actions = [[fields.username, entry.login], [fields.password, entry.password]]
            .filter(([field, value]) => field && value)
            .map(([field, value]) => ({ op: 'type', el: field, value }));
        const { results } = await Hands.run(actions, { isCancelled });
        Hands.letGo();
        return results.filter(r => r.ok).length;
    }

    async function run(sessionId) {
        const me = current = { sessionId, stopped: false };
        const notify = msg => Compat.notify({ ...msg, sessionId });
        const isCancelled = () => me.stopped || current !== me;
        const checkStopped = () => { if (isCancelled()) throw new Error(STOPPED); };
        try {
            notify({ action: 'fillFormStart' });
            notify({ action: 'fillFormProgress', processed: 0, filled: 0, total: 2, message: 'Looking for credential fields...' });

            const fields = findFields();
            const total = (fields.username ? 1 : 0) + (fields.password ? 1 : 0);
            if (!total) {
                notify({ action: 'fillFormComplete', filled: 0, total: 0, message: 'No credential fields found on this page.' });
                return { status: 'success', message: 'No credential fields found.' };
            }
            checkStopped();

            notify({ action: 'fillFormProgress', processed: 1, filled: 0, total: 2, message: 'Querying KeePass for credentials...' });
            const answer = await browser.runtime.sendMessage({ action: 'keepass-get-logins', url: location.href });
            const entries = (answer && answer.success && answer.entries) || [];
            if (!entries.length) {
                notify({ action: 'fillFormComplete', filled: 0, total, message: 'No KeePass entries found for this site.' });
                return { status: 'success', message: 'No KeePass entries found.' };
            }
            checkStopped();

            if (entries.length === 1) {
                const filled = await fillEntry(entries[0], fields, isCancelled);
                notify({ action: 'fillFormComplete', filled, total, message: `Filled ${filled} credential field(s) from KeePass.` });
                return { status: 'success', message: `Filled ${filled} credential field(s).` };
            }
            showPicker(entries, fields);
            notify({ action: 'fillFormComplete', filled: 0, total, message: `Found ${entries.length} KeePass entries. Click the icon to select.` });
            return { status: 'success', message: `Found ${entries.length} entries. Select from picker.` };
        } catch (error) {
            const text = String((error && error.message) || error);
            if (text === STOPPED) notify({ action: 'fillFormStopped', filled: 0, processed: 0, total: 0, message: STOPPED });
            else { console.error('[CredentialFill]', error); notify({ action: 'fillFormError', error: text }); }
            return { status: 'error', message: text };
        } finally {
            if (current === me) current = null;
        }
    }

    // ------------------------------------------------------------ the picker (several entries for one site)

    function showPicker(entries, fields) {
        removePicker();
        const anchor = fields.username || fields.password;

        const icon = document.createElement('img');
        icon.id = 'keepass-picker-icon';
        icon.src = browser.runtime.getURL('icons/icon16.png');
        icon.title = `${entries.length} KeePass entries found - click to select`;
        icon.style.cssText = `
            position: absolute; width: 20px; height: 20px; cursor: pointer; z-index: 2147483646;
            opacity: 0.9; transition: opacity 0.2s; background: #fff; border-radius: 3px; padding: 2px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        `;
        const place = () => {
            const rect = anchor.getBoundingClientRect();
            icon.style.left = `${rect.right + window.scrollX + 4}px`;
            icon.style.top = `${rect.top + window.scrollY + (rect.height - 24) / 2}px`;
        };
        place();
        document.body.appendChild(icon);

        window.addEventListener('scroll', place, { passive: true });
        window.addEventListener('resize', place, { passive: true });
        removePickerListeners = () => {
            window.removeEventListener('scroll', place);
            window.removeEventListener('resize', place);
        };
        icon.addEventListener('mouseenter', () => { icon.style.opacity = '1'; });
        icon.addEventListener('mouseleave', () => { icon.style.opacity = '0.9'; });
        icon.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            showDropdown(entries, fields, icon);
        });
    }

    function showDropdown(entries, fields, icon) {
        const existing = document.getElementById('keepass-picker-dropdown');
        if (existing) existing.remove();

        const dropdown = document.createElement('div');
        dropdown.id = 'keepass-picker-dropdown';
        dropdown.style.cssText = `
            position: absolute; z-index: 2147483647; background: #fff; border: 1px solid #ccc; border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2); min-width: 220px; max-width: 350px; max-height: 300px; overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'padding: 8px 12px; background: #f5f5f5; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #333;';
        header.textContent = 'Select KeePass Entry';
        dropdown.appendChild(header);

        for (const entry of entries) {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #f0f0f0;';

            const name = document.createElement('div');
            name.style.cssText = 'font-weight: 500; color: #333; margin-bottom: 2px;';
            name.textContent = entry.name || 'Unnamed Entry';
            item.appendChild(name);

            if (entry.login || entry.url) {
                const details = document.createElement('div');
                details.style.cssText = 'font-size: 11px; color: #888;';
                details.textContent = entry.login || entry.url;
                item.appendChild(details);
            }

            item.addEventListener('mouseenter', () => { item.style.background = '#e8f4fc'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
            item.addEventListener('click', async e => {
                e.preventDefault();
                e.stopPropagation();
                removePicker();
                await fillEntry(entry, fields).catch(() => {});
            });
            dropdown.appendChild(item);
        }
        document.body.appendChild(dropdown);

        // Below the icon, right-aligned to it, kept inside the window.
        const iconRect = icon.getBoundingClientRect();
        dropdown.style.left = `${iconRect.right + window.scrollX - dropdown.offsetWidth}px`;
        dropdown.style.top = `${iconRect.bottom + window.scrollY + 4}px`;
        const rect = dropdown.getBoundingClientRect();
        if (rect.right > window.innerWidth) dropdown.style.left = `${window.innerWidth - rect.width - 10 + window.scrollX}px`;
        if (rect.left < 0) dropdown.style.left = `${10 + window.scrollX}px`;

        const closeOnOutsideClick = e => {
            if (dropdown.contains(e.target) || e.target === icon) return;
            dropdown.remove();
            document.removeEventListener('click', closeOnOutsideClick);
        };
        setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 0);
    }

    function removePicker() {
        for (const id of ['keepass-picker-icon', 'keepass-picker-dropdown']) {
            const el = document.getElementById(id);
            if (el) el.remove();
        }
        if (removePickerListeners) { removePickerListeners(); removePickerListeners = null; }
    }

    return { run, stop, sessionId: () => (current ? current.sessionId : null) };
})();

if (typeof window !== 'undefined') window.CredentialFill = CredentialFill;
