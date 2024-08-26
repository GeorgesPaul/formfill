let currentEditingConfig = null;

document.addEventListener('DOMContentLoaded', initializePage);

function initializePage() {
  loadConfigurations().then(selectActiveConfig);
  setupEventListeners();
}

function setupEventListeners() {
  document.getElementById('configForm').addEventListener('submit', saveConfiguration);
  document.getElementById('addConfig').addEventListener('click', () => showConfigForm());
  document.getElementById('editConfig').addEventListener('click', editSelectedConfig);
  document.getElementById('deleteConfig').addEventListener('click', deleteSelectedConfig);
  document.getElementById('testApi').addEventListener('click', initiateAPITest);
  document.getElementById('cancelEdit').addEventListener('click', hideConfigForm);
  document.getElementById('closePersistentMessage').addEventListener('click', hidePersistentMessage);
}

function hideConfigForm() {
  document.getElementById('configForm').style.display = 'none';
  currentEditingConfig = null;
}

function hidePersistentMessage() {
  document.getElementById('persistentMessage').style.display = 'none';
}

async function loadConfigurations() {
  const data = await browser.storage.local.get(['llmConfigurations', 'currentLlmConfig']);
  let configs = data.llmConfigurations || {};
  let currentConfig = data.currentLlmConfig;
  
  if (Object.keys(configs).length === 0) {
    configs = createDefaultConfig();
    currentConfig = 'Default';
    await browser.storage.local.set({llmConfigurations: configs, currentLlmConfig: currentConfig});
  }
  
  populateConfigTable(configs);
  return currentConfig;
}

function createDefaultConfig() {
  return {
    'Default': {
      apiUrl: 'http://localhost:11434/api/generate',
      model: 'llama3.1',
      apiKey: ''
    }
  };
}

function populateConfigTable(configs) {
  const configTableBody = document.querySelector('#configTable tbody');
  configTableBody.innerHTML = '';
  
  for (let name in configs) {
    const config = configs[name];
    const row = createConfigRow(name, config);
    configTableBody.appendChild(row);
  }
}

function createConfigRow(name, config) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${name}</td>
    <td>${config.apiUrl}</td>
    <td>${config.model}</td>
    <td>${config.apiKey ? '********' : ''}</td>
  `;
  row.addEventListener('click', () => selectRow(row, true));
  return row;
}

async function selectRow(row, initialLoad = false) {
  const selectedRow = document.querySelector('#configTable tbody tr.selected');
  if (selectedRow) {
    selectedRow.classList.remove('selected');
  }
  row.classList.add('selected');
  
  // Always update the current config when a row is selected
  await updateCurrentConfig(row);
}

async function updateCurrentConfig(row) {
  const configName = row.cells[0].textContent;
  const data = await browser.storage.local.get('llmConfigurations');
  const configs = data.llmConfigurations || {};
  const selectedConfig = configs[configName];
  
  await browser.storage.local.set({ currentLlmConfig: configName });
  console.log(`Current LLM config set to:`, selectedConfig);
  
  //notifyAllTabs(selectedConfig);
}

// This doesn't work as this script can't access the content.js script
// function notifyAllTabs(config) {
//   browser.tabs.query({}).then((tabs) => {
//     for (let tab of tabs) {
//       browser.tabs.sendMessage(tab.id, {
//         action: "updateLlmConfig",
//         config: config
//       }).catch(err => console.log(`Could not update tab ${tab.id}:`, err));
//     }
//   });
// }

function selectActiveConfig() {
  browser.storage.local.get('currentLlmConfig').then(data => {
    const currentConfig = data.currentLlmConfig;
    if (currentConfig) {
      const rows = document.querySelectorAll('#configTable tbody tr');
      for (let row of rows) {
        if (row.cells[0].textContent === currentConfig) {
          selectRow(row, true);
          break;
        }
      }
    }
  });
}

function getSelectedConfig() {
  const selectedRow = document.querySelector('#configTable tbody tr.selected');
  return selectedRow ? selectedRow.cells[0].textContent : null;
}

function showConfigForm(configName = '') {
  const form = document.getElementById('configForm');
  form.style.display = 'block';
  
  if (configName) {
    populateFormWithConfig(configName);
  } else {
    form.reset();
  }
}

async function populateFormWithConfig(configName) {
  const data = await browser.storage.local.get('llmConfigurations');
  const config = data.llmConfigurations[configName];
  document.getElementById('configName').value = configName;
  document.getElementById('apiUrl').value = config.apiUrl;
  document.getElementById('model').value = config.model;
  document.getElementById('apiKey').value = config.apiKey;
}

async function saveConfiguration(event) {
  event.preventDefault();
  const configName = document.getElementById('configName').value;
  let apiUrl = document.getElementById('apiUrl').value;
  
  apiUrl = ensureCorrectApiUrl(apiUrl);
  
  const config = {
    apiUrl: apiUrl,
    model: document.getElementById('model').value,
    apiKey: document.getElementById('apiKey').value
  };
  
  await saveConfigToStorage(configName, config);
  hideConfigForm();
  showStatus('Configuration saved!');
}

function ensureCorrectApiUrl(apiUrl) {
  if (apiUrl.includes('localhost') && !apiUrl.endsWith('/api/generate')) {
    return apiUrl.replace(/\/?$/, '/api/generate');
  }
  return apiUrl;
}

async function saveConfigToStorage(configName, config) {
  const data = await browser.storage.local.get('llmConfigurations');
  const configs = data.llmConfigurations || {};
  configs[configName] = config;
  await browser.storage.local.set({
    llmConfigurations: configs,
    currentLlmConfig: configName
  });
  console.log(`Saved and set current LLM config to:`, config);
  //notifyAllTabs(config);
  loadConfigurations();
}

function editSelectedConfig() {
  const selectedConfig = getSelectedConfig();
  if (selectedConfig) {
    currentEditingConfig = selectedConfig;
    showConfigForm(selectedConfig);
  } else {
    showStatus('Please select a configuration to edit.');
  }
}

async function deleteSelectedConfig() {
  const selectedConfig = getSelectedConfig();
  if (selectedConfig) {
    if (confirm(`Are you sure you want to delete "${selectedConfig}"?`)) {
      const data = await browser.storage.local.get('llmConfigurations');
      const configs = data.llmConfigurations || {};
      delete configs[selectedConfig];
      await browser.storage.local.set({llmConfigurations: configs});
      loadConfigurations();
      showStatus('Configuration deleted.');
    }
  } else {
    showStatus('Please select a configuration to delete.');
  }
}

function initiateAPITest() {
  const config = getSelectedConfig();
  if (!config) {
    updateStatusMessage('No configuration selected.');
    return;
  }
  updateStatusMessage('Initiating API test...');
  console.log('Starting API test');
  
  ApiUtils.testAPI()
    .then(result => {
      console.log('Received API test result:', result);
      handleApiTestResult(result);
    })
    .catch(error => {
      console.error('Error in API test:', error);
      updateStatusMessage('API test failed: ' + error.message);
    });
}

function handleApiTestResult(result) {
  if (result.success) {
    console.log('API test successful:', result.data);
    updateStatusMessage('API test successful! ' + result.data);
  } else {
    console.error('API test failed:', result.error);
    updateStatusMessage('API test failed: ' + result.error);
  }
}

function showStatus(message) {
  const statusElement = document.getElementById('statusMessage');
  statusElement.textContent = message;
  setTimeout(() => {
    statusElement.textContent = '';
  }, 3000);
}

function updateStatusMessage(message) {
  // Skip empty messages
  if (!message.trim()) return;

  const logMsg = document.getElementById('logMsg');
  const heightInNrofLines = 6; // Set the desired number of lines here


  // Get current timestamp
  const timestamp = new Date().toLocaleString();

  // Create the new message with timestamp
  const newMessage = `${timestamp}: ${message}`;

  // Split the current content into an array of messages
  let messages = logMsg.textContent.split('\n').filter(msg => msg.trim() !== '');

  // Add the new message to the beginning of the array
  messages.unshift(newMessage);

  // Keep only the most recent messages based on heightInNrofLines
  messages = messages.slice(0, heightInNrofLines);

  // Update the logMsg content
  logMsg.textContent = messages.join('\n');

  // Ensure the logMsg element has a fixed height
  logMsg.style.height = `${heightInNrofLines * 1.5}em`; // Adjust 1.5em as needed for line height
  logMsg.style.overflowY = 'auto';

  // Scroll to the top
  logMsg.scrollTop = 0;
}

// function runPopupTest() {
//   console.log("Running API test from popup...");
//   if (typeof ApiUtils !== 'undefined' && ApiUtils.testAPI) {
//     ApiUtils.testAPI().then(result => {
//       console.log("Popup API test result:", result);
//       handleApiTestResult(result);
//     }).catch(error => {
//       console.error("Popup API test error:", error);
//       updateStatusMessage('API test failed: ' + error.message);
//     });
//   } else {
//     console.error("ApiUtils is not defined in the popup context");
//   }
// }

// // Run the test every 6 seconds
// setInterval(runPopupTest, 6000);

// // Run once when popup opens
// runPopupTest();