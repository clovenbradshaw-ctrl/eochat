#!/usr/bin/env node
// Tests for prosify-cue.js — the terse-follow-up rewrite gate.
//
// Properties that matter, asserted directly:
//
//   - the trip-wire only fires on short messages carrying an unresolved
//     referent, so a self-contained question never pays for a rewrite it
//     does not need;
//   - the prompt builder never fabricates state — it only ever restates the
//     hot terms, facts, and history it was actually given;
//   - a degenerate model output (empty, or a runaway completion) falls back
//     to the raw question unchanged, not to something invented.

import assert from "node:assert";

import {
  needsProsify, buildProsifyMessages, applyProsifyResult,
} from "../server/prosify-cue.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// ── needsProsify ─────────────────────────────────────────────────────────────

test("a terse referent-bearing follow-up triggers", () => {
  assert.equal(needsProsify("read it again"), true);
  assert.equal(needsProsify("make it shorter"), true);
  assert.equal(needsProsify("go deeper on that"), true);
});

test("a self-contained question does not trigger", () => {
  assert.equal(needsProsify("What does Victor Frankenstein feel toward the creature he made?"), false);
});

test("a long message does not trigger even with a referent word", () => {
  const long = "it ".repeat(11) + "explain the whole thing again from the very beginning please";
  assert.equal(needsProsify(long), false);
});

test("empty or whitespace-only input does not trigger", () => {
  assert.equal(needsProsify(""), false);
  assert.equal(needsProsify("   "), false);
});

test("a short message with no referent does not trigger", () => {
  assert.equal(needsProsify("hello there"), false);
});

// ── buildProsifyMessages ─────────────────────────────────────────────────────

test("the prompt carries only the state it was given, verbatim", () => {
  const messages = buildProsifyMessages({
    question: "read it again",
    history: ["Tell me about the creation scene in Frankenstein."],
    hot: [{ term: "frankenstein", weight: 3 }, { term: "creation", weight: 2 }],
    facts: [{ text: "The reader is studying chapter 4." }],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, "read it again");
  const system = messages[0].content;
  assert.ok(system.includes("frankenstein"), "hot term missing from prompt");
  assert.ok(system.includes("The reader is studying chapter 4."), "fact missing from prompt");
  assert.ok(system.includes("creation scene in Frankenstein"), "history missing from prompt");
  assert.ok(/never introduce/i.test(system), "no-invention constraint missing from prompt");
});

test("no state given yields a prompt with no fabricated sections", () => {
  const messages = buildProsifyMessages({ question: "again" });
  assert.equal(messages[1].content, "again");
  assert.ok(!/stated in this conversation/i.test(messages[0].content));
  assert.ok(!/in focus now/i.test(messages[0].content));
});

// ── applyProsifyResult ───────────────────────────────────────────────────────

test("a clean rewrite is used as the cue", () => {
  const result = applyProsifyResult({
    question: "read it again",
    modelText: "Re-read the Frankenstein creation scene just discussed.",
  });
  assert.equal(result.cue, "Re-read the Frankenstein creation scene just discussed.");
  assert.equal(result.raw, "read it again");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "expanded");
});

test("surrounding quotes from the model are stripped", () => {
  const result = applyProsifyResult({ question: "again", modelText: '"Re-read the passage again."' });
  assert.equal(result.cue, "Re-read the passage again.");
});

test("empty model output falls back to the raw question", () => {
  const result = applyProsifyResult({ question: "read it again", modelText: "   " });
  assert.equal(result.cue, "read it again");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "empty");
});

test("a runaway completion falls back to the raw question", () => {
  const result = applyProsifyResult({ question: "again", modelText: "word ".repeat(500) });
  assert.equal(result.cue, "again");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "degenerate");
});

test("a no-op rewrite (model echoes the question) is not reported as changed", () => {
  const result = applyProsifyResult({ question: "read it again", modelText: "read it again" });
  assert.equal(result.changed, false);
});

console.log(`\n${passed} test(s) passed`);
