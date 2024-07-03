async function loadYaml(src) {
  const response = await fetch(browser.runtime.getURL(src));
  const yamlText = await response.text();
  return jsyaml.load(yamlText);
}

function simpleSimilarity(str1, str2) {
  str1 = str1.toLowerCase();
  str2 = str2.toLowerCase();
  const set1 = new Set(str1.split(/\W+/));
  const set2 = new Set(str2.split(/\W+/));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

function findBestMatch(fieldInfo, profileFields) {
  let bestMatch = null;
  let highestSimilarity = -1;

  const fieldString = Object.values(fieldInfo).filter(Boolean).join(' ').toLowerCase();

  for (const field of profileFields) {
      const fieldMetadata = [
          field.id,
          field.label,
          field.description,
          ...(field.aliases || []),
          ...(field.common_labels || []),
          ...(field.possible_placeholders || []),
      ].join(' ').toLowerCase();

      const similarity = simpleSimilarity(fieldString, fieldMetadata);

      if (similarity > highestSimilarity) {
          highestSimilarity = similarity;
          bestMatch = field;
      }
  }

  return bestMatch;
}

function getNearbyText(element, maxDistance = 50) {
  let text = '';
  let node = element;
  let distance = 0;

  while (node && distance < maxDistance) {
      if (node.nodeType === Node.TEXT_NODE) {
          text += ' ' + node.textContent.trim();
      } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'LABEL' && node.htmlFor === element.id) {
              text += ' ' + node.textContent.trim();
          }
      }
      node = node.previousSibling || node.parentNode;
      distance++;
  }

  return text.trim();
}

browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  console.log("Received message in content script:", message);
 
  if (message.action === "fillForm") {
      console.log("Filling form with profile:", message.profile);
      const profile = message.profile;
   
      try {
          const { fields: profileFields } = await loadYaml('profileFields.yaml');
          console.log("Loaded profile fields:", profileFields);

          const formInputs = document.querySelectorAll('input, select, textarea');
          console.log("Found form inputs:", formInputs.length);

          for (const input of formInputs) {
              const fieldInfo = {
                  name: input.name,
                  id: input.id,
                  placeholder: input.placeholder,
                  type: input.type,
                  nearbyText: getNearbyText(input)
              };

              if (Object.values(fieldInfo).some(value => value)) {
                  console.log("Processing field:", fieldInfo);
                  const bestMatch = findBestMatch(fieldInfo, profileFields);
                  console.log("Best match for", fieldInfo, ":", bestMatch);
                  if (bestMatch && profile[bestMatch.id]) {
                      input.value = profile[bestMatch.id];
                      console.log("Filled", fieldInfo.name || fieldInfo.id, "with", profile[bestMatch.id]);
                  }
              }
          }
     
          sendResponse({status: "success"});
      } catch (error) {
          console.error("Error filling form:", error);
          sendResponse({status: "error", message: error.toString()});
      }
  }
 
  return true;  // Indicates that we will send a response asynchronously
});