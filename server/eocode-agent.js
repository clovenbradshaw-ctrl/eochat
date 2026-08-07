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
import { REPO_ROOT } from "./paths.js";
import { createTools } from "../eval/agent/tools.mjs";
import { runReactLoop } from "../eval/agent/react-loop.mjs";
import { createOllamaAdapter } from "../eval/adapters/ollama-adapter.mjs";

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
  workspace, prompt, model = "qwen2.5-coder:1.5b", maxSteps = 20, maxTokensPerStep = 400, seed = 0, onEvent = null,
}) {
  const emit = onEvent || (() => {});
  if (!prompt || !String(prompt).trim()) throw new Error("prompt is required");

  const dir = resolveWorkspaceDir(workspace);
  mkdirSync(dir, { recursive: true });

  const toolset = createTools(dir);
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
