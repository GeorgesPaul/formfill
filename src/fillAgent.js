// fillAgent.js -- the closed-loop driver that replaces the one-shot
// "map every field, fill, hope" pass.
//
//   1. FormKit.snapshot() describes every visible field with a stable ref.
//   2. Site memory and the deterministic heuristics attach suggested values.
//      If memory covers every empty field, it is applied without any model
//      call; the model is only consulted when something is missing/invalid.
//   3. Otherwise the model receives the snapshot and the profile and answers
//      with the form_actions tool: a batch of {ref, op, value} actions plus
//      what it deliberately skipped (and why, and whether the user must
//      supply it).
//   4. FormKit.execute() runs the batch (typing, autocomplete, comboboxes,
//      radio groups, checkboxes, clicks) and reports per action what the
//      field holds now and whether the page flagged it invalid.
//   5. The results, the page's reaction (new/removed/changed fields, error
//      messages) go back to the model, which fixes, continues (e.g. clicks
//      "Next") or declares done. Bounded by config.maxTurns.
//
// Models improve -> step 3 improves, with no code change: the extension
// decides HOW to touch a widget, the model decides WHAT.
// ff:logs:start
//
// In development builds every step is recorded through FillLogger, so a failed
// fill can be replayed and understood later. Store builds are packaged without
// it (build.ps1 -Channel store).
// ff:logs:end
const FillAgent = (function () {
    'use strict';

    const TOOL = {
        name: 'form_actions',
        description: 'Fill, choose, set, click or clear form fields identified by their ref. Report fields you deliberately skip. Set done=true when the form is filled as far as the profile allows (or nothing more can be done).',
        parameters: {
            type: 'object',
            properties: {
                actions: {
                    type: 'array',
                    description: 'Actions to execute in order. Use fill for text-like fields (value = text), choose for select/combobox/radio-group/listbox (value = option text exactly as listed), set for checkbox/switch (value = true/false), click for buttons (and fields that need a click), clear to empty a field.',
                    items: {
                        type: 'object',
                        properties: {
                            ref: { type: 'string', description: 'Field or button ref from the snapshot, e.g. "f12", "g3", "b2".' },
                            op: { type: 'string', enum: ['fill', 'choose', 'set', 'click', 'clear'] },
                            value: { description: 'Text for fill/choose; true/false for set; omit for click/clear.' },
                            source: { type: 'string', description: 'Profile key the value came from (the text left of the colon in the profile, e.g. "email"), "derived" when reformatted/combined, "none" for fixed choices (consent boxes, defaults).' },
                            note: { type: 'string', description: 'Optional short reasoning, e.g. why you chose this option.' },
                        },
                        required: ['ref', 'op'],
                    },
                },
                skipped: {
                    type: 'array',
                    description: 'Fields you deliberately leave alone this turn.',
                    items: {
                        type: 'object',
                        properties: {
                            ref: { type: 'string' },
                            reason: { type: 'string' },
                            needs_user_input: { type: 'boolean', description: 'true when the profile lacks the information and the user must fill it in themselves.' },
                        },
                        required: ['ref', 'reason'],
                    },
                },
                done: { type: 'boolean', description: 'true when nothing more should be done after these actions.' },
                summary: { type: 'string', description: 'One or two sentences for the user: what was filled, what they still need to do.' },
            },
            required: ['actions', 'done'],
        },
    };

    const RULES = `You are the decision-maker inside a browser extension that fills web forms with the user's own profile data. The extension does the mechanical work (real keystrokes, suggestion dropdowns, comboboxes, radio buttons, clicks) and reports back what the page did. You decide WHAT goes where.

You receive a snapshot of the visible form fields. Each field has a stable ref ("f12" for a field, "g3" for a radio-button group, "b2" for a button) and what a person can see: label, section, placeholder, description, options, current value, and any validation error the page shows. The name/id/autocomplete attributes are hints only; some forms set them wrong or reuse them.

How to act:
- Call the form_actions tool with a batch of actions for every field you can fill from the profile. Refs must come from the snapshot.
- fill: text-like fields. choose: select, combobox, radio-group, listbox (value = the option text exactly as listed; for a searchable combobox without a listed option, give the text to search for). set: checkbox/switch (true/false). click: buttons. clear: empty a field.
- Match the value format the field expects: placeholder patterns ("dd-mm-yyyy"), maxlength, min/max, the options list, split fields (day/month/year, country code + number, first/last name), local conventions of the page language.
- Fields marked "date" are handled by the extension's date mechanics (masks, native pickers, calendars): give the date in the format shown when one is shown, otherwise as dd-mm-yyyy, and do not retry other formats yourself when it is rejected.
- Comboboxes keep their choice inside the widget, not necessarily in the text box: "value" and "now" report what the widget shows as chosen. A choose that reports selected=... and accepted=true is done, even when the box looks empty.
- If a turn reports PAGE CHANGED, the earlier refs are gone; work only from the new snapshot in that message.
- Never invent data. When the profile lacks something the form needs, list it under skipped with needs_user_input=true so the user can fill it in themselves. Names, addresses, dates and numbers must come from the profile; you may reformat and combine them.
- Fields that already hold a correct value (see "value") are left alone. Fix a pre-filled value only when it is clearly wrong for this profile.
- "suggested" values were proposed by the extension's deterministic matching or by memory of a previous fill of this same form. Use them unless the label or context says otherwise.
- Consent checkboxes: tick the ones required to proceed (terms, privacy). Do NOT tick optional marketing/newsletter/third-party boxes unless the profile or the user's instructions say so.
- Never fill password fields (kind "password"); the user has a separate credential tool.
- Never submit, pay, order, register, send, confirm or otherwise finalize. Buttons of kind "submit" are off limits. You MAY click buttons that reveal more of the form (kind "next" or "reveal": Next, Continue, Add address, Enter manually, Same as billing...), but only after the current fields are filled correctly, and at most one such click per turn.
- After each batch you get the results: the value the field holds now, whether it was accepted, validation messages, which suggestion an autocomplete widget picked, and which fields appeared, changed or vanished. Fix what the page rejected (different format, a listed option, a different search text), fill new fields, then set done=true. Do not retry an identical value that was just rejected. If a field cannot be satisfied, skip it with a reason.
- Buttons carry a "disabled" flag. A Next/Continue/submit button that stays disabled after everything is filled means the page is still waiting for something: a field you skipped or never saw, a required checkbox, a choice that did not register, or a value it silently rejected. When you are told this, do not set done=true just because the fields look right; look again at the whole field list and act. Only give up when nothing plausible is left, and then say in the summary what the user should check.
- Optional fields you have data for are filled too. Fields you have no data for are simply not touched (list them under skipped only when they are required).
- Keep summary short and useful for the user: what was filled, what they must complete themselves.`;

    const wait = ms => new Promise(r => setTimeout(r, ms));

    function normKey(k) {
        return String(k == null ? '' : k).toLowerCase().trim().replace(/[\s-]+/g, '_');
    }

    function fillableKinds(f) {
        return f.kind !== 'password' && f.kind !== 'file' && !f.disabled;
    }

    function isEmptyValue(v) {
        if (v === undefined || v === null) return true;
        if (typeof v === 'boolean') return v === false;
        if (Array.isArray(v)) return v.length === 0;
        return String(v).trim() === '';
    }

    function profileText(profiles) {
        return (profiles || []).map(p => `=== ${p.name || 'Profile'} ===\n${(p.data || '').trim()}`).join('\n\n');
    }

    function systemPrompt(profiles, customPrompt, jsonMode) {
        const today = new Date();
        const parts = [RULES];
        parts.push(`\nToday's date: ${today.toISOString().slice(0, 10)}. Browser language: ${navigator.language || 'unknown'}. Page language: ${document.documentElement.lang || 'unknown'}.`);
        parts.push(`\nUSER PROFILE DATA (key: value lines; the key is the "source" you report):\n${profileText(profiles)}`);
        if (customPrompt) parts.push(`\nADDITIONAL INSTRUCTIONS FROM THE USER (these override the rules above where they conflict):\n${customPrompt}`);
        if (jsonMode) {
            parts.push(`\nThis endpoint does not support tools. Respond with ONE JSON object only, no prose, no markdown fences, with this shape:\n${JSON.stringify({ actions: [{ ref: 'f1', op: 'fill', value: '...', source: 'email' }], skipped: [{ ref: 'f9', reason: '...', needs_user_input: true }], done: true, summary: '...' })}`);
        }
        return parts.join('\n');
    }

    function describeSnapshot(snap, opts = {}) {
        const fields = snap.fields.filter(f => opts.all || fillableKinds(f)).map(FormKit.describeField);
        const buttons = snap.buttons.map(FormKit.describeButton);
        const head = `PAGE: ${snap.title || ''} (${snap.url})${snap.frame === 'iframe' ? ' [this is an embedded frame]' : ''}\nVIEWPORT: ${snap.viewport.w}x${snap.viewport.h}, scrolled ${snap.viewport.scrollY}px of ${snap.viewport.pageH}px`;
        return `${head}\nFIELDS (${fields.length}):\n${JSON.stringify(fields)}\nBUTTONS (${buttons.length}):\n${JSON.stringify(buttons)}`;
    }

    function compactResult(r) {
        const o = { ref: r.ref, op: r.op };
        if (r.value !== undefined && r.op !== 'click') o.value = r.value;
        o.ok = !!r.ok;
        if (r.accepted !== undefined) o.accepted = r.accepted;
        if (r.finalValue !== undefined && r.op !== 'click') o.now = r.finalValue;
        if (r.selected) o.selected = r.selected;
        if (r.autocomplete) o.autocomplete = r.autocomplete;
        if (r.validation) o.validation = r.validation;
        if (r.tried) o.tried = r.tried;
        if (r.format) o.format = r.format;
        if (r.note) o.note = r.note;
        if (r.error) o.error = r.error;
        return o;
    }

    function planFromResponse(resp) {
        let plan = null;
        const call = (resp.toolCalls || []).find(c => c.name === TOOL.name) || (resp.toolCalls || [])[0];
        if (call && call.args && typeof call.args === 'object') plan = call.args;
        if (!plan && resp.text) plan = ApiUtils.parseJsonLoose(resp.text);
        if (!plan || typeof plan !== 'object') return null;
        plan.actions = Array.isArray(plan.actions) ? plan.actions.filter(a => a && a.ref) : [];
        plan.skipped = Array.isArray(plan.skipped) ? plan.skipped.filter(s => s && s.ref) : [];
        plan.done = plan.done === true || plan.done === 'true';
        return { plan, call };
    }

    function actionsKey(actions) {
        return JSON.stringify((actions || []).map(a => [a.ref, a.op, a.value]));
    }

    // ------------------------------------------------------------------ run

    async function run(opts) {
        const { profiles, customPrompt = '', sessionId = null, vision = false } = opts;
        if (window.abortController) { try { window.abortController.abort(); } catch (_) {} }
        window.currentFillSessionId = sessionId;
        window.stopFilling = false;
        const isCancelled = () => window.stopFilling || window.currentFillSessionId !== sessionId;
        const abort = new AbortController();
        window.abortController = abort;

        const llm = opts.llm || ((messages, o) => ApiUtils.chat(messages, o));
        const config = opts.config || await ApiUtils.getLlmConfig();
        const maxTurns = Math.max(1, Math.min(10, Number(config.maxTurns) || 4));
        const logging = opts.logging !== false;
        const overlays = typeof OverlayUtils !== 'undefined';
        const notify = (msg) => { try { Compat.notify({ ...msg, sessionId }); } catch (_) {} };
        const t0 = Date.now();

        if (!Array.isArray(profiles) || profiles.length === 0) {
            notify({ action: 'fillFormError', error: 'No profile selected.' });
            throw new Error('No profile selected.');
        }

        // Wait for the page to finish loading.
        await new Promise(resolve => {
            if (document.readyState === 'complete') resolve();
            else window.addEventListener('load', resolve, { once: true });
        });
        if (isCancelled()) throw new Error('Form filling stopped by user.');

        let snap = FormKit.snapshot();
        let targets = snap.fields.filter(fillableKinds);
        if (targets.length === 0) {
            // Nothing to do in this frame: stay silent (other frames may have the form).
            return { status: 'success', message: 'No form fields in this frame.', filled: 0, total: 0 };
        }

        notify({ action: 'fillFormStart' });
        const total = targets.length;
        const progress = (done, message) => {
            try { updateFillProgress(Math.min(done, total - 1), Math.min(done, total - 1), total, message, sessionId); } catch (_) {}
        };
        progress(0, `Found ${total} field(s). Preparing...`);

        // ---- fill logs (development builds only; see build.ps1 -Channel)
        let logOn = false;
        let log = () => {};
        // ff:logs:start
        if (logging && typeof FillLogger !== 'undefined') {
            logOn = await FillLogger.start(sessionId, {
                model: config.model, apiUrl: config.apiUrl, reasoningEffort: config.reasoningEffort, maxTurns,
                vision: !!vision, customPrompt, profiles: profiles.map(p => ({ name: p.name, data: p.data })),
                extensionVersion: (function () { try { return browser.runtime.getManifest().version; } catch (_) { return null; } })(),
                userAgent: navigator.userAgent,
            });
        }
        if (logOn) {
            log = (type, payload) => { try { FillLogger.event(type, payload); } catch (_) {} };
            log('snapshot', { turn: 0, snapshot: snap, pageHtml: FormKit.capturePageHtml() });
            try { document.dispatchEvent(new CustomEvent('ff-record', { detail: 'on' })); } catch (_) {}
        }
        // ff:logs:end

        let screenshotForModel = null;
        if (window === window.top && (logOn || vision)) {
            const raw = await FormKit.captureScreenshot();
            if (raw) {
                if (logOn) log('screenshot', { turn: 0, image: await FormKit.shrinkImage(raw, 1024, 0.5) });
                if (vision) screenshotForModel = await FormKit.shrinkImage(raw, 1280, 0.7);
            }
        }

        if (overlays) {
            OverlayUtils.clearAll();
            for (const f of targets) {
                const r = FormKit.resolveRef(f.ref);
                if (r && r.el) OverlayUtils.add(r.el, 'detected', `${f.ref} ${f.label || f.placeholder || f.name || ''}`.trim());
            }
        }

        // ---- suggestions: memory + heuristics
        const profileParsed = HeuristicFiller.parseProfiles(profiles);
        const pHash = SiteMemory.profileHash(profiles);
        let memory = null;
        try { memory = await SiteMemory.lookup(location.href); } catch (_) {}
        const attachSuggestions = (fields) => {
            const memSug = memory ? SiteMemory.suggestions(memory, fields, profileParsed, pHash) : new Map();
            const infos = fields.map(f => ({ info: { label: f.label, name: f.name, id: f.id, autocomplete: f.autocomplete, type: f.type || f.kind, placeholder: f.placeholder, ariaLabel: undefined, nearbyText: f.description } }));
            let heur = { matches: {} };
            try { heur = HeuristicFiller.applyHeuristics(infos, profiles); } catch (_) {}
            fields.forEach((f, i) => {
                delete f.suggested;
                if (!fillableKinds(f)) return;
                const m = memSug.get(f.ref);
                if (m) { f.suggested = { value: m.value, from: 'memory', key: m.key }; return; }
                if (heur.matches && i in heur.matches && (f.kind === 'text' || f.kind === 'email' || f.kind === 'tel' || f.kind === 'url' || f.kind === 'textarea' || f.kind === 'combobox' || f.kind === 'number' || f.kind === 'search')) {
                    f.suggested = { value: heur.matches[i], from: 'heuristic' };
                }
            });
            return memSug;
        };
        let memSug = attachSuggestions(snap.fields);

        const details = { needsUserInput: [], skipped: [], summary: '', turns: 0, llmCalls: 0, memoryApplied: 0, stillInvalid: [], blockedProgress: [] };
        const mappingsToRemember = new Map(); // ref -> { field, key, value }
        const messages = [];
        let filledOk = 0;
        // Progression buttons we pressed ourselves: a Next that advanced the
        // form and then greyed itself out is not the page blocking us.
        const usedButtons = new Set();
        let prevSnap = snap;
        let lastResults = [];
        let lastObserved = null;

        const markOverlay = (ref, status) => {
            if (!overlays) return;
            const r = FormKit.resolveRef(ref);
            if (r && r.el) OverlayUtils.setStatus(r.el, status);
        };

        // The page moved on since the snapshot the model is answering to (a
        // step advanced, the person clicked Continue, the form re-mounted):
        // the batch would type into fields that no longer exist. Take a fresh
        // snapshot and tell the model instead of firing stale actions.
        const pageChanged = (turnLabel) => {
            const moved = FormKit.pageMoved(prevSnap);
            if (!moved.moved) return null;
            log('pageChanged', { turn: turnLabel, ...moved });
            return moved;
        };

        const executeBatch = async (actions, turnLabel) => {
            const moved = pageChanged(turnLabel);
            if (moved) {
                const after = FormKit.snapshot();
                attachSuggestions(after.fields);
                const results = actions.map(a => ({ ref: a.ref, op: a.op, value: a.value, ok: false, error: 'not executed: the page changed before this batch' }));
                log('results', { turn: turnLabel, results });
                const d = FormKit.diff(prevSnap, after);
                const observed = {
                    pageChanged: moved,
                    newFields: after.fields.filter(fillableKinds).map(FormKit.describeField),
                    removedFields: d.removed,
                    changedFields: [],
                    newButtons: after.buttons.map(FormKit.describeButton),
                    changedButtons: [],
                    invalidFields: [],
                    blockedProgress: FormKit.blockedProgress(after, { exclude: usedButtons }),
                };
                log('observed', { turn: turnLabel, ...observed, url: location.href });
                prevSnap = after;
                snap = after;
                targets = snap.fields.filter(fillableKinds);
                lastResults = results;
                lastObserved = observed;
                gateHandled = false;
                return { results, observed, after, moved };
            }
            log('actions', { turn: turnLabel, actions });
            const results = await FormKit.execute(actions, {
                isCancelled,
                onBefore: (a, target) => { if (overlays && target.el) OverlayUtils.pulseFilling(target.el, 600); },
                onAfter: (a, target, res) => {
                    const okish = res.ok && (res.accepted !== false) && !(res.validation && res.validation.invalid);
                    if (a.op === 'click' && res.ok) usedButtons.add(a.ref);
                    if (a.op !== 'click') markOverlay(a.ref, okish ? (turnLabel === 'memory' ? 'heuristic' : 'llm') : 'nomatch');
                    if (okish && a.op !== 'click' && a.op !== 'clear' && a.op !== 'commit' && a.op !== 'retype') {
                        const f = FormKit.fieldByRef(a.ref);
                        if (f) mappingsToRemember.set(a.ref, { field: f, key: a.source ? normKey(a.source) : (turnLabel === 'memory' ? (a.source || 'none') : 'none'), value: a.value });
                    } else {
                        mappingsToRemember.delete(a.ref);
                    }
                    progress(Math.min(total, countFilled()), `Filling ${f2label(a.ref)}...`);
                },
            });
            log('results', { turn: turnLabel, results });
            await waitForDomSettle(350, 2500);
            const after = FormKit.snapshot();
            attachSuggestions(after.fields);
            const d = FormKit.diff(prevSnap, after);
            const invalid = after.fields.filter(f => fillableKinds(f) && f.invalid).map(f => ({ ref: f.ref, label: f.label, value: f.value, error: f.error }));
            const navigated = String(after.url).replace(/#.*$/, '') !== String(prevSnap.url).replace(/#.*$/, '');
            const observed = {
                ...(navigated ? { pageChanged: { moved: true, reason: 'navigated', from: prevSnap.url, to: after.url } } : {}),
                newFields: d.added.filter(fillableKinds).map(FormKit.describeField),
                removedFields: d.removed,
                changedFields: d.changed,
                newButtons: d.newButtons.map(FormKit.describeButton),
                changedButtons: d.changedButtons,
                invalidFields: invalid,
                blockedProgress: FormKit.blockedProgress(after, { exclude: usedButtons }),
            };
            // Suggestion popups the autocomplete handler saw, for the log.
            log('observed', { turn: turnLabel, ...observed, url: location.href });
            for (const f of invalid) markOverlay(f.ref, 'nomatch');
            prevSnap = after;
            snap = after;
            targets = snap.fields.filter(fillableKinds);
            lastResults = results;
            lastObserved = observed;
            return { results, observed, after };
        };

        function f2label(ref) {
            const f = FormKit.fieldByRef(ref);
            return f ? (f.label || f.text || f.placeholder || f.name || ref) : ref;
        }

        function countFilled() {
            let n = 0;
            for (const f of snap.fields) if (fillableKinds(f) && !isEmptyValue(f.value) && !f.invalid) n++;
            return n;
        }

        // ---- the page's own verdict -------------------------------------
        //
        // No event simulation can be proven complete: the browser reserves
        // default actions for trusted events, and a page can always want
        // something we did not know to give it. So the loop does not trust its
        // own view of "filled"; it reads the page's verdict, and the clearest
        // verdict a form gives is whether its Continue/submit button is
        // pressable. Every required field filled, nothing flagged invalid, and
        // the button still greyed out means something never reached the page.
        function gateStuck() {
            if (FormKit.pageMoved(snap).moved) return null;    // nothing to recover on a page that left
            const gate = FormKit.progressGate(snap, { exclude: usedButtons });
            if (!gate || !gate.disabled) return null;
            // The page has a better reason to refuse; leave it to the model.
            if (targets.some(f => f.required && isEmptyValue(f.value))) return null;
            if (targets.some(f => f.invalid)) return null;
            return gate;
        }

        // The two things a person does when a form ignores what was filled:
        // click into the field and out again (so a blur-only validator runs),
        // then delete the last character and type it back. Both leave the
        // value exactly as it was.
        async function recoverGate(gate, turnLabel) {
            const refs = Array.from(mappingsToRemember.keys()).filter(ref => {
                const f = FormKit.fieldByRef(ref);
                return f && fillableKinds(f) && !isEmptyValue(f.value) &&
                       f.kind !== 'checkbox' && f.kind !== 'switch' && f.kind !== 'radio-group';
            });
            const tried = [];
            if (!refs.length) return { recovered: false, tried };

            for (const op of ['commit', 'retype']) {
                if (isCancelled()) throw new Error('Form filling stopped by user.');
                progress(countFilled(), `"${gate.text}" is still disabled; re-entering ${refs.length} field(s)...`);
                const results = await FormKit.execute(refs.map(ref => ({ ref, op })), { isCancelled });
                tried.push(op);
                await waitForDomSettle(350, 2500);
                const after = FormKit.snapshot();
                attachSuggestions(after.fields);
                prevSnap = after;
                snap = after;
                targets = snap.fields.filter(fillableKinds);
                const now = FormKit.progressGate(snap, { exclude: usedButtons });
                log('recovery', { turn: turnLabel, op, refs, results, gate: now });
                if (!now || !now.disabled) return { recovered: true, tried, gate: now };
            }
            return { recovered: false, tried };
        }

        // Set when recovery could not unblock the page, so the next model turn
        // is told about it. Consumed once.
        let gateNote = '';
        let gateHandled = false;

        async function checkGate(turnLabel) {
            if (gateHandled) return true;
            const gate = gateStuck();
            if (!gate) return true;
            gateHandled = true;
            const rec = await recoverGate(gate, turnLabel);
            if (rec.recovered) {
                details.recoveredGate = { ref: gate.ref, text: gate.text, by: rec.tried[rec.tried.length - 1] };
                return true;
            }
            details.blockedProgress = FormKit.blockedProgress(snap, { exclude: usedButtons });
            gateNote = `\n\nIMPORTANT: the page still keeps its "${gate.text}" button (${gate.ref}, kind ${gate.kind}) disabled, although every required field has a value and nothing is flagged invalid. The extension already re-entered and re-committed the fields it filled (${rec.tried.join(' then ') || 'nothing to re-enter'}) with no effect. The page is waiting for something else: a field that is not filled or that you skipped, a checkbox that must be ticked, a choice that never registered, or a value it silently rejected. Look at the whole field list again and act on it. Only if nothing is left, set done=true and tell the user in the summary what to check.`;
            return false;
        }

        try {
            // ---- memory fast path: everything empty is covered by memory
            // Unchecked boxes are a valid state, not a gap, so they do not
            // count against memory coverage (memory may still set them).
            const emptyTargets = targets.filter(f => isEmptyValue(f.value) && f.kind !== 'checkbox' && f.kind !== 'switch');
            const coveredByMemory = emptyTargets.filter(f => memSug.has(f.ref));
            // "Required and still empty" is the normal state of a fresh form,
            // not a reason to distrust memory: it is exactly what memory is
            // about to fill. Only a real rejection (a value the page refused)
            // sends us to the model.
            const realInvalid = f => f.invalid && !(f.required && isEmptyValue(f.value));
            if (emptyTargets.length > 0 && coveredByMemory.length === emptyTargets.length && !targets.some(realInvalid)) {
                progress(0, `Applying remembered mapping for this site (${coveredByMemory.length} field(s))...`);
                const actions = coveredByMemory.map(f => {
                    const s = memSug.get(f.ref);
                    const op = FormKit.normalizeOp('fill', f);
                    return { ref: f.ref, op, value: s.value, source: s.key };
                });
                const { results, observed } = await executeBatch(actions, 'memory');
                details.memoryApplied = results.filter(r => r.ok && r.accepted !== false).length;
                const allGood = results.every(r => r.ok && r.accepted !== false && !(r.validation && r.validation.invalid)) &&
                                observed.invalidFields.length === 0 && observed.newFields.length === 0;
                // Even a clean memory fill only counts if the page agrees; if
                // it does not, fall through to the model with the reason.
                if (allGood && await checkGate('memory')) {
                    details.summary = `Filled ${details.memoryApplied} field(s) from memory of a previous visit; no model call needed.`;
                    return await finish('success');
                }
                details.summary = '';
            }

            // ---- model loop
            let jsonMode = ApiUtils.providerOf(config) === 'ollama-generate';
            messages.push({ role: 'system', content: systemPrompt(profiles, customPrompt, jsonMode), cache: true });
            let firstUser = describeSnapshot(snap);
            if (lastResults.length) {
                firstUser += `\n\nThe extension already applied a remembered mapping. RESULTS:\n${JSON.stringify(lastResults.map(compactResult))}\nOBSERVED:\n${JSON.stringify(lastObserved)}\nFix what is wrong and fill what is missing.`;
            }
            if (gateNote) { firstUser += gateNote; gateNote = ''; }
            firstUser += `\n\nFill this form now by calling ${TOOL.name}.`;
            if (screenshotForModel) {
                messages.push({ role: 'user', content: [{ type: 'text', text: firstUser + '\nA screenshot of the visible part of the page is attached; field boxes in the snapshot are viewport coordinates.' }, { type: 'image_url', image_url: { url: screenshotForModel } }] });
            } else {
                messages.push({ role: 'user', content: firstUser });
            }

            let lastActionsKey = null;
            let repeats = 0;
            for (let turn = 1; turn <= maxTurns; turn++) {
                if (isCancelled()) throw new Error('Form filling stopped by user.');
                details.turns = turn;
                progress(countFilled(), `Turn ${turn}/${maxTurns}: asking ${config.model}...`);
                // ff:logs:start
                if (logOn) log('llmRequest', { turn, messages: FillLogger.slim(messages, 20000), tools: jsonMode ? null : [TOOL.name] });
                // ff:logs:end

                let resp;
                try {
                    details.llmCalls++;
                    resp = await llm(messages, { tools: jsonMode ? undefined : [TOOL], toolChoice: jsonMode ? undefined : TOOL.name, signal: abort.signal, config, jsonMode });
                } catch (e) {
                    if (e && e.message === 'Form filling stopped by user.') throw e;
                    // Endpoint without tool support: retry once in JSON mode.
                    if (!jsonMode && /tool|function/i.test(String(e && e.message)) && /400|not support|invalid/i.test(String(e && e.message))) {
                        jsonMode = true;
                        messages[0] = { role: 'system', content: systemPrompt(profiles, customPrompt, true), cache: true };
                        log('llmError', { turn, error: String(e && e.message), retryJsonMode: true });
                        details.llmCalls++;
                        resp = await llm(messages, { signal: abort.signal, config, jsonMode: true });
                    } else {
                        throw e;
                    }
                }
                if (isCancelled()) throw new Error('Form filling stopped by user.');
                log('llmResponse', { turn, text: resp.text, toolCalls: resp.toolCalls, usage: resp.usage, latencyMs: resp.latencyMs, model: resp.model, provider: resp.provider });

                const parsed = planFromResponse(resp);
                if (!parsed) {
                    log('llmError', { turn, error: 'unparseable response', text: (resp.text || '').slice(0, 1000) });
                    if (turn === 1) throw new Error('The model did not return a usable form_actions call. Response: ' + (resp.text || '').slice(0, 200));
                    break;
                }
                const { plan, call } = parsed;
                for (const s of plan.skipped) {
                    const label = f2label(s.ref);
                    if (s.needs_user_input) {
                        if (!details.needsUserInput.some(x => x.ref === s.ref)) details.needsUserInput.push({ ref: s.ref, label, reason: s.reason });
                    } else if (!details.skipped.some(x => x.ref === s.ref)) {
                        details.skipped.push({ ref: s.ref, label, reason: s.reason });
                    }
                    markOverlay(s.ref, 'nomatch');
                }
                if (plan.summary) details.summary = plan.summary;

                // Guard: identical batch twice in a row means the model is stuck.
                const key = actionsKey(plan.actions);
                if (plan.actions.length && key === lastActionsKey) {
                    repeats++;
                    if (repeats >= 1) { log('loopGuard', { turn, reason: 'identical action batch repeated' }); break; }
                }
                lastActionsKey = key;

                if (plan.actions.length === 0) {
                    break; // done, or nothing more it can do
                }

                // Refuse submit-kind buttons regardless of what the model says.
                const safeActions = [];
                const refused = [];
                for (const a of plan.actions) {
                    const b = FormKit.fieldByRef(a.ref);
                    if (b && b.kind === 'submit' && b.text !== undefined) { refused.push({ ref: a.ref, error: 'refused: submit-type button' }); continue; }
                    safeActions.push(a);
                }
                const { results, observed, moved } = await executeBatch(safeActions, turn);
                const stillInvalid = observed.invalidFields.filter(f => safeActions.some(a => a.ref === f.ref) || plan.actions.some(a => a.ref === f.ref));
                const anyRejected = results.some(r => !r.ok || r.accepted === false || (r.validation && r.validation.invalid));
                let finished = plan.done && !anyRejected && observed.newFields.length === 0 && stillInvalid.length === 0;
                // The model thinks it is done; ask the page whether it agrees.
                if (finished) finished = await checkGate(turn);
                // A page that moved on with nothing left to fill is done too.
                if (moved && targets.length === 0) finished = true;

                // Feed results back.
                const feedback = {
                    results: results.map(compactResult).concat(refused),
                    observed,
                    state: {
                        fieldsWithValue: countFilled(),
                        fillable: targets.length,
                        invalid: observed.invalidFields.length,
                        emptyRequired: targets.filter(f => f.required && isEmptyValue(f.value)).map(f => ({ ref: f.ref, label: f.label })),
                        progressGate: FormKit.progressGate(snap, { exclude: usedButtons }),
                    },
                };
                let feedbackText;
                if (moved) {
                    feedbackText = `PAGE CHANGED before your actions ran (${moved.reason}${moved.to ? ': now ' + moved.to : ''}); none of them were executed and their refs are gone.\n\n${describeSnapshot(snap)}\n\nSTATE: ${JSON.stringify(feedback.state)}`;
                    lastActionsKey = null;
                } else {
                    feedbackText = `RESULTS:\n${JSON.stringify(feedback.results)}\nOBSERVED after the actions:\n${JSON.stringify(feedback.observed)}\nSTATE: ${JSON.stringify(feedback.state)}`;
                }
                if (gateNote) { feedbackText += gateNote; gateNote = ''; }
                if (finished || turn === maxTurns) {
                    // No further model call; record for the log only.
                    log('feedback', { turn, feedback, final: true });
                    break;
                }
                feedbackText += moved
                    ? `\n\nFill this page now by calling ${TOOL.name} with refs from the snapshot above, or set done=true with no actions if nothing on it belongs to the profile.`
                    : `\n\nFix rejected/invalid fields (use a different format or a listed option; do not repeat a rejected value), fill any new fields, or set done=true with no actions if the form is complete as far as the profile allows.`;
                messages.push(resp.assistantMessage);
                if (call && call.id && !jsonMode) {
                    messages.push({ role: 'tool', tool_call_id: call.id, content: feedbackText });
                } else {
                    messages.push({ role: 'user', content: feedbackText });
                }
            }
            return await finish('success');
        } catch (error) {
            console.error('[FillAgent] Error:', error);
            if (overlays) OverlayUtils.clearAll();
            log('error', { error: String(error && error.message), stack: error && error.stack });
            if (error && error.message === 'Form filling stopped by user.') {
                notify({ action: 'fillFormStopped', filled: countFilled(), processed: countFilled(), total, message: 'Form filling stopped by user.' });
                window.stopFilling = false;
            } else {
                notify({ action: 'fillFormError', error: String(error && error.message ? error.message : error) });
            }
            // ff:logs:start
            if (logOn) FillLogger.end({ status: 'error', error: String(error && error.message), durationMs: Date.now() - t0 });
            // ff:logs:end
            return { status: 'error', message: String(error && error.message) };
        } finally {
            if (window.abortController === abort) window.abortController = null;
        }

        async function finish(status) {
            const finalSnap = FormKit.snapshot();
            attachSuggestions(finalSnap.fields);
            snap = finalSnap;
            targets = snap.fields.filter(fillableKinds);
            // Fields can appear mid-fill (wizard steps), so report against the
            // final field count, not the count the fill started with.
            const finalTotal = Math.max(total, targets.length);
            filledOk = Math.min(countFilled(), finalTotal);
            details.stillInvalid = targets.filter(f => f.invalid).map(f => ({ ref: f.ref, label: f.label, value: f.value, error: f.error }));
            details.emptyRequired = targets.filter(f => f.required && isEmptyValue(f.value)).map(f => ({ ref: f.ref, label: f.label }));
            details.durationMs = Date.now() - t0;
            const finalGate = FormKit.progressGate(snap, { exclude: usedButtons });
            details.progressGate = finalGate;
            details.blockedProgress = FormKit.blockedProgress(snap, { exclude: usedButtons }).map(b => ({ ...b, label: b.text, reason: 'the page still keeps this button disabled' }));

            try {
                const mappings = Array.from(mappingsToRemember.values()).filter(m => {
                    const f = FormKit.fieldByRef(m.field.ref);
                    return f && !f.invalid && !isEmptyValue(f.value);
                });
                if (mappings.length) await SiteMemory.remember(location.href, mappings, pHash);
            } catch (e) { console.warn('[FillAgent] memory update failed', e); }

            try { simulateMouseClick(document.body, true); } catch (_) {}

            log('finalState', { snapshot: finalSnap, details, progressGate: finalGate, primaryButtonDisabled: !!(finalGate && finalGate.disabled) });
            if (window === window.top && logOn) {
                const raw = await FormKit.captureScreenshot();
                if (raw) log('screenshot', { turn: 'final', image: await FormKit.shrinkImage(raw, 1024, 0.5) });
            }
            // ff:logs:start
            if (logOn) FillLogger.end({ status, filled: filledOk, total, details, durationMs: details.durationMs });
            // ff:logs:end

            const parts = [`Filled ${filledOk} of ${finalTotal} field(s) in ${(details.durationMs / 1000).toFixed(1)}s (${details.llmCalls} model call${details.llmCalls === 1 ? '' : 's'}).`];
            if (details.summary) parts.push(details.summary);
            if (details.needsUserInput.length) parts.push('Needs your input: ' + details.needsUserInput.map(x => x.label || x.ref).join(', ') + '.');
            if (details.stillInvalid.length) parts.push('Still flagged by the page: ' + details.stillInvalid.map(x => `${x.label || x.ref}${x.error ? ' (' + x.error + ')' : ''}`).join('; ') + '.');
            if (details.recoveredGate) parts.push(`"${details.recoveredGate.text}" only became clickable after re-entering the fields (${details.recoveredGate.by}).`);
            if (details.blockedProgress.length) parts.push('The page still keeps ' + details.blockedProgress.map(b => `"${b.text}"`).join(', ') + ' disabled, so it is waiting for something more.');
            const message = parts.join(' ');
            try { updateFillProgress(finalTotal, filledOk, finalTotal, message, sessionId); } catch (_) {}
            notify({ action: 'fillFormComplete', filled: filledOk, total: finalTotal, message, details });
            if (overlays) setTimeout(() => OverlayUtils.clearAll(), 2500);
            return { status, message, filled: filledOk, total: finalTotal, details };
        }
    }

    return { run, TOOL, RULES, describeSnapshot, planFromResponse };
})();

if (typeof window !== 'undefined') window.FillAgent = FillAgent;
