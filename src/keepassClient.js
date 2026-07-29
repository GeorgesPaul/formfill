// KeePassXC Direct KDBX Reader
// Reads credentials directly from .kdbx database files using kdbxweb library.
// Password is kept in memory only (never persisted to disk).

let masterPassword = null;  // In-memory only, cleared on browser restart
let databasePath = null;    // Stored in browser.storage.local
let cachedDatabase = null;  // Cached parsed database for performance
let cacheTimestamp = 0;
const CACHE_TTL = 60000;    // Re-read file every 60 seconds

// --- Database operations ---

async function loadDatabase() {
    if (!databasePath || !masterPassword) {
        throw new Error('Database path or password not set');
    }

    // Check cache
    if (cachedDatabase && (Date.now() - cacheTimestamp) < CACHE_TTL) {
        return cachedDatabase;
    }

    try {
        let arrayBuffer;

        // Check if database is stored in extension storage
        if (databasePath.startsWith('storage:')) {
            const stored = await browser.storage.local.get(['keepassDatabaseData']);
            if (!stored.keepassDatabaseData) {
                throw new Error('Database not found in storage. Please re-select the file.');
            }
            // Decode base64 to ArrayBuffer
            const binaryString = atob(stored.keepassDatabaseData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            arrayBuffer = bytes.buffer;
        } else {
            // Try to fetch from file:// URL (may not work due to security)
            const response = await fetch(databasePath);
            if (!response.ok) {
                throw new Error(`Failed to read database file: ${response.status} ${response.statusText}`);
            }
            arrayBuffer = await response.arrayBuffer();
        }

        // Create credentials
        const credentials = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString(masterPassword)
        );

        // Parse the database
        const db = await kdbxweb.Kdbx.load(arrayBuffer, credentials);

        cachedDatabase = db;
        cacheTimestamp = Date.now();
        console.log('[KeePass] Database loaded successfully');
        return db;
    } catch (err) {
        cachedDatabase = null;
        cacheTimestamp = 0;
        throw explainKdbxError(err);
    }
}

// kdbxweb raises terse errors ("Error InvalidKey", "Error NotImplemented:
// argon2 not implemented") that surface verbatim in the popup. Turn the two
// the user can actually hit into something actionable.
//
// On Argon2: kdbxweb ships no implementation and we deliberately do not bundle
// one. A WASM build would need separate source disclosure for AMO review and a
// CSP exception, and pure-JS Argon2 takes many seconds at KeePassXC's default
// memory cost. Databases using AES-KDF (KDBX 3.1, and KDBX4 files whose KDF was
// left at AES) work fine, which is why this has never been hit in practice.
function explainKdbxError(err) {
    const code = err && err.code;
    const message = String((err && err.message) || err);

    if (code === 'NotImplemented' && /argon2/i.test(message)) {
        return new Error(
            'This database uses the Argon2 key derivation function, which this extension cannot read. ' +
            'In KeePassXC open Database > Database Settings > Encryption and set "Key Derivation Function" ' +
            'to AES-KDF, then save. Your entries and master password stay the same.'
        );
    }
    if (code === 'InvalidKey') {
        return new Error('Wrong master password (or this file needs a key file as well).');
    }
    if (code === 'BadSignature') {
        return new Error('That file is not a KeePass database (.kdbx).');
    }
    if (code === 'FileCorrupt') {
        return new Error('The database file is truncated or corrupt. Re-select it in KeePass Config.');
    }
    return err;
}

function clearCache() {
    cachedDatabase = null;
    cacheTimestamp = 0;
}

async function unlockDatabase(password) {
    masterPassword = password;
    clearCache();

    // Try to load to verify password is correct
    try {
        await loadDatabase();
        broadcastStatusChange();
        return { success: true };
    } catch (err) {
        masterPassword = null;
        throw err;
    }
}

function lockDatabase() {
    masterPassword = null;
    clearCache();
    broadcastStatusChange();
}

// Broadcast status change to all extension pages (popup, etc.)
function broadcastStatusChange() {
    browser.runtime.sendMessage({ action: 'keepass-status-changed' }).catch(() => {
        // Ignore errors if no listeners (popup not open)
    });
}

async function getLogins(url) {
    if (!masterPassword || !databasePath) {
        return { success: false, entries: [], error: 'Database not unlocked' };
    }

    try {
        const db = await loadDatabase();
        const entries = searchEntries(db, url);
        return { success: true, entries };
    } catch (err) {
        return { success: false, entries: [], error: err.message };
    }
}

function searchEntries(db, url) {
    const results = [];
    const searchTerms = buildSearchTerms(url);

    // Recursive function to search all groups
    function searchGroup(group) {
        if (!group) return;

        // Search entries in this group
        if (group.entries) {
            for (const entry of group.entries) {
                if (entryMatches(entry, searchTerms)) {
                    const username = getFieldValue(entry, 'UserName');
                    const password = getFieldValue(entry, 'Password');
                    const title = getFieldValue(entry, 'Title');
                    const entryUrl = getFieldValue(entry, 'URL');

                    if (username || password) {
                        results.push({
                            login: username || '',
                            password: password || '',
                            name: title || '',
                            url: entryUrl || ''
                        });
                    }
                }
            }
        }

        // Recurse into subgroups
        if (group.groups) {
            for (const subgroup of group.groups) {
                searchGroup(subgroup);
            }
        }
    }

    searchGroup(db.getDefaultGroup());
    return results;
}

function buildSearchTerms(url) {
    const terms = [];

    try {
        const parsed = new URL(url);

        // Full URL
        terms.push(url.toLowerCase());

        // Origin
        terms.push(parsed.origin.toLowerCase());

        // Hostname
        terms.push(parsed.hostname.toLowerCase());

        // Without www
        if (parsed.hostname.startsWith('www.')) {
            terms.push(parsed.hostname.slice(4).toLowerCase());
        }

        // Extract domain keyword (e.g., "github" from "github.com")
        const keyword = extractDomainKeyword(parsed.hostname);
        if (keyword) {
            terms.push(keyword.toLowerCase());
        }
    } catch (e) {
        terms.push(url.toLowerCase());
    }

    return [...new Set(terms)]; // Deduplicate
}

function extractDomainKeyword(hostname) {
    let domain = hostname.replace(/^www\./, '');
    const parts = domain.split('.');
    if (parts.length <= 1) return null;

    // Handle multi-part TLDs (co.uk, com.au, etc.)
    if (parts.length >= 3) {
        const secondToLast = parts[parts.length - 2];
        if (['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(secondToLast)) {
            return parts[parts.length - 3];
        }
    }

    return parts[parts.length - 2];
}

function entryMatches(entry, searchTerms) {
    // Check URL field
    const entryUrl = getFieldValue(entry, 'URL');
    if (entryUrl) {
        const urlLower = entryUrl.toLowerCase();
        for (const term of searchTerms) {
            if (urlLower.includes(term) || term.includes(urlLower)) {
                return true;
            }
        }
    }

    // Check Title field
    const title = getFieldValue(entry, 'Title');
    if (title) {
        const titleLower = title.toLowerCase();
        for (const term of searchTerms) {
            if (titleLower.includes(term)) {
                return true;
            }
        }
    }

    return false;
}

function getFieldValue(entry, fieldName) {
    const field = entry.fields.get(fieldName);
    if (!field) return '';

    // Handle ProtectedValue (passwords are protected)
    if (field instanceof kdbxweb.ProtectedValue) {
        return field.getText();
    }

    return String(field);
}

function getStatus() {
    const hasPath = !!databasePath;
    const isUnlocked = !!masterPassword;
    const status = {
        connected: hasPath,
        associated: isUnlocked,
        databasePath: databasePath || null
    };
    console.log('[KeePass] getStatus called:', JSON.stringify(status));
    return status;
}

// --- Message handler ---

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'keepass-set-database':
            databasePath = message.path;
            browser.storage.local.set({ keepassDatabasePath: message.path });
            clearCache();
            sendResponse({ success: true });
            return false;

        case 'keepass-unlock':
            unlockDatabase(message.password)
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case 'keepass-lock':
            lockDatabase();
            sendResponse({ success: true });
            return false;

        case 'keepass-get-logins':
            getLogins(message.url)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ success: false, entries: [], error: err.message }));
            return true;

        case 'keepass-status':
            sendResponse(getStatus());
            return false;

        // Legacy action names for compatibility with formFiller.js/visualProcessor.js
        case 'keepass-connect':
            // No-op for direct file reading; unlock is separate
            sendResponse({ success: !!databasePath, error: databasePath ? null : 'No database path set' });
            return false;

        case 'keepass-disconnect':
            lockDatabase();
            sendResponse({ success: true });
            return false;

        case 'keepass-test-associate':
            // For direct reading, test if we can load the database
            if (!masterPassword || !databasePath) {
                sendResponse({ success: false, error: 'Not unlocked' });
            } else {
                loadDatabase()
                    .then(() => sendResponse({ success: true }))
                    .catch(err => sendResponse({ success: false, error: err.message }));
            }
            return true;
    }
});

// Load saved database path on startup
browser.storage.local.get(['keepassDatabasePath']).then(stored => {
    if (stored.keepassDatabasePath) {
        databasePath = stored.keepassDatabasePath;
        console.log('[KeePass] Loaded saved database path:', databasePath);
    }
});
