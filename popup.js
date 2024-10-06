let profileFields = [];
let currentProfileName = '';

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

function loadProfiles() {
  return browser.storage.local.get(['profiles', 'lastLoadedProfile'])
    .then(data => {
      const profiles = data.profiles || {};
      const lastLoadedProfile = data.lastLoadedProfile;
      
      if (Object.keys(profiles).length === 0) {
        return createDefaultProfile();
      }
      
      return { profiles, lastLoadedProfile };
    });
}



function createDefaultProfile() {
  const defaultProfile = {
    [generateUUID()]: {
      name: 'Default Profile',
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
    lastLoadedProfile: 'Default Profile'
  }).then(() => ({
    profiles: defaultProfile,
    lastLoadedProfile: 'Default Profile'
  }));
}

function initializeUI({ profiles, lastLoadedProfileId }) {
  updateProfileSelect(profiles, lastLoadedProfileId);
  initializeProfileForm();
  if (lastLoadedProfileId && profiles[lastLoadedProfileId]) {
    loadProfile(lastLoadedProfileId);
  } else if (Object.keys(profiles).length > 0) {
    loadProfile(Object.keys(profiles)[0]);
  }
  
  // Set up event listeners
  document.getElementById('fillForm').addEventListener('click', fillForm);
  document.getElementById('showAddProfileForm').addEventListener('click', addNewProfile);
  document.getElementById('profileSelect').addEventListener('change', e => loadProfile(e.target.value));
  document.getElementById('backupProfile').addEventListener('click', backupProfileToTxt);
  document.getElementById('loadFromTxt').addEventListener('click', loadProfileFromTxt);
  document.getElementById('llmConfigButton').addEventListener('click', openLlmConfig);
  document.getElementById('removeProfile').addEventListener('click', removeSelectedProfile);
  document.getElementById('profileName').addEventListener('input', handleProfileNameChange);

  document.getElementById('profileForm').style.display = 'block';
}

function handleInitializationError(error) {
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
      const input = createInput(field.id, field.label, 'text', e => autoSaveProfile(field.id, e.target.value));
      dynamicForm.appendChild(input);
    });
  }
}

function createInput(id, label, type, changeHandler) {
  const container = document.createElement('div');
  const labelElement = document.createElement('label');
  labelElement.htmlFor = id;
  labelElement.textContent = label;
  
  const input = document.createElement('input');
  input.type = type;
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
        updateProfileSelect(profiles, profileId);
        updateStatusMessage(`Profile name updated`);
      });
    }
  });
}


function updateProfileSelect(profiles, selectedProfileId) {
  const profileSelect = document.getElementById('profileSelect');
  profileSelect.innerHTML = '';
  
  Object.entries(profiles).forEach(([id, profile]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = profile.name || '(Unnamed Profile)';
    profileSelect.appendChild(option);
  });
  
  if (selectedProfileId && profiles[selectedProfileId]) {
    profileSelect.value = selectedProfileId;
  }
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
      browser.storage.local.set({ lastLoadedProfileId: profileId });
      updateStatusMessage(`Loaded profile: ${profile.name || '(Unnamed Profile)'}`);
    } else {
      updateStatusMessage(`Profile not found`);
    }
  });
}


function addNewProfile() {
  const newProfileId = generateUUID();
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    profiles[newProfileId] = { name: '' };
    browser.storage.local.set({ profiles, lastLoadedProfileId: newProfileId }).then(() => {
      updateProfileSelect(profiles, newProfileId);
      loadProfile(newProfileId);
      updateStatusMessage(`Created new profile`);
    });
  });
}

function fillForm() {
  const profileName = document.getElementById('profileSelect').value;
  if (!profileName) {
    updateStatusMessage("Please select a profile to fill the form.");
    return;
  }

  browser.storage.local.get('profiles').then(data => {
    const profile = data.profiles[profileName];
    browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
      browser.tabs.sendMessage(tabs[0].id, {
        action: "fillForm",
        profile: profile
      }).then(response => {
        if (response && response.status === "success") {
          updateStatusMessage(`Form filled: ${response.message}`);
        } else {
          updateStatusMessage(`Error filling form: ${response ? response.message : 'Unknown error'}`);
        }
      }).catch(error => {
        updateStatusMessage(`Error: ${error.toString()}`);
      });
    });
  });
}

function backupProfileToTxt() {
  if (!currentProfileId) {
    updateStatusMessage("Please select a profile to backup.");
    return;
  }

  browser.storage.local.get('profiles').then(data => {
    const profiles = data.profiles || {};
    const profile = profiles[currentProfileId];
    if (!profile) {
      updateStatusMessage("Profile not found.");
      return;
    }

    const backupData = {
      id: currentProfileId,
      ...profile
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
        let profileId = backupData.id || generateUUID();
        let profile = { ...backupData };
        delete profile.id; // Remove id from the profile object if it exists

        browser.storage.local.get('profiles').then(data => {
          const profiles = data.profiles || {};
          profiles[profileId] = profile;
          browser.storage.local.set({ profiles, lastLoadedProfile: profileId }).then(() => {
            updateProfileSelect(profiles, profileId);
            loadProfile(profileId);
            updateStatusMessage(`Profile "${profile.name || 'Unnamed Profile'}" loaded from txt file and saved`);
          });
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
  const profileSelect = document.getElementById('profileSelect');
  const selectedProfileId = profileSelect.value;

  if (!selectedProfileId) {
    updateStatusMessage("Please select a profile to remove.");
    return;
  }

  if (confirm(`Are you sure you want to remove this profile?`)) {
    browser.storage.local.get('profiles').then(data => {
      const profiles = data.profiles || {};
      if (profiles[selectedProfileId]) {
        delete profiles[selectedProfileId];
        browser.storage.local.set({ profiles }).then(() => {
          updateProfileSelect(profiles, Object.keys(profiles)[0]);
          if (Object.keys(profiles).length > 0) {
            loadProfile(Object.keys(profiles)[0]);
          } else {
            document.getElementById('profileForm').reset();
            currentProfileId = '';
          }
          updateStatusMessage(`Profile has been removed.`);
        });
      } else {
        updateStatusMessage(`Profile not found.`);
      }
    });
  }
}

function openLlmConfig() {
  browser.windows.create({
    url: 'llmConfig.html',
    type: 'popup',
    width: 800,
    height: 600
  });
}

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
  if (message.action === "fillFormProgress") {
    updateStatusMessage(`Filled ${message.filled} out of ${message.total} fields.`);
  }
});


