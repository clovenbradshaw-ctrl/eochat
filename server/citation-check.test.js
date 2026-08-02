// Tests for the mechanical fact-check surface.
//
// Every case here is a defect that was possible against the previous version
// of this file, or a false positive the new checks must NOT produce. There are
// no model calls: the whole point of these checks is that they are decidable
// from the answer text and the citation table alone, so the tests are too.
//
// The adversarial half — does a real, weak, CPU-hosted model actually produce
// these shapes — lives in scripts/test-fact-check-model.mjs, which drives a
// live Ollama model against a real corpus and asserts on what comes back.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCitationRefs,
  validateCitations,
  verifyQuotedFidelity,
  checkGrounding,
  annotateVoids,
  groundingGaps,
  normalizeForFidelity,
} from "./citation-check.js";

// A small, deliberately ordinary citation table. Passage 1 and passage 2 share
// no proper noun and no figure, so a claim landing in the wrong one is always
// mechanically visible.
const TABLE = [
  {
    index: 1,
    source_id: "source:frankenstein.txt:100",
    text: "I am by birth a Genevese, and my family is one of the most distinguished of that republic. My ancestors had been for many years counsellors and syndics.",
  },
  {
    index: 2,
    source_id: "source:frankenstein.txt:200",
    text: "It was on a dreary night of November that I beheld the accomplishment of my toils. The rain pattered dismally against the panes.",
  },
  {
    index: 3,
    source_id: "source:report.txt:10",
    text: "Total revenue for the quarter reached 4,200 units, up from 3,150 in the prior period.",
  },
];

// ── Bracket grammar ──────────────────────────────────────────────────────────

test("a plain bracket is parsed with its number and its span", () => {
  const refs = parseCitationRefs("Genevese by birth [1].");
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].nums, [1]);
  assert.equal("Genevese by birth [1].".slice(refs[0].start, refs[0].end), "[1]");
});

test("a comma list and a range both expand to their members", () => {
  assert.deepEqual(parseCitationRefs("x [1,2]")[0].nums, [1, 2]);
  assert.deepEqual(parseCitationRefs("x [1, 2; 3]")[0].nums, [1, 2, 3]);
  assert.deepEqual(parseCitationRefs("x [2-4]")[0].nums, [2, 3, 4]);
  assert.deepEqual(parseCitationRefs("x [2–3]")[0].nums, [2, 3]);
  assert.deepEqual(parseCitationRefs("x [2 to 3]")[0].nums, [2, 3]);
});

test("an absurd range cannot make the parser allocate", () => {
  const refs = parseCitationRefs("x [1-99999]");
  assert.deepEqual(refs[0].nums, [1, 99999]);
});

test("prose that merely contains brackets is not read as a citation", () => {
  assert.deepEqual(parseCitationRefs("an array like [foo] or [] or [a1]"), []);
});

// ── validateCitations ────────────────────────────────────────────────────────

test("an out-of-range citation becomes a visible void marker", () => {
  assert.equal(
    validateCitations("As shown [1] and also [9].", 3),
    "As shown [1] and also [⊘ no source 9].",
  );
});

test("REGRESSION: a comma-list of fabricated numbers no longer escapes validation", () => {
  // The old /\[(\d+)\]/ regex did not match "[9,10]" at all, so an answer
  // citing two nonexistent passages in one bracket passed through untouched —
  // rendering as a real citation to the reader.
  const out = validateCitations("Revenue rose sharply [9,10].", 3);
  assert.match(out, /⊘ no source 9, 10/);
  assert.doesNotMatch(out, /\[9,10\]/);
});

test("REGRESSION: a fabricated range no longer escapes validation", () => {
  const out = validateCitations("Three findings [4-6].", 3);
  assert.match(out, /⊘ no source 4, 5, 6/);
});

test("a mixed bracket keeps the real citation and voids only the invented one", () => {
  // Voiding the whole bracket would destroy a verifiable link to punish an
  // adjacent mistake — the reader loses a route to real evidence.
  const out = validateCitations("Both points hold [2,9].", 3);
  assert.match(out, /\[2\]/);
  assert.match(out, /⊘ no source 9/);
});

test("with no citation table at all, nothing is rewritten", () => {
  assert.equal(validateCitations("Plain answer [1].", 0), "Plain answer [1].");
});

// ── Quoted fidelity ──────────────────────────────────────────────────────────

test("a genuine verbatim quote from the passage it cites verifies", () => {
  const r = verifyQuotedFidelity('He writes "I am by birth a Genevese" [1].', TABLE);
  assert.equal(r.quotesChecked, 1);
  assert.equal(r.verified, 1);
  assert.equal(r.unverified.length, 0);
});

test("an invented quotation is reported as unverified", () => {
  const r = verifyQuotedFidelity('He writes "I was born in the city of Ingolstadt" [1].', TABLE);
  assert.equal(r.verified, 0);
  assert.equal(r.unverified.length, 1);
  assert.match(r.unverified[0].quote, /Ingolstadt/);
});

test("REGRESSION: a real quote attached to the wrong passage is caught, not passed", () => {
  // The old check asked "does this appear in ANY cited passage" — so a
  // quotation that is verbatim real but attributed to the wrong number
  // verified cleanly, and a reader following [1] landed on bytes that do not
  // contain the sentence they were shown.
  const r = verifyQuotedFidelity('The novel opens "It was on a dreary night of November" [1].', TABLE);
  assert.equal(r.verified, 0);
  assert.equal(r.misattributed.length, 1);
  assert.equal(r.misattributed[0].actualIndex, 2);
  assert.deepEqual(r.misattributed[0].citedNums, [1]);
});

test("a quote with no bracket at all falls back to the whole table, inventing no misattribution", () => {
  const r = verifyQuotedFidelity('Someone once said "It was on a dreary night of November" in passing.', TABLE);
  assert.equal(r.verified, 1);
  assert.equal(r.misattributed.length, 0);
});

test("a quote attached by a preceding bracket is checked against that bracket", () => {
  const r = verifyQuotedFidelity('Passage [2] reads: "It was on a dreary night of November".', TABLE);
  assert.equal(r.verified, 1);
});

test("a bracket on the far side of a sentence boundary is not treated as this quote's citation", () => {
  const r = verifyQuotedFidelity(
    'He writes "It was on a dreary night of November". A separate point follows [1].',
    TABLE,
  );
  // Falls back to the whole table rather than reading [1] across the full
  // stop, so this verifies rather than producing a bogus misattribution.
  assert.equal(r.verified, 1);
});

test("typographic quotes and collapsed whitespace do not break verification", () => {
  const r = verifyQuotedFidelity('He writes “I am by  birth\na Genevese” [1].', TABLE);
  assert.equal(r.verified, 1);
  assert.equal(normalizeForFidelity("“a  b”"), '"a b"');
});

test("REGRESSION (found by the live-model harness): a quote's first letter re-cased to open a sentence is not a fabrication", () => {
  // qwen2.5:0.5b-instruct produced 'The best season the orchard yielded 41
  // hogsheads of cider, and in the worst none' for source text reading
  // '...in the best season the orchard yielded 41 hogsheads of cider, and in
  // the worst none at all.' — every byte after the first identical; only the
  // opening capital differs, the ordinary convention for opening a sentence
  // with a mid-sentence quotation.
  const table = [{ index: 1, source_id: "s", text: "In the best season the orchard yielded 41 hogsheads of cider, and in the worst none at all." }];
  const r = verifyQuotedFidelity('"The best season the orchard yielded 41 hogsheads of cider, and in the worst none" [1].', table);
  assert.equal(r.verified, 1);
  assert.equal(r.unverified.length, 0);
});

test("a case change past the FIRST character is still caught, not swallowed by the tolerance above", () => {
  const table = [{ index: 1, source_id: "s", text: "the orchard yielded forty barrels of cider that Season." }];
  const r = verifyQuotedFidelity('"the orchard yielded forty Barrels of cider that season" [1].', table);
  assert.equal(r.verified, 0);
  assert.equal(r.unverified.length, 1);
});

test("a short quoted fragment is below the checked threshold and reported as such", () => {
  const r = verifyQuotedFidelity('He said "no" [1].', TABLE);
  assert.equal(r.quotesChecked, 0);
});

// ── Unsupported claims: the void a valid bracket still points into ───────────

test("THE CORE CASE: a well-formed citation on a claim absent from that passage is caught", () => {
  // [1] resolves, nothing is quoted, and the bracket looks perfect. The claim
  // is nowhere in passage 1. Before this check, nothing in the app noticed.
  const r = checkGrounding("His brother William was murdered near Geneva [1].", TABLE);
  const names = r.findings.filter((f) => f.kind === "unsupported_claim").map((f) => f.text);
  assert.ok(names.includes("William"), `expected William flagged, got ${JSON.stringify(names)}`);
  assert.equal(r.clean, false);
});

test("a claim faithfully paraphrasing the cited passage is NOT flagged", () => {
  const r = checkGrounding("The narrator describes himself as a Genevese by birth [1].", TABLE);
  assert.deepEqual(r.findings, []);
  assert.equal(r.clean, true);
  // and it must be visible that the check actually looked
  assert.ok(r.atomsChecked > 0);
  assert.equal(r.citedSentences, 1);
});

test("a fabricated figure under a real citation is caught", () => {
  const r = checkGrounding("Revenue reached 9,900 units this quarter [3].", TABLE);
  const f = r.findings.find((x) => x.atomKind === "number");
  assert.ok(f, "expected the invented figure to be flagged");
  assert.equal(f.text, "9,900");
  assert.deepEqual(f.citedNums, [3]);
});

test("a real figure from the passage it cites is NOT flagged, commas and all", () => {
  const r = checkGrounding("Revenue reached 4,200 units, up from 3,150 [3].", TABLE);
  assert.deepEqual(r.findings, []);
});

test("a claim absent from what it cites but present in another passage is misattributed, not merely unsupported", () => {
  const r = checkGrounding("The narrator recalls a dreary night in November [1].", TABLE);
  const f = r.findings.find((x) => x.kind === "misattributed_claim");
  assert.ok(f, `expected a misattribution, got ${JSON.stringify(r.findings)}`);
  assert.deepEqual(f.citedNums, [1]);
  assert.ok(f.foundIn.includes(2));
});

test("a citation number is never mistaken for a claimed figure", () => {
  // Without blanking brackets before extracting atoms, every "[3]" reads as an
  // unsupported number 3.
  const r = checkGrounding("Total revenue reached 4,200 units [3].", TABLE);
  assert.ok(!r.findings.some((f) => f.text === "3"), JSON.stringify(r.findings));
});

test("a sentence-initial capitalised ordinary word is not read as a proper noun", () => {
  const r = checkGrounding("Total revenue reached 4,200 units [3]. Later figures are absent [3].", TABLE);
  assert.ok(!r.findings.some((f) => f.text === "Later"), JSON.stringify(r.findings));
});

test("possessives and plurals match their stem in the source", () => {
  const r = checkGrounding("The family's counsellors are described [1].", TABLE);
  assert.deepEqual(r.findings, []);
});

test("an uncited sentence is not flagged, but IS counted", () => {
  const r = checkGrounding("The narrator is Genevese [1]. Zurich is a different city entirely.", TABLE);
  assert.equal(r.findings.length, 0);
  assert.equal(r.citedSentences, 1);
  assert.equal(r.uncitedSentences, 1);
});

test("an atom the reader's own question supplied is flagged, but marked as an echo", () => {
  const r = checkGrounding(
    "Ingolstadt is where the work was done [1].",
    TABLE,
    { question: "What happened at Ingolstadt?" },
  );
  const f = r.findings.find((x) => x.text === "Ingolstadt");
  assert.ok(f, "the finding must still be made — the sources not saying this is the point");
  assert.equal(f.echoesQuestion, true);
});

test("a quoted run is checked once, as a quote, not again word by word", () => {
  const r = checkGrounding('He writes "I was born in Ingolstadt, a distant city" [1].', TABLE);
  const kinds = r.findings.map((f) => f.kind);
  assert.deepEqual(kinds, ["unverified_quote"]);
});

test("abbreviations and initials do not split a sentence into fragments", () => {
  const r = checkGrounding("Mrs. Saville is addressed by the narrator [1].", TABLE);
  assert.equal(r.sentences, 1);
});

test("a list marker at the head of a line is layout, not a claimed figure", () => {
  const r = checkGrounding("Findings:\n1. Revenue reached 4,200 units [3].", TABLE);
  assert.ok(!r.findings.some((f) => f.text === "1"), JSON.stringify(r.findings));
});

test("a bracket that resolves to nothing is reported as unresolved, not as an unsupported claim", () => {
  const r = checkGrounding("Something entirely invented happened in Ingolstadt [9].", TABLE);
  assert.deepEqual(r.unresolvedNums, [9]);
  assert.equal(r.findings.length, 0);
});

// ── The report is honest about what it did ───────────────────────────────────

test("a clean report still says what it examined, so silence is never ambiguous", () => {
  const r = checkGrounding("The narrator is a Genevese by birth [1].", TABLE);
  assert.equal(r.clean, true);
  assert.equal(r.citationTableSize, 3);
  assert.equal(r.bracketsFound, 1);
  assert.ok(r.atomsChecked >= 1);
  assert.equal(r.truncated, null);
});

test("an answer with no citations at all reports zero checked, not zero wrong", () => {
  const r = checkGrounding("A perfectly fluent ungrounded paragraph about Ingolstadt.", TABLE);
  assert.equal(r.citedSentences, 0);
  assert.equal(r.atomsChecked, 0);
  assert.equal(r.clean, true); // nothing claimed a source, so nothing lied about one
  assert.equal(r.uncitedSentences, 1);
});

test("L3: a capped findings list says how much it dropped", () => {
  const many = Array.from({ length: 80 }, (_, i) => `Fabricatedname${i} appeared [1].`).join(" ");
  const r = checkGrounding(many, TABLE);
  assert.ok(r.truncated, "expected truncation to be reported");
  assert.equal(r.findings.length, 60);
  assert.equal(r.truncated.total, r.truncated.reported + r.truncated.dropped);
  assert.ok(groundingGaps(r).some((g) => g.type === "findings_truncated"));
});

test("an empty citation table checks nothing and claims nothing", () => {
  const r = checkGrounding("Anything at all about Ingolstadt.", []);
  assert.equal(r.citationTableSize, 0);
  assert.equal(r.clean, true);
});

// ── The void is written into the artifact ────────────────────────────────────

test("an unsupported claim is marked in the answer itself, additively", () => {
  const text = "His brother William was murdered [1].";
  const r = checkGrounding(text, TABLE);
  const marked = annotateVoids(text, r);
  assert.match(marked, /William\[⊘ not in source 1\]/);
  // The model's own words survive in order — the marker is inserted between
  // them, never in place of them.
  assert.equal(marked.replace(/\[⊘[^\]]*\]/g, ""), text);
});

test("multiple markers in one sentence all land on the right spans", () => {
  const text = "William and Ingolstadt both appear [1].";
  const r = checkGrounding(text, TABLE);
  const marked = annotateVoids(text, r);
  assert.match(marked, /William\[⊘[^\]]*\]/);
  assert.match(marked, /Ingolstadt\[⊘[^\]]*\]/);
});

test("a misattributed quote's marker names where the bytes actually are", () => {
  const text = 'He writes "It was on a dreary night of November" [1].';
  const marked = annotateVoids(text, checkGrounding(text, TABLE));
  assert.match(marked, /verbatim in source 2, not 1/);
});

test("a clean answer is returned byte-identical", () => {
  const text = "The narrator is a Genevese by birth [1].";
  assert.equal(annotateVoids(text, checkGrounding(text, TABLE)), text);
});

// ── Typed gaps, the vocabulary the rest of the app speaks ────────────────────

test("every finding kind becomes a typed gap with a reader-legible reason", () => {
  const text =
    'His brother William was murdered [1]. He writes "I was born in Ingolstadt tonight" [1]. Also [9].';
  const gaps = groundingGaps(checkGrounding(text, TABLE));
  const types = new Set(gaps.map((g) => g.type));
  assert.ok(types.has("unsupported_claim"));
  assert.ok(types.has("unverified_quote"));
  assert.ok(types.has("unresolved_citation"));
  for (const g of gaps) assert.ok(g.reason && g.reason.length > 10, `bare gap: ${JSON.stringify(g)}`);
});

test("a clean report produces no gaps", () => {
  assert.deepEqual(groundingGaps(checkGrounding("The narrator is Genevese [1].", TABLE)), []);
});

// ── Robustness: nothing here may throw on hostile input ──────────────────────

test("hostile and degenerate inputs are survived, not thrown on", () => {
  const hostile = [
    "", null, undefined,
    "[".repeat(5000),
    "[1]".repeat(5000),
    "[" + "9".repeat(400) + "]",
    " � unicode ‮ reversed",
    '"' .repeat(2000),
    "a".repeat(200000) + " [1]",
    "[1,".repeat(1000) + "1]",
  ];
  for (const h of hostile) {
    assert.doesNotThrow(() => {
      const r = checkGrounding(h, TABLE);
      annotateVoids(h, r);
      groundingGaps(r);
      validateCitations(h, 3);
      verifyQuotedFidelity(h, TABLE);
    }, `threw on ${JSON.stringify(String(h).slice(0, 40))}`);
  }
});

test("a citation table with missing or malformed text does not break the check", () => {
  const broken = [{ index: 1 }, { index: 2, text: null }, { text: "no index" }];
  assert.doesNotThrow(() => {
    const r = checkGrounding("A claim about William [1].", broken);
    annotateVoids("A claim about William [1].", r);
  });
});

test("offsets stay valid on multibyte text, so markers never land mid-character", () => {
  const table = [{ index: 1, source_id: "s", text: "Le café était naïf — résumé fini." }];
  const text = "The café was naïf [1]. The Zürich office was not [1].";
  const r = checkGrounding(text, table);
  const marked = annotateVoids(text, r);
  assert.ok(marked.includes("Zürich[⊘"), marked);
  assert.ok(marked.includes("café"), "existing multibyte text must survive intact");
});
