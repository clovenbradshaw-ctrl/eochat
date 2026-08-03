#!/usr/bin/env node
// Tests for compiling a project's free-form instructions into gate folds.
//
// The properties that matter are the ones INSTRUCTION-LAW names, so they are
// asserted directly: every surfaced body is verbatim (R1), an absence is named
// rather than silent (R2), and every conditional fold declares terms that can
// actually surface it (R3). The length behaviour the feature exists for —
// instructions of any size, folded only when they do not fit — is measured
// rather than assumed.

import assert from "node:assert";
import { compileInstructionFolds } from "../server/project-instructions.js";
import { createInstructionGate, countTokens } from "../server/instruction-gate.js";

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

const SHORT = `Always answer in British English.
Never use bullet points in a reply shorter than four sentences.`;

// The gate's own framing costs ~244 tokens before a single rule is surfaced,
// so a fixture has to be substantially larger than that for folding to be a
// meaningful test rather than a budget that nothing could fit inside. Each
// section carries distinctive vocabulary, repeated enough to be realistically
// sized, so relevance has something to route on.
function section(heading, rules, pad) {
  return `\n## ${heading}\n${rules}\n${(pad + " ").repeat(40)}\n`;
}

const LONG =
  `We are a legal research team. Cite the statute, never paraphrase it.\n` +
  section("Billing and invoices",
    `Invoices are issued on the first business day of the month. Never quote a billing figure that is not on an issued invoice. Late payment interest accrues at the statutory rate.`,
    "Invoice ledger reconciliation remains the billing department's responsibility.") +
  section("Shipping and delivery",
    `Physical bundles ship by courier within three business days. Never promise a delivery date; give the dispatch window only.`,
    "Courier dispatch manifests are logged against each outbound bundle.") +
  section("Refund policy",
    `Refunds are approved by a partner, never by this assistant. State the refund window as fourteen days from dispatch. Do not estimate a refund amount.`,
    "Refund adjudication follows the partner review calendar without exception.") +
  section("Privacy and client data",
    `Never reveal a client name in an answer that also names a matter number. Redaction requests are honoured immediately.`,
    "Redaction workflows are audited quarterly by the privacy steward.");

// Forces folding (the corpus is larger) while leaving room above the gate's
// ~244-token framing floor for a matched section to actually be surfaced.
const TIGHT = 800;

test("short instructions are handed over whole, not folded", () => {
  const { folds, report } = compileInstructionFolds(SHORT, { budgetTokens: 2800 });
  assert.equal(report.mode, "whole");
  assert.equal(folds.length, 1);
  assert.equal(folds[0].always, true);
  assert.equal(folds[0].body, SHORT.trim());
});

test("a long set folds into several addressable folds", () => {
  const { folds, report } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  assert.equal(report.mode, "folded");
  assert.ok(folds.length >= 4, `expected several folds, got ${folds.length}`);
});

test("R1 — every fold body is a verbatim slice of what the reader wrote", () => {
  const { folds } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  for (const fold of folds) {
    assert.ok(LONG.includes(fold.body), `fold ${fold.id} is not verbatim`);
  }
});

test("R3 — every conditional fold declares signals that can surface it", () => {
  const { folds } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  for (const fold of folds) {
    if (fold.always) continue;
    assert.ok(fold.signals.length > 0, `fold ${fold.id} is conditional with no signals — a wall`);
  }
});

test("the preamble is always in force when it fits", () => {
  const { folds, report } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  assert.equal(report.preambleAlwaysOn, true);
  const preamble = folds.find((f) => f.id.includes("preamble"));
  assert.ok(preamble, "no preamble fold");
  assert.equal(preamble.always, true);
  assert.ok(preamble.body.includes("Cite the statute"));
});

test("a question surfaces its own section verbatim and folds the others", () => {
  const { folds, report } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  assert.equal(report.mode, "folded");
  const gate = createInstructionGate({ folds, budgetTokens: TIGHT });
  const r = gate.gate({ question: "What is our refund window?" });

  const surfacedText = r.surfaced.map((f) => f.body).join("\n");
  assert.ok(/fourteen days from dispatch/.test(surfacedText),
    `refund rule did not surface; active: ${r.activeIds.join(", ")}`);
  // And the rules that did not match are named, not vanished.
  assert.ok(r.foldedIds.length > 0, "nothing was folded — the index is empty");
  assert.ok(/NOT active/.test(r.systemMessage), "folded folds are not marked inactive");
});

test("a different question surfaces a different section", () => {
  const { folds } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  const gate = createInstructionGate({ folds, budgetTokens: TIGHT });
  const r = gate.gate({ question: "When does the courier collect a physical bundle?" });
  const surfacedText = r.surfaced.map((f) => f.body).join("\n");
  assert.ok(/dispatch window/.test(surfacedText),
    `shipping rule did not surface; active: ${r.activeIds.join(", ")}`);
});

test("a split section surfaces its head, where the rule is, not its tail", () => {
  // Regression: every part of a split section carries the same signals, so
  // they tie on relevance and the tie-break decides what the model is handed.
  // This once favoured whichever part happened to be small enough to fit,
  // which surfaced a section's trailing commentary and withheld the rule
  // stated in its first line.
  const { folds } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  const parts = folds.filter((f) => f.id.includes("refund-policy"));
  assert.ok(parts.length > 1, "the refund section was not split — nothing to order");
  const head = parts.find((f) => !f.id.includes("part"));
  for (const later of parts.filter((f) => f !== head)) {
    assert.ok(head.weight > later.weight,
      `${later.id} does not sort after the section head ${head.id}`);
  }
});

test("R2 — a turn matching nothing names the gap instead of going silent", () => {
  const { folds } = compileInstructionFolds(LONG, { budgetTokens: TIGHT });
  const gate = createInstructionGate({ folds, budgetTokens: TIGHT });
  const r = gate.gate({ question: "zzyzx quixotropic bandersnatch" });
  assert.equal(r.stats.gap, true, "no gap flagged on a no-match turn");
  assert.ok(/NO FOLD SURFACED THIS TURN/.test(r.systemMessage));
});

test("R5 — the block stays inside its budget however long the instructions are", () => {
  // Forty times the corpus against an unchanged budget. The point of the gate
  // is that the block does not grow with the manual.
  const huge = LONG.repeat(40);
  for (const budget of [400, 1200, 2800]) {
    const { folds } = compileInstructionFolds(huge, { budgetTokens: budget });
    const gate = createInstructionGate({ folds, budgetTokens: budget });
    const r = gate.gate({ question: "What is the refund window?" });
    assert.ok(r.stats.blockTokens <= budget,
      `block was ${r.stats.blockTokens} tokens against a ${budget} budget ` +
      `from a ${countTokens(huge)}-token corpus (overflow ${r.stats.overflow})`);
  }
});

test("R4 — every folded rule is still named in the index, at any size", () => {
  const huge = LONG.repeat(40);
  const budget = 2800;
  const { folds } = compileInstructionFolds(huge, { budgetTokens: budget });
  const gate = createInstructionGate({ folds, budgetTokens: budget });
  const r = gate.gate({ question: "What is the refund window?" });
  for (const id of r.foldedIds) {
    assert.ok(r.systemMessage.includes(id), `folded fold ${id} is not named in the block`);
  }
});

test("a wall of prose with no blank lines still splits, and stays verbatim", () => {
  const oneHugeSection = `## Everything\n` + "This rule matters. ".repeat(4000);
  const { folds } = compileInstructionFolds(oneHugeSection, { budgetTokens: 300 });
  assert.ok(folds.length > 1, "an oversized section was not split into parts");
  for (const fold of folds) {
    assert.ok(oneHugeSection.includes(fold.body), `split part ${fold.id} is not verbatim`);
  }
});

test("a fold too big to ever surface is reported, not left as a silent wall", () => {
  const huge = LONG.repeat(40);
  const { report } = compileInstructionFolds(huge, { budgetTokens: 400 });
  if (report.oversized.length) {
    assert.ok(report.warning, "oversized folds were not explained in the report");
    assert.ok(/Raise the instruction budget/.test(report.warning));
  }
});

test("empty instructions compile to nothing, not to an empty rule", () => {
  const { folds, report } = compileInstructionFolds("   \n  ");
  assert.equal(folds.length, 0);
  assert.equal(report.mode, "empty");
});

test("an unroutable section is kept in force and named, never dropped", () => {
  // A section whose only words are stopwords: nothing distinctive to route on.
  const text = `## A\nit is to be of the and or if so.\n\n## B\n` + "distinctive vocabulary here ".repeat(300);
  const { folds, report } = compileInstructionFolds(text, { budgetTokens: 50 });
  const all = folds.map((f) => f.body).join("\n");
  assert.ok(all.includes("it is to be of the and or if so."), "the unroutable section was dropped");
  if (report.unroutable.length) {
    const promoted = folds.find((f) => f.id === report.unroutable[0]);
    assert.equal(promoted.always, true, "an unroutable fold must be always-on, never a wall");
  }
});

// ── storage ──
//
// The compiler is pure, but the promise "any length, kept verbatim" is a
// storage promise, so it is checked against a real store on a real temp dir.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { ProjectStore } from "../server/project-store.js";

const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "eochat-proj-"));
const store = new ProjectStore({ dir: tmp });

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

await asyncTest("instructions of any length round-trip byte for byte", async () => {
  const p = await store.create({ name: "big" });
  const huge = LONG.repeat(80); // ~900KB
  await store.setInstructions(p.id, huge);
  const back = await store.getInstructions(p.id);
  assert.equal(back.text, huge, "stored instructions are not byte-identical");
  assert.equal(back.chars, huge.length);
});

await asyncTest("clearing instructions removes them rather than storing empty", async () => {
  const p = await store.create({ name: "clearable" });
  await store.setInstructions(p.id, "some rules");
  await store.setInstructions(p.id, "   ");
  const back = await store.getInstructions(p.id);
  assert.equal(back.text, "");
  assert.equal(back.updatedAt, null, "an absent instruction set should have no timestamp");
});

await asyncTest("deleting a project deletes its instructions with it", async () => {
  const p = await store.create({ name: "doomed" });
  await store.setInstructions(p.id, "rules that should not outlive the project");
  const sidecar = store.instructionsPath(p.id);
  assert.ok(fs.existsSync(sidecar), "sidecar was not written");
  await store.remove(p.id);
  assert.ok(!fs.existsSync(sidecar),
    "the instructions sidecar outlived its project — a later project reusing the id would inherit rules nobody wrote for it");
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed`);
if (process.exitCode) console.log("SOME TESTS FAILED");
else console.log("ALL PROJECT-INSTRUCTION TESTS PASSED");
