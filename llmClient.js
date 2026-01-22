// LLM Configuration functions
async function getLlmConfig() {
    try {
        const data = await browser.storage.local.get(['llmConfigurations', 'currentLlmConfig']);
        if (data.currentLlmConfig && data.llmConfigurations[data.currentLlmConfig]) {
            let currentLlmConfig = data.llmConfigurations[data.currentLlmConfig];
            return currentLlmConfig;
        }
    } catch (error) {
        console.error("Error retrieving LLM config:", error);
    }

    return getDefaultLlmConfig();
}

function getDefaultLlmConfig() {
    return {
        apiUrl: 'http://localhost:11434/api/generate',
        model: 'llama3.1',
        apiKey: ''
    };
}

// LLM API interaction functions
async function promptLLM(prompt) {
    const config = await getLlmConfig();
    console.log("Using LLM model: " + config.model);
    const requestBody = createRequestBody(config, prompt);
    const requestOptions = createRequestOptions(config, requestBody);

    window.abortController = new AbortController();
    requestOptions.signal = window.abortController.signal;

    try {
        const response = await fetch(config.apiUrl, requestOptions);
        return handleLlmResponse(response, config);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("LLM request aborted.");
            throw new Error("Form filling stopped by user.");
        }
        console.error("Error interacting with LLM API:", error);
        throw error;
    } finally {
        window.abortController = null;
    }
}

function createRequestBody(config, prompt) {
    if (config.apiUrl.includes('openrouter.ai')) {
        return {
            model: config.model,
            messages: [{ role: "user", content: prompt }],
            stream: false
        };
    } else {
        return {
            model: config.model,
            prompt: prompt,
            stream: false,
            options: {
                seed: 123,
                top_k: 20,
                top_p: 0.9,
                temperature: 0
            }
        };
    }
}

function createRequestOptions(config, requestBody) {
    const requestOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
    };

    if (config.apiKey) {
        requestOptions.headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    return requestOptions;
}

async function handleLlmResponse(response, config) {
    // Check 1: Was the HTTP request successful? (e.g., not a 404 or 500)
    if (!response.ok) {
        const errorBody = await response.text();
        // This gives a very clear error like "HTTP error! status: 401, body: Invalid API Key"
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
    }

    // Check 2: Did the server send us JSON? This is the crucial new check.
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        const responseText = await response.text();
        // This is the error we are currently experiencing.
        logToUser(
            `API Error: Expected JSON response but received '${contentType}'. ` +
            `This often means an invalid API key or incorrect endpoint. ` +
            `Response body (first 200 chars): ${responseText.substring(0, 200)}`
        );
    }

    // If both checks pass, we can confidently proceed.
    if (config.apiUrl.includes('openrouter.ai')) {
        // We already know it's JSON, so we can parse it here safely.
        // This simplifies the logic in fillFormSinglePrompt.
        const data = await response.json();
        return data.choices[0].message.content.trim();
    } else {
        // Streaming response is handled differently.
        return handleStreamingResponse(response);
    }
}

async function handleStreamingResponse(response) {
    const reader = response.body.getReader();
    let accumulatedResponse = '';
    const startTime = Date.now();

    while (true) {
        if (window.stopFilling) {
            reader.releaseLock();
            throw new Error("Form filling stopped by user.");
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (line.trim() !== '') {
                try {
                    const parsedLine = JSON.parse(line);
                    accumulatedResponse += parsedLine.response;
                    if (parsedLine.done) {
                        return accumulatedResponse.trim();
                    }
                } catch (parseError) {
                    console.warn('Error parsing JSON line:', line, parseError);
                }
            }
        }

        if (isResponseTimedOut(startTime)) {
            throw new Error(`LLM API request timed out after ${response_Timeout_ms} milliseconds.`);
        }
    }

    throw new Error('LLM API response ended unexpectedly');
}

function isResponseTimedOut(startTime) {
    return Date.now() - startTime > response_Timeout_ms;
}

// Matching and Prompting functions
// (Functions matchFieldWithllama and get_str_to_fill_with_LLM were removed as they are no longer used)
