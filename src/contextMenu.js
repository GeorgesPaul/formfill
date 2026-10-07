// contextMenu.js: a right-click entry that fills a page without the panel.
//
// The sidebar (Firefox) and the side panel (Chrome) only exist in ordinary
// browser windows. A chrome-less popup, which is what window.open with window
// features produces and what payment and 3-D Secure flows use, has no toolbar
// and no sidebar box, so no shortcut can open the panel there. A context menu
// is available in every window and inside every frame, which makes it the one
// trigger that reaches those pages.
//
// The submenu names the profiles for the same reason: in a popup window there
// is nothing else to show you which profile is about to be used.

(function () {
    'use strict';

    const menus = browser.contextMenus;
    if (!menus) return;

    const ROOT = 'ff-fill';
    const SELECTED = 'ff-fill-selected';
    const SEPARATOR = 'ff-fill-separator';
    const EMPTY = 'ff-fill-empty';
    const PROFILE_PREFIX = 'ff-fill-profile:';

    // 'selection' is listed because a right-click with text selected does not
    // match 'page', and 'frame' because payment fields usually live in one.
    const CONTEXTS = ['page', 'frame', 'editable', 'selection'];

    function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // "&" marks the access key in a menu title, so a literal one must double.
    const esc = s => String(s).replace(/&/g, '&&');

    const nameOf = (profiles, id) => (profiles[id] && profiles[id].name) || '(Unnamed Profile)';

    // The panel's rule (popup.js): an empty selection falls back to the last
    // loaded profile, then to the first one that exists.
    function resolveSelection(data) {
        const profiles = data.profiles || {};
        const ids = (data.selectedProfileIds || []).filter(id => profiles[id]);
        if (ids.length) return ids;
        if (data.lastLoadedProfile && profiles[data.lastLoadedProfile]) return [data.lastLoadedProfile];
        const first = Object.keys(profiles)[0];
        return first ? [first] : [];
    }

    // ---------------------------------------------------------------------
    // Building the menu
    // ---------------------------------------------------------------------

    // removeAll is promise-based in Firefox and callback-based in Chrome before
    // promise support landed. Awaiting a bare undefined would resolve at once
    // and let create() race the removal, which raises duplicate-id errors on
    // every service worker wake. This settles on whichever style is in play.
    function removeAll() {
        return new Promise(resolve => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                try { void browser.runtime.lastError; } catch (_) {}
                resolve();
            };
            let p;
            try {
                p = menus.removeAll(done);
            } catch (_) {
                // Firefox rejects the surplus callback argument.
                try { p = menus.removeAll(); } catch (_) { return done(); }
            }
            if (p && typeof p.then === 'function') p.then(done, done);
        });
    }

    function create(props) {
        // Chrome reports a bad item through runtime.lastError, Firefox throws.
        try { menus.create(props); } catch (err) { console.error('[ContextMenu] create failed:', props.id, err); }
    }

    // One top-level item only: Firefox nests an extension's items under its own
    // name as soon as there are two, which would bury this one level deeper.
    async function build() {
        await removeAll();

        const data = await browser.storage.local.get(['profiles', 'selectedProfileIds', 'lastLoadedProfile']);
        const profiles = data.profiles || {};
        const ids = Object.keys(profiles);

        create({ id: ROOT, title: 'Fill this form', contexts: CONTEXTS });

        if (!ids.length) {
            create({ id: EMPTY, parentId: ROOT, title: 'No profiles yet', enabled: false, contexts: CONTEXTS });
            return;
        }

        const selected = resolveSelection(data);
        const label = selected.map(id => nameOf(profiles, id)).join(', ');
        create({
            id: SELECTED,
            parentId: ROOT,
            title: label ? 'Use current selection (' + esc(label) + ')' : 'Use current selection',
            contexts: CONTEXTS
        });
        create({ id: SEPARATOR, parentId: ROOT, type: 'separator', contexts: CONTEXTS });
        for (const id of ids) {
            create({ id: PROFILE_PREFIX + id, parentId: ROOT, title: esc(nameOf(profiles, id)), contexts: CONTEXTS });
        }
    }

    // Serialized: a rebuild that overlapped another would create duplicate ids.
    let building = Promise.resolve();
    function rebuild() {
        building = building.then(build, build).catch(err => console.error('[ContextMenu] Rebuild failed:', err));
        return building;
    }

    // ---------------------------------------------------------------------
    // Filling
    // ---------------------------------------------------------------------

    async function fill(tabId, profileIds) {
        const data = await browser.storage.local.get(['profiles', 'useVisualProcessing']);
        const profiles = data.profiles || {};
        const profileTexts = [];
        for (const id of profileIds) {
            if (profiles[id] && profiles[id].data) {
                profileTexts.push({ name: profiles[id].name, data: profiles[id].data.trim() });
            }
        }
        if (!profileTexts.length) {
            console.warn('[ContextMenu] Nothing to fill with: the chosen profile has no data.');
            return;
        }

        // No custom prompt. That textarea is a panel-only control, and you
        // cannot see what it holds at the moment you right-click.
        const payload = {
            action: 'fillForm',
            profiles: profileTexts,
            customPrompt: '',
            sessionId: uuid()
        };
        if (data.useVisualProcessing) payload.useVisualProcessing = true;

        // No frameId: this broadcasts to every frame in the tab, which is what
        // the panel does too, so a form split across frames behaves the same.
        try {
            await browser.tabs.sendMessage(tabId, payload);
        } catch (_) {
            // Content script absent (PDF viewer, restricted page, a frame that
            // loaded before the extension). Inject and retry, as the panel does.
            await Compat.injectContentScripts(tabId);
            await browser.tabs.sendMessage(tabId, payload);
        }
    }

    menus.onClicked.addListener((info, tab) => {
        if (!tab || tab.id === undefined || tab.id < 0) return;
        const id = info.menuItemId;
        let p;
        if (id === SELECTED) {
            p = browser.storage.local.get(['profiles', 'selectedProfileIds', 'lastLoadedProfile'])
                .then(data => fill(tab.id, resolveSelection(data)));
        } else if (typeof id === 'string' && id.startsWith(PROFILE_PREFIX)) {
            p = fill(tab.id, [id.slice(PROFILE_PREFIX.length)]);
        } else {
            return;
        }
        p.catch(err => console.error('[ContextMenu] Fill failed:', err));
    });

    // The menu mirrors the profile list, so it follows every change to it.
    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.profiles || changes.selectedProfileIds || changes.lastLoadedProfile) rebuild();
    });

    if (browser.runtime.onInstalled) browser.runtime.onInstalled.addListener(rebuild);
    if (browser.runtime.onStartup) browser.runtime.onStartup.addListener(rebuild);

    // Firefox's persistent background page runs this once at startup; Chrome's
    // service worker runs it on every wake, where removeAll makes it idempotent.
    rebuild();
})();
