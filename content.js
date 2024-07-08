const apiUrl = 'http://localhost:11434/api/generate';
const response_Timeout_ms = 20000; 
// Example using ollama running locally

const LLM_model = "llama3"; //"llama3:70b"; 

async function promptLLM(prompt) {
  console.log('Sending prompt to LLM:', prompt);

  const requestBody = {
    model: LLM_model,
    prompt: prompt,
    stream: true,
    "options": {
      "seed": 123,
      "top_k": 40,
      "top_p": 0.9,
      "temperature": 0.5
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
  const longestKey = Math.max(...Object.keys(fieldInfo).map(key => key.length));
  
  for (const [key, value] of Object.entries(fieldInfo)) {
    if (value !== null && value !== undefined) {
      const paddedKey = key.padEnd(longestKey);
      if (typeof value === 'object' && !Array.isArray(value)) {
        // For nested objects
        result += `${paddedKey}: \n`;
        for (const [subKey, subValue] of Object.entries(value)) {
          if (subValue !== null && subValue !== undefined) {
            result += `  ${subKey.padEnd(longestKey - 2)}: ${subValue}\n`;
          }
        }
      } else if (Array.isArray(value)) {
        // For array values
        result += `${paddedKey}: ${value.join(', ')}\n`;
      } else {
        // For simple key-value pairs
        result += `${paddedKey}: ${value}\n`;
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
  
  const fieldInfoString = 
`Label: ${fieldInfo.label || ''}
Name: ${fieldInfo.name || ''}
ID: ${fieldInfo.id || ''}
Placeholder: ${fieldInfo.placeholder || ''}
NearbyText: ${fieldInfo.nearbyText || ''}
Attributes: ${JSON.stringify(fieldInfo.attributes || {})}${fieldInfo.type === 'select-one' && fieldInfo.options ? `\n  Options: ${fieldInfo.options.join(', ')}` : ''}`;

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

FORM FIELD:
  ${fieldInfoString}

USER DATA:
  ${profileDataString}
  
  RULES:
  1. From the USER DATA get the most appropriate data to fill out in the one FORM FIELD described above. 
  2. NearbyText and Label attributes in FORM FIELD above have priority over other attributes in FORM FIELD. 
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


browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "fillForm") {
    console.log("Filling form with profile:", message.profile);
    const profile = message.profile;
   
    try {
      const { fields: profileFields } = await loadYaml('profileFields.yaml');
      console.log("Loaded profile field meta data:", profileFields);
      
      const formElements = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
        .filter(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
      console.log("Found form elements:", formElements.length);

      const formFieldsInfo = formElements.map(getFormFieldInfo);
      console.log("Form fields info:", formFieldsInfo);

      for (const { element, info } of formFieldsInfo) {
        if (info && Object.values(info).some(value => value)) {
          try {
            const str_to_fill = await get_str_to_fill_with_LLM(info, profileFields, profile, formFieldsInfo); 
            if (str_to_fill !== '') {
              if (element.tagName.toLowerCase() === 'select') {
                const bestMatch = findBestMatch(str_to_fill, info.options);
                if (bestMatch) {
                  element.value = Array.from(element.options).find(option => option.text === bestMatch).value;
                }
              } else {
                element.value = str_to_fill;
              }
            }
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