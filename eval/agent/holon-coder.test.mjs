// Deterministic, offline coverage for the bidirectional holonic nesting
// added to holon-coder.mjs: a leaf's real failure evidence earns the parent
// the right to replan (low sets the possibility of the high), and a
// decomposed task hands each child a bounded top-down prior (high sets the
// probability of the low). No network, no real model — a scripted adapter
// stands in, exactly like eval/adapters/scripted-adapter.mjs does for
// --dry-run, so this suite runs in milliseconds and never lies about being
// a capability measurement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHolonicCodingTask, foldHandoff } from "./holon-coder.mjs";
import { createTools } from "./tools.mjs";
import { ENTRY_KINDS } from "../../server/task-log.js";

/** Records every prompt the agent under test was actually shown, and plays
 * back a fixed script of responses — a spy, not a real model, but real
 * enough to prove what data crossed which boundary. */
function createSpyAdapter(script) {
  const calls = [];
  let i = 0;
  return {
    id: "spy",
    calls,
    async generate(messages, opts = {}) {
      calls.push({ messages: messages.map((m) => ({ ...m })), opts });
      if (i >= script.length) throw new Error(`spy adapter ran out of script at call ${i} (${script.length} scripted)`);
      const next = script[i++];
      const resolved = typeof next === "function" ? next(messages, opts) : next;
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    },
  };
}

function freshSandbox() {
  return mkdtempSync(join(tmpdir(), "holon-coder-test-"));
}

test("a direct attempt that never fails never triggers a replan (existing behavior preserved)", async () => {
  const sandboxDir = freshSandbox();
  try {
    const adapter = createSpyAdapter([
      { decompose: false },
      { tool: "finish", args: { summary: "done in one shot" } },
    ]);
    const result = await runHolonicCodingTask({
      taskId: "root", taskPrompt: "trivial task", adapter, toolset: createTools(sandboxDir), maxSteps: 4, seed: 1,
    });
    assert.equal(result.finished, true);
    assert.equal(result.decomposed, false);
    assert.equal(result.retried, undefined);
    assert.equal(adapter.calls.length, 2, "only the up-front plan call and one react-loop step — no replan call was earned");
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("bottom-up: a direct attempt that hits the step cap hands its REAL evidence to the replan, which may then decompose", async () => {
  const sandboxDir = freshSandbox();
  try {
    const adapter = createSpyAdapter([
      { decompose: false },                                             // root plan
      { tool: "list_files", args: {} },                                 // root react-loop step 0 (never finishes)
      { tool: "list_files", args: {} },                                 // root react-loop step 1 -> hits maxSteps=2, hitStepCap
      { decompose: true, subtasks: [                                    // replan, now WITH evidence
        { id: "partA", description: "do part A" },
        { id: "partB", description: "do part B" },
      ] },
      { tool: "finish", args: { summary: "done A" } },                  // subtask A, depth 1 -> runs directly (maxDepth reached)
      { tool: "finish", args: { summary: "done B" } },                  // subtask B, depth 1
    ]);

    const result = await runHolonicCodingTask({
      taskId: "root", taskPrompt: "a task that will not converge directly",
      adapter, toolset: createTools(sandboxDir), maxSteps: 2, seed: 1,
    });

    assert.equal(result.retried, true, "the retry path must have fired");
    assert.equal(result.decomposed, true);
    assert.equal(result.finished, true, "both retried sub-tasks finished");
    assert.equal(result.leafResults.length, 3, "the original failed attempt PLUS its two retried children — nothing is hidden");
    assert.equal(result.leafResults[0].taskId, "root");
    assert.equal(result.leafResults[0].supersededBy, "root@retry");

    // The replan call (4th generate() call, index 3) must actually have been
    // shown real evidence from the failed attempt, not a fresh blind guess.
    const replanCall = adapter.calls[3];
    const replanPrompt = replanCall.messages.map((m) => m.content).join("\n");
    assert.match(replanPrompt, /prior direct attempt/i);
    assert.match(replanPrompt, /list_files/, "the real tool that was actually called must appear in the replan's evidence, not a paraphrase");

    // The log must record the retry as a real structural act: a SUPERSEDE
    // entry, carrying why, that supersedes the original attempt.
    const supersede = result.log.entries.find((e) => e.kind === ENTRY_KINDS.SUPERSEDE && e.task_id === "root@retry");
    assert.ok(supersede, "expected a SUPERSEDE entry for root@retry");
    assert.equal(supersede.supersedes, "root");
    assert.match(supersede.revised_because, /list_files/);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("top-down: a decomposed child is handed a bounded prior naming the parent goal and its sibling — never the whole codebase", async () => {
  const sandboxDir = freshSandbox();
  try {
    const hugeParentGoal = "solve the enormous task. ".repeat(60); // > 280-char handoff budget by construction
    const adapter = createSpyAdapter([
      { decompose: true, subtasks: [
        { id: "partA", description: "do part A" },
        { id: "partB", description: "do part B" },
      ] },
      { tool: "finish", args: { summary: "done A" } },
      { tool: "finish", args: { summary: "done B" } },
    ]);

    await runHolonicCodingTask({
      taskId: "root", taskPrompt: hugeParentGoal, adapter, toolset: createTools(sandboxDir), maxSteps: 4, seed: 1,
    });

    // Call index 1 is subtask A's first react-loop step; its user message
    // carries the top-down prior (groundingBlock).
    const childIntro = adapter.calls[1].messages.find((m) => m.role === "user").content;
    assert.match(childIntro, /context from the parent task/i);
    assert.match(childIntro, /do part A/);
    assert.match(childIntro, /withheld/i, "a prior built from a >280-char parent goal must report what it folded away, never truncate silently");
    assert.ok(!childIntro.includes(hugeParentGoal), "the full unfolded parent goal must never reach the child verbatim");
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("a replan that still judges the task undecomposable is an honest decline, not a forced split", async () => {
  const sandboxDir = freshSandbox();
  try {
    const adapter = createSpyAdapter([
      { decompose: false },
      { tool: "list_files", args: {} },
      { tool: "list_files", args: {} },
      { decompose: false }, // replan considers the evidence and still says no
    ]);

    const result = await runHolonicCodingTask({
      taskId: "root", taskPrompt: "a task that fails and stays undecomposable",
      adapter, toolset: createTools(sandboxDir), maxSteps: 2, seed: 1,
    });

    assert.equal(result.decomposed, false);
    assert.equal(result.retryConsidered, true);
    assert.ok(result.retryDeclined);
    assert.equal(
      result.log.entries.some((e) => e.kind === ENTRY_KINDS.SUPERSEDE),
      false,
      "a declined replan must not be recorded as a structural act — nothing was produced",
    );
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("bounded recursion is preserved: a sub-task's own failure at maxDepth does not trigger a further replan", async () => {
  const sandboxDir = freshSandbox();
  try {
    const adapter = createSpyAdapter([
      { decompose: true, subtasks: [{ id: "partA", description: "A" }, { id: "partB", description: "B" }] },
      { tool: "list_files", args: {} }, // subtask A step 0 (depth 1 == maxDepth -> no plan call, no replan possible)
      { tool: "list_files", args: {} }, // subtask A step 1 -> hits maxSteps=2
      { tool: "finish", args: { summary: "done B" } }, // subtask B
    ]);

    const result = await runHolonicCodingTask({
      taskId: "root", taskPrompt: "root", adapter, toolset: createTools(sandboxDir), maxSteps: 2, maxDepth: 1, seed: 1,
    });

    assert.equal(adapter.calls.length, 4, "no 5th call — a depth-1 failure must not earn a replan call");
    assert.equal(result.finished, false, "subtask A's own failure is real and must not be papered over");
    assert.equal(result.log.entries.some((e) => e.kind === ENTRY_KINDS.SUPERSEDE), false);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

// AMENDMENT-13-PROPOSAL.md (eo-constitution): foldHandoff used to be a bare
// `s.slice(0, MAX_HANDOFF_CHARS)` — bounded, and it reported what it
// withheld, but the FIRST 280 characters were kept for no reason other than
// being first. These tests lock down the real fix: sentences are kept by
// information density (specific vocabulary — identifiers, paths, numbers),
// not by which one happened to come first.

test("foldHandoff keeps the information-dense sentence over generic filler, even when the filler comes first", () => {
  const filler = "OK. Sure. Got it. Noted. Fine. Yes. ".repeat(6); // short, low-content sentences — near-zero significant terms each
  const specific = "convert.js line 42 throws TypeError: cannot read property 'split' of undefined in parseRow().";
  const text = filler + specific;
  assert.ok(text.length > 280, "test setup: must actually exceed the handoff budget to exercise folding");

  const folded = foldHandoff(text, "test evidence");

  assert.match(folded, /parseRow/, "the information-dense sentence must survive the fold");
  assert.match(folded, /withheld/i, "must report what was dropped, same as every other fold in this harness");
});

test("foldHandoff falls back to a plain, honestly-labeled hard truncation for a single unbreakable unit longer than the budget", () => {
  const oneGiantSentence = `error: ${"x".repeat(400)}`; // no sentence boundaries at all
  const folded = foldHandoff(oneGiantSentence, "test evidence");
  assert.match(folded, /single unbreakable unit/);
});

test("foldHandoff returns short text unchanged — no fold needed, nothing to score", () => {
  const short = "a short evidence string.";
  assert.equal(foldHandoff(short, "test evidence"), short);
});
