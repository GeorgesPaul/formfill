console.log("popup.js loaded");
let profileFields = [];

document.addEventListener('DOMContentLoaded', function() {
  loadProfileFields().then(() => {
    return loadProfiles();
  }).then(({ profileName, profile }) => {
    console.log("Loaded profile:", profileName, profile);
    if (profileName && profile) {
      showProfileForm('edit', profileName);
    }
    document.getElementById('fillForm').addEventListener('click', fillForm);
    document.getElementById('showAddProfileForm').addEventListener('click', () => showProfileForm('add'));
    document.getElementById('submitProfile').addEventListener('click', submitProfile);
    document.getElementById('profileSelect').addEventListener('change', handleProfileSelect);
    document.getElementById('backupProfile').addEventListener('click', backupProfileToTxt);
  });
});

function createTestProfile() {
  const testProfile = {
    'Test Profile': {
      user_name: 'usernametest',
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
      linkedIN: 'https://www.linkedin.com/in/georges-meinders/', 
      Website: 'www.megahard.pro',
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
      date_of_birth_day: '10',
      date_of_birth_month: '12',
      date_of_birth_year: '1988', 
      gender: 'Male',
      nationality: 'American',
      occupation: 'Software Engineer'
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
  const profileName = document.getElementById('profileSelect').value;
  if (profileName) {
    const profiles = await browser.storage.local.get('profiles');
    console.log("All profiles:", profiles);
    const profile = profiles.profiles[profileName];
    console.log("Selected profile:", profile);
    
    await setLastLoadedProfile(profileName);
    
    console.log("Sending fillForm message with profile:", profile);
    
    browser.tabs.query({active: true, currentWindow: true}, function(tabs) {
      try {
        browser.tabs.sendMessage(tabs[0].id, {action: "fillForm", profile: profile}, function(response) {
          console.log("Response from content script:", response);
        });
      } catch (error) {
        console.error("Error sending message to content script:", error);
      }
    });
  } else {
    document.getElementById('logMsg').textContent = "Please select a profile to fill the form.";
  }
}

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

  if (mode === 'edit' && profileName) {
    browser.storage.local.get('profiles').then(data => {
      console.log("Retrieved profiles:", data.profiles);
      const profile = data.profiles[profileName];
      console.log("Retrieved profile:", profile);
      if (profile) {
        profileNameInput.value = profileName;
        generateForm(dynamicForm, profile);
      } else {
        document.getElementById('logMsg').textContent = "Profile not found.";
      }
    });
  } else {
    generateForm(dynamicForm);
  }
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

function submitProfile() {
  const profileName = document.getElementById('profileName').value;
  if (profileName) {
    const profile = {};
    profileFields.forEach(field => {
      profile[field.id] = document.getElementById(field.id).value;
    });
    browser.storage.local.get('profiles', function(data) {
      const profiles = data.profiles || {};
      profiles[profileName] = profile;
      browser.storage.local.set({profiles: profiles}, function() {
        updateProfileSelect(profileName);  // Pass the profileName here
        const timestamp = new Date().toLocaleString();
        document.getElementById('logMsg').textContent = `${timestamp}: ${profileName} saved`;
      });
    });
  } else {
    document.getElementById('logMsg').textContent = "Please enter a profile name.";
  }
}

// Updates the dropdown box with profiles to sync between stored profiles and what is displayed
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
    // If no profile was selected and there are profiles, select the first one
    if (!selectedProfileName && profileSelect.options.length > 1) {
      profileSelect.selectedIndex = 1;
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

    const timestamp = new Date().toLocaleString();
    document.getElementById('logMsg').textContent = `${timestamp}: ${profileName} backed up to txt file`;
  } else {
    document.getElementById('logMsg').textContent = "Please enter a profile name before backing up.";
  }
}