const apiUrl = 'http://localhost:11434/api/generate';
const response_Timeout_ms = 15000; 
// Example using ollama running locally

const LLM_model = "gemma2"; //"llama3:70b"; 

async function promptLLM(prompt) {
  console.log('Sending prompt to LLM:', prompt);

  const requestBody = {
    model: LLM_model,
    prompt: prompt,
    stream: true,
    "options": {
      "seed": 123,
      "top_k": 20,
      "top_p": 0.9,
      "temperature": 0
      }
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

function generateFieldInfoString(fieldInfo) {
  let result = "";
  for (const [key, value] of Object.entries(fieldInfo)) {
    if (value !== null && value !== undefined) {
      if (typeof value === 'object' && !Array.isArray(value)) {
        // For nested objects like parentElement
        result += `${key}:\n`;
        for (const [subKey, subValue] of Object.entries(value)) {
          if (subValue !== null && subValue !== undefined) {
            result += `  ${subKey}: ${subValue}\n`;
          }
        }
      } else if (Array.isArray(value)) {
        // For array values
        result += `${key}: ${value.join(', ')}\n`;
      } else {
        // For simple key-value pairs
        result += `${key}: ${value}\n`;
      }
    }
  }
  return result;
}

// Main function to match field with LLM
async function matchFieldWithllama(fieldInfo, profileFields) {

  const fieldInfoString = generateFieldInfoString(fieldInfo);
  console.log('Preparing to call LLM API for field:', fieldInfo);
  const prompt = `TASK: Match form field to profile field.

  FORM FIELD:
  ${fieldInfoString}
  
  PROFILE FIELDS:
  ${profileFields.map(field => `- ${field.id}: ${field.label}`).join('\n')}
  
  INSTRUCTIONS:
  1. Find the profile field that best matches the form field.
  2. Return ONLY the id of the matching profile field.
  3. Return empty string if there is no obvious match. 
  
  Now, provide the id of the best matching profile field. No other text.`;

  try {
    const bestMatchId = await promptLLM(prompt);
    console.log('Best match ID from LLM:', bestMatchId);
    return bestMatchId;
  } catch (error) {
    console.error("Error in matchFieldWithllama:", error);
    throw error;
  }
}

// Main function to match field with LLM
async function get_str_to_fill_with_LLM(fieldInfo, profileFieldsMetaData, profileData) {

  const fieldInfoString = generateFieldInfoString(fieldInfo);
  const profileFieldsMetaDataString = profileFieldsMetaData.map(field => `- ${field.id}: ${field.label}`).join('\n'); 
  const profileDataString = generateFieldInfoString(profileData);

  console.log('Preparing to call LLM API for field:', fieldInfo);

  const prompt = `TASK: What string to fill out in the following form field:

  FORM FIELD:
  ${fieldInfoString}
  
  PROFILE FIELDS META DATA:
  ${profileFieldsMetaDataString}

  PROFILE FIELDS USER DATA:
  ${profileDataString}
  
  INSTRUCTIONS:
  1. Generate the string that needs to be filled out in the form field, based on profile fields meta data and profile fields user data.
  
  Return only the string to fill the form field with. No other text.`;

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

// Gets info from textbox / form input
function getFormFieldInfo(input) {
  const info = {
    name: input.name,
    id: input.id,
    placeholder: input.placeholder,
    type: input.type,
    required: input.required,
    autocomplete: input.autocomplete,
    ariaLabel: input.getAttribute('aria-label'),
    ariaLabelledBy: input.getAttribute('aria-labelledby'),
    ariaDescribedBy: input.getAttribute('aria-describedby'),
    classes: input.className,
    nearbyText: getNearbyText(input),
    label: getAssociatedLabel(input),
    parentElement: {
      tagName: input.parentElement.tagName,
      classes: input.parentElement.className
    }
  };

  // Get all data attributes
  const dataAttributes = {};
  for (let attr of input.attributes) {
    if (attr.name.startsWith('data-')) {
      dataAttributes[attr.name] = attr.value;
    }
  }
  info.dataAttributes = dataAttributes;

  return { element: input, info: info };
}

// Gets data from label near form input / textbox
function getAssociatedLabel(input) {
  // Try to find a label that references this input
  let label = document.querySelector(`label[for="${input.id}"]`);
  
  // If no label found, try to find a parent label
  if (!label) {
      label = input.closest('label');
  }
  
  // If a label is found, return its text content
  if (label) {
      return label.textContent.trim();
  }
  
  // If no label found, return null
  return null;
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
      
      const formFieldsInfo = Array.from(formInputs).map(getFormFieldInfo);
      console.log("Form fields info:", formFieldsInfo);

      for (const { element, info } of formFieldsInfo) {
        if (info && Object.values(info).some(value => value)) {
          try {
            
            const str_to_fill = await get_str_to_fill_with_LLM(info, profileFields, profile); 
            element.value = str_to_fill; 
            //const bestMatchId = await matchFieldWithllama(info, profileFields);
            // console.log("Best match for", info, ":", bestMatchId);
            
            // const cleanBestMatchId = bestMatchId.replace(/^["']|["']$/g, '');
            // console.log("Cleaned Best match ID:", cleanBestMatchId);
          
            // if (profile[cleanBestMatchId] !== undefined) {
            //   element.value = profile[cleanBestMatchId];
            //   console.log("Filled", info.name || info.id, "with", profile[cleanBestMatchId]);
            // } else {
            //   console.log("No matching profile field found for textbox with name ", info.name || info.id);
            // }

          } catch (fieldError) {
            console.error("Error processing field:", info, fieldError);
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