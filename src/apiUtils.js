// apiUtils.js -- one chat() entry point for every LLM endpoint the extension
// talks to, with tool calling and (optional) images.
//
// Endpoints, detected from the configured URL:
//   .../v1/chat/completions   OpenAI-compatible (OpenRouter, OpenAI, Ollama's
//                             /v1, LM Studio, vLLM). Tools + images supported.
//   .../api/chat              Ollama native chat. Tools + images supported.
//   .../api/generate          Ollama legacy generate. Text only; the agent
//                             falls back to JSON-in-text for its actions.
//
// Anthropic prompt caching and reasoning effort are applied on OpenRouter.

(function(global) {
    'use strict';

    const ApiUtils = {};

    // Retired model slugs and what replaces them. Saved configs are rewritten
    // once; a config still named after the old model gets the new name too.
    const MODEL_UPGRADES = {
        'anthropic/claude-opus-5': { model: 'anthropic/claude-opus-5.5', oldName: 'Claude Opus 5', newName: 'Claude Opus 5.5' },
    };

    ApiUtils.migrateLlmConfigs = async function() {
        const data = await browser.storage.local.get(['llmConfigurations', 'currentLlmConfig']);
        const configs = data.llmConfigurations;
        if (!configs) return;
        let current = data.currentLlmConfig;
        let changed = false;
        const out = {};
        for (const [name, cfg] of Object.entries(configs)) {
            const up = MODEL_UPGRADES[cfg && cfg.model];
            if (!up) { out[name] = cfg; continue; }
            const newName = (name === up.oldName && !configs[up.newName]) ? up.newName : name;
            out[newName] = { ...cfg, model: up.model };
            if (current === name) current = newName;
            changed = true;
        }
        if (changed) await browser.storage.local.set({ llmConfigurations: out, currentLlmConfig: current });
    };

    ApiUtils.getLlmConfig = async function() {
        try {
            await ApiUtils.migrateLlmConfigs();
            const data = await browser.storage.local.get(['llmConfigurations', 'currentLlmConfig']);
            if (data.currentLlmConfig && data.llmConfigurations && data.llmConfigurations[data.currentLlmConfig]) {
                return { ...ApiUtils.getDefaultLlmConfig(), ...data.llmConfigurations[data.currentLlmConfig] };
            }
        } catch (error) {
            console.error("Error retrieving LLM config:", error);
        }
        return ApiUtils.getDefaultLlmConfig();
    };

    ApiUtils.getDefaultLlmConfig = function() {
        return {
            apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
            model: 'anthropic/claude-opus-5.5',
            apiKey: '',
            reasoningEffort: 'low',   // none | low | medium | high (OpenRouter / OpenAI reasoning models)
            maxLooks: 12,             // model calls per fill, at most (fillAgent.js: one per look at the page)
            timeoutMs: 180000,
        };
    };

    ApiUtils.providerOf = function(config) {
        const url = String(config.apiUrl || '');
        if (/\/api\/generate\/?$/.test(url)) return 'ollama-generate';
        if (/\/api\/chat\/?$/.test(url)) return 'ollama-chat';
        return 'openai';
    };

    ApiUtils.isOpenRouter = function(config) {
        return /openrouter\.ai/.test(String(config.apiUrl || ''));
    };

    function headersFor(config) {
        const h = { 'Content-Type': 'application/json' };
        if (config.apiKey) h['Authorization'] = `Bearer ${config.apiKey}`;
        if (ApiUtils.isOpenRouter(config)) {
            h['HTTP-Referer'] = 'https://github.com/GeorgesPaul/formfill';
            h['X-Title'] = 'LLM Form Filler';
        }
        return h;
    }

    // Tolerant JSON: strips fences, finds the outermost object.
    ApiUtils.parseJsonLoose = function(text) {
        if (text == null) return null;
        if (typeof text === 'object') return text;
        let s = String(text).trim();
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        try { return JSON.parse(s); } catch (_) {}
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
        }
        return null;
    };

    function contentToText(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
        return String(content);
    }

    function imagesOf(content) {
        if (!Array.isArray(content)) return [];
        return content.filter(p => p && p.type === 'image_url' && p.image_url && p.image_url.url)
            .map(p => p.image_url.url.replace(/^data:[^;]+;base64,/, ''));
    }

    function combinedSignal(signals, timeoutMs) {
        const ctl = new AbortController();
        for (const s of signals) {
            if (!s) continue;
            if (s.aborted) { ctl.abort(s.reason); break; }
            s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
        }
        if (timeoutMs) setTimeout(() => ctl.abort(new Error('LLM request timed out after ' + timeoutMs + ' ms')), timeoutMs);
        return ctl.signal;
    }

    async function readError(response) {
        let body = '';
        try { body = await response.text(); } catch (_) {}
        return new Error(`HTTP ${response.status}: ${body.slice(0, 600)}`);
    }

    // ---- OpenAI-compatible -------------------------------------------------

    function buildOpenAIBody(config, messages, opts) {
        const openrouter = ApiUtils.isOpenRouter(config);
        const msgs = messages.map((m, i) => {
            const out = { role: m.role };
            if (m.role === 'tool') {
                out.tool_call_id = m.tool_call_id;
                out.content = contentToText(m.content);
                return out;
            }
            if (m.role === 'assistant') {
                out.content = typeof m.content === 'string' ? m.content : contentToText(m.content);
                if (m.tool_calls) out.tool_calls = m.tool_calls;
                if (m.reasoning_details) out.reasoning_details = m.reasoning_details;
                return out;
            }
            // system / user
            if (Array.isArray(m.content)) {
                out.content = m.content.map(p => ({ ...p }));
            } else {
                out.content = openrouter && m.cache ? [{ type: 'text', text: String(m.content) }] : String(m.content);
            }
            if (openrouter && m.cache && Array.isArray(out.content)) {
                const lastText = [...out.content].reverse().find(p => p.type === 'text');
                if (lastText) lastText.cache_control = { type: 'ephemeral' };
            }
            return out;
        });

        const body = { model: config.model, messages: msgs, stream: false };
        if (opts.tools && opts.tools.length) {
            body.tools = opts.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
            if (opts.toolChoice && opts.toolChoice !== 'auto' && opts.toolChoice !== 'none') {
                body.tool_choice = { type: 'function', function: { name: opts.toolChoice } };
            } else if (opts.toolChoice) {
                body.tool_choice = opts.toolChoice;
            }
        }
        if (opts.maxTokens) body.max_tokens = opts.maxTokens;
        if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
        const effort = (config.reasoningEffort || 'none').toLowerCase();
        if (openrouter) {
            if (effort !== 'none') body.reasoning = { effort };
        } else if (/api\.openai\.com/.test(config.apiUrl) && effort !== 'none' && /^(o\d|gpt-5)/.test(config.model || '')) {
            body.reasoning_effort = effort;
        }
        if (opts.responseFormat) body.response_format = opts.responseFormat;
        return body;
    }

    function parseOpenAIResponse(data) {
        const choice = (data.choices && data.choices[0]) || {};
        const msg = choice.message || {};
        const text = contentToText(msg.content);
        const toolCalls = [];
        for (const tc of (msg.tool_calls || [])) {
            const fn = tc.function || {};
            toolCalls.push({ id: tc.id, name: fn.name, args: ApiUtils.parseJsonLoose(fn.arguments) || {}, rawArgs: fn.arguments });
        }
        const assistantMessage = { role: 'assistant', content: msg.content == null ? '' : msg.content };
        if (msg.tool_calls) assistantMessage.tool_calls = msg.tool_calls;
        if (msg.reasoning_details) assistantMessage.reasoning_details = msg.reasoning_details;
        return { text, toolCalls, assistantMessage, usage: data.usage || null, finishReason: choice.finish_reason, raw: data };
    }

    // ---- Ollama native chat ----------------------------------------------

    function buildOllamaChatBody(config, messages, opts) {
        const msgs = messages.map(m => {
            const out = { role: m.role, content: contentToText(m.content) };
            const imgs = imagesOf(m.content);
            if (imgs.length) out.images = imgs;
            if (m.role === 'assistant' && m.tool_calls) {
                out.tool_calls = m.tool_calls.map(tc => ({ function: { name: tc.function.name, arguments: ApiUtils.parseJsonLoose(tc.function.arguments) || {} } }));
            }
            return out;
        });
        const body = { model: config.model, messages: msgs, stream: false, options: { temperature: 0 } };
        if (opts.tools && opts.tools.length) {
            body.tools = opts.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        }
        return body;
    }

    function parseOllamaChatResponse(data) {
        const msg = data.message || {};
        const toolCalls = [];
        (msg.tool_calls || []).forEach((tc, i) => {
            const fn = tc.function || {};
            toolCalls.push({ id: 'call_' + i, name: fn.name, args: typeof fn.arguments === 'object' ? fn.arguments : (ApiUtils.parseJsonLoose(fn.arguments) || {}), rawArgs: JSON.stringify(fn.arguments || {}) });
        });
        const assistantMessage = { role: 'assistant', content: msg.content || '' };
        if (msg.tool_calls) {
            assistantMessage.tool_calls = (msg.tool_calls || []).map((tc, i) => ({ id: 'call_' + i, type: 'function', function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {}) } }));
        }
        return { text: msg.content || '', toolCalls, assistantMessage, usage: { prompt_tokens: data.prompt_eval_count, completion_tokens: data.eval_count }, raw: data };
    }

    // ---- Ollama legacy generate (text only) ------------------------------

    function flattenForGenerate(messages) {
        return messages.map(m => {
            const text = contentToText(m.content);
            if (m.role === 'system') return `[SYSTEM]\n${text}`;
            if (m.role === 'tool') return `[TOOL RESULT]\n${text}`;
            if (m.role === 'assistant') {
                const calls = (m.tool_calls || []).map(tc => tc.function.arguments).join('\n');
                return `[ASSISTANT]\n${text}${calls ? '\n' + calls : ''}`;
            }
            return `[USER]\n${text}`;
        }).join('\n\n') + '\n\n[ASSISTANT]\n';
    }

    async function readOllamaGenerateStream(response, signal) {
        const reader = response.body.getReader();
        let acc = '';
        for (;;) {
            if (signal && signal.aborted) { try { reader.releaseLock(); } catch (_) {} throw new Error('Form filling stopped by user.'); }
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            for (const line of chunk.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.response) acc += parsed.response;
                    if (parsed.done) return acc.trim();
                } catch (_) {}
            }
        }
        return acc.trim();
    }

    // ---- chat() -------------------------------------------------------------
    //
    // messages: [{role, content, cache?, tool_calls?, tool_call_id?}]
    //   content is a string or OpenAI-style parts [{type:'text',text},{type:'image_url',image_url:{url}}]
    // opts: { tools:[{name,description,parameters}], toolChoice:'name'|'auto', signal, maxTokens, config, jsonMode }
    // Returns { text, toolCalls:[{id,name,args}], assistantMessage, usage, latencyMs, provider, supportsTools }
    ApiUtils.chat = async function(messages, opts = {}) {
        const config = opts.config || await ApiUtils.getLlmConfig();
        const provider = ApiUtils.providerOf(config);
        const signal = combinedSignal([opts.signal], config.timeoutMs || 180000);
        const t0 = Date.now();

        let body, url = config.apiUrl;
        if (provider === 'ollama-generate') {
            body = { model: config.model, prompt: flattenForGenerate(messages), stream: true, options: { temperature: 0, seed: 123 } };
            if (opts.jsonMode) body.format = 'json';
        } else if (provider === 'ollama-chat') {
            body = buildOllamaChatBody(config, messages, opts);
            if (opts.jsonMode && !(opts.tools && opts.tools.length)) body.format = 'json';
        } else {
            body = buildOpenAIBody(config, messages, opts);
        }

        let response;
        try {
            response = await fetch(url, { method: 'POST', headers: headersFor(config), body: JSON.stringify(body), signal });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                // The caller's own signal fired: the user pressed Stop.
                if (opts.signal && opts.signal.aborted) throw new Error('Form filling stopped by user.');
                throw new Error((signal.reason && signal.reason.message) || 'LLM request aborted');
            }
            throw new Error('Network error talking to the LLM API: ' + (error && error.message));
        }
        if (!response.ok) throw await readError(response);

        let result;
        if (provider === 'ollama-generate') {
            const text = await readOllamaGenerateStream(response, signal);
            result = { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text }, usage: null, raw: null };
        } else {
            const ct = response.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                const t = await response.text();
                throw new Error(`Expected JSON from the LLM API but got '${ct}': ${t.slice(0, 200)}`);
            }
            const data = await response.json();
            if (data.error) throw new Error('LLM API error: ' + (data.error.message || JSON.stringify(data.error)).slice(0, 600));
            result = provider === 'ollama-chat' ? parseOllamaChatResponse(data) : parseOpenAIResponse(data);
        }
        result.latencyMs = Date.now() - t0;
        result.provider = provider;
        result.supportsTools = provider !== 'ollama-generate';
        result.model = config.model;
        return result;
    };

    // Simple one-shot text prompt (autocomplete tiebreak, API test).
    ApiUtils.promptLLM = async function(prompt, opts = {}) {
        const messages = [];
        if (opts.staticContext) messages.push({ role: 'system', content: opts.staticContext, cache: true });
        messages.push({ role: 'user', content: prompt });
        const r = await ApiUtils.chat(messages, { signal: opts.signal, maxTokens: opts.maxTokens });
        return r.text;
    };

    ApiUtils.testAPI = async function() {
        try {
            const response = await ApiUtils.promptLLM("Hello world in French. Answer with the sentence only.");
            return { success: true, data: response };
        } catch (error) {
            return { success: false, error: error.toString() };
        }
    };

    if (typeof window !== 'undefined') window.ApiUtils = ApiUtils;
    else if (typeof global !== 'undefined') global.ApiUtils = ApiUtils;
    else if (typeof self !== 'undefined') self.ApiUtils = ApiUtils;

})(typeof globalThis !== 'undefined' ? globalThis :
    typeof window !== 'undefined' ? window :
    typeof global !== 'undefined' ? global :
    typeof self !== 'undefined' ? self : this);
