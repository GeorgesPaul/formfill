let worker;

function loadModelSync() {
    const modelUrl = browser.runtime.getURL('models/xlm-roberta-base/model.onnx');
    const xhr = new XMLHttpRequest();
    xhr.open('GET', modelUrl, false);  // false makes the request synchronous
    xhr.responseType = 'arraybuffer';
    
    try {
        xhr.send(null);
        if (xhr.status === 200) {
            return xhr.response;
        } else {
            throw new Error(`HTTP error! status: ${xhr.status}`);
        }
    } catch (error) {
        console.error('Error loading model:', error, ' check whether the model is present at ', modelUrl);
        throw error;
    }
}

async function initializeWorker() {
    return new Promise((resolve, reject) => {
        const workerUrl = browser.runtime.getURL('onnx-worker.js');
        worker = new Worker(workerUrl);
        
        const wasmPaths = {
            'ort-wasm.wasm': browser.runtime.getURL('node_modules/onnxruntime-web/dist/ort-wasm.wasm'),
            'ort-wasm-simd.wasm': browser.runtime.getURL('node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm')
        };
        
        let modelData;
        try {
            console.log('Loading model...');
            modelData = loadModelSync();
            console.log('Model loaded successfully. Size:', modelData.byteLength);
        } catch (error) {
            console.error('Failed to load model:', error);
            reject(error);
            return;
        }

        console.log('Initializing worker...');
        worker.postMessage({ action: 'init', wasmPaths, modelData }, [modelData]);

        worker.onmessage = function(e) {
            if (e.data === "ready") {
                console.log("ONNX Runtime worker initialized");
                resolve();
            } else if (e.data.error) {
                console.error("Error initializing ONNX Runtime worker:", e.data.error);
                reject(new Error(e.data.error));
            }
        };
        worker.onerror = function(error) {
            console.error("Worker error:", error);
            reject(error);
        };
    });
}

async function runInference(input) {
  return new Promise((resolve, reject) => {
    worker.onmessage = function(e) {
      if (e.data.results) {
        resolve(e.data.results);
      } else if (e.data.error) {
        reject(new Error(e.data.error));
      }
    };
    worker.postMessage({action: "runInference", input: input});
  });
}

async function loadYaml(src) {
  const response = await fetch(browser.runtime.getURL(src));
  const yamlText = await response.text();
  return jsyaml.load(yamlText);
}

function getNearbyText(element, maxDistance = 50) {
  // ... (keep this function as it was) ...
}

browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "fillForm") {
      console.log("Filling form with profile:", message.profile);
      const profile = message.profile;
     
      try {
          if (!worker) {
              console.log("Initializing ONNX Runtime worker...");
              await initializeWorker();
          }

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
          const fieldString = Object.values(fieldInfo).filter(Boolean).join(' ');
          const inferenceResult = await runInference({text: fieldString});
          
          // Assume the model outputs a similarity score for each profile field
          const bestMatch = profileFields[inferenceResult.indexOf(Math.max(...inferenceResult))];
          const similarity = Math.max(...inferenceResult);

          console.log("Best match for", fieldInfo, ":", bestMatch, "with similarity:", similarity);
          if (bestMatch && profile[bestMatch.id] && similarity > 0.5) {
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