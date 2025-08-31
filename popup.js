let profileFields = [];
let currentProfileId = '';
let isFilling = false; // Track filling state

document.addEventListener('DOMContentLoaded', initializeExtension);

function initializeExtension() {
  updateStatusMessage("Configure the API (button at bottom) then press Fill Form on a website with forms.");
  
  loadProfileFields()
    .then(loadProfiles)
    .then(initializeUI)
    .catch(handleInitializationError);
}

// Add this function to generate UUIDs
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function loadProfileFields() {
  return fetch(browser.runtime.getURL('profileFields.yaml'))
    .then(response => response.text())
    .then(yamlText => {
      profileFields = jsyaml.load(yamlText).fields;
      console.log("Profile fields loaded:", profileFields);
    });
}

async function loadProfiles() {
  try {
    const data = await browser.storage.local.get(['profiles', 'lastLoadedProfile']);
    let profiles = data.profiles || {};
    let lastLoadedProfile = data.lastLoadedProfile;

    if (Object.keys(profiles).length === 0) {
      console.log("No profiles found, creating default profile");
      const defaultData = await createDefaultProfile();
      profiles = defaultData.profiles;
      lastLoadedProfile = defaultData.lastLoadedProfile;

      // Store the newly created default profile
      await browser.storage.local.set({ profiles, lastLoadedProfile });
      console.log("Default profile created and stored:", profiles, lastLoadedProfile);
    }

    return { profiles, lastLoadedProfile };
  } catch (error) {
    console.error("Error in loadProfiles:", error);
    throw error;
  }
}



function createDefaultProfile() {
  const defaultProfileId = generateUUID();
  const defaultProfile = {
    [defaultProfileId]: {
      name: 'Test Profile',
      user_name: 'johndoe123',
      given_names: 'John William',
      family_names: 'Doe Smith',
      name_order: 'Given-Family',
      name_infix: 'van',
      name_prefix: 'de',
      title: 'Dr.',
      salutation: 'Mr.',
      name_suffix: 'Jr.',
      preferred_name: 'Johnny',
      full_name: 'Dr. John William van de Doe Smith Jr.',
      email: 'john.doe@example.com',
      linkedIN: 'https://www.linkedin.com/in/johndoe',
      website: 'www.johndoe.com',
      phone: '+1 (555) 123-4567',
      phone_country_code: '+1',
      phone_area_code: '555',
      phone_local_number: '123-4567',
      address_line1: '123 Main Street',
      address_line2: 'Apartment 4B',
      address_street: 'Main Street',
      address_house_number: '123',
      address_city: 'Anytown',
      address_state: 'California',
      address_postal_code: '12345',
      address_country: 'United States',
      date_of_birth_day: '15',
      date_of_birth_month: '07',
      date_of_birth_year: '1985',
      gender: 'Male',
      tax_number: '123-45-6789',
      social_security_number: '987-65-4321',
      health_insurance_number: '1EG4-TE5-MK72',
      nationality: 'American',
      passport_number: 'A1234567',
      passport_expiry_day: '20',
      passport_expiry_month: '09',
      passport_expiry_year: '2028',
      occupation: 'Software Engineer',
      cardholder_name: 'John W. Doe',
      credit_card_number: '4111111111111111',
      credit_card_brand: 'Visa',
      credit_card_expiration_month: '12',
      credit_card_expiration_year: '2025',
      credit_card_security_code: '123'
    }
  };
  
  return browser.storage.local.set({ 
    profiles: defaultProfile,
    lastLoadedProfile: defaultProfileId
  }).then(() => ({
    profiles: defaultProfile,
    lastLoadedProfile: defaultProfileId
  }));
}

function initializeUI({ profiles, lastLoadedProfileId }) {
  updateProfileSelect(profiles);
  initializeProfileForm();
  
  // Load previously selected profiles
  browser.storage.local.get('selectedProfileIds').then(data => {
    const selectedIds = data.selectedProfileIds || [];
    updateProfileSelect(profiles, selectedIds);
  });
  
  // Set up event listeners
  document.getElementById('fillForm').addEventListener('click', fillForm);
  document.getElementById('stopFilling').addEventListener('click', stopFilling);
  document.getElementById('profileSelect').addEventListener('change', updateSelectedCount);
  document.getElementById('selectAllProfiles').addEventListener('click', selectAllProfiles);
  document.getElementById('clearAllProfiles').addEventListener('click', clearAllProfiles);
  document.getElementById('showAddProfileForm').addEventListener('click', addNewProfile);
  document.getElementById('backupProfile').addEventListener('click', backupProfileToTxt);
  document.getElementById('loadFromTxt').addEventListener('click', loadProfileFromTxt);
  document.getElementById('llmConfigButton').addEventListener('click', openLlmConfig);
  document.getElementById('removeProfile').addEventListener('click', removeSelectedProfile);
  document.getElementById('profileName').addEventListener('input', handleProfileNameChange);
  document.getElementById('donateButton').addEventListener('click', function() {
    const stripePaymentLink = 'https://donate.stripe.com/cN2dRB4RRcT40OA000';
    // Open the Stripe payment link in a new tab
    window.open(stripePaymentLink, '_blank');
  });

  document.getElementById('profileForm').style.display = 'block';
}

function handleInitializationError(error) {
  isFilling = false; // Ensure reset on init error
  updateButtonStates();
  console.error("Initialization error:", error);
  updateStatusMessage("An error occurred while loading. Please try again later.");
}

function initializeProfileForm() {
  const formDiv = document.getElementById('profileForm');
  const dynamicForm = document.getElementById('dynamicProfileForm');
  formDiv.style.display = 'block';
  
  if (dynamicForm.innerHTML === '') {
    const profileNameInput = createInput('profileName', 'Profile Name:', 'text', handleProfileNameChange);
    dynamicForm.appendChild(profileNameInput);
    dynamicForm.appendChild(document.createElement('br'));
    
    profileFields.forEach(field => {
      const input = createInput(field.id, field.label, field.type, e => autoSaveProfile(field.id, e.target.value));
      dynamicForm.appendChild(input);
    });
  }
}

function createInput(id, labelText, inputType, changeHandler) {
  const container = document.createElement('div');
  const labelElement = document.createElement('label');
  labelElement.htmlFor = id;
  labelElement.textContent = labelText;
  
  let input;
  if (inputType === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 5;  // Set a default number of visible rows (adjust as needed, e.g., 3-10)
    input.cols = 40; // Optional: Set default width in characters (adjust for your popup's layout)
  } else {
    input = document.createElement('input');
    input.type = inputType || 'text';  // Default to 'text' if no type is specified
  }
  input.id = id;
  input.addEventListener('input', changeHandler);
  
  container.appendChild(labelElement);
  container.appendChild(input);
  return container;
}

function handleProfileNameChange(event) {
  const newProfileName = event.target.value.trim();
  updateProfileName(currentProfileId, newProfileName);
}

function updateProfileName(profileId, newProfileName) {
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    
    if (profiles[profileId]) {
      profiles[profileId].name = newProfileName;
      browser.storage.local.set({ profiles, lastLoadedProfileId: profileId }).then(() => {
        refreshProfileList();
        updateStatusMessage(`Profile name updated`);
      });
    }
  });
}

function updateProfileSelect(profiles, selectedProfileIds = []) {
  const profileSelect = document.getElementById('profileSelect');
  
  // Clear existing options
  profileSelect.innerHTML = '';
  
  // Add profile options
  Object.entries(profiles).forEach(([id, profile]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = profile.name || '(Unnamed Profile)';
    option.selected = selectedProfileIds.includes(id);
    profileSelect.appendChild(option);
  });
  
  updateSelectedCount();
}

function updateSelectedCount() {
  const select = document.getElementById('profileSelect');
  const selectedOptions = Array.from(select.selectedOptions);
  const count = selectedOptions.length;
  
  const selectedCount = document.getElementById('selectedCount');
  if (selectedCount) {
    selectedCount.textContent = `${count} profile${count !== 1 ? 's' : ''} selected`;
  }
  
  // Store selected profiles
  const selectedIds = selectedOptions.map(option => option.value);
  browser.storage.local.set({ selectedProfileIds: selectedIds });
  
  return selectedIds;
}

function getSelectedProfileIds() {
  const select = document.getElementById('profileSelect');
  return Array.from(select.selectedOptions).map(option => option.value);
}

function selectAllProfiles() {
  const select = document.getElementById('profileSelect');
  Array.from(select.options).forEach(option => {
    option.selected = true;
  });
  updateSelectedCount();
}

function clearAllProfiles() {
  const select = document.getElementById('profileSelect');
  Array.from(select.options).forEach(option => {
    option.selected = false;
  });
  updateSelectedCount();
}



function autoSaveProfile(fieldId, value) {
  if (currentProfileId) {
    browser.storage.local.get('profiles').then(data => {
      let profiles = data.profiles || {};
      if (!profiles[currentProfileId]) {
        profiles[currentProfileId] = { name: '' };
      }
      profiles[currentProfileId][fieldId] = value;
      browser.storage.local.set({ profiles }).then(() => {
        console.log(`Profile ${currentProfileId} auto-saved`);
        updateStatusMessage(`Saved ${fieldId} for current profile`);
      });
    });
  }
}

function loadProfile(profileId) {
  browser.storage.local.get('profiles').then(data => {
    const profiles = data.profiles || {};
    const profile = profiles[profileId];
    if (profile) {
      currentProfileId = profileId;
      document.getElementById('profileName').value = profile.name || '';
      profileFields.forEach(field => {
        const input = document.getElementById(field.id);
        if (input) {
          input.value = profile[field.id] || '';
        }
      });
      // Apply stored textarea height if present
      const textarea = document.getElementById('additionalFields');
      if (textarea && profile.additionalFieldsHeight) {
        textarea.style.height = profile.additionalFieldsHeight;
      }
      browser.storage.local.set({ lastLoadedProfileId: profileId });
      updateStatusMessage(`Loaded profile: ${profile.name || '(Unnamed Profile)'}`);
    } else {
      updateStatusMessage(`Profile not found`);
    }
  });
}


function refreshProfileList() {
  browser.storage.local.get(['profiles', 'selectedProfileIds']).then(data => {
    const profiles = data.profiles || {};
    const selectedIds = data.selectedProfileIds || [];
    updateProfileSelect(profiles, selectedIds);
  });
}

// Call refreshProfileList after profile operations
function addNewProfile() {
  const newProfileId = generateUUID();
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    profiles[newProfileId] = { name: '' };
    browser.storage.local.set({ profiles, lastLoadedProfileId: newProfileId }).then(() => {
      refreshProfileList();
      loadProfile(newProfileId);
      updateStatusMessage(`Created new profile`);
    });
  });
}

function stopFilling() {
  isFilling = false;
  updateButtonStates();
  browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
    if (!tabs || tabs.length === 0) {
      updateStatusMessage("No active tab to stop.");
      return;
    }
    browser.tabs.sendMessage(tabs[0].id, {
      action: "stopFillForm"
    }).then(response => {
      updateStatusMessage("Form filling stopped.");
    }).catch(error => {
      updateStatusMessage(`Error stopping form filling: ${error.toString()}`);
    });
  }).catch(error => {
    updateStatusMessage(`Error querying tabs: ${error.toString()}`);
  });
}

function handleError(message, error = null) {
  isFilling = false;
  updateButtonStates();
  updateStatusMessage(error ? `${message}: ${error.toString()}` : message);
}

async function fillForm() {
  isFilling = true;
  updateButtonStates();
  updateStatusMessage("Starting to fill form...");

  try {
    const selectedProfileIds = getSelectedProfileIds();
    if (selectedProfileIds.length === 0) {
      throw new Error("Please select at least one profile to fill the form.");
    }

    const data = await browser.storage.local.get('profiles');
    const profiles = data.profiles || {};
    
    // Get profile names for status message
    const profileNames = selectedProfileIds.map(id => profiles[id]?.name || '(Unnamed Profile)').join(', ');
    
    // Merge selected profiles
    const mergedProfile = {};
    selectedProfileIds.forEach(profileId => {
      const profile = profiles[profileId];
      if (profile) {
        // Later profiles override earlier ones for conflicting fields
        Object.assign(mergedProfile, profile);
      }
    });

    updateStatusMessage(`Filling form with profiles: ${profileNames}`);

    // Get custom prompt from textarea
    const customPrompt = document.getElementById('userPrompt').value.trim();

    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      throw new Error("No active tab found.");
    }

    const response = await browser.tabs.sendMessage(tabs[0].id, {
      action: "fillForm",
      profile: mergedProfile,
      customPrompt: customPrompt
    });

    if (response && response.status === "success") {
      updateStatusMessage(`Form filling complete: ${response.message}`);
    } else {
      throw new Error(response ? response.message : "Unknown error");
    }
  } catch (error) {
    handleError("Error filling form", error);
  } finally {
    isFilling = false;
    updateButtonStates();
  }
}

function backupProfileToTxt() {
  const selectedIds = getSelectedProfileIds();
  
  if (selectedIds.length === 0) {
    updateStatusMessage("Please select profiles to backup.");
    return;
  }

  browser.storage.local.get('profiles').then(data => {
    const profiles = data.profiles || {};
    
    if (selectedIds.length === 1) {
      // Single profile backup (existing behavior)
      const profileId = selectedIds[0];
      const profile = profiles[profileId];
      if (!profile) {
        updateStatusMessage("Profile not found.");
        return;
      }

      // Capture the current textarea height
      const textarea = document.getElementById('additionalFields');
      const additionalFieldsHeight = textarea ? textarea.style.height || `${textarea.clientHeight}px` : '';

      const backupData = {
        id: profileId,
        ...profile,
        additionalFieldsHeight: additionalFieldsHeight
      };

      const profileJson = JSON.stringify(backupData, null, 2);
      const blob = new Blob([profileJson], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      const fileName = `${profile.name || 'Unnamed_Profile'}_backup.txt`.replace(/\s+/g, '_');
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      updateStatusMessage(`Profile backed up to ${fileName}`);
    } else {
      // Multiple profiles backup
      const backupData = {
        profiles: {},
        selectedProfileIds: selectedIds
      };
      
      selectedIds.forEach(profileId => {
        if (profiles[profileId]) {
          backupData.profiles[profileId] = profiles[profileId];
        }
      });

      const profileJson = JSON.stringify(backupData, null, 2);
      const blob = new Blob([profileJson], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      const fileName = `multiple_profiles_backup.txt`;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      updateStatusMessage(`Multiple profiles backed up to ${fileName}`);
    }
  });
}


function loadProfileFromTxt() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt';
  input.onchange = e => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = function(event) {
      try {
        const backupData = JSON.parse(event.target.result);
        
        browser.storage.local.get('profiles').then(data => {
          const profiles = data.profiles || {};
          
          if (backupData.profiles) {
            // Multiple profiles backup
            Object.assign(profiles, backupData.profiles);
            browser.storage.local.set({ profiles }).then(() => {
              refreshProfileList();
              updateStatusMessage(`Multiple profiles loaded from txt file and saved`);
            });
          } else {
            // Single profile backup
            let profileId = backupData.id || generateUUID();
            let profile = { ...backupData };
            delete profile.id; // Remove id from the profile object if it exists
            
            profiles[profileId] = profile;
            browser.storage.local.set({ profiles }).then(() => {
              refreshProfileList();
              loadProfile(profileId);
              updateStatusMessage(`Profile "${profile.name || 'Unnamed Profile'}" loaded from txt file and saved`);
            });
          }
        });
      } catch (error) {
        updateStatusMessage("Error loading profile: " + error.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function removeSelectedProfile() {
  const selectedIds = getSelectedProfileIds();

  if (selectedIds.length === 0) {
    updateStatusMessage("Please select profiles to remove.");
    return;
  }

  // Get profile names for confirmation
  browser.storage.local.get('profiles').then(data => {
    const profiles = data.profiles || {};
    const profileNames = selectedIds.map(id => profiles[id]?.name || '(Unnamed Profile)').join(', ');

    if (confirm(`Are you sure you want to remove the selected profiles: ${profileNames}?`)) {
      selectedIds.forEach(id => {
        if (profiles[id]) {
          delete profiles[id];
        }
      });
      
      browser.storage.local.set({ profiles }).then(() => {
        refreshProfileList();
        
        if (Object.keys(profiles).length > 0) {
          // Load the first remaining profile into the form
          const firstRemainingId = Object.keys(profiles)[0];
          loadProfile(firstRemainingId);
        } else {
          document.getElementById('profileForm').reset();
          currentProfileId = '';
        }
        updateStatusMessage(`Selected profiles have been removed.`);
      });
    }
  });
}

function openLlmConfig() {
  browser.windows.create({
    url: 'llmConfig.html',
    type: 'popup',
    width: 800,
    height: 600
  });
}

function updateButtonStates() {
  const fillButton = document.getElementById('fillForm');
  const stopButton = document.getElementById('stopFilling');
  fillButton.disabled = isFilling;
  stopButton.disabled = !isFilling;
}

let lastUpdateTime = 0;
const updateInterval = 50; // Minimum time between updates in milliseconds

function updateStatusMessage(message) {
  const logMsg = document.getElementById('logMsg');
  const timestamp = new Date().toLocaleString();
  const newMessage = `${timestamp}: ${message}`;
  const messages = logMsg.textContent.split('\n').filter(msg => msg.trim() !== '');
  messages.unshift(newMessage);
  logMsg.textContent = messages.slice(0, 6).join('\n');
  logMsg.scrollTop = 0;
}

browser.runtime.onMessage.addListener((message) => {
  switch (message.action) {
    case "fillFormStart":
      isFilling = true; // Set filling state
      updateButtonStates();
      updateStatusMessage(message.message || "Starting to fill form...");
      break;
    case "fillFormProgress":
      updateStatusMessage(message.message || `Filled ${message.filled} out of ${message.total} fields.`);
      break;
    case "fillFormComplete":
      isFilling = false; // Reset on completion
      updateButtonStates();
      updateStatusMessage(message.message || `Completed filling ${message.filled} out of ${message.total} fields.`);
      break;
    case "fillFormStopped":
      isFilling = false; // Reset on stop
      updateButtonStates();
      updateStatusMessage(message.message || `Form filling stopped. Filled ${message.filled} out of ${message.total} fields.`);
      break;
    case "fillFormError":
      isFilling = false; // Reset on error
      updateButtonStates();
      updateStatusMessage(message.message || `Error filling form: ${message.error}`);
      break;
    case "updateProgress":
      updateStatusMessage(message.message);
      break;
  }
});