// Globals (shared with content.js)
let observer = null;
let debounceTimer = null;
const DEBOUNCE_DELAY = 750;

// Setup the observer before fill loop
function setupFormObserver() {
  if (observer) return;

  const targetNode = document.body;
  const config = { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] }; // Limit attributes to common visibility changes

  observer = new MutationObserver((mutations) => {
    console.log('Mutation observed:', mutations); // Debug

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      if (hasSignificantFormChange(mutations)) {
        console.log('Significant form change detected, setting flag for restart...');
        formChanged = true; // Set flag for content.js to check
      }
    }, DEBOUNCE_DELAY);
  });

  observer.observe(targetNode, config);
}

function hasSignificantFormChange(mutations) {
  return mutations.some(mutation => {
    if (mutation.type === 'attributes') {
      // Ignore value changes, our marking, or on marked elements
      if (mutation.attributeName === 'value' || mutation.attributeName === 'data-filled-by-extension' || mutation.target.hasAttribute('data-filled-by-extension')) return false;
      // Check if on form element or affects visibility
      return mutation.target.matches('input, select, textarea, form') ||
             (mutation.attributeName === 'style' || mutation.attributeName === 'class' || mutation.attributeName === 'hidden');
    } else if (mutation.type === 'childList') {
      // Check added nodes for form elements (recursive), ignore if marked or in marked parent
      return Array.from(mutation.addedNodes).some(node => 
        node.nodeType === Node.ELEMENT_NODE &&
        !node.hasAttribute('data-filled-by-extension') &&
        !node.closest('[data-filled-by-extension]') &&  // Ignore if inside marked
        (node.matches('input, select, textarea, form') || node.querySelector('input, select, textarea, form'))
      );
    }
    return false;
  });
}

// Disconnect observer
function disconnectObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}