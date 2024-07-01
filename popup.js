let profileFields = [];

document.addEventListener('DOMContentLoaded', function() {
  loadProfileFields().then(() => {
    loadProfiles();
    document.getElementById('fillForm').addEventListener('click', fillForm);
    document.getElementById('showAddProfileForm').addEventListener('click', () => showProfileForm('add'));
    //document.getElementById('editProfile').addEventListener('click', () => showProfileForm('edit'));
    document.getElementById('submitProfile').addEventListener('click', submitProfile);
    document.getElementById('profileSelect').addEventListener('change', handleProfileSelect);
  });
});

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
    });
}

function loadProfiles() {
  browser.storage.local.get('profiles', function(data) {
    const profileSelect = document.getElementById('profileSelect');
    const profiles = data.profiles || {};
    profileSelect.innerHTML = '<option value="">Select a profile</option>';
    for (let name in profiles) {
      let option = document.createElement('option');
      option.text = name;
      option.value = name;
      profileSelect.add(option);
    }
  });
}

function fillForm() {
  const profileName = document.getElementById('profileSelect').value;
  if (profileName) {
    browser.tabs.query({active: true, currentWindow: true}, function(tabs) {
      browser.tabs.sendMessage(tabs[0].id, {action: "fillForm", profile: profileName});
    });
  } else {
    document.getElementById('logMsg').textContent = "Please select a profile to fill the form.";
  }
}

function showProfileForm(mode, profileName = null) {
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
  
    if (mode === 'edit') {
      if (!profileName) {
        document.getElementById('logMsg').textContent = "Please select a profile to edit.";
        formDiv.style.display = 'none';
        return;
      }
      browser.storage.local.get('profiles', function(data) {
        const profile = data.profiles[profileName];
        profileNameInput.value = profileName;
        generateForm(dynamicForm, profile);
      });
    } else {
      generateForm(dynamicForm);
    }
  }

function generateForm(form, profile = {}) {
  profileFields.forEach(field => {
    const label = document.createElement('label');
    label.htmlFor = field.id;
    label.textContent = field.label + ':';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = field.id;
    input.value = profile[field.id] || '';
    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(document.createElement('br'));
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
        loadProfiles();
        document.getElementById('logMsg').textContent = "Profile saved successfully.";
        document.getElementById('profileForm').style.display = 'none';
      });
    });
  } else {
    document.getElementById('logMsg').textContent = "Please enter a profile name.";
  }
}