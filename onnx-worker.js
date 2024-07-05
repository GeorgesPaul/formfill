importScripts('node_modules/onnxruntime-web/dist/ort.min.js');

let session;

async function initializeOnnxRuntime(wasmPaths, modelData) {
    try {
        console.log('Initializing ONNX Runtime...');
        
        // Disable threaded WASM execution
        ort.env.wasm.numThreads = 1;

        // Set up WASM paths
        ort.env.wasm.wasmPaths = wasmPaths;

        // Enable debugging
        ort.env.debug = true;
        ort.env.logLevel = 'verbose';

        console.log("Creating InferenceSession...");
        const options = {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all'
        };
        console.log("Session options:", options);
        console.log("Model data size:", modelData.byteLength);

        // Try creating the session with more detailed error logging
        try {
            session = await ort.InferenceSession.create(modelData, options);
        } catch (sessionError) {
            console.error("Error creating InferenceSession:", sessionError);
            console.error("Error details:", JSON.stringify(sessionError, Object.getOwnPropertyNames(sessionError)));
            throw sessionError;
        }

        console.log("ONNX Runtime initialized successfully");
        self.postMessage("ready");
    } catch (e) {
        console.error("Error initializing ONNX Runtime:", e);
        console.error("Error name:", e.name);
        console.error("Error message:", e.message);
        console.error("Error stack:", e.stack);
        self.postMessage({error: e.message, name: e.name, stack: e.stack});
    }
}

self.onmessage = async function(e) {
    if (e.data.action === "init") {
        console.log('Received init message. Model data size:', e.data.modelData.byteLength);
        await initializeOnnxRuntime(e.data.wasmPaths, e.data.modelData);
    } else if (e.data.action === "runInference") {
        try {
            if (!session) {
                throw new Error("ONNX Runtime session not initialized");
            }
            const results = await session.run(e.data.input);
            self.postMessage({results: results});
        } catch (error) {
            self.postMessage({error: error.message});
        }
    }
};