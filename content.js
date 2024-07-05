let worker;
const modelURL = 'models/xlm-roberta-base/model.onnx'; 

async function matchFieldWithClaude(fieldInfo, profileFields) {
  const apiKey = config.CLAUDE_API_KEY;
  const apiUrl = 'https://api.anthropic.com/v1/messages';

  console.log('Preparing to call Claude API for field:', fieldInfo);

  const prompt = `Given the following form field information:
${JSON.stringify(fieldInfo, null, 2)}

And the following list of profile fields:
${JSON.stringify(profileFields, null, 2)}

Which profile field is the best match for the form field? Return only the ID of the best matching profile field.`;

  console.log('Sending prompt to Claude:', prompt);

  const requestBody = {
      model: "claude-3-sonnet-20240229",
      messages: [
          {
              role: "user",
              content: prompt
          }
      ],
      max_tokens: 100
  };

  const requestOptions = {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
  };

  try {
      const response = await fetch(apiUrl, requestOptions);

      console.log('Received response from Claude API. Status:', response.status);

    if (!response.ok) {
        const errorBody = await response.text();
        console.error('Error response body:', errorBody);
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
    }

      const data = await response.json();
      console.log('Parsed response data:', data);

      const bestMatchId = data.content[0].text.trim();
      console.log('Best match ID from Claude:', bestMatchId);

      return bestMatchId;
  } catch (error) {
      console.error("Error calling Claude API:", error);
      throw error; // Re-throw the error instead of using a fallback
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
          console.log("Loaded profile fields:", profileFields);

          const formInputs = document.querySelectorAll('input, select, textarea');
          console.log("Found form inputs:", formInputs.length);

          for (const input of formInputs) {
              const fieldInfo = {
                  name: input.name,
                  id: input.id,
                  placeholder: input.placeholder,
                  type: input.type,
                  nearbyText: getNearbyText(input)
              };

              if (Object.values(fieldInfo).some(value => value)) {
                  console.log("Processing field:", fieldInfo);
                  const bestMatchId = await matchFieldWithClaude(fieldInfo, profileFields);
                  console.log("Best match for", fieldInfo, ":", bestMatchId);
                  if (bestMatchId && profile[bestMatchId]) {
                      input.value = profile[bestMatchId];
                      console.log("Filled", fieldInfo.name || fieldInfo.id, "with", profile[bestMatchId]);
                  } else {
                      console.log("No suitable match found for", fieldInfo);
                  }
              }
          }
     
          sendResponse({status: "success"});
      } catch (error) {
          console.error("Error filling form:", error);
          sendResponse({status: "error", message: error.toString()});
      }
  }
 
  return true;  // Indicates that we will send a response asynchronously
});