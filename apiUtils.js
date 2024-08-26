// apiUtils.js

(function(global) {
    'use strict';
  
    const ApiUtils = {};
  
    ApiUtils.getLlmConfig = async function() {
      try {
        const data = await browser.storage.local.get(['llmConfigurations', 'currentLlmConfig']);
        if (data.currentLlmConfig && data.llmConfigurations[data.currentLlmConfig]) {
          return data.llmConfigurations[data.currentLlmConfig];
        }
      } catch (error) {
        console.error("Error retrieving LLM config:", error);
      }
  
      return ApiUtils.getDefaultLlmConfig();
    };
  
    ApiUtils.getDefaultLlmConfig = function() {
      return {
        apiUrl: 'http://localhost:11434/api/generate',
        model: 'llama3.1',
        apiKey: ''
      };
    };
  
    ApiUtils.createHttpieCommand = function(url, method, headers, body) {
        const jsonBody = JSON.stringify(body).replace(/"/g, '"');
        let command = `echo ${jsonBody} | http ${method.toUpperCase()} "${url}"`;
        
        for (const [key, value] of Object.entries(headers)) {
            command += ` "${key}: ${value}"`;
        }
        
        return command;
    };

    ApiUtils.promptLLM = async function(prompt) {
        const config = await ApiUtils.getLlmConfig();
        console.log("Using LLM model:", config.model);
        const requestBody = ApiUtils.createRequestBody(config, prompt);
        const requestOptions = ApiUtils.createRequestOptions(config, requestBody);

        // Create and log HTTPie command
        const httpieCommand = ApiUtils.createHttpieCommand(
            config.apiUrl,
            requestOptions.method,
            requestOptions.headers,
            JSON.parse(requestOptions.body)
        );
        console.log("HTTPie equivalent command:");
        console.log(httpieCommand);
        // console.log("URL:", config.apiUrl);
        // console.log("Request options method:", requestOptions.method); 
        // console.log("Request options headers:", requestOptions.headers);
        // console.log("Request options body:", requestOptions.body);

        try {
            const response = await fetch(config.apiUrl, requestOptions);
            return ApiUtils.handleLlmResponse(response, config);
        } catch (error) {
            console.error("Error interacting with LLM API:", error);
            throw error;
        }
    };
  
    ApiUtils.createRequestBody = function(config, prompt) {
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
    };
  
    ApiUtils.createRequestOptions = function(config, requestBody) {
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
    };
  
    ApiUtils.handleLlmResponse = async function(response, config) {
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
      }
  
      if (config.apiUrl.includes('openrouter.ai')) {
        const data = await response.json();
        return data.choices[0].message.content.trim();
      } else {
        return ApiUtils.handleStreamingResponse(response);
      }
    };
  
    ApiUtils.handleStreamingResponse = async function(response) {
      const reader = response.body.getReader();
      let accumulatedResponse = '';
      const startTime = Date.now();
  
      while (true) {
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
  
        if (Date.now() - startTime > 15000) {
          throw new Error(`LLM API request timed out after 15000 milliseconds.`);
        }
      }
  
      throw new Error('LLM API response ended unexpectedly');
    };
  
    ApiUtils.testAPI = async function() {
      try {
        const prompt = "Hello world in French.";
        const response = await ApiUtils.promptLLM(prompt);
        console.log('API test successful:', response);
        return { success: true, data: response };
      } catch (error) {
        console.error('API test failed:', error);
        return { success: false, error: error.toString() };
      }
    };
  
    // Expose ApiUtils to the global scope
    if (typeof window !== 'undefined') {
        window.ApiUtils = ApiUtils;
    } else if (typeof global !== 'undefined') {
        global.ApiUtils = ApiUtils;
    } else if (typeof self !== 'undefined') {
        self.ApiUtils = ApiUtils;
    } else {
        console.warn('Unable to find global object');
    }
  
  })(typeof globalThis !== 'undefined' ? globalThis : 
    typeof window !== 'undefined' ? window : 
    typeof global !== 'undefined' ? global : 
    typeof self !== 'undefined' ? self : this);