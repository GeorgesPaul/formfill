// idleMonitor.js

// Network Activity Monitoring (HTTP/S only)
let activeRequests = 0;
const IDLE_CHECK_INTERVAL = 50; // ms to re-check during pause
const IDLE_THRESHOLD = 100; // ms of inactivity after last request to resume (buffer for lingering)

function overrideFetch() {
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    activeRequests++;
    try {
      const response = await originalFetch(...args);
      // Track completion (clone to handle async reading if needed)
      response.clone().finally(() => {
        activeRequests = Math.max(0, activeRequests - 1);
      });
      return response;
    } catch (error) {
      activeRequests = Math.max(0, activeRequests - 1);
      throw error;
    }
  };
}

function overrideXHR() {
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    xhr.open = function(...args) {
      activeRequests++;
      return originalOpen.apply(this, args);
    };
    xhr.addEventListener('loadend', () => {
      activeRequests = Math.max(0, activeRequests - 1);
    });
    xhr.addEventListener('error', () => {
      activeRequests = Math.max(0, activeRequests - 1);
    });
    xhr.addEventListener('abort', () => {
      activeRequests = Math.max(0, activeRequests - 1);
    });
    return xhr;
  };
}

// Initialize overrides once (call this early, e.g., on load)
overrideFetch();
overrideXHR();

async function waitForIdle() {
  while (activeRequests > 0) {
    console.log(`Pausing fill: ${activeRequests} active HTTP(S) requests`);
    await sleep(IDLE_CHECK_INTERVAL);
  }
  // Extra buffer after last request completes
  console.log('Network idle detected; waiting buffer...');
  await sleep(IDLE_THRESHOLD);
}