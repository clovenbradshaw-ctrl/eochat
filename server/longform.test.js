import test from "node:test";
import assert from "node:assert/strict";
import { fidelityResidual, outlineFromEvidence } from "./longform.js";

const EVIDENCE = [{ text:
  "I beheld the wretch — the miserable monster whom I had created. He held up the curtain " +
  "of the bed; and his eyes, if eyes they may be called, were fixed on me. Victor had worked " +
  "hard to give it life. Horror and disgust filled my heart." }];

test("a faithful paraphrase passes; a fabrication does not", () => {
  const paraphrase = fidelityResidual(
    "Victor experiences overwhelming revulsion toward what he has made [1].", EVIDENCE);
  const fabrication = fidelityResidual(
    "The creature was created by Rostov, an officer in the Russian army near Borodino [1].", EVIDENCE);
  assert.equal(paraphrase.residual, 0, "paraphrasing is not infidelity");
  assert.equal(fabrication.residual, 1, "names the evidence never contained are");
  assert.ok(fabrication.unsupported.includes("rostov"));
  assert.ok(fabrication.residual > paraphrase.residual, "the metric must separate them");
});

test("a draft asserting no specific reports a gap, not a pass", () => {
  const r = fidelityResidual("It suggests something quite profound about all of this.", EVIDENCE);
  assert.equal(r.residual, null);
  assert.match(r.gap, /no specific/);
});

test("a name the evidence does contain is supported", () => {
  const r = fidelityResidual("Victor beheld the wretch he had created [1].", EVIDENCE);
  assert.equal(r.residual, 0);
});

test("outlineFromEvidence sorts by terrain ladder within source", () => {
  const passages = [
    { span_id:"a", source_id:"source:book.txt", byte_start:500, text:"In the garden", terrain:"Field" },
    { span_id:"b", source_id:"source:book.txt", byte_start:100, text:"He seized", terrain:"Link" },
    { span_id:"c", source_id:"source:book.txt", byte_start:900, text:"She wept", terrain:"Atmosphere" },
    { span_id:"d", source_id:"source:book.txt", byte_start:300, text:"The door", terrain:"Entity" },
    { span_id:"e", source_id:"source:letter.txt", byte_start:50, text:"Dear friend", terrain:"Link" },
  ];
  const outline = outlineFromEvidence(passages, { maxSections:5 });
  // 2 SEG + 1 CON + 1 SYN = 4 sections
  const secSections = outline.sections.filter((s) => s.task_id.startsWith("sec:"));
  assert.equal(secSections.length, 2);
  const bookSection = secSections.find((s) => s.source === "source:book.txt");
  assert.ok(bookSection, "book.txt has a section");
  // Terrain ladder: Entity(1)→Field(3)→Link(4)→Atmosphere(6)
  assert.deepEqual(bookSection.evidence, ["d","a","b","c"], "sorted by terrain ladder then byte_start");
});

test("fold-to-working-set prefers relevance and terrain diversity", () => {
  const passages = [
    { span_id:"a", source_id:"source:important.txt", byte_start:100, text:"Crucial", terrain:"Link", score:0.85 },
    { span_id:"b", source_id:"source:important.txt", byte_start:200, text:"She seized", terrain:"Atmosphere", score:0.72 },
    { span_id:"c", source_id:"source:noise.txt", byte_start:100, text:"Door", terrain:"Entity", score:0.21 },
    { span_id:"d", source_id:"source:noise.txt", byte_start:200, text:"Walked", terrain:"Entity", score:0.19 },
  ];
  const outline = outlineFromEvidence(passages, { maxSections:1 });
  assert.equal(outline.sections.length, 1);
  assert.equal(outline.sections[0].source, "source:important.txt", "relevance + diversity wins");
  assert.equal(outline.withheld, 3, "three sections withheld");
});

test("outlineFromEvidence falls back when terrain missing", () => {
  const passages = [
    { span_id:"x", source_id:"source:old.txt", byte_start:200, text:"Something" },
    { span_id:"y", source_id:"source:old.txt", byte_start:100, text:"Else" },
  ];
  const outline = outlineFromEvidence(passages, { maxSections:5 });
  assert.equal(outline.sections.length, 1);
  assert.deepEqual(outline.sections[0].evidence, ["y","x"], "fallback to byte_start ordering");
});
