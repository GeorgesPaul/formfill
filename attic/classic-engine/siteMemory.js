// siteMemory.js -- remembers, per site and form, which profile key went into
// which field. The second time the same form is filled the mapping is applied
// directly and the model is only consulted for what the memory does not
// cover, or when the page rejects a remembered value.
//
// Stored under browser.storage.local "ffSiteMemory":
//   { [siteKey]: { updatedAt, hits, fields: { [fieldSig]: { key, value, profileHash } } } }
// siteKey  = origin + pathname with numeric / uuid segments replaced by "*"
// fieldSig = label|kind|name|id|autocomplete|placeholder (digits stripped from
//            name/id so generated ids do not defeat the match)
// key      = the profile line the value came from ("email"); "derived" when
//            the model reformatted or combined values, in which case the
//            stored value is only reused while the profile is unchanged.
(function (global) {
    'use strict';

    const STORE = 'ffSiteMemory';
    const MAX_SITES = 200;
    const MAX_FIELDS = 150;

    function siteKey(url) {
        try {
            const u = new URL(url);
            const path = u.pathname
                .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')
                .replace(/\/\d+(?=\/|$)/g, '/*')
                .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/*');
            return u.origin + path;
        } catch (_) { return String(url); }
    }

    function fieldSig(f) {
        const strip = s => String(s == null ? '' : s).toLowerCase().replace(/\d+/g, '#').trim();
        return [
            String(f.label || '').toLowerCase().trim().slice(0, 80),
            f.kind || '',
            strip(f.name).slice(0, 60),
            strip(f.id).slice(0, 60),
            String(f.autocomplete || '').toLowerCase(),
            String(f.placeholder || '').toLowerCase().slice(0, 40),
        ].join('|');
    }

    function profileHash(profiles) {
        const s = (profiles || []).map(p => (p && p.data) || '').join('\n');
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return String(h >>> 0);
    }

    async function readAll() {
        try {
            const d = await browser.storage.local.get(STORE);
            return d[STORE] || {};
        } catch (_) { return {}; }
    }

    async function writeAll(mem) {
        try { await browser.storage.local.set({ [STORE]: mem }); } catch (e) { console.warn('[SiteMemory] write failed', e); }
    }

    // Returns { siteKey, bySig: Map(sig -> entry), entry } for the current page.
    async function lookup(url) {
        const key = siteKey(url);
        const mem = await readAll();
        const entry = mem[key];
        const bySig = new Map();
        if (entry && entry.fields) for (const [sig, v] of Object.entries(entry.fields)) bySig.set(sig, v);
        return { siteKey: key, bySig, entry: entry || null };
    }

    // Suggest values for the fields of a snapshot from memory.
    // profileParsed: { key -> value } from HeuristicFiller.parseProfiles
    function suggestions(lookupResult, fields, profileParsed, currentProfileHash) {
        const out = new Map(); // ref -> { value, key }
        if (!lookupResult || !lookupResult.bySig.size) return out;
        for (const f of fields) {
            const m = lookupResult.bySig.get(fieldSig(f));
            if (!m) continue;
            let value = null;
            if (m.key && m.key !== 'derived' && m.key !== 'none' && profileParsed && profileParsed[m.key] != null && profileParsed[m.key] !== '') {
                value = profileParsed[m.key];
                // A remembered derived form of the same key (formatted phone/date)
                // beats the raw profile value while the profile is unchanged.
                if (m.value != null && m.profileHash === currentProfileHash) value = m.value;
            } else if (m.key === 'derived' && m.profileHash === currentProfileHash && m.value != null) {
                value = m.value;
            } else if (m.key === 'none' && m.value != null && m.profileHash === currentProfileHash) {
                value = m.value;
            }
            if (value != null && value !== '') out.set(f.ref, { value, key: m.key });
        }
        return out;
    }

    // Persist what worked. mappings: [{ field, key, value }] (field = snapshot field)
    async function remember(url, mappings, currentProfileHash) {
        if (!mappings || !mappings.length) return;
        const key = siteKey(url);
        const mem = await readAll();
        const entry = mem[key] || { fields: {}, hits: 0 };
        entry.updatedAt = Date.now();
        entry.hits = (entry.hits || 0) + 1;
        for (const m of mappings) {
            if (!m || !m.field) continue;
            const sig = fieldSig(m.field);
            entry.fields[sig] = { key: m.key || 'none', value: typeof m.value === 'boolean' ? m.value : String(m.value == null ? '' : m.value).slice(0, 300), profileHash: currentProfileHash, label: m.field.label || undefined };
        }
        // Bound per-site size.
        const sigs = Object.keys(entry.fields);
        if (sigs.length > MAX_FIELDS) for (const s of sigs.slice(0, sigs.length - MAX_FIELDS)) delete entry.fields[s];
        mem[key] = entry;
        // Bound number of sites (drop least recently updated).
        const keys = Object.keys(mem);
        if (keys.length > MAX_SITES) {
            keys.sort((a, b) => (mem[a].updatedAt || 0) - (mem[b].updatedAt || 0));
            for (const k of keys.slice(0, keys.length - MAX_SITES)) delete mem[k];
        }
        await writeAll(mem);
    }

    async function forget(url) {
        const key = siteKey(url);
        const mem = await readAll();
        if (mem[key]) { delete mem[key]; await writeAll(mem); }
    }

    async function clearAll() { await writeAll({}); }

    const SiteMemory = { siteKey, fieldSig, profileHash, lookup, suggestions, remember, forget, clearAll };

    if (typeof window !== 'undefined') window.SiteMemory = SiteMemory;
    else if (typeof global !== 'undefined') global.SiteMemory = SiteMemory;
    else if (typeof self !== 'undefined') self.SiteMemory = SiteMemory;

})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global :
   typeof self !== 'undefined' ? self : this);
