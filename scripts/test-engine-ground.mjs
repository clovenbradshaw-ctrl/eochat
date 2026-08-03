#!/usr/bin/env node
// Real-engine tests for the engine-ground bridge, focused on the
// discourse-conditioned retrieval added to fix the vague-turn shape: a
// question whose own words carry no topic ("what was that again?", "remind
// me") retrieves nothing on its own, and the conversation's topic trace (the
// desk's hot terms) widens it to the passage on topic.
//
// Unlike the smoke suite, these tests use the REAL corpus host
// (@eoreader/host/corpus) against an in-memory throwaway pool — no proxy, no
// Ollama, no network. The engine is a hard dependency of the server, so a
// host import failure failing these tests is correct (a broken install, not
// a flaky test).

import assert from "node:assert";

import { engineSearch, engineGroundQuery, engineIngestText } from "../server/engine-ground.js";

const POOL = "p-ground-test";

const DEMO_TEXT = [
  "The vault access code is X9-FALCON-42. Only the warden knows it.",
  "The quarterly revenue target is twelve million dollars.",
  "The mountain weather was cold and rainy all week, so the hike was postponed.",
  "The creature lurked outside the laboratory window on the dreary November night.",
].join("\n");

engineIngestText(DEMO_TEXT, "source:demo.txt", "demo", { pool: POOL });

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

const VAGUE = "what was that again";
const CUE = "vault access code x9-falcon-42";

test("no cue means discourse is reported as null", () => {
  const r = engineGroundQuery("what is the vault access code", { pool: POOL });
  assert.strictEqual(r.discourse, null, "discourse must be null without a cue");
  assert.strictEqual(r.priorWidening, null, "no priors in this pool");
});

test("a vague question retrieves nothing without the topic cue", () => {
  const r = engineGroundQuery(VAGUE, { pool: POOL });
  assert.strictEqual(r.citations.length, 0, "a question with no topic must fold no citations");
  assert.strictEqual(r.folded, 0);
});

test("the topic cue widens a vague question to the passage on topic", () => {
  const r = engineGroundQuery(VAGUE, { pool: POOL, discourse: CUE });
  assert.ok(r.discourse, "the cue must be reported");
  assert.ok(r.discourse.terms.length > 0, "some cue terms must join the query");
  assert.strictEqual(r.citations.length, 1);
  assert.match(r.citations[0].text, /X9-FALCON-42/, "the vault passage, not a distractor, must fold");
});

test("terms already in the question are not duplicated from the cue", () => {
  const r = engineGroundQuery("what is the vault access code", { pool: POOL, discourse: CUE });
  assert.ok(r.discourse, "the cue is still reported");
  assert.ok(!r.discourse.terms.includes("vault"), "vault is already in the question");
  assert.ok(r.discourse.terms.includes("x9-falcon-42"), "only the code term is genuinely new");
  assert.strictEqual(r.citations.length, 1);
});

test("direct verbatim retrieval still works (regression)", () => {
  const r = engineGroundQuery("what is the vault access code", { pool: POOL });
  assert.strictEqual(r.citations.length, 1);
  assert.match(r.citations[0].text, /vault access code is X9-FALCON-42/);
});

test("the minScore floor still withholds off-topic noise", () => {
  const r = engineGroundQuery("who is neil armstrong", { pool: POOL });
  assert.strictEqual(r.folded, 0);
  assert.strictEqual(r.citations.length, 0);
});

test("engineSearch reports the same discourse field", () => {
  const without = engineSearch(VAGUE, 5, { pool: POOL });
  assert.strictEqual(without.discourse, null);
  const withCue = engineSearch(VAGUE, 5, { pool: POOL, discourse: CUE });
  assert.ok(withCue.discourse, "the cue must widen the search too");
  assert.strictEqual(withCue.total, 1, "only the vault passage carries the cue terms");
  assert.match(withCue.passages[0].text, /X9-FALCON-42/);
});

console.log(`\nENGINE-GROUND TESTS: ${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
