browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === "fillForm") {
      fillFormWithProfile(request.profile);
    }
  });
  
  function fillFormWithProfile(profileName) {
    browser.storage.local.get('profiles', function(data) {
      const profile = data.profiles[profileName];
      if (profile) {
        for (let field in profile) {
          const value = profile[field];
          if (field === 'given_names' || field === 'family_names') {
            fillNameFields(field, value);
          } else {
            const inputs = document.querySelectorAll(`input[name*="${field}"], input[id*="${field}"], input[placeholder*="${field}"]`);
            inputs.forEach(input => {
              input.value = value;
            });
          }
        }
      }
    });
  }
  
  function fillNameFields(fieldType, value) {
    const nameInputs = document.querySelectorAll('input[type="text"], input[name*="name"], input[id*="name"]');
    nameInputs.forEach(input => {
      const inputId = input.id.toLowerCase();
      const inputName = input.name.toLowerCase();
      if (fieldType === 'given_names' && (inputId.includes('first') || inputName.includes('first') || 
          inputId.includes('given') || inputName.includes('given'))) {
        input.value = value;
      } else if (fieldType === 'family_names' && (inputId.includes('last') || inputName.includes('last') || 
                 inputId.includes('family') || inputName.includes('family') || 
                 inputId.includes('surname') || inputName.includes('surname'))) {
        input.value = value;
      }
    });
  }