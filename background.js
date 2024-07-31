browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "testAPI") {
      const config = request.config;
      const prompt = "Hello world in French.";


      let requestBody;
      if (config.apiUrl.includes('openrouter.ai')) {
        requestBody = {
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          stream: false
        };
      } else {
        requestBody = {
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
  
      console.log('Sending request to:', config.apiUrl);
      console.log('Request options:', JSON.stringify(requestOptions, null, 2));
  
      fetch(config.apiUrl, requestOptions)
        .then(response => {
          console.log('Response status:', response.status);
          console.log('Response headers:', JSON.stringify(Object.fromEntries([...response.headers]), null, 2));
          
          if (!response.ok) {
            return response.text().then(text => {
              throw new Error(`HTTP error! status: ${response.status}, body: ${text}`);
            });
          }
          return response.json();
        })
        .then(data => {
          console.log('API response:', data);
          sendResponse({ success: true, data: data });
        })
        .catch(error => {
          console.error('API error:', error);
          sendResponse({ success: false, error: error.toString() });
        });
  
      return true;  // Will respond asynchronously
    }
  });