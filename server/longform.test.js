import test from "node:test";
import assert from "node:assert/strict";
import { fidelityResidual } from "./longform.js";

const EVIDENCE = [{ text:
  "I beheld the wretch — the miserable monster whom I had created. He held up the curtain " +
  "of the bed; and his eyes, if eyes they may be called, were fixed on me. Victor had worked " +
  "hard to give it life. Horror and disgust filled my heart." }];

test("a faithful paraphrase passes; a fabrication does not", () => {
  // The load-bearing distinction. Measured dead end this replaces: scoring all
  // non-stopwords, and then scoring long words, BOTH gave the paraphrase and
  // the fabrication 1.00 — a metric that rejects true and false prose equally
  // is not a fidelity metric, it is a copying metric.
  const paraphrase = fidelityResidual(
    "Victor experiences overwhelming revulsion toward what he has made [1].", EVIDENCE);
  const fabrication = fidelityResidual(
    "The creature was created by Rostov, an officer in the Russian army near Borodino [1].", EVIDENCE);

  assert.equal(paraphrase.residual, 0, "paraphrasing in one's own words is not infidelity");
  assert.equal(fabrication.residual, 1, "names the evidence never contained are");
  assert.ok(fabrication.unsupported.includes("rostov"));
  assert.ok(fabrication.residual > paraphrase.residual, "the metric must separate them");
});

test("a draft asserting no specific reports a gap, not a pass", () => {
  const r = fidelityResidual("It suggests something quite profound about all of this.", EVIDENCE);
  assert.equal(r.residual, null, "nothing checkable is not the same as nothing wrong");
  assert.match(r.gap, /no specific/);
});

test("a name the evidence does contain is supported", () => {
  const r = fidelityResidual("Victor beheld the wretch he had created [1].", EVIDENCE);
  assert.equal(r.residual, 0);
});
