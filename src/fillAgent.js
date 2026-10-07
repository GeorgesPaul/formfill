// fillAgent.js -- look, act, look again.
//
// The whole of form filling is this loop, run once in every frame that has
// fields:
//
//   1. PageView.capture() shows the page as text, top to bottom, with a
//      number on everything that can be acted on.
//   2. The model reads that text next to the user's profile and answers
//      with a batch of human actions: type, choose, check, click, press.
//   3. Hands.run() performs them and reports what each control shows now.
//   4. The page is captured again, with what is new since the last look
//      marked. Back to 2, until the model has nothing left to do.
//
// The extension does not classify widgets, guess labels, verify values or
// repair fields. A dropdown that opens a list, a date in three parts, a field
// that appears after a choice: the model sees what happened and acts on it,
// like a person, so a widget nobody has met before needs no new code here.
// What it costs is one more look for every change of the page; a plain form
// is one look.
// ff:logs:start
//
// In development builds every step is recorded through FillLogger. Store
// builds are packaged without it (build.ps1 -Channel store).
// ff:logs:end
const FillAgent = (function () {
    'use strict';

    const TOOL = {
        name: 'form_actions',
        description: 'Act on the page: type into fields, choose from lists, check boxes, click, press keys. Set done=true when nothing is left for you to do.',
        parameters: {
            type: 'object',
            properties: {
                actions: {
                    type: 'array',
                    description: 'Actions to perform in order, top to bottom as a person would go through the form.',
                    items: {
                        type: 'object',
                        properties: {
                            op: { type: 'string', enum: ['type', 'choose', 'check', 'click', 'press'] },
                            ref: { type: 'integer', description: 'The number in brackets of the thing to act on. Not needed for press, nor for a click on something without a number.' },
                            value: { description: 'type: the text. choose: the visible text of the entry. check: true or false. press: the key name. click: omit, or (with no ref) the exact visible text of the thing to click.' },
                            note: { type: 'string', description: 'Optional, a few words: why, when it is not obvious.' },
                        },
                        required: ['op'],
                    },
                },
                needs_user: {
                    type: 'array',
                    description: 'Things the form needs that the profile does not have, for the user to fill in.',
                    items: {
                        type: 'object',
                        properties: {
                            ref: { type: 'integer', description: 'Its number, when it has one.' },
                            what: { type: 'string', description: 'The field or choice, as the user would call it.' },
                            reason: { type: 'string' },
                        },
                        required: ['what'],
                    },
                },
                done: { type: 'boolean', description: 'true when, once these actions have run, nothing is left for you to do.' },
                summary: { type: 'string', description: 'One or two sentences for the user: what was filled, what they still have to do.' },
            },
            required: ['actions', 'done'],
        },
    };

    const RULES = `You fill in web forms for the user, the way a person would who sits at the page with the user's profile data next to them. You see the page as text and act on it through the form_actions tool. After your actions have run you are shown the page again, and so on until the form is filled.

HOW THE PAGE IS SHOWN
- Top to bottom, as a person reads it. Anything you can act on starts with a number in brackets, for example: [12] text field = "current value" (details).
- A field's label is the text next to it: usually just before it, sometimes right after it, sometimes inside it as a placeholder. Text in quotes directly after the kind of control is the control's own built-in name. "name=" and "autocomplete=" are the page's internal names: useful hints, not always right.
- "…" stands for parts of the page left out because nothing fillable is there.
- shows "..." is what a control's box displays while the control itself holds no typed text. For a field that opens a list it is the chosen entry (or a prompt such as "Select..."): such a field is filled, not empty. For a plain text box it is usually its label.
- Lines starting with "+" are new or changed since you last looked: a list that opened, fields that appeared, an error message, a field whose content changed (its earlier content is shown as: was "...").
- "ON TOP OF THE PAGE" lists what lies over the page right now (an open list, a pop-up, a banner). Fields marked "covered" cannot be reached until that is dealt with.
- You see one frame of the page. "(embedded frame ...)" marks a part that lives in another frame. It is filled by a separate run of this tool: never tell the user to fill it in and never report it as missing.

ACTIONS (each has op, ref = the number, value)
- type: click into the field and type value on the keyboard. In a text box this replaces what was there; value "" empties it. A field that says "type it as yyyy-mm-dd" (or another pattern) takes exactly that pattern.
- choose: pick from a dropdown, a combobox, or any field that opens a list. value is the visible text of the entry you want. When the list has no such entry you are shown the entries it does have; choose again with one of those, or click the entry by its number.
- check: value true or false for a checkbox or switch; value true on a radio button selects it.
- click: press a button, a tab, an entry in an open list, a day in a calendar. Something a person would click that carries no number (a card, a tile, a row of an option list) is clicked by its words: leave ref out and give its exact visible text as value.
- press: one key wherever the cursor is (Tab, Escape, ArrowDown, ArrowUp, Enter, Backspace). Enter only to accept the highlighted entry of an open list.
Put the actions in the order a person would go through the form, top to bottom. They run one after another on the page as it is at that moment, so a later action may rely on what an earlier one causes (choose the country, then the region whose list fills because of it).
When a click or a key makes something new appear (a list, a dialog, more fields), the batch stops there and you are shown the page: the actions after it are not run. A click that only makes something go away (closing a banner) lets the batch carry on.

WHAT COMES BACK
- For each action: what the control shows now ("now"), or why it could not be done. Pages reformat what is typed (spaces in a card number, capitals, a date mask); that is fine while it still means the same. When it does not, fix it.
- "suggestions" means a list opened under the field while typing, and the batch stopped there. Deal with it first, because acting elsewhere closes it: click the entry that fits (its number is in the new page view), or carry on if none is needed.
- Actions listed as not run were skipped because the page had to be looked at first. Issue them again if they are still wanted.
- A click noted as "nothing visible on the page changed" did nothing. Do not press it again; finish, and mention it in the summary if it matters.
- Then the page as it is now.

RULES
- Use only the user's profile data. Never invent names, addresses, dates or numbers. You may reformat and combine what the profile has.
- Fill every field you have data for, required or not. Leave alone what you have no data for, and list under needs_user what the form requires but the profile lacks.
- Fields that already hold the right value are left alone. Correct a pre-filled value only when it is clearly wrong for this profile.
- Give values in the shape the field shows it wants: its placeholder or example, its length limit, the language and conventions of the page, the entries of its list. Keep the profile's own capitalisation and spacing for names and other words; numbers (phone, card, tax, bank) are typed as plain digits unless the field shows a pattern.
- Split fields get split values: day / month / year, first and last name, street and house number. A date shown as separate small parts next to each other is typed part by part. A phone number whose country prefix has its own box, or is already shown, is typed without that prefix.
- Consent boxes: tick the ones required to proceed (terms, privacy). Do not tick optional marketing, newsletter or third-party boxes unless the profile or the user's instructions say so.
- Never fill password fields; the user has a separate tool for those.
- Never send the form. Buttons such as Submit, Pay, Order, Buy, Register, Sign in, Save, Confirm or Send are the user's to press. You may click what only reveals or leads to more fields (Next, Continue, Add, Edit, "enter manually"), once the visible fields are filled. When such a button stays disabled after everything is filled, do not wait for it: say so in the summary, with your best reading of what the page still wants.
- A choice the profile says nothing about and that matters to the user (a paid option, a delivery method, a plan) is not yours to make: leave it and list it under needs_user.
- Something lying on top of the page (a cookie banner, a pop-up) is dismissed only when it covers fields you need, and then in the least committing way it offers (Reject, Only necessary, Close). What is not in the way is left alone.
- Do not repeat an action that has just failed in the same way. If a field cannot be satisfied, leave it and say so in the summary.
- done=true means that once the actions of this answer have run, nothing is left for you to do. When you are shown the page and everything is in order, answer with no actions and done=true.
- summary: short and useful for the user. What was filled, and what they must still do themselves (including pressing the button that sends the form).`;

    const STOPPED = 'Form filling stopped by user.';
    const notifyPanel = msg => { try { Compat.notify(msg); } catch (_) {} };

    // The fill running in this frame, if any: { sessionId, abort, stopped }.
    let current = null;

    function stop() {
        if (!current) return;
        current.stopped = true;
        current.abort.abort();
    }

    // ------------------------------------------------------------ what the model is told

    function systemPrompt(profiles, customPrompt, jsonMode) {
        const profileText = profiles.map(p => `=== ${p.name || 'Profile'} ===\n${(p.data || '').trim()}`).join('\n\n');
        const parts = [
            RULES,
            `\nToday's date: ${new Date().toISOString().slice(0, 10)}. Browser language: ${navigator.language || 'unknown'}. Page language: ${document.documentElement.lang || 'unknown'}.`,
            `\nUSER PROFILE DATA:\n${profileText}`,
        ];
        if (customPrompt) parts.push(`\nADDITIONAL INSTRUCTIONS FROM THE USER (these override the rules above where they conflict):\n${customPrompt}`);
        if (jsonMode) {
            parts.push(`\nThis endpoint does not support tools. Respond with ONE JSON object only, no prose, no markdown fences, with this shape:\n${JSON.stringify({ actions: [{ op: 'type', ref: 12, value: '...' }], needs_user: [{ ref: 9, what: '...', reason: '...' }], done: true, summary: '...' })}`);
        }
        return parts.join('\n');
    }

    function pageText(view) {
        const head = `PAGE: ${view.title || ''} (${view.url})${view.frame === 'iframe' ? ' [this is a frame embedded in another page]' : ''}`;
        return head + '\n\n' + (view.text || '(nothing fillable is visible)');
    }

    // What the hands did, as the model is told it.
    function resultsText(exec) {
        const lines = ['RESULTS:'];
        for (const r of exec.results) {
            const line = { op: r.op };
            if (r.ref !== undefined) line.ref = r.ref;
            if (r.value !== undefined && r.op !== 'click') line.value = r.value;
            line.ok = !!r.ok;
            if (r.now !== undefined) line.now = r.now;
            if (r.picked) line.picked = r.picked;
            if (r.note) line.note = r.note;
            if (r.suggestions) line.suggestions = r.suggestions;
            if (r.shown) line.entries_it_has = r.shown;
            if (r.error) line.error = r.error;
            lines.push(JSON.stringify(line));
        }
        if (exec.notExecuted.length) {
            lines.push(`NOT RUN (${exec.stopped || 'the batch ended early'}):`);
            for (const a of exec.notExecuted) lines.push(JSON.stringify({ op: a.op, ref: a.ref, value: a.value }));
        }
        return lines.join('\n');
    }

    // The model's answer: the arguments of its form_actions call (or, from an
    // endpoint without tools, the JSON object it wrote).
    function planFrom(resp) {
        const call = (resp.toolCalls || []).find(c => c.name === TOOL.name) || (resp.toolCalls || [])[0];
        const plan = (call && call.args && typeof call.args === 'object') ? call.args : (resp.text ? ApiUtils.parseJsonLoose(resp.text) : null);
        if (!plan || typeof plan !== 'object') return null;
        return {
            call,
            actions: (Array.isArray(plan.actions) ? plan.actions : []).filter(a => a && a.op && (a.ref !== undefined || a.value !== undefined)),
            needsUser: (Array.isArray(plan.needs_user) ? plan.needs_user : []).filter(n => n && (n.what || n.ref !== undefined)),
            done: plan.done === true || plan.done === 'true',
            summary: plan.summary || '',
        };
    }

    // ------------------------------------------------------------ judging a batch

    const fillable = view => view.fields.filter(f => !f.disabled && !f.secret && !f.readonly);

    function isFilled(f) {
        if (f.toggle) return !!f.checked;
        if (f.reads && /^empty$/i.test(f.reads)) return false;
        // A list field shows its choice in its box, not as typed text.
        return !!f.value || (!!f.shows && f.open !== undefined);
    }

    // Did the action leave the control showing what was meant, to the letter?
    // Only used to decide whether the model has to look once more; anything
    // short of an exact result gets that look.
    function asMeant(r) {
        if (!r.ok || r.op !== 'type') return !!r.ok;
        const meant = String(r.value == null ? '' : r.value), now = String(r.now == null ? '' : r.now);
        const bare = s => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        return now === meant || (/\d/.test(meant) && bare(now) === bare(meant));
    }

    // ------------------------------------------------------------ screenshots

    // Re-encode a data URL as a smaller JPEG.
    function shrinkImage(dataUrl, maxWidth, quality) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxWidth / img.width);
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch (_) { resolve(dataUrl); }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    // The visible part of the tab, as only the background page can capture it.
    async function screenshot() {
        try {
            const res = await browser.runtime.sendMessage({ action: 'captureScreenshot' });
            return (res && res.dataUrl) || null;
        } catch (_) { return null; }
    }

    // ------------------------------------------------------------ run

    // opts: profiles [{name, data}], customPrompt, sessionId, vision (attach a
    // screenshot to the first look). For tests: llm (stands in for
    // ApiUtils.chat), config, maxLooks, logging: false.
    async function run(opts) {
        const { profiles, customPrompt = '', sessionId = null, vision = false } = opts;
        stop();   // a new fill replaces one still running in this frame
        const me = current = { sessionId, abort: new AbortController(), stopped: false };
        const isCancelled = () => me.stopped || current !== me;
        const notify = msg => notifyPanel({ ...msg, sessionId });
        const t0 = Date.now();

        // Every frame that got the fill says so at once, before any waiting:
        // the panel's progress stays up until each one has started and
        // finished, or said it has no fields.
        notify({ action: 'fillFormJoin' });
        const leave = result => {
            if (current === me) current = null;
            notify({ action: 'fillFormLeave' });
            return result;
        };

        if (!Array.isArray(profiles) || profiles.length === 0) {
            if (current === me) current = null;
            notify({ action: 'fillFormError', error: 'No profile selected.' });
            return { status: 'error', message: 'No profile selected.' };
        }
        const llm = opts.llm || ((messages, o) => ApiUtils.chat(messages, o));
        const config = opts.config || await ApiUtils.getLlmConfig();
        const maxLooks = opts.maxLooks || Math.max(2, Math.min(20, Number(config.maxLooks) || 12));

        // Wait for the page to finish loading, but not for a page that never
        // does (a stalled ad or tracker keeps "complete" away forever).
        await new Promise(resolve => {
            if (document.readyState === 'complete') return resolve();
            window.addEventListener('load', resolve, { once: true });
            setTimeout(resolve, 8000);
        });
        if (isCancelled()) return leave({ status: 'error', message: STOPPED });

        const input = (await TrustedInput.probe(true)).available ? TrustedInput.backend() : 'synthetic';

        PageView.reset();
        let view = PageView.capture();
        if (fillable(view).length === 0) {
            return leave({ status: 'success', message: 'No form fields in this frame.', filled: 0 });
        }
        notify({ action: 'fillFormStart' });

        // Progress is counted in actions: done so far, of those known so far.
        const filled = new Set();   // the numbers of the controls filled in
        let stepsDone = 0, stepsKnown = 1;
        const progress = message => {
            notify({ action: 'fillFormProgress', processed: Math.min(stepsDone, stepsKnown - 1), filled: Math.min(stepsDone, stepsKnown - 1), total: stepsKnown, message });
        };
        progress(`Found ${fillable(view).length} field(s). Preparing...`);

        // ---- fill logs (development builds only; see build.ps1 -Channel)
        let logging = false;
        let log = () => {};
        // ff:logs:start
        logging = opts.logging !== false && await FillLogger.start(sessionId, {
            model: config.model, apiUrl: config.apiUrl, reasoningEffort: config.reasoningEffort, maxLooks,
            vision: !!vision, customPrompt, profiles: profiles.map(p => ({ name: p.name, data: p.data })),
            extensionVersion: browser.runtime.getManifest().version,
            userAgent: navigator.userAgent,
            input,
        });
        if (logging) {
            log = (type, payload) => FillLogger.event(type, payload);
            log('view', { look: 0, text: view.text, pageHtml: FillLogger.pageHtml() });
        }
        // ff:logs:end

        let screenshotForModel = null;
        if (window === window.top && (vision || logging)) {
            const shot = await screenshot();
            if (shot && logging) log('screenshot', { look: 0, image: await shrinkImage(shot, 1024, 0.5) });
            if (shot && vision) screenshotForModel = await shrinkImage(shot, 1280, 0.7);
        }

        OverlayUtils.clearAll();
        for (const f of fillable(view)) OverlayUtils.add(f.el, 'seen', `[${f.ref}] ${f.name || f.placeholder || f.hint || ''}`.trim());

        const details = { summary: '', needsUserInput: [], stillInvalid: [], emptyRequired: [], looks: 0, llmCalls: 0 };

        try {
            let jsonMode = ApiUtils.providerOf(config) === 'ollama-generate';
            const messages = [{ role: 'system', content: systemPrompt(profiles, customPrompt, jsonMode), cache: true }];
            const first = pageText(view) + `\n\nFill this form now by calling ${TOOL.name}.`;
            messages.push(screenshotForModel
                ? { role: 'user', content: [{ type: 'text', text: first + '\nA screenshot of the visible part of the page is attached.' }, { type: 'image_url', image_url: { url: screenshotForModel } }] }
                : { role: 'user', content: first });
            PageView.commit(view);

            let lastBatch = null, lastDigest = view.digest, unchanged = 0;
            for (let look = 1; look <= maxLooks; look++) {
                if (isCancelled()) throw new Error(STOPPED);
                details.looks = look;
                progress(`Look ${look}: asking ${config.model}...`);
                // ff:logs:start
                if (logging) log('llmRequest', { look, messages: FillLogger.slim(messages, 20000), tools: jsonMode ? null : [TOOL.name] });
                // ff:logs:end

                const ask = json => llm(messages, { tools: json ? undefined : [TOOL], toolChoice: json ? undefined : TOOL.name, signal: me.abort.signal, config, jsonMode: json });
                let resp;
                details.llmCalls++;
                try {
                    resp = await ask(jsonMode);
                } catch (e) {
                    const text = String(e && e.message);
                    // An endpoint without tool support: once more, asking for plain JSON.
                    if (jsonMode || text === STOPPED || !(/tool|function/i.test(text) && /400|not support|invalid/i.test(text))) throw e;
                    jsonMode = true;
                    messages[0] = { role: 'system', content: systemPrompt(profiles, customPrompt, true), cache: true };
                    log('llmError', { look, error: text, retryJsonMode: true });
                    details.llmCalls++;
                    resp = await ask(true);
                }
                if (isCancelled()) throw new Error(STOPPED);
                log('llmResponse', { look, text: resp.text, toolCalls: resp.toolCalls, usage: resp.usage, latencyMs: resp.latencyMs, model: resp.model, provider: resp.provider });

                const plan = planFrom(resp);
                if (!plan) {
                    log('llmError', { look, error: 'unparseable response', text: (resp.text || '').slice(0, 1000) });
                    if (look === 1) throw new Error('The model did not return a usable form_actions call. Response: ' + (resp.text || '').slice(0, 200));
                    break;
                }
                for (const n of plan.needsUser) {
                    const el = n.ref !== undefined && n.ref !== null ? PageView.resolve(n.ref) : null;
                    const label = n.what || (el ? PageView.label(el) : String(n.ref));
                    if (!details.needsUserInput.some(x => x.label === label)) details.needsUserInput.push({ ref: n.ref, label, reason: n.reason || '' });
                    if (el) OverlayUtils.setStatus(el, 'failed');
                }
                if (plan.summary) details.summary = plan.summary;
                if (plan.actions.length === 0) break;

                // The same batch twice in a row means the model is stuck.
                const batch = JSON.stringify(plan.actions.map(a => [a.op, a.ref, a.value]));
                if (batch === lastBatch) { log('loopGuard', { look, reason: 'identical action batch repeated' }); break; }
                lastBatch = batch;

                log('actions', { look, actions: plan.actions });
                stepsKnown = stepsDone + plan.actions.length + 1;
                const exec = await Hands.run(plan.actions, {
                    isCancelled,
                    onBefore: (a, el) => { if (el) OverlayUtils.pulse(el, 600); },
                    onAfter: (a, el, r) => {
                        stepsDone++;
                        if (r.ok && el && (r.op === 'choose' || r.op === 'check' || (r.op === 'type' && r.value !== ''))) filled.add(PageView.parseRef(r.ref));
                        if (el && r.op !== 'click') OverlayUtils.setStatus(el, r.ok ? 'filled' : 'failed');
                        progress(`${r.op} ${r.what ? '"' + String(r.what).slice(0, 40) + '"' : ''}...`);
                    },
                });
                log('results', { look, results: exec.results, stopped: exec.stopped, notExecuted: exec.notExecuted });

                // Look again. A batch that ran to its end leaves the last field
                // first, as a person moving on does, so what validates on
                // leaving has had its say. A batch cut short is looked at as
                // it stands (an open list must stay open).
                await Hands.atRest(250, 2000);
                if (!exec.stopped && Hands.letGo()) await Hands.atRest(200, 1200);
                view = PageView.capture();
                log('view', { look, text: view.text, hasNew: view.hasNew, url: location.href });

                // The model may stop without another look only when every
                // action did to the letter what was meant, nothing new showed
                // up, and no field changed that it did not touch itself (a
                // value the page filled in or wiped as a side effect).
                const acted = new Set(exec.results.map(r => PageView.parseRef(r.ref)));
                const sideEffects = view.fields.some(f => f.changed && !acted.has(f.ref));
                const clean = !exec.stopped && exec.notExecuted.length === 0 && exec.results.every(asMeant);
                if (plan.done && clean && !view.hasNew && !sideEffects) break;
                if (look === maxLooks) break;
                // Two batches in a row that left the page looking the same:
                // nothing more is going to happen here.
                unchanged = view.digest === lastDigest ? unchanged + 1 : 0;
                lastDigest = view.digest;
                if (unchanged >= 2) { log('loopGuard', { look, reason: 'the page did not change in two batches' }); break; }

                const feedback = [resultsText(exec), '', 'THE PAGE NOW:', pageText(view), '',
                    'Carry on: fix what went wrong, act on what is new, fill what is still empty. If nothing is left for you to do, answer with no actions and done=true.'].join('\n');
                messages.push(resp.assistantMessage);
                messages.push(plan.call && plan.call.id && !jsonMode
                    ? { role: 'tool', tool_call_id: plan.call.id, content: feedback }
                    : { role: 'user', content: feedback });
                PageView.commit(view);
            }

            // ---- done: what the page said at the last look goes to the panel
            if (Hands.letGo()) await Hands.atRest(150, 800);
            const label = f => f.name || f.placeholder || f.hint || `[${f.ref}]`;
            details.stillInvalid = fillable(view).filter(f => f.invalid).map(f => ({ ref: f.ref, label: label(f) }));
            details.emptyRequired = fillable(view).filter(f => f.required && !isFilled(f)).map(f => ({ ref: f.ref, label: label(f) }));
            details.durationMs = Date.now() - t0;
            details.input = input;
            if (input !== 'synthetic') details.inputStats = { ...TrustedInput.stats };

            // ff:logs:start
            if (logging) {
                log('finalState', { values: FillLogger.values(), details });
                const shot = window === window.top ? await screenshot() : null;
                if (shot) log('screenshot', { look: 'final', image: await shrinkImage(shot, 1024, 0.5) });
                FillLogger.end({ status: 'success', filled: filled.size, details, durationMs: details.durationMs });
            }
            // ff:logs:end

            const parts = [`Filled ${filled.size} field(s) in ${(details.durationMs / 1000).toFixed(1)}s (${details.llmCalls} model call${details.llmCalls === 1 ? '' : 's'}).`];
            if (details.summary) parts.push(details.summary);
            if (details.needsUserInput.length) parts.push('Needs your input: ' + details.needsUserInput.map(x => x.label).join(', ') + '.');
            if (details.stillInvalid.length) parts.push('Still flagged by the page: ' + details.stillInvalid.map(x => x.label).join('; ') + '.');
            const message = parts.join(' ');
            notify({ action: 'fillFormComplete', filled: filled.size, total: stepsDone, message, details });
            setTimeout(() => OverlayUtils.clearAll(), 2500);
            return { status: 'success', message, filled: filled.size, details };
        } catch (error) {
            const text = String((error && error.message) || error);
            OverlayUtils.clearAll();
            if (text !== STOPPED) console.error('[FillAgent]', error);
            log('error', { error: text, stack: error && error.stack });
            if (text === STOPPED) notify({ action: 'fillFormStopped', filled: filled.size, processed: stepsDone, total: stepsKnown, message: STOPPED });
            else notify({ action: 'fillFormError', error: text });
            // ff:logs:start
            if (logging) FillLogger.end({ status: 'error', error: text, durationMs: Date.now() - t0 });
            // ff:logs:end
            return { status: 'error', message: text };
        } finally {
            if (current === me) current = null;
        }
    }

    return { run, stop, sessionId: () => (current ? current.sessionId : null), TOOL, RULES };
})();

if (typeof window !== 'undefined') window.FillAgent = FillAgent;
