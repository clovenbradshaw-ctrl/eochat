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

test("a successful call resets the repeat streak — only IDENTICAL failures count", async () => {
  const sandboxDir = freshSandbox();
  try {
    writeFileSync(join(sandboxDir, "a.js"), "line one\nline two\n");
    const badEdit = { tool: "edit_file", args: { path: "a.js", old_string: "not present", new_string: "x" } };
    const goodEdit = { tool: "edit_file", args: { path: "a.js", old_string: "line one", new_string: "line ONE" } };
    // fail, fail (2nd -> would normally nudge), succeed (resets), fail, fail, finish
    const adapter = createSpyAdapter([badEdit, badEdit, goodEdit, badEdit, badEdit, { tool: "finish", args: { summary: "done" } }]);

    const result = await runReactLoop({
      taskPrompt: "irrelevant", toolset: createTools(sandboxDir), adapter, maxSteps: 10, seed: 1,
    });

    assert.equal(result.stuckLoopAbort, false, "the streak must not carry across a successful call");
    assert.equal(result.finished, true);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("older steps get folded to a bounded digest once the window is exceeded, but the full record is kept", async () => {
  const sandboxDir = freshSandbox();
  try {
    writeFileSync(join(sandboxDir, "a.js"), "content\n");
    // 6 distinct list_files calls (never repeats -> no stuck-loop interference), then finish.
    const script = [
      { tool: "list_files", args: {} }, { tool: "list_files", args: { path: "x1" } },
      { tool: "list_files", args: { path: "x2" } }, { tool: "list_files", args: { path: "x3" } },
      { tool: "list_files", args: { path: "x4" } }, { tool: "finish", args: { summary: "done" } },
    ];
    const adapter = createSpyAdapter(script);

    const result = await runReactLoop({
      taskPrompt: "irrelevant", toolset: createTools(sandboxDir), adapter, maxSteps: 10, seed: 1,
    });

    assert.equal(result.finished, true);
    // The FULL record (result.messages) must still hold every step -- folding
    // must never lose data from the harness's own history.
    const fullAssistantTurns = result.messages.filter((m) => m.role === "assistant");
    assert.equal(fullAssistantTurns.length, script.length);

    // What was actually SHOWN to the model on the last call must be bounded:
    // the earliest step's raw args ("x1") must have been folded away, not
    // sent verbatim, and a folded-digest notice must be present instead.
    const lastCallMessages = adapter.calls.at(-1).messages;
    assert.ok(
      lastCallMessages.length < fullAssistantTurns.length * 2 + 2,
      "the last prompt sent to the model must be smaller than the full unfolded history",
    );
    const foldedNotice = lastCallMessages.find((m) => /EARLIER STEPS/.test(m.content));
    assert.ok(foldedNotice, "expected an explicit folded-history notice once the window is exceeded");
    assert.ok(/step 0: list_files/.test(foldedNotice.content), "the folded digest should still mention what the condensed steps were");
    // The earliest step's ORIGINAL raw assistant turn must not appear
    // verbatim (only a condensed one-line digest of it, inside foldedNotice).
    const rawStep1Call = JSON.stringify(script[1]);
    assert.ok(!lastCallMessages.some((m) => m.content === rawStep1Call), "the earliest folded step's raw response must not be sent verbatim in the bounded prompt");
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("a different failing call does not count toward the same streak", async () => {
  const sandboxDir = freshSandbox();
  try {
    writeFileSync(join(sandboxDir, "a.js"), "content\n");
    const failA = { tool: "edit_file", args: { path: "a.js", old_string: "missing A", new_string: "x" } };
    const failB = { tool: "edit_file", args: { path: "a.js", old_string: "missing B", new_string: "x" } };
    // alternate distinct failures — never repeats the SAME call, so it should never abort
    const adapter = createSpyAdapter([failA, failB, failA, failB, failA, failB, failA, failB]);

    const result = await runReactLoop({
      taskPrompt: "irrelevant", toolset: createTools(sandboxDir), adapter, maxSteps: 8, seed: 1,
    });

    assert.equal(result.stuckLoopAbort, false);
    assert.equal(result.hitStepCap, true, "should run the full budget since alternating distinct failures never trip the repeat detector");
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
