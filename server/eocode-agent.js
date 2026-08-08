// eoCode — an interactive agentic-coding surface built on the SAME organs
// eval/agent/ already grew for the offline capability eval (createTools,
// runReactLoop, createOllamaAdapter): the same read/write/edit/run tool set,
// the same one-tool-call-per-turn loop, the same stuck-loop detection —
// pointed at a real, named workspace directory instead of a throwaway eval
// sandbox, with every step disclosed live via onEvent instead of only being
// visible after the run finishes in a results file.
//
// Nothing about the agent's own behavior is duplicated or forked here — this
// module is entirely plumbing: resolve a safe workspace path, wire the real
// organs together, and forward what react-loop.mjs already emits.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { randomBytes } from "node:crypto";
import { REPO_ROOT } from "./paths.js";
import { createTools } from "../eval/agent/tools.mjs";
import { runReactLoop, createSession, promptViewFor, applyResponse } from "../eval/agent/react-loop.mjs";
import { createOllamaAdapter } from "../eval/adapters/ollama-adapter.mjs";
import { addPriorArtSearchTool } from "../eval/agent/crispr-search.mjs";

/** Every eoCode workspace lives under here — never anywhere else on disk. */
export const WORKSPACE_ROOT = resolve(REPO_ROOT, "eocode-workspace");

const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * Resolve a workspace name to a real directory under WORKSPACE_ROOT,
 * refusing anything that would escape it (mirrors tools.mjs's own
 * resolveInSandbox discipline, applied one level up — at the workspace
 * name, before any tool ever gets a sandboxDir to bound paths within).
 */
export function resolveWorkspaceDir(name) {
  const clean = String(name ?? "").trim() || "default";
  if (!NAME_RE.test(clean)) {
    throw new Error(`invalid workspace name "${clean}" — use letters, digits, "." "_" "-" only`);
  }
  const abs = resolve(WORKSPACE_ROOT, clean);
  const rel = relative(WORKSPACE_ROOT, abs);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`workspace name "${clean}" escapes the workspace root`);
  }
  return abs;
}

function listAllFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) listAllFiles(p, base, out);
    else out.push({ path: relative(base, p), bytes: st.size, modified: st.mtimeMs });
  }
  return out;
}

export function listWorkspaces() {
  if (!existsSync(WORKSPACE_ROOT)) return [];
  return readdirSync(WORKSPACE_ROOT).filter((name) => {
    try { return statSync(join(WORKSPACE_ROOT, name)).isDirectory(); } catch { return false; }
  });
}

export function listWorkspaceFiles(name) {
  const dir = resolveWorkspaceDir(name);
  return existsSync(dir) ? listAllFiles(dir) : [];
}

/**
 * Run one agentic-coding task against a real, named workspace, disclosing
 * every step live through onEvent as react-loop.mjs's onStep fires it —
 * the same real-time transparency Claude Code / opencode show for their own
 * tool calls, here driven by a local Ollama model instead of a hosted one.
 *
 * @param {object} opts
 * @param {string} opts.workspace  workspace name (resolved under WORKSPACE_ROOT)
 * @param {string} opts.prompt     the task, verbatim, handed to the model
 * @param {string} [opts.model]    an Ollama model tag (e.g. "qwen2.5-coder:1.5b")
 * @param {number} [opts.maxSteps]
 * @param {number} [opts.maxTokensPerStep]
 * @param {number} [opts.seed]
 * @param {Function} [opts.onEvent]  (type: string, payload: object) => void
 */
export async function runEoCodeTask({
  // 400 had no write_file call in mind: Ollama's format:"json" grammar-
  // constrains SYNTAX, not length, so a content-heavy write_file (a whole
  // styled HTML/CSS/JS file as one JSON string field) gets cut off mid-
  // string at the token cap before its braces/quotes ever close — invalid
  // JSON every time, indistinguishable from the model actually failing.
  // Measured: a Pomodoro-timer-app prompt against qwen2.5-coder:7b produced
  // an identical ~1195-char (~400-token) truncated response on 3 straight
  // steps and tripped the stuck-loop abort — not a model failure, a token
  // budget too small for the tool call it was asked to make. 1600 gives a
  // single write_file room for a modest single-file app without letting one
  // step run unbounded on local hardware.
  workspace, prompt, model = "qwen2.5-coder:1.5b", maxSteps = 20, maxTokensPerStep = 1600, seed = 0, onEvent = null,
}) {
  const emit = onEvent || (() => {});
  if (!prompt || !String(prompt).trim()) throw new Error("prompt is required");

  const dir = resolveWorkspaceDir(workspace);
  mkdirSync(dir, { recursive: true });

  const toolset = createTools(dir);
  addPriorArtSearchTool(toolset);
  const adapter = createOllamaAdapter({ model });

  emit("start", { workspace: relative(WORKSPACE_ROOT, dir) || "default", dir, model, prompt, maxSteps });

  const result = await runReactLoop({
    taskPrompt: prompt,
    toolset,
    adapter,
    maxSteps,
    maxTokensPerStep,
    seed,
    onStep: (entry) => emit("step", entry),
  });

  emit("end", {
    finished: result.finished,
    summary: result.summary,
    steps: result.stepsRun,
    hitStepCap: result.hitStepCap,
    stuckLoopAbort: result.stuckLoopAbort,
    toolCalls: result.toolCalls,
    files: listWorkspaceFiles(workspace),
  });

  return result;
}

// ── Stepping API — the SAME agent, driven one turn at a time by a caller ──
// that supplies its own model text instead of an adapter this module owns.
// Exists for WebLLM: a model running in the reader's own browser can plan
// and write code just as well as one running server-side via Ollama, but it
// cannot touch this machine's filesystem or run a shell — only the SERVER
// can safely do that. So tool execution stays here, unconditionally, and
// only the "what should I do next" text generation moves to wherever the
// caller's model actually runs. createSession/promptViewFor/applyResponse
// (react-loop.mjs) are the exact same primitives runReactLoop's own for-loop
// above is built from — nothing about how a step is scored, folded, or
// disclosed differs between a server-driven and a client-driven run.
//
// Sessions are in-memory only (a local dev tool, not a durable service) and
// swept on an idle timeout so an abandoned browser tab does not pin a
// sandbox directory or its tool state forever.
const SESSIONS = new Map(); // sessionId -> { session, dir, workspace, maxSteps, createdAt, lastActiveAt }
const SESSION_IDLE_MS = 30 * 60 * 1000;

function sweepStaleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, entry] of SESSIONS) {
    if (entry.lastActiveAt < cutoff) SESSIONS.delete(id);
  }
}

/**
 * Begin a stepping session: creates the sandbox + tool set + react-loop
 * session, and returns the FIRST prompt view to show a model — no model
 * call happens here, the caller owns that.
 */
export function startEoCodeSession({ workspace, prompt, foldK, maxSteps = 20 }) {
  if (!prompt || !String(prompt).trim()) throw new Error("prompt is required");
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be a positive integer");
  sweepStaleSessions();

  const dir = resolveWorkspaceDir(workspace);
  mkdirSync(dir, { recursive: true });
  const wsName = relative(WORKSPACE_ROOT, dir) || "default";

  const toolset = createTools(dir);
  addPriorArtSearchTool(toolset);
  const session = createSession({ taskPrompt: prompt, toolset, foldK });
  const sessionId = randomBytes(16).toString("hex");
  const now = Date.now();
  SESSIONS.set(sessionId, { session, dir, workspace: wsName, maxSteps, createdAt: now, lastActiveAt: now });

  return { sessionId, workspace: wsName, dir, maxSteps, promptView: promptViewFor(session) };
}

/**
 * Apply one raw model response to an existing session: runs whatever tool
 * call it names (or records why it couldn't), and reports the same
 * {phase, ...} events react-loop.mjs's onStep emits for a server-driven
 * run. When the session is done (finished, stuck-loop abort, or this call
 * exhausted maxSteps), `result` carries the final summary and the session
 * is discarded; otherwise `promptView` carries what to show the model next.
 */
export function stepEoCodeSession({ sessionId, raw }) {
  const entry = SESSIONS.get(sessionId);
  if (!entry) throw new Error(`no such eoCode session "${sessionId}" — it may have finished, been cancelled, or expired`);
  entry.lastActiveAt = Date.now();

  const { events, done } = applyResponse(entry.session, raw);
  const hitStepCap = !done && entry.session.step >= entry.maxSteps;
  const finished = done || hitStepCap;

  if (!finished) {
    return { events, done: false, promptView: promptViewFor(entry.session) };
  }

  const result = {
    finished: entry.session.finished,
    summary: entry.session.summary,
    steps: entry.session.transcript.length,
    hitStepCap: !entry.session.finished && !entry.session.stuckLoopAbort && hitStepCap,
    stuckLoopAbort: entry.session.stuckLoopAbort,
    files: listWorkspaceFiles(entry.workspace),
  };
  SESSIONS.delete(sessionId);
  return { events, done: true, promptView: null, result };
}

/** Drop a session early (the reader stopped the run, or navigated away). */
export function cancelEoCodeSession(sessionId) {
  return SESSIONS.delete(sessionId);
}
