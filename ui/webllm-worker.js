// Worker entry point for WebLLM. Model download, shader compilation, and
// token generation all run in here instead of on the main thread — see
// webllm-client.js's CreateWebWorkerMLCEngine() call, which spawns this file.
// The point: a stalled generation or a WebGPU device the browser reclaims
// mid-answer (mlc-ai/web-llm#647) now only takes this worker down, not the
// tab, and the client can terminate + rebuild it and fall back to standby
// instead of the whole page locking up or crashing.
import * as webllm from "https://esm.run/@mlc-ai/web-llm";

const handler = new webllm.WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
