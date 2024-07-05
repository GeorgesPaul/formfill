const apiUrl = 'http://localhost:11434/api/generate';
const response_Timeout_ms = 15000; 
// Example using ollama running locally

const LLM_model = "llama3"; 

async function promptLLM(prompt) {
  console.log('Sending prompt to LLM:', prompt);

  const requestBody = {
    model: LLM_model,
    prompt: prompt,
    stream: true
  };

  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody)
  };

  try {
    const response = await fetch(apiUrl, requestOptions);
    console.log('Received response from LLM API. Status:', response.status);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Error response body:', errorBody);
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
    }

    const reader = response.body.getReader();
    let accumulatedResponse = '';
    const startTime = Date.now();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = new TextDecoder().decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.trim() !== '') {
          const parsedLine = JSON.parse(line);
          accumulatedResponse += parsedLine.response;

          if (parsedLine.done) {
            console.log('Full response:', accumulatedResponse);
            return accumulatedResponse.trim();
          }
        }
      }

      // Check for timeout
      const time_elapsed_ms = Date.now() - startTime;
      if (time_elapsed_ms > response_Timeout_ms) {
        throw new Error(`LLM API request timed out after ${time_elapsed_ms} milliseconds.`);
      }
    }

    throw new Error('LLM API response ended unexpectedly');
  } catch (error) {
    console.error("Error interacting with LLM API:", error);
    throw error;
  }
}

// Main function to match field with LLM
async function matchFieldWithllama(fieldInfo, profileFields) {
  console.log('Preparing to call LLM API for field:', fieldInfo);
  const prompt = `Given the following form field information:
${JSON.stringify(fieldInfo, null, 2)}
And the following list of profile fields:
${JSON.stringify(profileFields, null, 2)}
Which profile field is the best match for the form field? Return only the ID of the best matching profile field. No other text.`;

  try {
    const bestMatchId = await promptLLM(prompt);
    console.log('Best match ID from LLM:', bestMatchId);
    return bestMatchId;
  } catch (error) {
    console.error("Error in matchFieldWithllama:", error);
    throw error;
  }
}

async function loadYaml(src) {
  const response = await fetch(browser.runtime.getURL(src));
  const yamlText = await response.text();
  return jsyaml.load(yamlText);
}

function getNearbyText(element, maxDistance = 50) {
  // ... (keep this function as it was) ...
}


browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "fillForm") {
      console.log("Filling form with profile:", message.profile);
      const profile = message.profile;
     
      try {
          const { fields: profileFields } = await loadYaml('profileFields.yaml');
          console.log("Loaded profile field meta data:", profileFields);

          const formInputs = document.querySelectorAll('input, select, textarea');
          console.log("Found form text boxes:", formInputs.length);

          for (const input of formInputs) {
            (async () => {  // Start of immediately invoked async function
                const fieldInfo = {
                    name: input.name,
                    id: input.id,
                    placeholder: input.placeholder,
                    type: input.type,
                    nearbyText: getNearbyText(input)
                };
        
                if (Object.values(fieldInfo).some(value => value)) {
                    const bestMatchId = await matchFieldWithllama(fieldInfo, profileFields);
                    console.log("Best match for", fieldInfo, ":", bestMatchId);
                    // Remove any surrounding quotes from bestMatchId
                    const cleanBestMatchId = bestMatchId.replace(/^["']|["']$/g, '');
                    console.log("Cleaned Best match ID:", cleanBestMatchId);
                            
                    if (profile[cleanBestMatchId] !== undefined) {
                        input.value = profile[cleanBestMatchId];
                        console.log("Filled", fieldInfo.name || fieldInfo.id, "with", profile[cleanBestMatchId]);
                    } else {
                        console.log("No matching profile field found for textbox with name ", fieldInfo.name || fieldInfo.id);
                    }
                }
            })();  // End and immediate invocation of async function
          }
          sendResponse({status: "success"});
      } catch (error) {
          console.error("Error filling form:", error);
          sendResponse({status: "error", message: error.toString()});
      }
  }
 
  return true;  // Indicates that we will send a response asynchronously
});