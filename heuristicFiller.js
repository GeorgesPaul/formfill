// Heuristic fast-path: deterministic field→profile-value matches via the
// HTML autocomplete attribute, input type, and name/label regex patterns.
// Runs before the LLM call. Anything it can't map falls through to the LLM.

(function (global) {
    'use strict';

    // --- Profile parsing ---

    function parseProfileText(data) {
        const out = {};
        if (!data) return out;
        const lines = String(data).split(/\r?\n/);
        for (const line of lines) {
            const m = line.match(/^\s*([A-Za-z0-9_\- ]+?)\s*:\s*(.+?)\s*$/);
            if (!m) continue;
            const key = m[1].toLowerCase().replace(/[\s-]+/g, '_');
            out[key] = m[2];
        }
        return out;
    }

    function parseProfiles(profiles) {
        // Merge profiles left-to-right; first profile wins on key collisions.
        const merged = {};
        const arr = Array.isArray(profiles) ? profiles : [profiles];
        for (let i = arr.length - 1; i >= 0; i--) {
            const parsed = parseProfileText(arr[i].data || arr[i]);
            Object.assign(merged, parsed);
        }
        return merged;
    }

    // --- Profile key aliases (multiple accepted spellings → canonical lookup) ---
    // Each entry lists candidate keys in the parsed profile, checked in order.
    const ALIASES = {
        given_name:   ['given_names', 'given_name', 'first_name', 'firstname', 'fname'],
        family_name:  ['family_names', 'family_name', 'last_name', 'lastname', 'surname', 'lname'],
        additional_name: ['middle_name', 'middlename', 'additional_name'],
        full_name:    ['full_name', 'name', 'fullname'],
        nickname:     ['nickname', 'preferred_name', 'user_name', 'username'],
        email:        ['email', 'email_address', 'e_mail'],
        tel:          ['phone', 'phone_number', 'telephone', 'mobile', 'cell'],
        tel_country:  ['phone_country_code'],
        tel_area:     ['phone_area_code'],
        tel_local:    ['phone_local_number'],
        street:       ['address_line1', 'address_street', 'street', 'street_address'],
        street2:      ['address_line2', 'apartment', 'unit'],
        city:         ['address_city', 'city', 'town', 'locality'],
        region:       ['address_state', 'state', 'province', 'region'],
        postal:       ['address_postal_code', 'postal_code', 'zip', 'zipcode', 'zip_code'],
        country:      ['address_country', 'country'],
        bday_day:     ['date_of_birth_day', 'dob_day', 'birth_day'],
        bday_month:   ['date_of_birth_month', 'dob_month', 'birth_month'],
        bday_year:    ['date_of_birth_year', 'dob_year', 'birth_year'],
        bday:         ['date_of_birth', 'dob', 'birthday'],
        sex:          ['gender', 'sex'],
        cc_name:      ['cardholder_name', 'cc_name', 'credit_card_name'],
        cc_number:    ['credit_card_number', 'cc_number', 'card_number'],
        cc_exp_month: ['credit_card_expiration_month', 'cc_exp_month'],
        cc_exp_year:  ['credit_card_expiration_year', 'cc_exp_year'],
        cc_csc:       ['credit_card_security_code', 'cvv', 'cvc', 'cc_csc'],
        organization: ['company', 'organization', 'employer'],
        job_title:    ['occupation', 'job_title', 'position', 'title'],
        url:          ['website', 'url', 'homepage'],
    };

    function resolve(profile, aliasKey) {
        const candidates = ALIASES[aliasKey] || [aliasKey];
        for (const k of candidates) {
            if (profile[k] != null && profile[k] !== '') return profile[k];
        }
        return null;
    }

    // --- HTML autocomplete token → profile alias ---
    // Ref: https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
    const AUTOCOMPLETE_MAP = {
        'given-name': 'given_name',
        'family-name': 'family_name',
        'additional-name': 'additional_name',
        'name': 'full_name',
        'nickname': 'nickname',
        'username': 'nickname',
        'email': 'email',
        'tel': 'tel',
        'tel-national': 'tel',
        'tel-country-code': 'tel_country',
        'tel-area-code': 'tel_area',
        'tel-local': 'tel_local',
        'street-address': 'street',
        'address-line1': 'street',
        'address-line2': 'street2',
        'address-level2': 'city',
        'address-level1': 'region',
        'postal-code': 'postal',
        'country': 'country',
        'country-name': 'country',
        'bday': 'bday',
        'bday-day': 'bday_day',
        'bday-month': 'bday_month',
        'bday-year': 'bday_year',
        'sex': 'sex',
        'cc-name': 'cc_name',
        'cc-number': 'cc_number',
        'cc-exp-month': 'cc_exp_month',
        'cc-exp-year': 'cc_exp_year',
        'cc-csc': 'cc_csc',
        'organization': 'organization',
        'organization-title': 'job_title',
        'url': 'url',
    };

    function matchByAutocomplete(info, profile) {
        const ac = (info.autocomplete || '').toLowerCase().trim();
        if (!ac) return null;
        // autocomplete can be a space-separated token list ("billing email")
        // The defined token is usually the last one.
        const tokens = ac.split(/\s+/);
        for (let i = tokens.length - 1; i >= 0; i--) {
            const alias = AUTOCOMPLETE_MAP[tokens[i]];
            if (alias) {
                const v = resolve(profile, alias);
                if (v != null) return v;
            }
        }
        return null;
    }

    function matchByType(info, profile) {
        const t = (info.type || '').toLowerCase();
        if (t === 'email') return resolve(profile, 'email');
        if (t === 'tel')   return resolve(profile, 'tel');
        if (t === 'url')   return resolve(profile, 'url');
        return null;
    }

    // Name/id/label/placeholder regex → profile alias.
    // Ordered: most specific first.
    const PATTERNS = [
        [/(first.?name|given.?name|forename|fname)/i, 'given_name'],
        [/(last.?name|family.?name|surname|lname)/i, 'family_name'],
        [/(middle.?name|additional.?name|middle.?initial)/i, 'additional_name'],
        [/(full.?name|^name$|your.?name)/i, 'full_name'],
        [/(nickname|preferred.?name|display.?name|user.?name|username)/i, 'nickname'],
        [/(e.?mail)/i, 'email'],
        [/(phone|telephone|mobile|cell)/i, 'tel'],
        [/(company|organization|employer)/i, 'organization'],
        [/(job.?title|position|occupation)/i, 'job_title'],
        [/(street.?address|address.?line.?1|^street$|^address$)/i, 'street'],
        [/(address.?line.?2|apartment|unit|suite)/i, 'street2'],
        [/(city|town|locality)/i, 'city'],
        [/(state|province|region)/i, 'region'],
        [/(zip|postal.?code|postcode)/i, 'postal'],
        [/(country)/i, 'country'],
        [/(birth.?day|birth.?date|date.?of.?birth|dob)(?!.*(month|year|day))/i, 'bday'],
        [/(bday.?day|birth.?day.*day|dob.?day)/i, 'bday_day'],
        [/(bday.?month|birth.?month|dob.?month)/i, 'bday_month'],
        [/(bday.?year|birth.?year|dob.?year)/i, 'bday_year'],
        [/(^sex$|gender)/i, 'sex'],
        [/(cardholder|card.?name|cc.?name)/i, 'cc_name'],
        [/(card.?number|cc.?number|credit.?card.?number)/i, 'cc_number'],
        [/(cc.?exp.?month|card.?exp.?month|expiration.?month)/i, 'cc_exp_month'],
        [/(cc.?exp.?year|card.?exp.?year|expiration.?year)/i, 'cc_exp_year'],
        [/(cvv|cvc|cc.?csc|security.?code|card.?verification)/i, 'cc_csc'],
        [/(website|homepage|personal.?url)/i, 'url'],
    ];

    function matchByPattern(info, profile) {
        // Haystack: prefer strong identifiers (autocomplete, name, id) over loose
        // text (placeholder, label, nearbyText) to reduce false positives.
        const strong = [info.name, info.id].filter(Boolean).join(' ');
        const weak = [info.placeholder, info.label, info.ariaLabel, info.nearbyText].filter(Boolean).join(' ');

        for (const [re, alias] of PATTERNS) {
            if (strong && re.test(strong)) {
                const v = resolve(profile, alias);
                if (v != null) return v;
            }
        }
        for (const [re, alias] of PATTERNS) {
            if (weak && re.test(weak)) {
                const v = resolve(profile, alias);
                if (v != null) return v;
            }
        }
        return null;
    }

    // --- Public API ---

    // Takes the formFieldsInfo array (each entry: {element, info}) and the
    // raw profiles passed from popup.js. Returns:
    //   { matches: {index: value}, remainingIndices: [idx,...] }
    // Callers fill the matched indices directly, then send only the remaining
    // fields to the vision LLM.
    function applyHeuristics(formFieldsInfo, profiles) {
        const profile = parseProfiles(profiles);
        const matches = {};
        const remainingIndices = [];

        for (let i = 0; i < formFieldsInfo.length; i++) {
            const { info } = formFieldsInfo[i];
            const v = matchByAutocomplete(info, profile)
                  || matchByType(info, profile)
                  || matchByPattern(info, profile);
            if (v != null && v !== '') {
                matches[i] = v;
            } else {
                remainingIndices.push(i);
            }
        }
        return { matches, remainingIndices };
    }

    const HeuristicFiller = { applyHeuristics, parseProfiles };

    if (typeof window !== 'undefined') window.HeuristicFiller = HeuristicFiller;
    else if (typeof global !== 'undefined') global.HeuristicFiller = HeuristicFiller;
    else if (typeof self !== 'undefined') self.HeuristicFiller = HeuristicFiller;

})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global :
   typeof self !== 'undefined' ? self : this);
