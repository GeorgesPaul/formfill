
// Loads LLM config from file
// Supports both Ollama and Openrouter style API requests
let currentLlmConfig = null;
const response_Timeout_ms = 15000; 


async function getLlmConfig() {
  console.log("Getting LLM config, current config:", currentLlmConfig);
  if (currentLlmConfig) {
    console.log("Using current config:", currentLlmConfig);
    return currentLlmConfig;
  }

  try {
    const data = await browser.storage.local.get(['llmConfigurations', 'currentLlmConfig']);
    console.log("Retrieved from storage:", data);
    if (data.currentLlmConfig && data.llmConfigurations[data.currentLlmConfig]) {
      currentLlmConfig = data.llmConfigurations[data.currentLlmConfig];
      console.log("Using config from storage:", currentLlmConfig);
      return currentLlmConfig;
    }
  } catch (error) {
    console.error("Error retrieving LLM config:", error);
  }

  // Fallback to default config if no current config is set
  console.log("No current config, using default");
  return {
    apiUrl: 'http://localhost:11434/api/generate',
    model: 'llama3.1',
    apiKey: ''
  };
}

async function promptLLM(prompt) {
  const config = await getLlmConfig();
  console.log('Using LLM config:', config);

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

  try {
    const response = await fetch(config.apiUrl, requestOptions);
    console.log('Received response from LLM API. Status:', response.status);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Error response body:', errorBody);
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
    }

    if (config.apiUrl.includes('openrouter.ai')) {
      const data = await response.json();
      return data.choices[0].message.content.trim();
    } else {
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
                console.log('Full response:', accumulatedResponse);
                return accumulatedResponse.trim();
              }
            } catch (parseError) {
              console.warn('Error parsing JSON line:', line, parseError);
              // Continue to next line if parsing fails
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
    }
  } catch (error) {
    console.error("Error interacting with LLM API:", error);
    throw error;
  }
}

function generateFieldInfoString(fieldInfo) {
  // Create a deep copy of the object to avoid modifying the original
  let jsonObject = JSON.parse(JSON.stringify(fieldInfo));

  // Remove null and undefined values
  function removeEmptyValues(obj) {
    for (let key in obj) {
      if (obj[key] === null || obj[key] === undefined) {
        delete obj[key];
      } else if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        removeEmptyValues(obj[key]);
        if (Object.keys(obj[key]).length === 0) {
          delete obj[key];
        }
      }
    }
  }

  removeEmptyValues(jsonObject);

  // Convert the object to a JSON string
  return JSON.stringify(jsonObject, null, 2);
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
  4. Return empty string if the form field is obviously not part of a form. Examples: search, password etc.
  
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
async function get_str_to_fill_with_LLM(fieldInfo, profileFields, profileData, allFormFields) {
  
  const fieldInfoString = JSON.stringify({
    Label: fieldInfo.label || '',
    Name: fieldInfo.name || '',
    ID: fieldInfo.id || '',
    Placeholder: fieldInfo.placeholder || '',
    NearbyText: fieldInfo.nearbyText || '',
    Attributes: fieldInfo.attributes || {},
    Options: fieldInfo.type === 'select-one' && fieldInfo.options ? fieldInfo.options : undefined
  }, null, 2);

  const allFormFieldsString = allFormFields.map((field, index) => {
    let fieldInfo = `Field ${index + 1}:
    Label: ${field.info.label}
    Name: ${field.info.name}
    ID: ${field.info.id}
    Placeholder: ${field.info.placeholder}
    NearbyText: ${field.info.nearbyText}`; 
    //Attributes: ${JSON.stringify(field.info.attributes)}`;

    // if (field.info.type === 'select-one' && field.info.options) {
    //   fieldInfo += `\n    Options: ${field.info.options.join(', ')}`;
    // }

    return fieldInfo;
  }).join('\n\n');

  const profileFieldsString = profileFields.map(field => {
    return `${field.id}:
    Label: ${field.label}
    Description: ${field.description || ''}
    Aliases: ${field.aliases ? field.aliases.join(', ') : ''}
    Common Labels: ${field.common_labels ? field.common_labels.join(', ') : ''}
    Possible Placeholders: ${field.possible_placeholders ? field.possible_placeholders.join(', ') : ''}
    Notes: ${field.notes ? field.notes.join(', ') : ''}
    Possible Values: ${field.possible_values ? field.possible_values.join(', ') : ''}`;
  }).join('\n\n');

  const profileDataString = generateFieldInfoString(profileData);

  console.log('Preparing to call LLM API for field:', fieldInfo);

  /*   ALL FORM FIELDS FOR CONTEXT:
  ${allFormFieldsString}

  USER DATA META DATA:
  ${profileFieldsString}*/

  const prompt = `TASK: Determine the correct value to fill in a form field on a web page based on given information.

FORM FIELD json:
  ${fieldInfoString}

USER DATA json:
  ${profileDataString}
  
  RULES:
  1. From the USER DATA get the most appropriate data to fill out in the one FORM FIELD described above. 
  2. NearbyText and Label attribute values in FORM FIELD above have priority over other attributes in FORM FIELD. 
  3. If a match is found, return the corresponding data from USER DATA.
  4. Do not use placeholder values unless they match USER DATA.
  5. Return an empty string if:
     - There is no obvious match
     - The form field is not part of a form (e.g., search, password)
     - The matching USER DATA field is empty
  6. For address fields:
     - Pay attention to specific components (city, street, house number, etc.)
     - Consider that multiple form fields might map to parts of a single address field in USER DATA
  7. Be aware that some fields might be mislabeled or use non-standard names.
  8. Do not include any additional text or explanation before or after your answer. 
  
  OUTPUT:
  Only a value. No explanation or additional text.`;

  try {
    const str_to_fill = await promptLLM(prompt);
    console.log('LLM response for field:', str_to_fill);
    return str_to_fill;
  } catch (error) {
    console.error("Error in get_str_to_fill_with_LLM:", error);
    throw error;
  }
}

async function loadYaml(src) {
  const response = await fetch(browser.runtime.getURL(src));
  const yamlText = await response.text();
  return jsyaml.load(yamlText);
}

function getNearbyText(element, maxDistance = 100) {
  let text = '';
  let currentNode = element;
  let distance = 0;

  while (currentNode && distance < maxDistance) {
      if (currentNode.nodeType === Node.TEXT_NODE) {
          text += currentNode.textContent.trim() + ' ';
      } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
          if (currentNode.tagName.toLowerCase() === 'label') {
              text += currentNode.textContent.trim() + ' ';
          }
      }
      
      if (currentNode.previousSibling) {
          currentNode = currentNode.previousSibling;
      } else {
          currentNode = currentNode.parentNode;
          distance += 1;
      }
  }

  return text.trim();
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
      classes: input.className,
      value: input.value,
      parentElement: {
          tagName: input.parentElement.tagName,
          classes: input.parentElement.className
      }
  };

  // Find all labels that reference this input's id
  const labels = Array.from(document.querySelectorAll(`label[for="${input.id}"]`));

  // Find the closest label by comparing positions
  let closestLabel = null;
  let minDistance = Infinity;
  const inputRect = input.getBoundingClientRect();
  for (const label of labels) {
      const labelRect = label.getBoundingClientRect();
      const distance = Math.abs(labelRect.top - inputRect.top);
      if (distance < minDistance) {
          minDistance = distance;
          closestLabel = label;
      }
  }

  // Get label text
  info.label = closestLabel ? closestLabel.textContent.trim() : null;

  // Get nearby text
  info.nearbyText = getNearbyText(input);

  // Get all attributes
  info.attributes = {};
  for (let attr of input.attributes) {
      info.attributes[attr.name] = attr.value;
  }

  // Add options for select elements
  if (input.tagName.toLowerCase() === 'select') {
      info.options = Array.from(input.options).map(option => option.text);
  }

  return { element: input, info: info };
}

// Gets data from label near form input / textbox
function getAssociatedLabel(input) {
  // Try to find a label that references this input
  let label = document.querySelector(`label[for="${input.id}"]`);
  
  // If no label found, look for nearby labels
  if (!label) {
    // Check parent elements up to 3 levels
    let element = input;
    for (let i = 0; i < 3; i++) {
        element = element.parentElement;
        if (!element) break;
        
        // Look for a label within this parent
        label = element.querySelector('label');
        if (label) break;
        
        // If the parent itself is a label, use it
        if (element.tagName.toLowerCase() === 'label') {
            label = element;
            break;
        }
    }
  }
  
  // If a label is found, return its text content
  if (label) {
      return label.textContent.trim();
  }
  
  // If no label found, return null
  return null;
}

function findBestMatch(value, options) {
  if (!value || !options || options.length === 0) return null;
  
  const lowerValue = value.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const option of options) {
    const lowerOption = option.toLowerCase();
    if (lowerOption === lowerValue) return option; // Exact match
    
    const score = lowerOption.includes(lowerValue) ? lowerValue.length / lowerOption.length : 0;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = option;
    }
  }

  return bestMatch;
}

function simulateInput(element, value) {
  element.focus();
  const inputEvent = new InputEvent('input', {
    inputType: 'insertText',
    data: value,
    bubbles: true,
    cancelable: true,
  });
  element.value = value;
  element.dispatchEvent(inputEvent);
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur();
}

function trimAndRemoveQuotes(str) {
  // First, trim leading and trailing whitespace
  str = str.trim();
  
  // Then, remove leading and trailing double quotes if they exist
  if (str.startsWith('"') && str.endsWith('"')) {
    str = str.slice(1, -1);
  }
  
  return str;
}

function removeEmptyFields(profile, profileFields) {
  const cleanProfile = {};
  const cleanProfileFields = [];

  for (const [key, value] of Object.entries(profile)) {
    if (value !== "" && value !== null && value !== undefined) {
      cleanProfile[key] = value;
      const fieldDescription = profileFields.find(field => field.id === key);
      if (fieldDescription) {
        cleanProfileFields.push(fieldDescription);
      }
    }
  }

  return { cleanProfile, cleanProfileFields };
}

function getVisibleFormElements() {
  const viewport = {
    width: window.innerWidth || document.documentElement.clientWidth,
    height: window.innerHeight || document.documentElement.clientHeight
  };

  return Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
    .filter(el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      
      return style.display !== 'none' && 
             style.visibility !== 'hidden' && 
             style.opacity !== '0' &&
             rect.top < viewport.height &&
             rect.left < viewport.width &&
             rect.bottom > 0 &&
             rect.right > 0;
    });
}

browser.runtime.onMessage.addListener((message, sender) => {

  if (message.action === "updateLlmConfig") {
    console.log("Updating LLM config:", message.config);
    currentLlmConfig = message.config;
  }

  if (message.action === "fillForm") {
    console.log("Filling form with profile:", message.profile);
    console.log("Using LLM config:", message.llmConfig);
    currentLlmConfig = message.llmConfig;
    const profile = message.profile;
   
    return (async () => {
      try {
        const { fields: profileFields } = await loadYaml('profileFields.yaml');
        console.log("Loaded profile field meta data:", profileFields);
       
        // Clean the profile and profileFields
        const { cleanProfile, cleanProfileFields } = removeEmptyFields(profile, profileFields);
        console.log("Cleaned profile:", cleanProfile);
        console.log("Cleaned profile fields:", cleanProfileFields);

        const formElements = getVisibleFormElements();
        console.log("Found form elements:", formElements.length);
        const formFieldsInfo = formElements.map(getFormFieldInfo);
        console.log("Form fields info:", formFieldsInfo);
        let filledCount = 0;
        const totalFields = formFieldsInfo.length;
        for (const { element, info } of formFieldsInfo) {
          if (info && Object.values(info).some(value => value)) {
            try {
              let str_to_fill = await get_str_to_fill_with_LLM(info, cleanProfileFields, cleanProfile, formFieldsInfo);
              str_to_fill = trimAndRemoveQuotes(str_to_fill);
              if (str_to_fill !== '') {
                if (element.tagName.toLowerCase() === 'select') {
                  const bestMatch = findBestMatch(str_to_fill, info.options);
                  if (bestMatch) {
                    element.value = Array.from(element.options).find(option => option.text === bestMatch).value;
                  }
                } else {
                  simulateInput(element, str_to_fill);
                }
                filledCount++;
              }
            } catch (fieldError) {
              console.error("Error processing field:", info, fieldError);
            }
          }
          // Send progress update
          browser.runtime.sendMessage({
            action: "fillFormProgress",
            filled: filledCount,
            total: totalFields
          });
        }
       
        console.log("Sending response from content script:", {status: "success", message: `Processed ${filledCount} out of ${totalFields} fields.`});
        return {status: "success", message: `Processed ${filledCount} out of ${totalFields} fields.`};
      } catch (error) {
        console.error("Error filling form:", error);
        return {status: "error", message: error.toString()};
      }
    })();
  }
});