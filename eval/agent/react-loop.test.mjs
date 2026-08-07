// Deterministic, offline coverage for react-loop.mjs's stuck-loop
// detection: a real transcript showed the model calling edit_file with the
// IDENTICAL (wrong) old_string 10 times in a row, re-reading the real file
// in between every attempt and never adapting. This tests that the loop
// (a) escalates with an explicit nudge once a failure repeats, (b) aborts
// honestly rather than exhausting the step budget once it clearly will not
// resolve itself, (c) never confuses that abort with hitStepCap, and (d) a
// genuinely different or successful call resets the streak.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReactLoop } from "./react-loop.mjs";
import { createTools } from "./tools.mjs";

function createSpyAdapter(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async generate(messages, opts = {}) {
      calls.push({ messages: messages.map((m) => ({ ...m })), opts });
      if (i >= script.length) throw new Error(`spy adapter ran out of script at call ${i}`);
      const next = script[i++];
      const resolved = typeof next === "function" ? next(messages, opts) : next;
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    },
  };
}

function freshSandbox() {
  return mkdtempSync(join(tmpdir(), "react-loop-test-"));
}

test("a repeated identical failing call escalates to an explicit nudge, then aborts before exhausting the step budget", async () => {
  const sandboxDir = freshSandbox();
  try {
    writeFileSync(join(sandboxDir, "a.js"), "real content\n");
    const badEdit = { tool: "edit_file", args: { path: "a.js", old_string: "// TODO: not really here", new_string: "x" } };
    // The model keeps retrying the exact same wrong edit; maxSteps=10 gives
    // plenty of room to prove the abort fires well before the cap, not because of it.
    const adapter = createSpyAdapter([badEdit, badEdit, badEdit, badEdit, badEdit, badEdit, badEdit, badEdit, badEdit, badEdit]);

    const result = await runReactLoop({
      taskPrompt: "irrelevant", toolset: createTools(sandboxDir), adapter, maxSteps: 10, seed: 1,
    });

    assert.equal(result.finished, false);
    assert.equal(result.stuckLoopAbort, true, "must self-abort on the repeated-failure loop");
    assert.equal(result.hitStepCap, false, "a stuck-loop abort is a DIFFERENT honest reason than running out of steps, and must not be reported as one");
    assert.ok(result.stepsRun < 10, `must abort before the step cap, got stepsRun=${result.stepsRun}`);
    assert.equal(result.stepsRun, 5, "4 identical failing calls plus the abort note (STUCK_LOOP_ABORT_AT)");

    // The nudge must actually have been shown to the model before the abort.
    const secondFailureObservation = result.messages.find((m) => m.role === "user" && /STUCK LOOP/.test(m.content));
    assert.ok(secondFailureObservation, "expected an explicit stuck-loop nudge in the conversation");
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("counting is CUMULATIVE across the whole attempt, not just consecutive — the exact real bug this was built to catch", async () => {
  // A real transcript showed edit_file(fail) -> read_file(succeed) ->
  // edit_file(SAME fail) repeated 11 times, and re-reading the file in
  // between reset a naive "consecutive" streak counter back to 1 every
  // single time, so it never fired. read_file here stands in for that:
  // a genuinely different, successful call interleaved between every
  // failure. If detection only looked at strict adjacency, this would
  // never trip. It must still count the failures.
  const sandboxDir = freshSandbox();
  try {
    writeFileSync(join(sandboxDir, "a.js"), "real content\n");
    const badEdit = { tool: "edit_file", args: { path: "a.js", old_string: "return 'pass'", new_string: "return 'refute'" } };
    const readBetween = { tool: "read_file", args: { path: "a.js" } };
    const adapter = createSpyAdapter([badEdit, readBetween, badEdit, readBetween, badEdit, readBetween, badEdit, readBetween]);

    const result = await runReactLoop({
      taskPrompt: "irrelevant", toolset: createTools(sandboxDir), adapter, maxSteps: 12, seed: 1,
    });

    assert.equal(result.stuckLoopAbort, true, "4 total occurrences of the identical failing edit_file call, even with a successful read_file after every one, must still trip the detector");
    assert.equal(result.hitStepCap, false);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("a different failing call does not count toward another call's streak", async () => {
  const sandboxDir = freshSandbox();
  try {
    writeFileSync(join(sandboxDir, "a.js"), "content\n");
    // 8 genuinely distinct failing calls — none repeats, so no single
    // callKey ever reaches the abort threshold.
    const distinctFails = Array.from({ length: 8 }, (_, i) => ({
      tool: "edit_file", args: { path: "a.js", old_string: `missing text variant ${i}`, new_string: "x" },
    }));
    const adapter = createSpyAdapter(distinctFails);

    const result = await runReactLoop({
      taskPrompt: "irrelevant", toolset: createTools(sandboxDir), adapter, maxSteps: 8, seed: 1,
    });

    assert.equal(result.stuckLoopAbort, false);
    assert.equal(result.hitStepCap, true, "should run the full budget since no single call ever repeats");
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
