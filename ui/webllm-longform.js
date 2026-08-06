// Browser-side bridge between the deliberate long-form orchestrator
// (runDeliberateAnswer in longform-orchestrator.js, served byte-identical from
// /shared/) and the in-tab WebLLM model (window.EOWebLLM from webllm-client.js).
//
// A generate() call over a local 3B model takes real wall-clock time; the
// orchestrator's own perCallTimeoutMs (default 45000) is calibrated for
// Ollama's token rate, not a browser model's. This file sets a longer default
// for the browser and exposes a streamlined entry point the UI's Component
// class can call directly: get the citations from /api/ground, then hand them
// here.
//
// The caller (index.html's Component) already has on_progress events wired
// back into its chat surface — this module just drives the pipeline, same
// shape as turn-controller.js's server-side deliberate path.

import { runDeliberateAnswer } from "/shared/server/longform-orchestrator.js";

const DEFAULT_BROWSER_PER_CALL_TIMEOUT_MS = 90000;
const DEFAULT_BROWSER_DEADLINE_MS = 300000;

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
 * additional fields are passed through unchanged). onProgress receives the
 * same event shapes the orchestrator emits (phase + section payloads), so
 * the UI can mirror the server-side streaming experience.
 *
 * Returns the orchestrator's standard shape:
 * `{ text, citations, sectionsKept, sectionsDropped, withheld, gaps }`
 *
 * @param {{ question: string, citations: object[], onProgress?: function, signal?: AbortSignal, maxSections?: number, maxRevisionRounds?: number, tolerance?: number }} opts
 */
export async function runWebLLMAnswer({
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
