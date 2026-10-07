// agent_harness.js -- run the real extension sources inside a plain page.
//
// Usage (from a browser console or an automation tool on a page served by
// `node test/serve.js`):
//
//   const s = document.createElement('script'); s.src = '/test/agent_harness.js'; document.head.appendChild(s);
//   await FFHarness.load();                       // loads /src/*.js in manifest order with a stubbed `browser`
//   FormKit.snapshot()                            // inspect what the extension sees
//   await FFHarness.runAgent({ profiles, turns }) // drive FillAgent with a scripted mock LLM
//   FFHarness.logs                                // everything FillLogger recorded (in memory)
//
// `turns` is an array of form_actions plans (one per model call). A function
// (messages, opts) => plan is also accepted for adaptive scripts.
(function () {
    'use strict';

    const storage = {};
    const logs = { sessions: {}, order: [] };
    const listeners = [];

    function clone(x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); }

    const browserStub = {
        runtime: {
            getManifest: () => ({ version: 'harness', manifest_version: 3 }),
            getURL: (p) => '/src/' + p,
            sendMessage: async (msg) => {
                if (!msg) return undefined;
                if (msg.action === 'ffLog') {
                    if (msg.op === 'start') { logs.sessions[msg.sessionId] = { id: msg.sessionId, meta: msg.meta, entries: [] }; logs.order.push(msg.sessionId); }
                    else if (msg.op === 'append' && logs.sessions[msg.sessionId]) logs.sessions[msg.sessionId].entries.push(msg.entry);
                    else if (msg.op === 'end' && logs.sessions[msg.sessionId]) logs.sessions[msg.sessionId].summary = msg.summary;
                    return { ok: true };
                }
                if (msg.action === 'captureScreenshot') return { dataUrl: null };
                if (msg.action === 'ffLogList') return { list: logs.order.map(id => ({ id })) };
                if (msg.action === 'ffLogGet') return { sessions: logs.order.map(id => logs.sessions[id]) };
                // progress / complete notifications
                harness.messages.push(clone(msg));
                for (const l of listeners) { try { l(msg, { frameId: 0 }, () => {}); } catch (_) {} }
                return undefined;
            },
            onMessage: { addListener: (fn) => listeners.push(fn) },
        },
        storage: {
            local: {
                get: async (keys) => {
                    if (keys == null) return clone(storage);
                    const ks = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
                    const out = {};
                    for (const k of ks) if (k in storage) out[k] = clone(storage[k]);
                    return out;
                },
                set: async (obj) => { for (const k of Object.keys(obj)) storage[k] = clone(obj[k]); },
                remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k]; },
            },
            onChanged: { addListener: () => {} },
        },
        tabs: { query: async () => [] },
    };

    const FILES = [
        'browserCompat.js', 'apiUtils.js', 'utils.js', 'accessibleName.js', 'eventSim.js', 'domUtils.js',
        'typingEngine.js', 'autocompleteFiller.js', 'choiceWidget.js', 'dateField.js', 'llmClient.js', 'heuristicFiller.js',
        'overlayUtils.js', 'formKit.js', 'siteMemory.js', 'fillLogger.js', 'fillAgent.js'
    ];

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('failed to load ' + src));
            document.head.appendChild(s);
        });
    }

    const harness = {
        logs, storage, messages: [], FILES,
        // `files` overrides the default list, so a built package can be driven
        // as well as the source tree: load('/dist/chrome/', FFHarness.FILES.filter(f => f !== 'fillLogger.js'))
        async load(base = '/src/', files = FILES) {
            window.browser = browserStub;
            window.chrome = window.chrome || browserStub;
            for (const f of files) await loadScript(base + f);
            return true;
        },
        // Mock LLM: returns a scripted plan per call as a tool call.
        mockLLM(turns) {
            let i = 0;
            const calls = [];
            const fn = async (messages, opts) => {
                const plan = typeof turns === 'function' ? await turns(messages, opts, i) : (turns[i] || { actions: [], done: true, summary: 'script exhausted' });
                i++;
                calls.push({ messages: clone(messages), plan: clone(plan) });
                return {
                    text: '',
                    toolCalls: [{ id: 'call_' + i, name: 'form_actions', args: clone(plan), rawArgs: JSON.stringify(plan) }],
                    assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id: 'call_' + i, type: 'function', function: { name: 'form_actions', arguments: JSON.stringify(plan) } }] },
                    usage: null, latencyMs: 1, provider: 'mock', model: 'mock', supportsTools: true,
                };
            };
            fn.calls = calls;
            return fn;
        },
        async runAgent({ profiles, turns, customPrompt = '', config = {}, sessionId }) {
            const llm = typeof turns === 'function' && turns.calls ? turns : harness.mockLLM(turns);
            harness.lastLLM = llm;
            const result = await FillAgent.run({
                profiles, customPrompt, sessionId: sessionId || ('harness-' + Date.now()),
                llm, config: { model: 'mock', apiUrl: 'mock://chat/completions', maxTurns: 4, ...config },
            });
            return { result, calls: llm.calls, logs: harness.logs };
        },
        lastSession() { const id = logs.order[logs.order.length - 1]; return logs.sessions[id]; },
    };

    window.FFHarness = harness;
})();
