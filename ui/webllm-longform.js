// Browser-side bridge between the deliberate long-form orchestrator
// (runDeliberateAnswer in longform-orchestrator.js, served byte-identical from
// the proxy's /shared/ route) and the in-tab WebLLM model (window.EOWebLLM
// from webllm-client.js).
//
// A generate() call over a local 3B model takes real wall-clock time; the
// orchestrator's own perCallTimeoutMs (default 45000) is calibrated for
// Ollama's token rate, not a browser model's. This file sets a longer default
// for the browser and exposes a streamlined entry point the UI's Component
// class can call directly: get the citations from /api/ground or
// /api/web-ground, then hand them here.
//
// The orchestrator is loaded with a cross-origin dynamic import of the
// proxy's /shared/ route — NOT a top-level `import` statement — because the
// UI is served from its own origin (e.g. `python3 -m http.server 8899`) while
// /shared/ exists only on the proxy origin (:11435). A top-level import of
// /shared/... would resolve against the UI origin, 404, and kill the whole
// module before window.EOWebLLMLongform could ever be set. Dynamic import
// works because the proxy answers every request with CORS "*" and the
// relative imports inside the orchestrator graph resolve on its own origin.
//
// The caller (index.html's Component) already has on_progress events wired
// back into its chat surface — this module just drives the pipeline, same
// shape as turn-controller.js's server-side deliberate path.

const DEFAULT_BROWSER_PER_CALL_TIMEOUT_MS = 90000;
const DEFAULT_BROWSER_DEADLINE_MS = 300000;

let orchestratorPromise = null;

function loadOrchestrator(proxyUrl) {
  if (!orchestratorPromise) {
    const url = new URL("/shared/server/longform-orchestrator.js", proxyUrl).href;
    orchestratorPromise = import(url).catch((err) => {
      orchestratorPromise = null; // a later call gets a clean retry
      throw err;
    });
  }
  return orchestratorPromise;
}

/**
 * Reads a browser-local model stream to completion, returning the full text.
 * window.EOWebLLM.stream() is an async generator that yields text deltas;
 * the orchestrator's generate() contract is a promise that resolves to the
 * assembled string — so we drain the generator here.
 */
async function drainTextStream(generator, signal) {
  let text = "";
  for await (const delta of generator) {
    if (signal?.aborted) return text;
    text += delta;
  }
  return text;
}

/**
 * The only function a caller needs. Hand the citations from /api/ground or
 * /api/web-ground (each with `{index, span_id, source_id, text}` — any
 * additional fields are passed through unchanged), plus the proxy URL the
 * orchestrator is fetched from. onProgress receives the same event shapes the
 * orchestrator emits (phase + section payloads), so the UI can mirror the
 * server-side streaming experience.
 *
 * Returns the orchestrator's standard shape:
 * `{ text, citations, sectionsKept, sectionsDropped, withheld, gaps }`
 *
 * @param {{ proxyUrl: string, question: string, citations: object[], onProgress?: function, signal?: AbortSignal, maxSections?: number, maxRevisionRounds?: number, tolerance?: number }} opts
 */
export async function runWebLLMAnswer({
  proxyUrl,
  question,
  citations,
  onProgress = null,
  signal = null,
  maxSections = 5,
  maxRevisionRounds = 3,
  tolerance = 0.45,
} = {}) {
  const webllm = window.EOWebLLM;
  if (!webllm || webllm.status !== "ready" || !webllm.engine) {
    throw new Error("The local model is not ready — select a model and wait for it to load first.");
  }

  const { runDeliberateAnswer } = await loadOrchestrator(proxyUrl);

  const generate = async (system, user, maxTokens) => {
    const stream = webllm.stream(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { signal }
    );
    return drainTextStream(stream, signal);
  };

  return runDeliberateAnswer({
    question,
    citations,
    generate,
    maxSections,
    maxRevisionRounds,
    tolerance,
    signal,
    perCallTimeoutMs: DEFAULT_BROWSER_PER_CALL_TIMEOUT_MS,
    deadlineMs: DEFAULT_BROWSER_DEADLINE_MS,
    onProgress,
  });
}

// Exposed as a global so index.html's Component (eval'd as a plain script, not
// a module) can reach it without an import. Same pattern as window.EOWebLLM in
// webllm-client.js.
window.EOWebLLMLongform = { runWebLLMAnswer };
