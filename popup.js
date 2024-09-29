console.log("popup.js loaded");
let profileFields = [];
let currentProfileName = '';
let isAddingNewProfile = false;
let additionalFieldsHeight = 100; // Default height in pixels

// A function to log things to the end user of the extension 
// under "system messages"
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

document.addEventListener('DOMContentLoaded', function() {
  updateStatusMessage("First configure the API (see the button at the bottom of this screen) after that press Fill Form on a website with forms.");
 
  loadProfileFields()
    .then(() => loadProfiles())
    .then(({ profileName, profile }) => {
      console.log("Loaded profile:", profileName, profile);
      if (profileName && profile) {
        showProfileForm('edit', profileName);
      }
      document.getElementById('fillForm').addEventListener('click', fillForm);
      document.getElementById('showAddProfileForm').addEventListener('click', () => {
        showProfileForm('add');
        const profileNameInput = document.getElementById('profileName');
        profileNameInput.value = '';
        profileNameInput.focus();
      });
      document.getElementById('profileSelect').addEventListener('change', handleProfileSelect);
      document.getElementById('backupProfile').addEventListener('click', backupProfileToTxt);
      document.getElementById('loadFromTxt').addEventListener('click', loadProfileFromTxt);
      document.getElementById('llmConfigButton').addEventListener('click', openLlmConfig);
      document.getElementById('removeProfile').addEventListener('click', removeSelectedProfile);
    })
    .catch(error => {
      console.error("Error during initialization:", error);
      updateStatusMessage("An error occurred while loading. The extension is probably broken. Try again when there's an update.");
    });
});

function openLlmConfig() {
  browser.windows.create({
    url: 'llmConfig.html',
    type: 'popup',
    width: 800,
    height: 600
  });
}

function handleProfileSelect() {
  const profileName = document.getElementById('profileSelect').value;
  if (profileName) {
    browser.storage.local.get('profiles').then(data => {
      const profiles = data.profiles || {};
      const profile = profiles[profileName];
      if (profile) {
        showProfileForm('edit', profileName);
        loadProfile(profile);
        currentProfileName = profileName;
        isAddingNewProfile = false;
      } else {
        updateStatusMessage("Selected profile not found.");
      }
    });
  } else {
    document.getElementById('profileForm').style.display = 'none';
  }
}

function loadProfileFields() {
  return fetch(browser.runtime.getURL('profileFields.yaml'))
    .then(response => response.text())
    .then(yamlText => {
      const data = jsyaml.load(yamlText);
      profileFields = data.fields;
      console.log("Profile fields loaded:", profileFields);
    })
    .catch(error => {
      console.error("Error loading profile fields:", error);
    });
}

function loadProfiles() {
  return browser.storage.local.get(['profiles', 'lastLoadedProfile'])
    .then(data => {
      console.log("Loaded data:", data);
      const profileSelect = document.getElementById('profileSelect');
      const profiles = data.profiles || {};
      updateProfileSelect(profiles, data.lastLoadedProfile);

      if (Object.keys(profiles).length === 0) {
        return createTestProfile().then(testProfile => {
          updateProfileSelect(testProfile, 'Test Profile');
          return { profileName: 'Test Profile', profile: testProfile['Test Profile'] };
        });
      } else if (data.lastLoadedProfile && profiles[data.lastLoadedProfile]) {
        return { profileName: data.lastLoadedProfile, profile: profiles[data.lastLoadedProfile] };
      } else {
        const firstProfileName = Object.keys(profiles)[0];
        return setLastLoadedProfile(firstProfileName).then(() => {
          return { profileName: firstProfileName, profile: profiles[firstProfileName] };
        });
      }
    });
}

function updateProfileSelect(profiles, selectedProfileName = null) {
  const profileSelect = document.getElementById('profileSelect');
  profileSelect.innerHTML = '<option value="">Select a profile</option>';
  
  for (let name in profiles) {
    let option = document.createElement('option');
    option.text = name;
    option.value = name;
    profileSelect.add(option);
    if (name === selectedProfileName) {
      option.selected = true;
    }
  }
}

async function fillForm() {
  const profileName = document.getElementById('profileSelect').value;
  if (!profileName) {
    updateStatusMessage("Please select a profile to fill the form.");
    return;
  }

  const startTime = Date.now();
  const storage = await browser.storage.local.get(['profiles']);
  const profile = storage.profiles[profileName];

  await setLastLoadedProfile(profileName);
  
  console.log("Sending fillForm message with profile:", profile);
  updateStatusMessage(`Starting to fill form...`);
  
  try {
    const tabs = await browser.tabs.query({active: true, currentWindow: true});
    const response = await browser.tabs.sendMessage(tabs[0].id, {
      action: "fillForm",
      profile: profile
    });
    
    console.log("Response from content script:", response);
    if (response && response.status === "success") {
      const endTime = Date.now();
      const processingTime = (endTime - startTime) / 1000;
      updateStatusMessage(`Starting to fill form...\n${response.message}\nDone filling. It took ${processingTime.toFixed(2)} seconds to process.`);
    } else {
      updateStatusMessage(`Error filling form: ${response ? response.message : 'Unknown error'}`);
    }
  } catch (error) {
    console.error("Error sending message to content script:", error);
    updateStatusMessage(`Error filling form: ${error.toString()}`);
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "updateStatus") {
    updateStatusMessage(message.message);
  }
});

// Update showProfileForm to not load the profile again if it's already been loaded
function showProfileForm(mode, profileName = null) {
  console.log("showProfileForm called with mode:", mode, "and profileName:", profileName);
  const formDiv = document.getElementById('profileForm');
  const formTitle = document.getElementById('formTitle');
  const dynamicForm = document.getElementById('dynamicProfileForm');

  formTitle.textContent = mode === 'add' ? 'Add Profile' : 'Edit Profile';
  formDiv.style.display = 'block';
  
  if (mode === 'add' || (mode === 'edit' && dynamicForm.innerHTML === '')) {
    dynamicForm.innerHTML = '';
    const profileNameInput = createProfileNameInput();
    dynamicForm.appendChild(profileNameInput.label);
    dynamicForm.appendChild(profileNameInput.input);
    dynamicForm.appendChild(document.createElement('br'));

    generateForm(dynamicForm);
    addEventListenersToInputs();
  }

  currentProfileName = profileName || '';
  document.getElementById('profileName').value = currentProfileName;

  if (mode === 'add') {
    isAddingNewProfile = true;
    clearForm();
    document.getElementById('profileName').focus();
  } else {
    isAddingNewProfile = false;
  }
}

function createProfileNameInput() {
  const label = document.createElement('label');
  label.htmlFor = 'profileName';
  label.textContent = 'Profile Name:';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'profileName';
  input.addEventListener('input', handleProfileNameChange);

  return { label, input };
}

function clearForm() {
  profileFields.forEach(field => {
    const input = document.getElementById(field.id);
    if (input) {
      input.value = '';
    }
  });
}

function loadProfile(profile) {
  document.getElementById('profileName').value = currentProfileName;
  profileFields.forEach(field => {
    const input = document.getElementById(field.id);
    if (input) {
      input.value = profile[field.id] || '';
    }
  });
}

function saveCurrentFormState() {
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    const profileName = document.getElementById('profileName').value.trim();
    if (profileName) {
      const profile = {};
      profileFields.forEach(field => {
        const input = document.getElementById(field.id);
        if (input) {
          profile[field.id] = input.value;
        }
      });
      profiles[profileName] = profile;
      browser.storage.local.set({profiles: profiles});
    }
  });
}

function handleProfileNameChange(event) {
  const newProfileName = event.target.value.trim();
  
  if (isAddingNewProfile) {
    handleNewProfile(newProfileName);
  } else {
    handleExistingProfile(newProfileName);
  }

  saveCurrentFormState();
}

function handleNewProfile(newProfileName) {
  if (newProfileName === '') {
    clearForm();
    updateStatusMessage("Enter a profile name to create a new profile.");
    return;
  }

  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    
    if (!profiles[newProfileName]) {
      profiles[newProfileName] = {};
      browser.storage.local.set({profiles: profiles});
      updateStatusMessage(`Created new profile "${newProfileName}"`);
      currentProfileName = newProfileName;
      updateProfileSelect(profiles, newProfileName);
      isAddingNewProfile = false;
    } else {
      updateStatusMessage(`Profile "${newProfileName}" already exists. Editing existing profile.`);
      loadProfile(profiles[newProfileName]);
      currentProfileName = newProfileName;
      updateProfileSelect(profiles, newProfileName);
      isAddingNewProfile = false;
    }
  });
}

function handleExistingProfile(newProfileName) {
  if (newProfileName === '') {
    document.getElementById('profileName').value = currentProfileName;
    updateStatusMessage(`Reverted to original profile name "${currentProfileName}"`);
  } else if (newProfileName !== currentProfileName) {
    browser.storage.local.get('profiles').then(data => {
      let profiles = data.profiles || {};
      if (profiles[newProfileName]) {
        updateStatusMessage(`Profile "${newProfileName}" already exists. Cannot rename.`);
        document.getElementById('profileName').value = currentProfileName;
      } else {
        profiles[newProfileName] = profiles[currentProfileName];
        delete profiles[currentProfileName];
        browser.storage.local.set({profiles: profiles});
        updateStatusMessage(`Renamed profile from "${currentProfileName}" to "${newProfileName}"`);
        currentProfileName = newProfileName;
        updateProfileSelect(profiles, newProfileName);
      }
    });
  }
}

function generateForm(form, profile = {}) {
  profileFields.forEach(field => {
    const div = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = field.id;
    label.textContent = field.label + ':';
    
    let input = createFormInput(field);
    input.id = field.id;
    input.value = profile[field.id] || '';
    
    div.appendChild(label);
    div.appendChild(input);
    form.appendChild(div);
  });
}

function createFormInput(field) {
  if (field.type === 'textarea') {
    const textarea = document.createElement('textarea');
    textarea.style.width = '100%';
    textarea.style.minHeight = '100px';
    textarea.style.resize = 'vertical';
    textarea.style.height = `${additionalFieldsHeight}px`;
    
    browser.storage.local.get('additionalFieldsHeight').then(data => {
      textarea.style.height = `${data.additionalFieldsHeight || 100}px`;
    });

    textarea.addEventListener('mouseup', function() {
      additionalFieldsHeight = this.offsetHeight;
      browser.storage.local.set({ additionalFieldsHeight: additionalFieldsHeight });
    });

    return textarea;
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    return input;
  }
}

function addEventListenersToInputs() {
  const dynamicForm = document.getElementById('dynamicProfileForm');
  const allInputs = dynamicForm.querySelectorAll('input, textarea');
  allInputs.forEach(input => {
    if (input.id !== 'profileName') {
      input.addEventListener('input', function() {
        autoSaveProfile(this.id, this.value);
      });
    }
  });
}

function autoSaveProfile(changedField, changedValue) {
  console.log('autoSaveProfile triggered');
  const profileName = document.getElementById('profileName').value.trim();
  if (profileName) {
    const profile = {};
    profileFields.forEach(field => {
      profile[field.id] = document.getElementById(field.id).value;
    });
    
    browser.storage.local.get('profiles').then(data => {
      const profiles = data.profiles || {};
      profiles[profileName] = profile;
      browser.storage.local.set({profiles: profiles}).then(() => {
        console.log(`${profileName} auto-saved`);
        updateStatusMessage(`Automatically saved ${changedField}: ${changedValue} to profile "${profileName}"`);
      });
    });
  }
}

function backupProfileToTxt() {
  const profileName = document.getElementById('profileName').value.replace(/^\d{4}-\d{2}-\d{2}/, '').trim();

  if (profileName) {
    const profile = {};
    profileFields.forEach(field => {
      profile[field.id] = document.getElementById(field.id).value;
    });
    
    const profileJson = JSON.stringify(profile, null, 2);
    const blob = new Blob([profileJson], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;

    const date = new Date();
    const formattedDate = `${date.getFullYear()} ${String(date.getMonth() + 1).padStart(2, '0')} ${String(date.getDate()).padStart(2, '0')}`;
    
    a.download = `${formattedDate} ${profileName}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    updateStatusMessage(`${profileName} backed up to txt file`);
  } else {
    updateStatusMessage("Please enter a profile name before backing up.");
  }
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
        const profile = JSON.parse(event.target.result);
        let profileName = file.name
          .replace(/\.txt$/, '')
          .replace(/_backup$/, '')
          .replace(/^\d{4}\s\d{2}\s\d{2}\s/, '')
          .trim();
        
        document.getElementById('profileName').value = profileName;
        loadProfile(profile);

        browser.storage.local.get('profiles', function(data) {
          const profiles = data.profiles || {};
          profiles[profileName] = profile;
          browser.storage.local.set({profiles: profiles}, function() {
            updateProfileSelect(profiles, profileName);
            updateStatusMessage(`${profileName} loaded from txt file and saved`);
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
  const selectedProfileName = profileSelect.value;

  if (!selectedProfileName) {
    updateStatusMessage("Please select a profile to remove.");
    return;
  }

  if (confirm(`Are you sure you want to remove the profile "${selectedProfileName}"?`)) {
    browser.storage.local.get('profiles').then(data => {
      const profiles = data.profiles || {};
      if (profiles[selectedProfileName]) {
        delete profiles[selectedProfileName];
        browser.storage.local.set({profiles: profiles}).then(() => {
          updateProfileSelect(profiles);
          document.getElementById('profileForm').style.display = 'none';
          updateStatusMessage(`Profile "${selectedProfileName}" has been removed.`);
        });
      } else {
        updateStatusMessage(`Profile "${selectedProfileName}" not found.`);
      }
    });
  }
}

function createTestProfile() {
  const testProfile = {
    'Test Profile': {
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
    profiles: testProfile,
    lastLoadedProfile: 'Test Profile'
  }).then(() => {
    console.log("Test profile created:", testProfile);
    return testProfile;
  });
}

function setLastLoadedProfile(profileName) {
  return browser.storage.local.set({ lastLoadedProfile: profileName });
}

function getLastLoadedProfile() {
  return browser.storage.local.get('lastLoadedProfile')
    .then(result => result.lastLoadedProfile || null);
}