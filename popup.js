let currentProfileId = '';
let isFilling = false; // Track filling state

// Add message listener to handle messages from background script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch(message.action) {
    case "fillFormStart":
    case "fillFormProgress":
    case "fillFormComplete":
    case "fillFormStopped":
    case "fillFormError":
      if (message.message) {
        updateStatusMessage(message.message);
      }
      break;
  }
});

// Default text template for profile data
const DEFAULT_PROFILE_TEXT = `name: Test Profile
user_name: johndoe123
given_names: John William
family_names: Doe Smith
name_order: Given-Family
name_infix: van
name_prefix: de
title: Dr.
salutation: Mr.
name_suffix: Jr.
preferred_name: Johnny
full_name: Dr. John William van de Doe Smith Jr.
email: john.doe@example.com
linkedIN: https://www.linkedin.com/in/johndoe
website: www.johndoe.com
phone: +1 (555) 123-4567
phone_country_code: +1
phone_area_code: 555
phone_local_number: 123-4567
address_line1: 123 Main Street
address_line2: Apartment 4B
address_street: Main Street
address_house_number: 123
address_city: Anytown
address_state: California
address_postal_code: 12345
address_country: United States
date_of_birth_day: 15
date_of_birth_month: 07
date_of_birth_year: 1985
gender: Male
tax_number: 123-45-6789
social_security_number: 987-65-4321
health_insurance_number: 1EG4-TE5-MK72
nationality: American
passport_number: A1234567
passport_expiry_day: 20
passport_expiry_month: 09
passport_expiry_year: 2028
occupation: Software Engineer
cardholder_name: John W. Doe
credit_card_number: 4111111111111111
credit_card_brand: Visa
credit_card_expiration_month: 12
credit_card_expiration_year: 2025
credit_card_security_code: 123`;

// Template for new empty profiles
const EMPTY_PROFILE_TEXT = `
name: Your Full Name
email: your.email@example.com
phone: +1 (555) 123-4567
address_line1: 123 Main Street
address_city: Your City
address_state: Your State
address_postal_code: 12345
address_country: Your Country

`;

document.addEventListener('DOMContentLoaded', initializeExtension);

function initializeExtension() {
  updateStatusMessage("Configure the API (button at bottom) then press Fill Form on a website with forms.");
  
  loadProfiles()
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
      data: DEFAULT_PROFILE_TEXT
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
  console.log('initializeUI called with profiles:', Object.keys(profiles));
  
  // Initialize the profile form first
  initializeProfileForm();
  
  updateProfileSelect(profiles);
  
  // Set up event listeners
  document.getElementById('fillForm').addEventListener('click', fillForm);
  document.getElementById('stopFilling').addEventListener('click', stopFilling);
  document.getElementById('profileSelect').addEventListener('change', updateSelectedCount);
  document.getElementById('selectAllProfiles').addEventListener('click', selectAllProfiles);
  document.getElementById('clearAllProfiles').addEventListener('click', clearAllProfiles);
  document.getElementById('showAddProfileForm').addEventListener('click', addNewProfile);
  document.getElementById('backupAllProfiles').addEventListener('click', backupAllProfilesToTxt);
  document.getElementById('saveSelectedProfile').addEventListener('click', backupProfileToTxt);
  document.getElementById('backupAllProfiles').addEventListener('click', backupAllProfilesToTxt);
  document.getElementById('reloadBackup').addEventListener('click', loadCompleteBackupFromTxt);
  document.getElementById('addProfileFromTxt').addEventListener('click', addProfileFromTxt);
  document.getElementById('llmConfigButton').addEventListener('click', openLlmConfig);
  document.getElementById('removeProfile').addEventListener('click', removeSelectedProfile);  
  document.getElementById('profileName').addEventListener('input', handleProfileNameChange);
  document.getElementById('donateButton').addEventListener('click', function() {
    const stripePaymentLink = 'https://donate.stripe.com/cN2dRB4RRcT40OA000';
    // Open the Stripe payment link in a new tab
    window.open(stripePaymentLink, '_blank');
  });

  // Load previously selected profiles and load the first one into the form
  browser.storage.local.get('selectedProfileIds').then(data => {
    const selectedIds = data.selectedProfileIds || [];
    updateProfileSelect(profiles, selectedIds);
    
    // Load the first selected profile into the form
    if (selectedIds.length >= 1) {
      loadProfileIntoForm(selectedIds[0]);
    } else if (lastLoadedProfileId && profiles[lastLoadedProfileId]) {
      // If no profiles are selected but we have a last loaded profile, load it
      loadProfileIntoForm(lastLoadedProfileId);
    } else if (Object.keys(profiles).length > 0) {
      // If no selection and no last loaded, load the first available profile
      const firstProfileId = Object.keys(profiles)[0];
      loadProfileIntoForm(firstProfileId);
    }
  });
  
  // Ensure the profile form is visible
  document.getElementById('profileForm').style.display = 'block';
  console.log('Profile form should be visible now');
}

function handleInitializationError(error) {
  isFilling = false; // Ensure reset on init error
  updateButtonStates();
  console.error("Initialization error:", error);
  updateStatusMessage("An error occurred while loading. Please try again later.");
}

function initializeProfileForm() {
  console.log('initializeProfileForm called');
  const formDiv = document.getElementById('profileForm');
  const dynamicForm = document.getElementById('dynamicProfileForm');
  
  console.log('formDiv:', formDiv);
  console.log('dynamicForm:', dynamicForm);
  
  // Check if the textarea already exists
  const existingTextarea = document.getElementById('profileData');
  const existingNameInput = document.getElementById('profileName');
  
  console.log('existingTextarea:', existingTextarea);
  console.log('existingNameInput:', existingNameInput);
  
  if (!existingTextarea || !existingNameInput) {
    // Clear the form and recreate it
    dynamicForm.innerHTML = '';
    
    const profileNameInput = createInput('profileName', 'Profile Name:', 'text', handleProfileNameChange);
    dynamicForm.appendChild(profileNameInput);
    dynamicForm.appendChild(document.createElement('br'));
    
    // Create the main data textarea
    const dataInput = createInput('profileData', 'Enter as much data as possible:', 'textarea', handleProfileDataChange);
    dynamicForm.appendChild(dataInput);
    
    console.log('Profile form recreated');
    console.log('Created elements:', document.getElementById('profileName'), document.getElementById('profileData'));
  } else {
    console.log('Profile form already exists');
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
    input.rows = 15;
    input.cols = 40;
    input.style.width = '100%';
    input.style.resize = 'vertical';
    input.placeholder = 'Enter profile data in key: value format, one per line...';
  } else {
    input = document.createElement('input');
    input.type = inputType || 'text';
  }
  input.id = id;
  input.addEventListener('input', changeHandler);
  
  container.appendChild(labelElement);
  container.appendChild(document.createElement('br'));
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

function handleProfileDataChange(event) {
  const newData = event.target.value;
  if (currentProfileId) {
    browser.storage.local.get('profiles').then(data => {
      let profiles = data.profiles || {};
      if (!profiles[currentProfileId]) {
        profiles[currentProfileId] = { name: '', data: '' };
      }
      profiles[currentProfileId].data = newData;
      browser.storage.local.set({ profiles }).then(() => {
        console.log(`Profile ${currentProfileId} data auto-saved`);
        updateStatusMessage(`Profile data saved`);
      });
    });
  }
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
  
  console.log('updateSelectedCount called');
  console.log('Selected options:', selectedOptions.map(opt => ({ value: opt.value, text: opt.textContent })));
  console.log('Selected count:', count);
  
  const selectedCount = document.getElementById('selectedCount');
  if (selectedCount) {
    selectedCount.textContent = `${count} profile${count !== 1 ? 's' : ''} selected`;
    console.log('Updated selectedCount text to:', selectedCount.textContent);
  } else {
    console.log('selectedCount element not found');
  }
  
  // Store selected profiles
  const selectedIds = selectedOptions.map(option => option.value);
  console.log('Selected IDs:', selectedIds);
  browser.storage.local.set({ selectedProfileIds: selectedIds });
  
  // Load profile into form if exactly one is selected
  if (selectedIds.length === 1) {
    console.log('Loading single profile:', selectedIds[0]);
    loadProfileIntoForm(selectedIds[0]);
  } else if (selectedIds.length > 1) {
    // When multiple profiles are selected, load the first one but don't set currentProfileId
    console.log('Loading first of multiple profiles:', selectedIds[0]);
    loadProfileIntoForm(selectedIds[0]);
  } else {
    // No profiles selected, clear the form
    console.log('No profiles selected, clearing form');
    document.getElementById('profileName').value = '';
    document.getElementById('profileData').value = EMPTY_PROFILE_TEXT;
    currentProfileId = '';
  }
  
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
        profiles[currentProfileId] = { name: '', data: '' };
      }
      profiles[currentProfileId][fieldId] = value;
      browser.storage.local.set({ profiles }).then(() => {
        console.log(`Profile ${currentProfileId} auto-saved`);
        updateStatusMessage(`Saved ${fieldId} for current profile`);
      });
    });
  }
}

// Function to convert profile object back to text
function profileToText(profile) {
  const lines = [];
  Object.entries(profile).forEach(([key, value]) => {
    if (key !== 'name' && value) {
      lines.push(`${key}: ${value}`);
    }
  });
  return lines.join('\n');
}

// Simplified fillForm function - send raw text directly to LLM
async function fillForm() {
  const selectedIds = getSelectedProfileIds();
  if (selectedIds.length === 0) {
    updateStatusMessage("No profiles selected!");
    return;
  }

  isFilling = true;
  updateButtonStates();
  updateStatusMessage("Filling form with selected profiles...");

  try {
    const data = await browser.storage.local.get('profiles');
    const profiles = data.profiles || {};
    
    // Send raw profile text directly (no parsing needed)
    let profileTexts = [];
    
    selectedIds.forEach(id => {
      if (profiles[id] && profiles[id].data) {
        profileTexts.push({
          name: profiles[id].name,
          data: profiles[id].data.trim() // Raw text as-is
        });
      }
    });
    
    // Log the raw profile texts being used
    console.log('=== RAW PROFILE TEXTS FOR FORM FILLING ===');
    profileTexts.forEach((profile, index) => {
      console.log(`Profile ${index + 1}: ${profile.name}`);
      console.log('Raw text:');
      console.log(profile.data);
      console.log('');
    });
    console.log('================================');

    // Capture the custom prompt
    const customPrompt = document.getElementById('userPrompt').value.trim();
    
    // Send both profiles AND custom prompt
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await browser.tabs.sendMessage(tabs[0].id, {
        action: "fillForm",
        profiles: profileTexts,
        customPrompt: customPrompt // Add this line
      });
    }
  } catch (error) {
    console.error("Error filling form:", error);
    updateStatusMessage("Error: " + error.message);
    isFilling = false;
    updateButtonStates();
  }
}

function stopFilling() {
  isFilling = false;
  updateButtonStates();
  updateStatusMessage("Form filling stopped.");
  
  // Send stop message to content script
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) {
      browser.tabs.sendMessage(tabs[0].id, { action: "stopFilling" });
    }
  });
}

function updateButtonStates() {
  const fillButton = document.getElementById('fillForm');
  const stopButton = document.getElementById('stopFilling');
  
  if (isFilling) {
    fillButton.disabled = true;
    stopButton.disabled = false;
  } else {
    fillButton.disabled = false;
    stopButton.disabled = true;
  }
}

function updateStatusMessage(message) {
  const logMsg = document.getElementById('logMsg');
  if (logMsg) {
    logMsg.textContent = message;
  }
}

function addNewProfile() {
  const newProfileId = generateUUID();
  const newProfileName = prompt('Enter profile name:');
  if (!newProfileName) return;
  
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    profiles[newProfileId] = {
      name: newProfileName,
      data: EMPTY_PROFILE_TEXT
    };
    
    browser.storage.local.set({ 
      profiles, 
      lastLoadedProfileId: newProfileId 
    }).then(() => {
      refreshProfileList();
      loadProfileIntoForm(newProfileId);
      updateStatusMessage(`New profile "${newProfileName}" created`);
    });
  });
}

function loadProfileIntoForm(profileId) {
  if (!profileId) {
    console.log('No profileId provided to loadProfileIntoForm');
    return;
  }
  
  console.log('Loading profile:', profileId);
  currentProfileId = profileId;
  
  browser.storage.local.get('profiles').then(data => {
    const profiles = data.profiles || {};
    const profile = profiles[profileId];
    
    console.log('All profiles in storage:', profiles);
    console.log('Profile data for', profileId, ':', profile);
    
    if (profile) {
      const profileNameInput = document.getElementById('profileName');
      const profileDataInput = document.getElementById('profileData');
      
      console.log('Setting profile name to:', profile.name);
      console.log('Setting profile data to:', profile.data);
      
      if (profileNameInput && profileDataInput) {
        profileNameInput.value = profile.name || '';
        profileDataInput.value = profile.data || EMPTY_PROFILE_TEXT;
        updateStatusMessage(`Loaded profile: ${profile.name}`);
        console.log('Profile loaded successfully:', profile.name);
        console.log('Form elements updated. Name value:', profileNameInput.value);
        console.log('Form elements updated. Data value length:', profileDataInput.value.length);
      } else {
        console.error('Form elements not found when loading profile');
        console.log('profileNameInput exists:', !!profileNameInput);
        console.log('profileDataInput exists:', !!profileDataInput);
        // Try to reinitialize the form
        initializeProfileForm();
        setTimeout(() => {
          const profileNameInput = document.getElementById('profileName');
          const profileDataInput = document.getElementById('profileData');
          if (profileNameInput && profileDataInput) {
            profileNameInput.value = profile.name || '';
            profileDataInput.value = profile.data || EMPTY_PROFILE_TEXT;
            updateStatusMessage(`Loaded profile: ${profile.name}`);
          }
        }, 100);
      }
    } else {
      console.error('Profile not found:', profileId);
      console.log('Available profile IDs:', Object.keys(profiles));
    }
  }).catch(error => {
    console.error('Error loading profile:', error);
  });
}

function refreshProfileList() {
  browser.storage.local.get(['profiles', 'selectedProfileIds']).then(data => {
    const profiles = data.profiles || {};
    const selectedIds = data.selectedProfileIds || [];
    updateProfileSelect(profiles, selectedIds);
  });
}

function removeSelectedProfile() {
  const selectedIds = getSelectedProfileIds();
  if (selectedIds.length === 0) {
    updateStatusMessage("No profiles selected to remove!");
    return;
  }
  
  const confirmRemove = confirm(`Remove ${selectedIds.length} selected profile(s)?`);
  if (!confirmRemove) return;
  
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    selectedIds.forEach(id => {
      delete profiles[id];
    });
    
    browser.storage.local.set({ profiles }).then(() => {
      refreshProfileList();
      updateStatusMessage(`${selectedIds.length} profile(s) removed`);
      
      // Clear form if current profile was removed
      if (selectedIds.includes(currentProfileId)) {
        document.getElementById('profileName').value = '';
        document.getElementById('profileData').value = EMPTY_PROFILE_TEXT;
        currentProfileId = '';
      }
    });
  });
}

function addProfileFromTxt() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
      const text = e.target.result;
      importSingleProfileFromText(text, file);
    };
    reader.readAsText(file);
  };
  input.click();
}

function importSingleProfileFromText(text, file = null) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) {
    updateStatusMessage("Invalid profile file format");
    return;
  }
  
  // Check if it starts with === Profile Name ===
  const firstLine = lines[0].trim();
  let profileName, profileData;
  
  if (firstLine.startsWith('===') && firstLine.endsWith('===')) {
    profileName = firstLine.slice(3, -3).trim();
    profileData = lines.slice(1).join('\n').trim();
  } else {
    // Fallback: treat whole file as profile data, use filename or ask for name
    const defaultName = file ? file.name.replace('.txt', '') : 'Imported Profile';
    profileName = prompt('Enter profile name:', defaultName);
    if (!profileName) return;
    profileData = text.trim();
  }
  
  if (!profileName || !profileData) {
    updateStatusMessage("Profile must have both name and data");
    return;
  }
  
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    const newProfileId = generateUUID();
    profiles[newProfileId] = {
      name: profileName,
      data: profileData
    };
    
    browser.storage.local.set({ profiles }).then(() => {
      refreshProfileList();
      loadProfileIntoForm(newProfileId);
      updateStatusMessage(`Profile "${profileName}" imported successfully`);
    });
  });
}

function backupAllProfilesToTxt() {
  browser.storage.local.get(['profiles', 'lastLoadedProfile', 'selectedProfileIds']).then(data => {
    const profiles = data.profiles || {};
    const lastLoadedProfile = data.lastLoadedProfile;
    const selectedProfileIds = data.selectedProfileIds || [];
    
    let backupText = '# FormFill Extension Backup\n';
    backupText += '# Generated on: ' + new Date().toISOString() + '\n';
    backupText += '# Number of profiles: ' + Object.keys(profiles).length + '\n\n';
    
    // Add metadata
    backupText += '=== METADATA ===\n';
    backupText += 'lastLoadedProfile: ' + (lastLoadedProfile || '') + '\n';
    backupText += 'selectedProfileIds: ' + JSON.stringify(selectedProfileIds) + '\n\n';
    
    // Add all profiles with their original UUIDs
    Object.entries(profiles).forEach(([profileId, profile]) => {
      backupText += `=== PROFILE:${profileId} ===\n`;
      backupText += `name: ${profile.name}\n`;
      backupText += profile.data + '\n\n';
    });
    
    const blob = new Blob([backupText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formfill_complete_backup.txt';
    a.click();
    URL.revokeObjectURL(url);
    
    updateStatusMessage("Complete backup downloaded with all profiles");
  });
}

function backupProfileToTxt() {
  const selectedIds = getSelectedProfileIds();
  if (selectedIds.length === 0) {
    updateStatusMessage("No profiles selected to backup!");
    return;
  }
  
  browser.storage.local.get('profiles').then(data => {
    const profiles = data.profiles || {};
    let backupText = '';
    
    selectedIds.forEach(id => {
      const profile = profiles[id];
      if (profile) {
        backupText += `=== ${profile.name} ===\n`;
        backupText += profile.data + '\n\n';
      }
    });
    
    const blob = new Blob([backupText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formfill_selected_profiles_backup.txt';
    a.click();
    URL.revokeObjectURL(url);
    
    updateStatusMessage("Selected profiles backup downloaded");
  });
}

function loadCompleteBackupFromTxt() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
      const text = e.target.result;
      if (text.startsWith('# FormFill Extension Backup')) {
        restoreCompleteBackup(text);
      } else {
        // Fall back to old format for backwards compatibility
        importProfilesFromText(text);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function loadProfileFromTxt() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
      const text = e.target.result;
      importProfilesFromText(text);
    };
    reader.readAsText(file);
  };
  input.click();
}

function restoreCompleteBackup(text) {
  const lines = text.split('\n');
  let metadata = {};
  let profiles = {};
  let currentProfileId = null;
  let currentProfileData = '';
  let inMetadata = false;
  let inProfile = false;
  
  lines.forEach(line => {
    if (line.startsWith('=== METADATA ===')) {
      inMetadata = true;
      inProfile = false;
      return;
    }
    
    if (line.startsWith('=== PROFILE:')) {
      // Save previous profile if any
      if (currentProfileId && currentProfileData) {
        profiles[currentProfileId] = {
          name: currentProfileData.split('\n')[0].replace('name: ', ''),
          data: currentProfileData.split('\n').slice(1).join('\n').trim()
        };
      }
      
      // Start new profile
      const profileIdMatch = line.match(/=== PROFILE:(.+) ===/);
      if (profileIdMatch) {
        currentProfileId = profileIdMatch[1];
        currentProfileData = '';
        inMetadata = false;
        inProfile = true;
      }
      return;
    }
    
    if (inMetadata) {
      if (line.startsWith('lastLoadedProfile:')) {
        metadata.lastLoadedProfile = line.split(': ')[1];
      } else if (line.startsWith('selectedProfileIds:')) {
        try {
          metadata.selectedProfileIds = JSON.parse(line.split(': ')[1]);
        } catch (e) {
          metadata.selectedProfileIds = [];
        }
      }
    } else if (inProfile && currentProfileId) {
      currentProfileData += line + '\n';
    }
  });
  
  // Save the last profile
  if (currentProfileId && currentProfileData) {
    profiles[currentProfileId] = {
      name: currentProfileData.split('\n')[0].replace('name: ', ''),
      data: currentProfileData.split('\n').slice(1).join('\n').trim()
    };
  }
  
  // Restore everything
  browser.storage.local.set({
    profiles: profiles,
    lastLoadedProfile: metadata.lastLoadedProfile || null,
    selectedProfileIds: metadata.selectedProfileIds || []
  }).then(() => {
    refreshProfileList();
    updateStatusMessage(`Complete backup restored with ${Object.keys(profiles).length} profiles`);
  });
}

function importProfilesFromText(text) {
  const sections = text.split('===').filter(section => section.trim());
  let importedCount = 0;
  
  browser.storage.local.get('profiles').then(data => {
    let profiles = data.profiles || {};
    
    sections.forEach(section => {
      const lines = section.trim().split('\n');
      if (lines.length > 0) {
        const profileName = lines[0].trim();
        const profileData = lines.slice(1).join('\n').trim();
        
        if (profileName && profileData) {
          const newProfileId = generateUUID();
          profiles[newProfileId] = {
            name: profileName,
            data: profileData
          };
          importedCount++;
        }
      }
    });
    
    browser.storage.local.set({ profiles }).then(() => {
      refreshProfileList();
      updateStatusMessage(`${importedCount} profile(s) imported`);
    });
  });
}

function openLlmConfig() {
  browser.tabs.create({ url: browser.runtime.getURL('llmConfig.html') });
}