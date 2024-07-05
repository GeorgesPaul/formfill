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
        session = await ort.InferenceSession.create(modelData, { executionProviders: ['wasm'] });
        console.log("ONNX Runtime initialized successfully");
        self.postMessage("ready");
    } catch (e) {
        console.error("Error initializing ONNX Runtime:", e);
        self.postMessage({error: e.message});
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