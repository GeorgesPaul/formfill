// llmClient.js -- thin compatibility layer over ApiUtils for the few callers
// that want a plain "prompt in, text out" helper (autocomplete tiebreak).
// All request building lives in apiUtils.js.

async function getLlmConfig() {
    return ApiUtils.getLlmConfig();
}

function getDefaultLlmConfig() {
    return ApiUtils.getDefaultLlmConfig();
}

async function promptLLM(prompt, staticContext = null) {
    window.abortController = new AbortController();
    try {
        return await ApiUtils.promptLLM(prompt, { staticContext, signal: window.abortController.signal, maxTokens: 300 });
    } finally {
        window.abortController = null;
    }
}
