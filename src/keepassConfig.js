// KeePassXC Configuration Popup Logic

document.addEventListener('DOMContentLoaded', () => {
    const databasePathInput = document.getElementById('keepassDatabasePath');
    const browseBtn = document.getElementById('browseDatabaseBtn');
    const passwordInput = document.getElementById('keepassMasterPassword');
    const unlockBtn = document.getElementById('keepassUnlock');
    const lockBtn = document.getElementById('keepassLock');
    const testBtn = document.getElementById('keepassTest');
    const statusSpan = document.getElementById('keepassStatus');
    const logMsg = document.getElementById('logMsg');

    function log(message) {
        const timestamp = new Date().toLocaleTimeString();
        logMsg.textContent = `[${timestamp}] ${message}\n` + logMsg.textContent;
    }

    function setStatus(text, color) {
        statusSpan.textContent = text;
        statusSpan.style.color = color || '#000';
    }

    function updateButtons(hasPath, isUnlocked) {
        unlockBtn.disabled = !hasPath || isUnlocked;
        lockBtn.disabled = !isUnlocked;
        testBtn.disabled = !hasPath;  // Enable test if we have a path (will auto-unlock)

        if (isUnlocked) {
            setStatus('Unlocked', '#008000');
        } else if (hasPath) {
            setStatus('Locked', '#808000');
        } else {
            setStatus('No database selected', '#800000');
        }
    }

    // Check initial status
    browser.runtime.sendMessage({ action: 'keepass-status' }).then(status => {
        if (status.databasePath) {
            databasePathInput.value = status.databasePath;
        }
        updateButtons(status.connected, status.associated);
        if (status.associated) {
            log('Database is unlocked.');
        } else if (status.connected) {
            log('Database path set. Enter password to unlock.');
        }
    });

    // Browse for database file
    browseBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.kdbx';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // For local files, we need to use a file:// URL
            // But file input doesn't give us the full path for security reasons
            // We'll read the file content and store it as a data URL or blob URL

            log(`Selected: ${file.name}`);

            try {
                const arrayBuffer = await file.arrayBuffer();
                // Store the file content as a blob URL
                const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
                const blobUrl = URL.createObjectURL(blob);

                // Store the blob data in extension storage for persistence
                const base64 = await arrayBufferToBase64(arrayBuffer);
                await browser.storage.local.set({
                    keepassDatabaseData: base64,
                    keepassDatabaseName: file.name
                });

                databasePathInput.value = file.name;
                await browser.runtime.sendMessage({
                    action: 'keepass-set-database',
                    path: 'storage:' + file.name  // Special marker for stored data
                });

                log(`Database "${file.name}" loaded and saved.`);
                updateButtons(true, false);
            } catch (err) {
                log('Error loading file: ' + err.message);
            }
        };

        input.click();
    });

    // Unlock database
    unlockBtn.addEventListener('click', async () => {
        const password = passwordInput.value;
        if (!password) {
            log('Please enter the master password.');
            return;
        }

        log('Unlocking database...');
        unlockBtn.disabled = true;

        try {
            const result = await browser.runtime.sendMessage({
                action: 'keepass-unlock',
                password: password
            });

            if (result.success) {
                log('Database unlocked successfully!');
                passwordInput.value = '';  // Clear password from input
                updateButtons(true, true);
            } else {
                throw new Error(result.error || 'Failed to unlock');
            }
        } catch (err) {
            log('Error: ' + err.message);
            updateButtons(true, false);
        }
    });

    // Allow Enter key to unlock
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            unlockBtn.click();
        }
    });

    // Lock database
    lockBtn.addEventListener('click', () => {
        browser.runtime.sendMessage({ action: 'keepass-lock' });
        log('Database locked.');
        updateButtons(true, false);
    });

    // Test lookup
    testBtn.addEventListener('click', async () => {
        // Check if database is unlocked, try to unlock if password is entered
        const status = await browser.runtime.sendMessage({ action: 'keepass-status' });

        if (!status.associated) {
            const password = passwordInput.value;
            if (!password) {
                log('Please enter your master password first.');
                passwordInput.focus();
                return;
            }

            // Try to unlock first
            log('Unlocking database...');
            try {
                const unlockResult = await browser.runtime.sendMessage({
                    action: 'keepass-unlock',
                    password: password
                });

                if (!unlockResult.success) {
                    log('Failed to unlock: ' + (unlockResult.error || 'Check your password.'));
                    return;
                }
                log('Database unlocked.');
                passwordInput.value = '';
                updateButtons(true, true);
            } catch (err) {
                log('Failed to unlock: ' + err.message);
                return;
            }
        }

        const testUrl = prompt('Enter a URL to test lookup:', 'https://github.com');
        if (!testUrl) return;

        log(`Testing lookup for: ${testUrl}`);
        try {
            const result = await browser.runtime.sendMessage({
                action: 'keepass-get-logins',
                url: testUrl
            });

            if (result.success) {
                if (result.entries.length > 0) {
                    log(`Found ${result.entries.length} entries:`);
                    result.entries.forEach((entry, i) => {
                        log(`  ${i + 1}. ${entry.name || '(no title)'} - ${entry.login}`);
                    });
                } else {
                    log('No entries found for this URL.');
                }
            } else {
                log('Lookup failed: ' + (result.error || 'unknown'));
            }
        } catch (err) {
            log('Error: ' + err.message);
        }
    });

    // Helper function
    function arrayBufferToBase64(buffer) {
        return new Promise((resolve) => {
            const blob = new Blob([buffer]);
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.readAsDataURL(blob);
        });
    }
});
