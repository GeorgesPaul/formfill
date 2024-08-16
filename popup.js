console.log("popup.js loaded");
let profileFields = [];
let currentProfileName = '';

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
  
  // Display the instructional message every time the extension loads
  updateStatusMessage("Press the Fill Form button to start filling forms on any website.\n\nMake sure ollama is running llama3 by typing \"ollama run llama3.1\" after downloading and installing Ollama from Ollama.com");
  
  loadProfileFields().then(() => {
    return loadProfiles();
  }).then(({ profileName, profile }) => {
    console.log("Loaded profile:", profileName, profile);
    if (profileName && profile) {
      showProfileForm('edit', profileName);
    }
    document.getElementById('fillForm').addEventListener('click', fillForm);
    document.getElementById('showAddProfileForm').addEventListener('click', () => showProfileForm('add'));
    document.getElementById('profileSelect').addEventListener('change', handleProfileSelect);
    document.getElementById('backupProfile').addEventListener('click', backupProfileToTxt);
    document.getElementById('loadFromTxt').addEventListener('click', loadProfileFromTxt);
    document.getElementById('llmConfigButton').addEventListener('click', openLlmConfig);
    document.getElementById('removeProfile').addEventListener('click', removeSelectedProfile);
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
      Website: 'www.johndoe.com',
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
      nationality: 'American',
      occupation: 'Software Engineer',
      passport_number: 'A1234567',
      passport_expiry_day: '20',
      passport_expiry_month: '09',
      passport_expiry_year: '2028'
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

function handleProfileSelect() {
  const profileName = document.getElementById('profileSelect').value;
  if (profileName) {
    showProfileForm('edit', profileName);
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
      profileSelect.innerHTML = '<option value="">Select a profile</option>';
      
      for (let name in profiles) {
        let option = document.createElement('option');
        option.text = name;
        option.value = name;
        profileSelect.add(option);
      }

      let selectedProfile;
      if (Object.keys(profiles).length === 0) {
        // No profiles exist, create and load test profile
        return createTestProfile().then(testProfile => {
          let option = document.createElement('option');
          option.text = 'Test Profile';
          option.value = 'Test Profile';
          profileSelect.add(option);
          profileSelect.value = 'Test Profile';
          selectedProfile = testProfile['Test Profile'];
          return { profileName: 'Test Profile', profile: selectedProfile };
        });
      } else if (data.lastLoadedProfile && profiles[data.lastLoadedProfile]) {
        // Set the select to the last loaded profile
        profileSelect.value = data.lastLoadedProfile;
        selectedProfile = profiles[data.lastLoadedProfile];
        return { profileName: data.lastLoadedProfile, profile: selectedProfile };
      } else {
        // No last loaded profile, select the first available profile
        const firstProfileName = Object.keys(profiles)[0];
        profileSelect.value = firstProfileName;
        selectedProfile = profiles[firstProfileName];
        return setLastLoadedProfile(firstProfileName).then(() => {
          return { profileName: firstProfileName, profile: selectedProfile };
        });
      }
    });
}

async function fillForm() {
  const startTime = Date.now();
  const profileName = document.getElementById('profileSelect').value;
  if (profileName) {
    const storage = await browser.storage.local.get(['profiles']);
    const profile = storage.profiles[profileName];
    //const currentConfigName = storage.currentLlmConfig;
    //const currentLlmConfig = storage.llmConfigurations[currentConfigName];

    //console.log("Current LLM Config:", currentLlmConfig);

    await setLastLoadedProfile(profileName);
    
    console.log("Sending fillForm message with profile:", profile);
    
    updateStatusMessage(`Starting to fill form...`);
    
    try {
      const tabs = await browser.tabs.query({active: true, currentWindow: true});
      const response = await browser.tabs.sendMessage(tabs[0].id, {
        action: "fillForm",
        profile: profile//,
        //llmConfig: currentLlmConfig
      });
      
      console.log("Response from content script:", response);
      if (response && response.status === "success") {
        const endTime = Date.now();
        const processingTime = (endTime - startTime) / 1000; // Convert to seconds
        updateStatusMessage(`Starting to fill form...\n${response.message}\nDone filling. It took ${processingTime.toFixed(2)} seconds to process.`);
      } else {
        updateStatusMessage(`Error filling form: ${response ? response.message : 'Unknown error'}`);
      }
    } catch (error) {
      console.error("Error sending message to content script:", error);
      updateStatusMessage(`Error filling form: ${error.toString()}`);
    }
  } else {
    updateStatusMessage("Please select a profile to fill the form.");
  }
}

// This listens to updates from the thread(s) running in content.js
// This is to give user feedback about the status of the form filling (running in another thread/isolated from the extension)
browser.runtime.onMessage.addListener((message) => {
  if (message.action === "fillFormProgress") {
    updateStatusMessage(`Processing ${message.filled} out of ${message.total} fields done.`);
  }
});

function showProfileForm(mode, profileName = null) {
  console.log("showProfileForm called with mode:", mode, "and profileName:", profileName);
  const formDiv = document.getElementById('profileForm');
  const formTitle = document.getElementById('formTitle');
  const dynamicForm = document.getElementById('dynamicProfileForm');

  formTitle.textContent = mode === 'add' ? 'Add Profile' : 'Edit Profile';
  formDiv.style.display = 'block';
  dynamicForm.innerHTML = '';

  // Add profile name field
  const profileNameLabel = document.createElement('label');
  profileNameLabel.htmlFor = 'profileName';
  profileNameLabel.textContent = 'Profile Name:';
  const profileNameInput = document.createElement('input');
  profileNameInput.type = 'text';
  profileNameInput.id = 'profileName';
  dynamicForm.appendChild(profileNameLabel);
  dynamicForm.appendChild(profileNameInput);
  dynamicForm.appendChild(document.createElement('br'));

  // Set the current profile name
  currentProfileName = profileName || '';
  profileNameInput.value = currentProfileName;

  // Add event listener for input changes
  profileNameInput.addEventListener('input', handleProfileNameChange);

  if (mode === 'edit' && profileName) {
    browser.storage.local.get('profiles').then(data => {
      console.log("Retrieved profiles:", data.profiles);
      const profile = data.profiles[profileName];
      console.log("Retrieved profile:", profile);
      if (profile) {
        generateForm(dynamicForm, profile);
        addEventListenersToInputs();
      } else {
        document.getElementById('logMsg').textContent = "Profile not found.";
      }
    });
  } else {
    generateForm(dynamicForm);
    addEventListenersToInputs();
  }
}

function handleProfileNameChange(event) {
  const newProfileName = event.target.value.trim();
  if (newProfileName && newProfileName !== currentProfileName) {
    browser.storage.local.get('profiles').then(data => {
      const profiles = data.profiles || {};
      if (profiles[currentProfileName]) {
        // Rename existing profile
        profiles[newProfileName] = profiles[currentProfileName];
        delete profiles[currentProfileName];
      }
      browser.storage.local.set({profiles: profiles}).then(() => {
        currentProfileName = newProfileName;
        updateProfileSelect(newProfileName);
        document.getElementById('logMsg').textContent = `Profile renamed to ${newProfileName}`;
      });
    });
  }
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
        // Add status message update
        updateStatusMessage(`Automatically saved ${changedField}: ${changedValue} to profile "${profileName}"`);
      });
    });
  }
}

function updateProfileSelect(selectedProfileName = null) {
  browser.storage.local.get('profiles', function(data) {
    const profileSelect = document.getElementById('profileSelect');
    const profiles = data.profiles || {};
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
  });
}

function generateForm(form, profile = {}) {
  profileFields.forEach(field => {
    const div = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = field.id;
    label.textContent = field.label + ':';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = field.id;
    input.value = profile[field.id] || '';
    div.appendChild(label);
    div.appendChild(input);
    form.appendChild(div);
  });
}

function addEventListenersToInputs() {
  const dynamicForm = document.getElementById('dynamicProfileForm');
  const allInputs = dynamicForm.querySelectorAll('input');
  allInputs.forEach(input => {
    if (input.id === 'profileName') {
      input.addEventListener('input', handleProfileNameChange);
    } else {
      input.addEventListener('input', function() {
        autoSaveProfile(this.id, this.value);
      });
    }
  });
}

function backupProfileToTxt() {
  const profileName = document.getElementById('profileName').value;
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
    a.download = `${profileName}_backup.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    document.getElementById('logMsg').textContent = `${profileName} backed up to txt file`;
  } else {
    document.getElementById('logMsg').textContent = "Please enter a profile name before backing up.";
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
        const profileName = file.name.replace('_backup.txt', '');
        
        // Clear all form fields first
        document.getElementById('profileName').value = '';
        profileFields.forEach(field => {
          const input = document.getElementById(field.id);
          if (input) {
            input.value = '';
          }
        });

        // Update form fields with loaded data
        document.getElementById('profileName').value = profileName;
        profileFields.forEach(field => {
          const input = document.getElementById(field.id);
          if (input && profile[field.id]) {
            input.value = profile[field.id];
          }
        });

        // Save the loaded profile
        browser.storage.local.get('profiles', function(data) {
          const profiles = data.profiles || {};
          profiles[profileName] = profile;
          browser.storage.local.set({profiles: profiles}, function() {
            updateProfileSelect(profileName);
            document.getElementById('logMsg').textContent = `${profileName} loaded from txt file and saved`;
          });
        });
      } catch (error) {
        document.getElementById('logMsg').textContent = "Error loading profile: " + error.message;
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
          updateProfileSelect();
          document.getElementById('profileForm').style.display = 'none';
          updateStatusMessage(`Profile "${selectedProfileName}" has been removed.`);
        });
      } else {
        updateStatusMessage(`Profile "${selectedProfileName}" not found.`);
      }
    });
  }
}
