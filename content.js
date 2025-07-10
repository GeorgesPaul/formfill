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

async function get_str_to_fill_with_LLM(fieldInfo, profileFields, profileData, profileFieldsInfo) {
  const fieldInfoString = JSON.stringify(fieldInfo, null, 2);
  const profileDataString = JSON.stringify(profileData, null, 2);
  const prompt = generateFillFieldPrompt(fieldInfoString, profileDataString, profileFields, profileFieldsInfo);

  try {
    let str_to_fill = await promptLLM(prompt);
    console.log('Raw LLM response for field:', str_to_fill);

    // Clean up the response
    str_to_fill = str_to_fill.trim();
    
    // If the response contains multiple lines or looks like code, return an empty string
    if (str_to_fill.includes('\n') || str_to_fill.includes('function') || str_to_fill.includes('{')) {
      console.warn('LLM returned unexpected format. Ignoring response.');
      return '';
    }

    return str_to_fill;
  } catch (error) {
    console.error("Error in get_str_to_fill_with_LLM:", error);
    throw error;
  }
}

function generateFillFieldPrompt(fieldInfoString, profileDataString, profileFields, profileFieldsInfo) {
  const relevantFieldInfo = getRelevantFieldInfo(fieldInfoString, profileFieldsInfo);

  const prompt = `TASK: Fill a form field with user data.

FORM FIELD:
${fieldInfoString}

USER DATA:
${profileDataString}

FIELD INFO:
${relevantFieldInfo}

RULES:
1. Match the form field to the best fitting user data.
2. Prioritize NearbyText and Label in FORM FIELD.
3. Use FIELD INFO for additional context if needed.
4. Return empty string if no match or field is not part of a form.
5. For addresses, match specific components (city, street, etc.).
6. Ignore placeholder values unless they match USER DATA.

OUTPUT:
Return ONLY the value to fill. Do not return any code, functions, or explanations. Just the value as a string.`;

  console.log("Generated prompt:", prompt);

  return prompt;
}

function getRelevantFieldInfo(fieldInfoString, profileFieldsInfo) {
  console.log("fieldInfoString:", fieldInfoString);
  console.log("profileFieldsInfo:", profileFieldsInfo);

  if (!profileFieldsInfo || !profileFieldsInfo.fields) {
    console.error("profileFieldsInfo or profileFieldsInfo.fields is undefined");
    return "No relevant field info available";
  }

  let fieldInfo;
  try {
    fieldInfo = JSON.parse(fieldInfoString);
  } catch (error) {
    console.error("Error parsing fieldInfoString:", error);
    return "Error parsing field info";
  }

  const relevantFields = profileFieldsInfo.fields.filter(field => 
    field.common_labels?.some(label => 
      fieldInfo.label?.toLowerCase().includes(label.toLowerCase()) ||
      fieldInfo.name?.toLowerCase().includes(label.toLowerCase()) ||
      fieldInfo.id?.toLowerCase().includes(label.toLowerCase())
    ) ||
    field.aliases?.some(alias => 
      fieldInfo.label?.toLowerCase().includes(alias.toLowerCase()) ||
      fieldInfo.name?.toLowerCase().includes(alias.toLowerCase()) ||
      fieldInfo.id?.toLowerCase().includes(alias.toLowerCase())
    )
  );

  if (relevantFields.length === 0) {
    return "No matching fields found";
  }

  return relevantFields.map(field => `
${field.id}:
  Label: ${field.label}
  Common Labels: ${field.common_labels?.join(', ')}
  Aliases: ${field.aliases?.join(', ')}
  Description: ${field.description}
  `).join('\n');
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

// Simulates fake manual events on an element to trick web pages into thinking they are being filled out by a human
function triggerEvents(element, eventTypes) {
  eventTypes.forEach(eventType => {
    const event = new Event(eventType, { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  });
}

function simulateMouseClick(element, outsideClick = false) {
  const rect = element.getBoundingClientRect();
  let centerX, centerY;

  if (outsideClick) {
    // Click slightly outside the element
    centerX = rect.right + 1;
    centerY = rect.bottom + 1;
  } else {
    // Click in the center of the element
    centerX = rect.left + rect.width / 2;
    centerY = rect.top + rect.height / 2;
  }

  const clickEvent = new MouseEvent('click', {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX: centerX,
    clientY: centerY
  });

  if (outsideClick) {
    document.elementFromPoint(centerX, centerY)?.dispatchEvent(clickEvent);
  } else {
    element.dispatchEvent(clickEvent);
  }
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
    await sleep(10 + Math.random() * 50);
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

  triggerEvents(element, ['input', 'change', 'blur']);

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
    updateFillProgress(0, 0, "Starting to fill form...");  // REMOVE THIS LINE

    const profileFields = await loadYaml('profileFields.yaml');   
    const { cleanProfile, cleanProfileFields } = removeEmptyFields(profile, profileFields.fields);

    const formElements = getAllFormElements();
    const totalFields = formElements.length;
    console.log('found formElements on page:', formElements);

    updateFillProgress(0, totalFields, "Starting to fill form... This will take at least a few seconds.");

    const formFieldsInfo = formElements.map(getFormFieldInfo);

    const config = await getLlmConfig();

    let filledFields;
    if (config.apiUrl.includes('openrouter.ai')) {
      filledFields = await fillFormSinglePrompt(formFieldsInfo, cleanProfileFields, cleanProfile, profileFields);
    } else {
      filledFields = await fillFormSequential(formFieldsInfo, cleanProfileFields, cleanProfile, profileFields);
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
        updateFillProgress(filledCount, totalFields, `Filled ${filledCount} out of ${totalFields} fields...`);
        
        await sleep(10);
      } else {
        console.log('No match found for:', info.id, info.name, classes.join(' '));
      }
    }
    
    simulateMouseClick(document.body, true);

    // Send completion to background
    browser.runtime.sendMessage({
      action: "fillFormComplete",
      filled: filledCount,
      total: totalFields
    });

    updateFillProgress(filledCount, totalFields, `Completed filling ${filledCount} out of ${totalFields} fields.`);

    return { status: "success", message: `Processed ${filledCount} out of ${totalFields} fields.` };
  } catch (error) {
    console.error("Error filling form:", error);
    // Send error to background
    browser.runtime.sendMessage({
      action: "fillFormError",
      error: error.toString()
    });
    updateFillProgress(0, 0, `Error filling form: ${error.toString()}`);
    return { status: "error", message: error.toString() };
  }
}

function updateFillProgress(filled, total, message) {
  browser.runtime.sendMessage({
    action: "fillFormProgress",
    filled: filled,
    total: total,
    message: message
  });
}

function logToUser(message) {
  browser.runtime.sendMessage({
    action: "updateProgress", 
    message: message
  }); 
}

/*
Generates 1 prompt for all fillable elements on the page/form. 
The LLM should be smart enough to return the correct values for all fields in the form with 1 prompt.
*/
// async function fillFormSinglePrompt(formFieldsInfo, profileFields, profileData) {
//   const prompt = generateSinglePromptForAllFields(formFieldsInfo, profileFields, profileData);
//   //console.log('prompt:', prompt);
//   try {
//     const response = await promptLLM(prompt);
//     return JSON.parse(response);
//   } catch (error) {
//     console.error("Error in fillFormSinglePrompt:", error);
//     throw error;
//   }
// }
async function fillFormSinglePrompt(formFieldsInfo, profileFields, profileData) {
  const prompt = generateSinglePromptForAllFields(formFieldsInfo, profileFields, profileData);
  let llmContentString = '';

  try {
    // promptLLM now returns the clean, stringified JSON content from the LLM.
    llmContentString = await promptLLM(prompt);

    // Clean it up just in case the LLM wrapped it in markdown.
    const cleanedJsonString = llmContentString.replace(/```json\n|```/g, '').trim();

    // Now, parse the LLM's output.
    return JSON.parse(cleanedJsonString);

  } catch (error) {
    if (error.name === 'SyntaxError') {
      // This catch is now ONLY for when the LLM's output itself is not valid JSON.
      logToUser(
        "LLM FORMATTING ERROR: The model did not return a valid JSON string.",
        "\nLLM's response (first 250 chars):",
        `\n>>>\n${llmContentString.substring(0, 250)}\n<<<`,
        "\nFull Error:", error
      );
    } else {
      // This will catch the new, clearer error from handleLlmResponse.
      console.error("An error occurred in fillFormSinglePrompt:", error);
    }
    
    return {};
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
2. Create a JSON object where keys are either the 'id', 'name' or 'class' of the form field (depending on which one is present), and values are the corresponding data to fill.
3. Follow these rules for matching and filling fields:
   a. Do not use placeholder values unless they match USER DATA.
   b. Leave a field empty (do not include in the JSON) if:
      - There is no obvious match
      - The form field is not part of a form (e.g., search, password)
   c. For address fields:
      - Pay attention to specific components (city, street, house number, etc.)
      - Consider that multiple form fields might map to parts of a single address field in USER DATA
   d. Be aware that some fields might be mislabeled or use non-standard names.
   e. For select fields, choose the option that best matches the USER DATA.
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
async function fillFormSequential(formFieldsInfo, profileFields, profileData, profileFieldsInfo) {
  let filledFields = {};
  let filledCount = 0;
  const totalFields = formFieldsInfo.length;

  for (const { element, info } of formFieldsInfo) {
    if (info && Object.values(info).some(value => value)) {
      try {
        let str_to_fill = await get_str_to_fill_with_LLM(info, profileFields, profileData, formFieldsInfo, profileFieldsInfo);
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

// async function fillField(element, value, info) {
//   const sleep_between_events_ms = 50; 
//   console.log(`Filling field:`, element, `with value:`, value);

//   if (info.iframeInfo) {
//     await focusIframeElement(info.iframeInfo);
//   }

//   // Simulate mouse click on the element
//   simulateMouseClick(element);

//   // Wait a bit for any click-triggered events to settle
//   await sleep(sleep_between_events_ms);

//   const win = element.ownerDocument.defaultView;

//   if (element.tagName.toLowerCase() === 'select') {
//     await fillSelectField(element, value);
//   } else {
//     await simulateInput(element, value, win);
//   }

//   // Trigger additional events
//   triggerEvents(element, ['input', 'change', 'blur']);

//   // Simulate click outside the form field
//   simulateMouseClick(element, true);

//   // Wait a bit after filling
//   await sleep(sleep_between_events_ms);
// }

async function fillField(element, value, info) {
  const sleep_between_events_ms = 50;
  console.log(`Filling field:`, element, `with value:`, value);

  element.focus(); // Bring the element into focus
  await sleep(sleep_between_events_ms);

  if (element.tagName.toLowerCase() === 'select') {
    await fillSelectField(element, value);
  } else {
    // This is often the most reliable method for complex sites.
    await simulateHumanTyping(element, value);
  }

  // The blur event is already handled inside simulateHumanTyping and fillSelectField.
  // element.blur(); // You can add this for extra certainty if needed.

  await sleep(sleep_between_events_ms);
}

async function fillSelectField(selectElement, value) {
  console.log(`Filling select field ${selectElement.name} with value:`, value);
  
  // Simulate clicking the select element to open the dropdown
  simulateMouseClick(selectElement);

  // Wait for the dropdown to open and options to be available
  await waitForOptions(selectElement);

  const options = Array.from(selectElement.options);
  const optionToSelect = options.find(option => 
    option.text.trim().toLowerCase() === value.toString().toLowerCase() || 
    option.value.trim().toLowerCase() === value.toString().toLowerCase()
  );

  if (optionToSelect) {
    selectElement.value = optionToSelect.value;
    selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Wait for the selection to be applied
    await waitForSelection(selectElement, optionToSelect.value);
    
    console.log(`Selected option in ${selectElement.name}:`, optionToSelect.text);
  } else {
    console.warn(`Could not find matching option for ${value} in`, selectElement);
  }
}

async function waitForOptions(selectElement, timeout = 2000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (selectElement.options.length > 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timeout waiting for select options to load');
}

async function waitForSelection(selectElement, expectedValue, timeout = 2000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (selectElement.value === expectedValue) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timeout waiting for select value to be applied');
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