// Tier 0, invariants "Witness gate coverage", "Void fidelity", and "No new
// propositions" — all three are the SAME real mechanism in this codebase:
// eochat/server/citation-check.js's checkGrounding/annotateVoids/
// groundingGaps. A claim traces to a source span or it is marked void
// in-place; nothing is silently passed through, and nothing is silently
// dropped or rewritten.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGrounding, annotateVoids, groundingGaps } from "../../server/citation-check.js";

const citations = [
  { index: 1, source_id: "source:demo.txt", text: "The observatory was completed in Geneva in 1995, under Director Aline Kessler." },
];

test("witness gate: a claim that matches the cited text is NOT flagged (clean report)", () => {
  const content = "The observatory was completed in Geneva in 1995 [1].";
  const report = checkGrounding(content, citations);
  assert.equal(report.clean, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
});

test("witness gate: a claim with no supporting citation is caught, never silently emitted", () => {
  const content = "The observatory was completed in Geneva in 2010 [1].";
  const report = checkGrounding(content, citations);
  assert.equal(report.clean, false);
  assert.ok(report.findings.some((f) => f.kind === "unsupported_claim"), JSON.stringify(report.findings));
});

test("witness gate: a claim attributed to the wrong source is caught as misattributed, not unsupported", () => {
  const twoSources = [
    { index: 1, source_id: "a.txt", text: "The observatory was completed in Geneva in 1995." },
    { index: 2, source_id: "b.txt", text: "The quarterly revenue target is 12000000 dollars." },
  ];
  const content = "The quarterly revenue target is 12000000 dollars [1].";
  const report = checkGrounding(content, twoSources);
  assert.ok(report.findings.some((f) => f.kind === "misattributed_claim" && f.foundIn.includes(2)), JSON.stringify(report.findings));
});

test("void fidelity: annotateVoids is ADDITIVE — every character of the original answer survives, in order", () => {
  const content = "The observatory was completed in Geneva in 2010 [1].";
  const report = checkGrounding(content, citations);
  const annotated = annotateVoids(content, report);
  assert.ok(annotated.length > content.length, "a void marker must have been inserted");
  // Strip every inserted marker back out and recover exactly the original —
  // proof that nothing was rewritten or deleted, only marked.
  const stripped = annotated.replace(/\[⊘[^\]]*\]/g, "");
  assert.equal(stripped, content, "annotateVoids must not alter the model's own words");
});

test("void fidelity: a clean answer is untouched by annotateVoids", () => {
  const content = "The observatory was completed in Geneva in 1995 [1].";
  const report = checkGrounding(content, citations);
  assert.equal(annotateVoids(content, report), content);
});

test("void fidelity: an inserted marker never lands inside a multi-byte word (Unicode-aware boundaries)", () => {
  const zCitations = [{ index: 1, source_id: "z.txt", text: "Zürich hosted the conference in 1998." }];
  const content = "München hosted the conference in 1998 [1].";
  const report = checkGrounding(content, zCitations);
  const annotated = annotateVoids(content, report);
  // The word "München" itself must appear intact somewhere in the output —
  // a corrupted insertion would split it (the exact regression this file's
  // PROPER_RE Unicode fix addressed for "Zürich").
  assert.ok(annotated.includes("München"), annotated);
});

test("no new propositions: groundingGaps reports a typed gap for every unsupported finding, never zero when findings exist", () => {
  const content = "The vault access code is Q7-PHOENIX-13 [1].";
  const report = checkGrounding(content, citations);
  const gaps = groundingGaps(report);
  assert.ok(Array.isArray(gaps));
  assert.ok(gaps.length > 0, "an unsupported claim must surface as a gap, not disappear");
});

test("no new propositions: an uncited sentence is counted, not silently absorbed into the cited total", () => {
  const content = "The vault access code is X9-FALCON-42 [1]. This part of the answer cites nothing.";
  const report = checkGrounding(content, citations);
  assert.equal(report.citedSentences, 1);
  assert.equal(report.uncitedSentences, 1);
  assert.equal(report.sentences, 2);
});
