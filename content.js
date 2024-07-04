const match_score_threshold = 0.1; 

// Simplified TF-IDF and n-gram matching
function createNGrams(text, n = 2) {
  const ngrams = [];
  for (let i = 0; i < text.length - n + 1; i++) {
      ngrams.push(text.slice(i, i + n));
  }
  return ngrams;
}

function calculateTFIDF(documents) {
  const documentFrequency = {};
  const tfIdf = {};

  documents.forEach((doc, docIndex) => {
      const terms = createNGrams(doc.toLowerCase());
      tfIdf[docIndex] = {};

      terms.forEach(term => {
          if (!(term in documentFrequency)) {
              documentFrequency[term] = 0;
          }
          documentFrequency[term]++;

          if (!(term in tfIdf[docIndex])) {
              tfIdf[docIndex][term] = 0;
          }
          tfIdf[docIndex][term]++;
      });
  });

  Object.keys(tfIdf).forEach(docIndex => {
      Object.keys(tfIdf[docIndex]).forEach(term => {
          const tf = tfIdf[docIndex][term] / Object.keys(tfIdf[docIndex]).length;
          const idf = Math.log(documents.length / documentFrequency[term]);
          tfIdf[docIndex][term] = tf * idf;
      });
  });

  return tfIdf;
}

function cosineSimilarity(vec1, vec2) {
  const intersection = Object.keys(vec1).filter(key => key in vec2);
  const dotProduct = intersection.reduce((sum, key) => sum + vec1[key] * vec2[key], 0);

  const mag1 = Math.sqrt(Object.values(vec1).reduce((sum, val) => sum + val * val, 0));
  const mag2 = Math.sqrt(Object.values(vec2).reduce((sum, val) => sum + val * val, 0));

  return dotProduct / (mag1 * mag2);
}

function findBestMatch(fieldInfo, profileFields) {
  const allDocuments = [Object.values(fieldInfo).filter(Boolean).join(' '), 
      ...profileFields.map(field => [field.id, field.label, ...(field.aliases || []), ...(field.common_labels || [])].join(' '))];

  const tfIdf = calculateTFIDF(allDocuments);

  let bestMatch = null;
  let highestSimilarity = -1;

  for (let i = 1; i < allDocuments.length; i++) {
      const similarity = cosineSimilarity(tfIdf[0], tfIdf[i]);
      if (similarity > highestSimilarity) {
          highestSimilarity = similarity;
          bestMatch = profileFields[i - 1];
      }
  }

  return { bestMatch, similarity: highestSimilarity };
}

// Levenshtein Distance
function levenshteinDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
          if (b.charAt(i - 1) === a.charAt(j - 1)) {
              matrix[i][j] = matrix[i - 1][j - 1];
          } else {
              matrix[i][j] = Math.min(
                  matrix[i - 1][j - 1] + 1,
                  matrix[i][j - 1] + 1,
                  matrix[i - 1][j] + 1
              );
          }
      }
  }

  return matrix[b.length][a.length];
}

// Combine different matching strategies
function combinedMatch(fieldInfo, profileFields) {
  const tfIdfMatch = findBestMatch(fieldInfo, profileFields);
  
  const fieldString = Object.values(fieldInfo).filter(Boolean).join(' ').toLowerCase();
  const levenshteinMatches = profileFields.map(field => {
      const fieldString2 = [field.id, field.label, ...(field.aliases || []), ...(field.common_labels || [])].join(' ').toLowerCase();
      return {
          field,
          distance: levenshteinDistance(fieldString, fieldString2)
      };
  });

  const bestLevenshtein = levenshteinMatches.reduce((best, current) => 
      current.distance < best.distance ? current : best
  );

  // Combine the results (you can adjust the weights)
  const combinedScore = tfIdfMatch.similarity * 0.7 + (1 - bestLevenshtein.distance / fieldString.length) * 0.3;

  return {
      bestMatch: combinedScore > match_score_threshold ? tfIdfMatch.bestMatch : null,
      similarity: combinedScore
  };
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

async function loadYaml(src) {
  const response = await fetch(browser.runtime.getURL(src));
  const yamlText = await response.text();
  return jsyaml.load(yamlText);
}

browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
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
                  const { bestMatch, similarity } = combinedMatch(fieldInfo, profileFields);
                  console.log("Best match for", fieldInfo, ":", bestMatch, "with similarity:", similarity);
                  if (bestMatch && profile[bestMatch.id] && similarity > match_score_threshold) {
                      input.value = profile[bestMatch.id];
                      console.log("Filled", fieldInfo.name || fieldInfo.id, "with", profile[bestMatch.id]);
                  } else {
                      console.log("No suitable match found for", fieldInfo);
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