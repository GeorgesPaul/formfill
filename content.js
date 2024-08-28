const response_Timeout_ms = 15000;

// Event listeners
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Content script received message:", message);

  if (message.action === "fillForm") {
    console.log("Filling form with profile:", message.profile);

    fillForm(message.profile).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ status: "error", message: error.toString() });
    });

    return true; // Indicate that we will send a response asynchronously
  }
});


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

  try {
    const response = await fetch(config.apiUrl, requestOptions);
    return handleLlmResponse(response, config);
  } catch (error) {
    console.error("Error interacting with LLM API:", error);
    throw error;
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
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
  }

  if (config.apiUrl.includes('openrouter.ai')) {
    const data = await response.json();
    return data.choices[0].message.content.trim();
  } else {
    return handleStreamingResponse(response);
  }
}

async function handleStreamingResponse(response) {
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

    if (isResponseTimedOut(startTime)) {
      throw new Error(`LLM API request timed out after ${response_Timeout_ms} milliseconds.`);
    }
  }

  throw new Error('LLM API response ended unexpectedly');
}

function isResponseTimedOut(startTime) {
  return Date.now() - startTime > response_Timeout_ms;
}

// Utility functions
function generateFieldInfoString(fieldInfo) {
  let jsonObject = JSON.parse(JSON.stringify(fieldInfo));
  removeEmptyValues(jsonObject);
  return JSON.stringify(jsonObject, null, 2);
}

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

// Main functions for field matching and filling
async function matchFieldWithllama(fieldInfo, profileFields) {
  const fieldInfoString = generateFieldInfoString(fieldInfo);
  const prompt = generateMatchFieldPrompt(fieldInfoString, profileFields);

  try {
    const bestMatchId = await promptLLM(prompt);
    console.log('Best match ID from LLM:', bestMatchId);
    return bestMatchId;
  } catch (error) {
    console.error("Error in matchFieldWithllama:", error);
    throw error;
  }
}

function generateMatchFieldPrompt(fieldInfoString, profileFields) {
  return `TASK: Match form field to profile field.

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
}

async function get_str_to_fill_with_LLM(fieldInfo, profileFields, profileData, allFormFields) {
  const fieldInfoString = generateFieldInfoString(fieldInfo);
  const profileDataString = generateFieldInfoString(profileData);
  const prompt = generateFillFieldPrompt(fieldInfoString, profileDataString);

  try {
    const str_to_fill = await promptLLM(prompt);
    console.log('LLM response for field:', str_to_fill);
    return str_to_fill;
  } catch (error) {
    console.error("Error in get_str_to_fill_with_LLM:", error);
    throw error;
  }
}

function generateFillFieldPrompt(fieldInfoString, profileDataString) {
  return `TASK: Determine the correct value to fill in a form field on a web page based on given information.

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
}


function getAllFormElements(doc = document) {
  return Array.from(doc.querySelectorAll('input:not([type="hidden"]), select, textarea'));
}

// Form field processing functions
function getFormFieldInfo(input) {
  const info = getBasicFieldInfo(input);
  info.label = getAssociatedLabel(input);
  info.nearbyText = getNearbyText(input);
  info.attributes = getElementAttributes(input);
  // Remove the iframeInfo property

  if (input.tagName.toLowerCase() === 'select') {
    info.options = Array.from(input.options).map(option => option.text);
  }

  return { element: input, info: info };
}

function getBasicFieldInfo(input) {
  return {
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
}

function getAssociatedLabel(input) {
  let label = document.querySelector(`label[for="${input.id}"]`);
  
  if (!label) {
    let element = input;
    for (let i = 0; i < 3; i++) {
      element = element.parentElement;
      if (!element) break;
      
      label = element.querySelector('label');
      if (label) break;
      
      if (element.tagName.toLowerCase() === 'label') {
        label = element;
        break;
      }
    }
  }
  
  return label ? label.textContent.trim() : null;
}

function getNearbyText(element, maxDistance = 100) {
  let text = '';
  let currentNode = element;
  let distance = 0;

  while (currentNode && distance < maxDistance) {
    if (currentNode.nodeType === Node.TEXT_NODE) {
      text += currentNode.textContent.trim() + ' ';
    } else if (currentNode.nodeType === Node.ELEMENT_NODE && currentNode.tagName.toLowerCase() === 'label') {
      text += currentNode.textContent.trim() + ' ';
    }
    
    currentNode = currentNode.previousSibling || currentNode.parentNode;
    distance++;
  }

  return text.trim();
}

function getElementAttributes(element) {
  const attributes = {};
  for (let attr of element.attributes) {
    attributes[attr.name] = attr.value;
  }
  return attributes;
}

function findIframesWithForms() {
  const iframesWithForms = [];
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
      if (iframeDocument.querySelector('input, select, textarea')) {
        iframesWithForms.push(iframeDocument);
      }
    } catch (e) {
      console.warn('Error accessing iframe:', e);
    }
  }
  return iframesWithForms.length > 0 ? iframesWithForms : [document];
}

// Form filling functions
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function simulateHumanTyping(element, value) {
  const specialChars = {
    ' ': 'Space',
    '.': 'Period',
    '/': 'Slash',
    '-': 'Dash'
  };

  element.focus();
  
  // Clear existing value
  element.value = '';
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const keyChar = specialChars[char] || char;

    // Simulate keydown
    const keydownEvent = new KeyboardEvent('keydown', {
      key: char,
      code: `Key${keyChar.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(keydownEvent);

    // Simulate keypress
    const keypressEvent = new KeyboardEvent('keypress', {
      key: char,
      code: `Key${keyChar.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
      charCode: char.charCodeAt(0),
    });
    element.dispatchEvent(keypressEvent);

    // Update value and dispatch input event
    element.value += char;
    const inputEvent = new InputEvent('input', {
      inputType: 'insertText',
      data: char,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(inputEvent);

    // Simulate keyup
    const keyupEvent = new KeyboardEvent('keyup', {
      key: char,
      code: `Key${keyChar.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(keyupEvent);

    // Random delay between keystrokes (50-150ms)
    await sleep(50 + Math.random() * 100);
  }

  // Final events
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function simulateInput(element, value) {
  // Try different methods to set the value
  const methods = [
    // Method 1: Direct value assignment
    () => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    // Method 2: Using Object.getOwnPropertyDescriptor
    () => {
      const propertyDescriptor = Object.getOwnPropertyDescriptor(element.__proto__, 'value');
      propertyDescriptor.set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    // Method 3: Using defineProperty
    () => {
      Object.defineProperty(element, 'value', { writable: true, value: value });
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    // Method 4: Simulated human typing
    () => simulateHumanTyping(element, value)
  ];

  for (const method of methods) {
    await method();
    await sleep(100);  // Wait a bit to see if the value sticks
    if (element.value === value) {
      console.log("Input successful with method:", method.name);
      return;
    }
  }

  console.error("Failed to set input value after trying all methods");
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

function getVisibleFormElements(documents) {
  let allElements = [];
  documents.forEach(doc => {
    const viewport = {
      width: window.innerWidth || doc.documentElement.clientWidth,
      height: window.innerHeight || doc.documentElement.clientHeight
    };

    const elements = Array.from(doc.querySelectorAll('input:not([type="hidden"]), select, textarea'))
      .filter(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               style.opacity !== '0' &&
               rect.top < viewport.height &&
               rect.left < viewport.width &&
               rect.width > 0 && rect.height > 0 &&
               rect.bottom > 0 &&
               rect.right > 0;
      });
    
    allElements = allElements.concat(elements);
  });
  
  return allElements;
}

// Main form filling process
async function fillForm(profile) {
  try {
    const { fields: profileFields } = await loadYaml('profileFields.yaml');
    const { cleanProfile, cleanProfileFields } = removeEmptyFields(profile, profileFields);

    const formElements = getAllFormElements();
    const totalFields = formElements.length;
    console.log('found formElements on page:', formElements);

    browser.runtime.sendMessage({ action: "fillFormStart" });

    const formFieldsInfo = formElements.map(getFormFieldInfo);

    const config = await getLlmConfig();

    let filledFields;
    if (config.apiUrl.includes('openrouter.ai')) {
      filledFields = await fillFormSinglePrompt(formFieldsInfo, cleanProfileFields, cleanProfile);
    } else {
      filledFields = await fillFormSequential(formFieldsInfo, cleanProfileFields, cleanProfile);
    }
    console.log('Fields to fill:', filledFields);

    let filledCount = 0;

    for (const { element, info } of formFieldsInfo) {
      const classes = Array.isArray(info.classes) ? info.classes : info.classes.split(' ');
      const matchingClass = classes.find(cls => cls in filledFields);

      if (filledFields[info.id] || filledFields[info.name] || matchingClass) {
        const value = filledFields[info.id] || filledFields[info.name] || filledFields[matchingClass];
        await fillField(element, value, info);
        filledCount++;
        updateFillProgress(filledCount, totalFields);
      } else {
        console.log('No match found for:', info.id, info.name, classes.join(' '));
      }
    }

    browser.runtime.sendMessage({ 
      action: "fillFormComplete",
      filledCount: filledCount,
      totalFields: totalFields
    });

    return { status: "success", message: `Processed ${filledCount} out of ${totalFields} fields.` };
  } catch (error) {
    console.error("Error filling form:", error);
    browser.runtime.sendMessage({ 
      action: "fillFormError",
      error: error.toString()
    });
    return { status: "error", message: error.toString() };
  }
}

function updateFillProgress(filled, total) {
  browser.runtime.sendMessage({
    action: "fillFormProgress",
    filled: filled,
    total: total
  });
}

/*
Generates 1 prompt for all fillable elements on the page/form. 
The LLM should be smart enough to return the correct values for all fields in the form with 1 prompt.
*/
async function fillFormSinglePrompt(formFieldsInfo, profileFields, profileData) {
  const prompt = generateSinglePromptForAllFields(formFieldsInfo, profileFields, profileData);
  //console.log('prompt:', prompt);
  try {
    const response = await promptLLM(prompt);
    return JSON.parse(response);
  } catch (error) {
    console.error("Error in fillFormSinglePrompt:", error);
    throw error;
  }
}

function generateSinglePromptForAllFields(formFieldsInfo, profileFields, profileData) {
  const formFieldsString = JSON.stringify(formFieldsInfo, null, 2);
  const profileFieldsString = JSON.stringify(profileFields, null, 2);
  const profileDataString = JSON.stringify(profileData, null, 2);

  //console.log('formFieldsString:', formFieldsString);

  return `TASK: Fill out a web form based on given information.

FORM FIELDS:
${formFieldsString}

PROFILE FIELDS:
${profileFieldsString}

USER DATA:
${profileDataString}

INSTRUCTIONS:
1. Analyze the form fields and match them with the appropriate user data.
2. Create a JSON object where keys are either the 'id' or 'name' of the form field, and values are the corresponding data to fill.
3. Follow these rules for matching and filling fields:
   a. NearbyText and Label attribute values in FORM FIELDS have priority over other attributes.
   b. Do not use placeholder values unless they match USER DATA.
   c. Leave a field empty (do not include in the JSON) if:
      - There is no obvious match
      - The form field is not part of a form (e.g., search, password)
   d. For address fields:
      - Pay attention to specific components (city, street, house number, etc.)
      - Consider that multiple form fields might map to parts of a single address field in USER DATA
   e. Be aware that some fields might be mislabeled or use non-standard names.
   f. For select fields, choose the option that best matches the USER DATA.
4. Return only the JSON object, no additional text.

OUTPUT:
Provide a JSON object with the fields to fill. No explanation or additional text.`;
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

/*
Generates 1 prompt for each fillable element on the page/form. 
Use this for LLMs that are not as good at handling this type of prompt (e.g. llama3.1 8B and similar models)
*/
async function fillFormSequential(formFieldsInfo, profileFields, profileData) {
  let filledFields = {};
  let filledCount = 0;
  const totalFields = formFieldsInfo.length;

  for (const { element, info } of formFieldsInfo) {
    if (info && Object.values(info).some(value => value)) {
      try {
        let str_to_fill = await get_str_to_fill_with_LLM(info, profileFields, profileData, formFieldsInfo);
        str_to_fill = trimAndRemoveQuotes(str_to_fill);
        if (str_to_fill !== '') {
          filledFields[info.id || info.name] = str_to_fill;
          await fillField(element, str_to_fill, info);
          filledCount++;
          updateFillProgress(filledCount, totalFields);
        }
      } catch (fieldError) {
        console.error("Error processing field:", info, fieldError);
      }
    }
  }
  return filledFields;
}

async function fillField(element, value, info) {
  try {
    console.log(`Filling field:`, element, `with value:`, value);

    if (element.tagName.toLowerCase() === 'select') {
      fillSelectField(element, value);
    } else {
      await simulateInput(element, value);
    }
  } catch (error) {
    console.error(`Error filling field:`, element, error);
  }
}

function fillSelectField(selectElement, value) {
  console.log(`Filling select field ${selectElement.name} with value:`, value);
  const options = Array.from(selectElement.options);
  const optionToSelect = options.find(option => 
    option.text.trim().toLowerCase() === value.toString().toLowerCase() || 
    option.value.trim().toLowerCase() === value.toString().toLowerCase()
  );

  if (optionToSelect) {
    selectElement.value = optionToSelect.value;
    selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`Selected option in ${selectElement.name}:`, optionToSelect.text);
  } else {
    console.warn(`Could not find matching option for ${value} in`, selectElement);
  }
}

// Utility functions
async function loadYaml(src) {
  const response = await fetch(browser.runtime.getURL(src));
  const yamlText = await response.text();
  return jsyaml.load(yamlText);
}


function runContentTest() {
  console.log("Running API test from content script...");
  ApiUtils.testAPI().then(result => {
    console.log("Content API test result:", result);
  }).catch(error => {
    console.error("Content API test error:", error);
  });
}

// Run the test every 6 seconds
//setInterval(runContentTest, 6000);

// Run once immediately
//runContentTest();