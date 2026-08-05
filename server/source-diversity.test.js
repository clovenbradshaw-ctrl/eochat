// Tests for the mechanical source diversity surface.
//
// Every case here verifies that the diversity checker correctly identifies
// when citations point to legitimately different sources versus when they
// masquerade as diverse but come from the same or highly similar evidence.
//
// There are no model calls: every check is decidable from the answer text
// and citation table alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkSourceDiversity,
  detectContentOverlap,
  measureSourceConcentration,
  measureSourceTypeDiversity,
  detectPseudoDiverseGroups,
  checkCorroborationClaims,
  annotateDiversityVoids,
  diversityGaps,
  jaccardSimilarity,
} from "./source-diversity.js";
import { parseCitationRefs } from "./citation-check.js";

// ── Test tables ──────────────────────────────────────────────────────────────

// GENUINELY DIVERSE: three different sources, different content
const DIVERSE_TABLE = [
  {
    index: 1,
    source_id: "source:frankenstein.txt:100",
    span_id: "span-a",
    text: "I am by birth a Genevese, and my family is one of the most distinguished of that republic. My ancestors had been for many years counsellors and syndics.",
  },
  {
    index: 2,
    source_id: "source:dracula.txt:50",
    span_id: "span-b",
    text: "I had for dinner, or rather supper, a chicken done up some way with red pepper, which was very good but thirsty. I asked for a glass of water and it was brought to me.",
  },
  {
    index: 3,
    source_id: "https://en.wikipedia.org/wiki/Geneva",
    span_id: "span-c",
    title: "Geneva - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Geneva",
    text: "Geneva is the second-most populous city in Switzerland. Situated where the Rhône exits Lake Geneva, it is the capital of the Republic and Canton of Geneva.",
  },
  {
    index: 4,
    source_id: "source:frankenstein.txt:200",
    span_id: "span-d",
    text: "It was on a dreary night of November that I beheld the accomplishment of my toils. The rain pattered dismally against the panes.",
  },
  {
    index: 5,
    source_id: "https://www.britannica.com/place/Geneva",
    span_id: "span-e",
    title: "Geneva - Britannica",
    url: "https://www.britannica.com/place/Geneva",
    text: "Geneva, French Genève, German Genf, city, capital of Genève canton, in the far southwestern part of Switzerland. Lying at the western tip of Lake Geneva, it is one of Europe's most cosmopolitan cities.",
  },
];

// SAME-SOURCE CONCENTRATION: five passages, all from the same file
const SAME_SOURCE_TABLE = [
  { index: 1, source_id: "source:frankenstein.txt:100", span_id: "s1", text: "I am by birth a Genevese, and my family is one of the most distinguished of that republic." },
  { index: 2, source_id: "source:frankenstein.txt:200", span_id: "s2", text: "It was on a dreary night of November that I beheld the accomplishment of my toils." },
  { index: 3, source_id: "source:frankenstein.txt:300", span_id: "s3", text: "No one can conceive the variety of feelings which bore me onwards, like a hurricane, in the first enthusiasm of success." },
];

// PSEUDO-DIVERSE: different source_ids but near-identical text
const OVERLAP_TABLE = [
  { index: 1, source_id: "https://news-site-a.com/article", span_id: "w1", title: "News Site A", text: "The Federal Reserve announced today that interest rates will remain unchanged at 5.25% to 5.5%, citing persistent inflation concerns and a labor market that remains stronger than anticipated." },
  { index: 2, source_id: "https://news-site-b.com/report", span_id: "w2", title: "News Site B", text: "The Federal Reserve announced today that interest rates will remain unchanged at 5.25% to 5.5%, citing persistent inflation concerns and a labor market that remains stronger than anticipated. Officials noted they would continue monitoring data." },
  { index: 3, source_id: "https://news-site-c.com/story", span_id: "w3", title: "News Site C", text: "The Federal Reserve announced today that interest rates will remain unchanged at 5.25% to 5.5%, citing persistent inflation concerns and a labor market that remains stronger than anticipated." },
];

// ── Source type classification ───────────────────────────────────────────────

test("source types are correctly classified", () => {
  const r = checkSourceDiversity("Geneva is described [1][2][3].", DIVERSE_TABLE);
  // After normalization, source:frankenstein.txt:100 and :200 share the base key
  const frankBase = Object.keys(r.sourceMap).find((k) => k.startsWith("source:frankenstein"));
  assert.ok(frankBase, `expected a frankenstein base key, got: ${JSON.stringify(Object.keys(r.sourceMap))}`);
  assert.equal(r.sourceMap[frankBase].type, "corpus");
  const draculaBase = Object.keys(r.sourceMap).find((k) => k.startsWith("source:dracula"));
  assert.ok(draculaBase);
  assert.equal(r.sourceMap[draculaBase].type, "corpus");
  const wikiBase = Object.keys(r.sourceMap).find((k) => k.includes("wikipedia"));
  assert.ok(wikiBase);
  assert.equal(r.sourceMap[wikiBase].type, "web");
});

// ── Concentration ────────────────────────────────────────────────────────────

test("a table with one source has maximum concentration (1.0)", () => {
  const single = [
    { index: 1, source_id: "source:book.txt:1", text: "abc def ghi jkl mno pqr stu vwx yz" },
    { index: 2, source_id: "source:book.txt:2", text: "123 456 789 012 345 678 901" },
  ];
  const { concentration, uniqueSources } = measureSourceConcentration(single);
  assert.equal(concentration, 1.0);
  assert.equal(uniqueSources, 1);
});

test("a table with all distinct sources has low concentration", () => {
  // DIVERSE_TABLE: source:frankenstein.txt:100 and :200 share the same base -> 4 unique sources
  const { concentration, uniqueSources } = measureSourceConcentration(DIVERSE_TABLE);
  assert.equal(uniqueSources, 4);
  assert.ok(concentration < 0.5, `expected low concentration, got ${concentration}`);
});

test("the full report labels concentration level", () => {
  const r = checkSourceDiversity("And so [1][2].", SAME_SOURCE_TABLE);
  assert.equal(r.concentrationLevel, "high");
  assert.equal(r.uniqueSources, 1);
  assert.equal(r.clean, false);
});

// ── Type diversity ───────────────────────────────────────────────────────────

test("all-corpus citations have zero type diversity", () => {
  const { typeCounts, diversityScore } = measureSourceTypeDiversity(SAME_SOURCE_TABLE);
  assert.ok(typeCounts.corpus > 0);
  assert.equal(Object.keys(typeCounts).length, 1);
  assert.equal(diversityScore, 0);
});

test("mixed corpus + web citations have positive type diversity", () => {
  const { typeCounts, diversityScore } = measureSourceTypeDiversity(DIVERSE_TABLE);
  assert.ok(typeCounts.corpus > 0);
  assert.ok(typeCounts.web > 0);
  assert.ok(diversityScore > 0, `expected positive diversity, got ${diversityScore}`);
});

// ── Content overlap detection ────────────────────────────────────────────────

test("two passages with substantially identical text are flagged as overlapping", () => {
  const pairs = detectContentOverlap(OVERLAP_TABLE);
  // [1] and [3] are 100% identical; [2] has extra text bringing Jaccard to ~0.72
  // which is below the 0.80 threshold. Only 1 pair at >= 0.80.
  assert.ok(pairs.length >= 1, `expected at least 1 overlap pair, got ${pairs.length}`);
  const pair13 = pairs.find((p) => p.aIndex === 1 && p.bIndex === 3);
  assert.ok(pair13, "expected [1] and [3] to be flagged as overlapping");
  assert.ok(pair13.similarity >= 0.80, `expected >= 0.80 similarity, got ${pair13.similarity}`);
});

test("genuinely different passages do not produce false overlap flags", () => {
  const pairs = detectContentOverlap(DIVERSE_TABLE);
  assert.equal(pairs.length, 0, `expected 0 overlaps, got ${JSON.stringify(pairs)}`);
});

test("passages from the same source are not flagged as overlap (expected)", () => {
  const pairs = detectContentOverlap(SAME_SOURCE_TABLE);
  assert.equal(pairs.length, 0, "same-source passages should not be overlap-flagged (they share a source_id)");
});

// ── Pseudo-diverse citations ────────────────────────────────────────────────

test("THE CORE CASE: a sentence citing multiple brackets from the same source is pseudo-diverse", () => {
  const { pseudoDiverse } = detectPseudoDiverseGroups(
    "The narrator describes his heritage [1], his emotional state [2], and his enthusiasm [3].",
    SAME_SOURCE_TABLE,
  );
  assert.equal(pseudoDiverse.length, 1);
  assert.deepEqual(pseudoDiverse[0].citedNums, [1, 2, 3]);
  assert.equal(pseudoDiverse[0].uniqueSources, 1);
  assert.equal(pseudoDiverse[0].totalSources, 3);
});

test("a sentence citing genuinely different sources is NOT flagged", () => {
  const { pseudoDiverse } = detectPseudoDiverseGroups(
    "Geneva is distinguished [1], the narrator ate chicken [2], and the city is populous [3].",
    DIVERSE_TABLE,
  );
  const multi = pseudoDiverse.filter((pd) => pd.totalSources >= 2);
  assert.equal(multi.length, 0,
    `unexpected pseudoDiverse findings: ${JSON.stringify(pseudoDiverse)}`);
});

test("THE CORE CASE: overlapping near-identical web sources are caught by content overlap, even with different URLs", () => {
  // Each URL is a different domain, so sourceBase differs — pseudo-diverse won't catch it.
  // But content_overlap WILL, because the passage text is nearly identical across URLs.
  const r = checkSourceDiversity(
    "The Federal Reserve kept rates unchanged, multiple outlets report [1,2,3].",
    OVERLAP_TABLE,
  );
  assert.ok(r.overlapPairs.length >= 1, `expected at least 1 content overlap pair, got ${r.overlapPairs.length}`);
  assert.equal(r.clean, false);
});

// ── Corroboration claims ─────────────────────────────────────────────────────

test("corroboration language with genuinely diverse sources PASSES", () => {
  const claims = checkCorroborationClaims(
    "Both sources confirm Geneva is a Swiss city [1][3].",
    DIVERSE_TABLE,
  );
  assert.ok(claims.length > 0, "expected to detect corroboration language");
  const multiSource = claims.find((c) => c.citedNums.includes(1) || c.citedNums.includes(3));
  assert.ok(multiSource, `no claim found for [1][3]: ${JSON.stringify(claims)}`);
  assert.equal(multiSource.passesCorroboration, true, `expected pass, got issue: ${multiSource.issue}`);
});

test("corroboration language with only one source FAILS", () => {
  const claims = checkCorroborationClaims(
    "Both sources agree the narrator is Genevese [1][2].",
    SAME_SOURCE_TABLE,
  );
  assert.ok(claims.length > 0);
  const claim = claims[0];
  assert.equal(claim.passesCorroboration, false);
  assert.match(claim.issue || "", /only one source/);
});

test("corroboration language with near-identical web sources FAILS", () => {
  const claims = checkCorroborationClaims(
    "Multiple independent sources confirmed the Fed's decision [1,2,3].",
    OVERLAP_TABLE,
  );
  // Each URL normalizes to a different base, so there are 3 unique source bases.
  // But the overlap between [1]-[2] and [2]-[3] is ~0.72 which is >= 0.60 threshold.
  assert.ok(claims.length > 0, `expected claims, got ${claims.length}`);
  const claim = claims[0];
  assert.equal(claim.passesCorroboration, false);
  assert.ok(claim.highestOverlap >= 0.60,
    `expected high overlap, got ${claim.highestOverlap}`);
});

test("a sentence using corroboration language with two genuinely different sources passes", () => {
  // [1] is Frankenstein, [2] is Dracula — legitimately different sources
  const claims = checkCorroborationClaims(
    "Both sources describe a narrator encountering a new place [1][2].",
    DIVERSE_TABLE,
  );
  assert.ok(claims.length > 0);
  const claim = claims[0];
  assert.equal(claim.uniqueSourceIds, 2);
  assert.equal(claim.passesCorroboration, true,
    `expected pass, got: ${claim.issue}`);
});

// ── The full report ──────────────────────────────────────────────────────────

test("a clean diverse answer reports clean = true", () => {
  const r = checkSourceDiversity(
    'Geneva is described as distinguished [1]. The narrator ate chicken with red pepper [2].',
    DIVERSE_TABLE,
  );
  assert.equal(r.clean, true, `expected clean, got: ${JSON.stringify({ clean: r.clean, issues: { overlapPairs: r.overlapPairs.length, pseudoDiverse: r.pseudoDiverse.length, uncorroborated: r.corroborationClaims.filter((c) => !c.passesCorroboration).length } })}`);
});

test("a single-source answer reports clean = false", () => {
  const r = checkSourceDiversity(
    "The narrator is Genevese [1]. The night was dreary [2].",
    SAME_SOURCE_TABLE,
  );
  assert.equal(r.clean, false);
  assert.equal(r.uniqueSources, 1);
});

test("an answer with overlapping web citations reports clean = false", () => {
  const r = checkSourceDiversity(
    "The Fed kept rates at 5.25% to 5.5%, as widely reported [1][2][3].",
    OVERLAP_TABLE,
  );
  assert.equal(r.clean, false);
  assert.ok(r.overlapPairs.length > 0);
});

test("a clean report still says what it examined", () => {
  const r = checkSourceDiversity("Geneva is Swiss [1][3].", DIVERSE_TABLE);
  assert.equal(r.totalCitations, 5);
  // 4 unique base sources (frankenstein appears twice)
  assert.equal(r.totalSources, 4);
  assert.ok(r.sourceTypeCounts.corpus > 0);
  assert.ok(r.sourceTypeCounts.web > 0);
});

// ── Void annotation ──────────────────────────────────────────────────────────

test("a pseudo-diverse finding is marked in the answer, additively", () => {
  const text = "The narrator reveals his background [1], feelings [2], and drive [3].";
  const r = checkSourceDiversity(text, SAME_SOURCE_TABLE);
  const marked = annotateDiversityVoids(text, r);
  assert.match(marked, /pseudo-diverse/);
  // The original text is preserved
  assert.ok(marked.startsWith(text));
});

test("an uncorroborated corroboration claim is marked", () => {
  const text = "Both sources independently confirm the narrator is from Geneva [1][2].";
  const r = checkSourceDiversity(text, SAME_SOURCE_TABLE);
  const marked = annotateDiversityVoids(text, r);
  assert.match(marked, /uncorroborated/);
});

test("a clean answer is returned byte-identical", () => {
  const text = "Geneva is in Switzerland [1]. The narrator ate chicken [2].";
  const r = checkSourceDiversity(text, DIVERSE_TABLE);
  assert.equal(annotateDiversityVoids(text, r), text);
});

// ── Typed gaps ───────────────────────────────────────────────────────────────

test("a single-source answer produces a single_source gap", () => {
  const r = checkSourceDiversity("The narrator is Genevese [1]. November was dreary [2].", SAME_SOURCE_TABLE);
  const gaps = diversityGaps(r);
  assert.ok(gaps.some((g) => g.type === "single_source"),
    `expected single_source gap, got: ${JSON.stringify(gaps.map(g => g.type))}`);
});

test("overlap pairs produce content_overlap gaps", () => {
  const r = checkSourceDiversity("Rates unchanged [1][2][3].", OVERLAP_TABLE);
  const gaps = diversityGaps(r);
  assert.ok(gaps.some((g) => g.type === "content_overlap"),
    `expected content_overlap gap, got: ${JSON.stringify(gaps.map(g => g.type))}`);
});

test("pseudo-diverse findings produce pseudo_diverse gaps", () => {
  const r = checkSourceDiversity(
    "The narrator reveals background [1], feelings [2], and ambition [3].",
    SAME_SOURCE_TABLE,
  );
  const gaps = diversityGaps(r);
  assert.ok(gaps.some((g) => g.type === "pseudo_diverse"),
    `expected pseudo_diverse gap, got: ${JSON.stringify(gaps.map(g => g.type))}`);
});

test("uncorroborated claims produce uncorroborated_claim gaps", () => {
  const r = checkSourceDiversity(
    "Both sources independently confirm the finding [1][2].",
    SAME_SOURCE_TABLE,
  );
  const gaps = diversityGaps(r);
  assert.ok(gaps.some((g) => g.type === "uncorroborated_claim"),
    `expected uncorroborated_claim gap, got: ${JSON.stringify(gaps.map(g => g.type))}`);
});

test("single source type produces single_source_type gap", () => {
  const allCorpus = DIVERSE_TABLE.filter((c) => typeof c.source_id === "string" && c.source_id.startsWith("source:"));
  const r = checkSourceDiversity("Genevese [1]. Dracula [2]. November [4].", allCorpus);
  const gaps = diversityGaps(r);
  assert.ok(gaps.some((g) => g.type === "single_source_type"),
    `expected single_source_type gap, got: ${JSON.stringify(gaps.map(g => g.type))}`);
});

test("a clean diverse report produces no gaps", () => {
  const r = checkSourceDiversity("Geneva is Swiss [1]. Chicken was eaten [2].", DIVERSE_TABLE);
  assert.deepEqual(diversityGaps(r), []);
});

// ── Source concentration sub-case ────────────────────────────────────────────

test("a table where 75%+ of citations come from one source but others exist produces a concentration gap", () => {
  // 3 from Frankenstein, 1 from Dracula, 1 from Wikipedia
  const table = [
    DIVERSE_TABLE[0], // frankenstein:100
    DIVERSE_TABLE[3], // frankenstein:200
    { index: 3, source_id: "source:frankenstein.txt:300", span_id: "s3", text: "Life and death appeared to me ideal bounds, which I should first break through." },
    DIVERSE_TABLE[1], // dracula:50
    DIVERSE_TABLE[2], // wikipedia geneva
  ];
  const r = checkSourceDiversity("Points made [1][2][3][4][5].", table);
  const gaps = diversityGaps(r);
  assert.ok(gaps.some((g) => g.type === "source_concentration" || g.type === "pseudo_diverse"),
    `expected source_concentration or pseudo_diverse gap, got: ${JSON.stringify(gaps.map(g => g.type))}`);
});

// ── Edge cases and robustness ────────────────────────────────────────────────

test("an empty citation table triggers no diversity findings", () => {
  const r = checkSourceDiversity("A perfectly fluent ungrounded claim.", []);
  assert.equal(r.totalCitations, 0);
  assert.equal(r.totalSources, 0);
  assert.equal(r.clean, true);
  assert.equal(r.concentration, 0);
  assert.deepEqual(diversityGaps(r), []);
});

test("a single citation table is clean but single source", () => {
  const r = checkSourceDiversity(
    "The narrator is Genevese [1].",
    [{ index: 1, source_id: "source:frankenstein.txt:100", text: "I am by birth a Genevese" }],
  );
  assert.equal(r.uniqueSources, 1);
  assert.equal(r.clean, true, "single-citation answers with no diversity claims are clean");
});

test("hostile and degenerate inputs survive without throwing", () => {
  const hostile = [
    [null, null],
    [undefined, undefined],
    ["", []],
    ["[".repeat(5000), DIVERSE_TABLE],
    ["[1]".repeat(5000), DIVERSE_TABLE],
    ["Both sources agree " + "x ".repeat(500) + "[1][2].", SAME_SOURCE_TABLE],
    ["", [{ index: 1 }, { index: 2, text: null }, { text: "no index" }]],
    ["Multiple independent sources confirm everything." + "[1,2,3,4,5]".repeat(200), DIVERSE_TABLE],
  ];
  for (const [text, citations] of hostile) {
    assert.doesNotThrow(() => {
      const r = checkSourceDiversity(text, citations || []);
      annotateDiversityVoids(text || "", r);
      diversityGaps(r);
    }, `threw on ${JSON.stringify(String(text || "").slice(0, 60))}`);
  }
});

test("citations with missing source_ids are treated as distinct unknowns", () => {
  const table = [
    { index: 1, text: "First passage of text about nothing in particular." },
    { index: 2, text: "Second passage of text about nothing in particular." },
    { index: 3, text: "Third passage of text about nothing in particular." },
  ];
  const r = checkSourceDiversity("One [1], two [2], three [3].", table);
  // Each gets a synthetic source base from its index (unknown:1, unknown:2, unknown:3)
  assert.equal(r.uniqueSources, 3);
  assert.equal(r.concentrationLevel, "low");
});

// ── The checker integrates with existing bracket parsing ─────────────────────

test("complex bracket forms ([1,2], [2-4], [1;3]) are correctly resolved in diversity checks", () => {
  const r = checkSourceDiversity(
    "Geneva appears [1,2] and the night was dreary [4]. Also Frankfurt [3;5].",
    DIVERSE_TABLE,
  );
  // [1,2] spans two base sources (frankenstein + dracula); [4] is also frankenstein.
  // That sentence cites 3 brackets from 2 unique base sources — pseudo-diverse is expected.
  // The check IS correct to flag it.
  assert.ok(r.pseudoDiverse.length > 0,
    "citing 3 brackets from 2 source bases is pseudo-diverse");
});

// ── Full integration: corroboration language across genuinely diverse sources passes all checks ──

test("FULL INTEGRATION: answer with diverse sources and explicit corroboration language", () => {
  const citations = [
    { index: 1, source_id: "source:economics-report.txt:10", text: "The quarterly GDP growth was revised upward to 3.2%, exceeding analyst expectations of 2.8%." },
    { index: 2, source_id: "https://reuters.com/economy/gdp-q4", title: "Reuters", url: "https://reuters.com/economy/gdp-q4", text: "U.S. GDP growth for the fourth quarter reached 3.2% according to the Bureau of Economic Analysis, surpassing the consensus estimate of 2.8%." },
    { index: 3, source_id: "source:fed-minutes.txt:50", text: "The Federal Open Market Committee noted that economic activity expanded at a solid pace, with GDP increasing at an annual rate above 3%." },
  ];

  const answer =
    "GDP growth for the quarter reached 3.2%, which was above the forecast of 2.8% [1][2]. " +
    "The Federal Reserve's minutes also noted expansion above 3% [3].";

  const r = checkSourceDiversity(answer, citations);

  // Three genuinely different sources, different types
  assert.equal(r.uniqueSources, 3);
  assert.equal(r.uniqueSourceTypes, 2); // corpus + web
  assert.equal(r.overlapPairs.length, 0, "no content overlap expected");
  assert.equal(r.pseudoDiverse.length, 0, "no pseudo-diverse groups expected");

  assert.equal(r.clean, true);
  assert.deepEqual(diversityGaps(r), []);
});

// ── FULL INTEGRATION: near-identical rehosted content masquerading as corroboration ──

test("FULL INTEGRATION: syndicated content across multiple URLs is caught", () => {
  // Press release syndicated to three "different" news sites
  const citations = [
    {
      index: 1, source_id: "https://news-outlet-a.com/story/123",
      title: "Outlet A", url: "https://news-outlet-a.com/story/123",
      text: "Tesla announced record quarterly deliveries of 484,507 vehicles, beating analyst estimates of 473,000. The stock rose 6% in after-hours trading following the announcement.",
    },
    {
      index: 2, source_id: "https://news-outlet-b.com/business/456",
      title: "Outlet B", url: "https://news-outlet-b.com/business/456",
      text: "Tesla announced record quarterly deliveries of 484,507 vehicles, beating analyst estimates of 473,000. The stock rose 6% in after-hours trading. CEO Elon Musk called it a landmark achievement.",
    },
    {
      index: 3, source_id: "https://news-outlet-c.com/markets/789",
      title: "Outlet C", url: "https://news-outlet-c.com/markets/789",
      text: "Tesla announced record quarterly deliveries of 484,507 vehicles, beating analyst estimates of 473,000. The stock rose 6% in after-hours trading following the announcement.",
    },
  ];

  const answer =
    "Tesla delivered 484,507 vehicles in the quarter, exceeding estimates of 473,000. " +
    "Multiple independent sources confirmed this record figure [1,2,3]. " +
    "The stock rose 6% in after-hours trading according to all reports [1,2,3].";

  const r = checkSourceDiversity(answer, citations);

  // Overlap should be detected between [1] and [3] which are identical text
  assert.ok(r.overlapPairs.length >= 1, `expected at least 1 overlap pair, got ${r.overlapPairs.length}`);

  // Pseudo-diverse: each URL has a different domain, so sourceBase differs.
  // These three citations come from 3 legitimately different source bases,
  // so pseudoDiverse won't flag them. The issue is caught via content_overlap +
  // corroboration checks instead.
  const corroboration = r.corroborationClaims.filter((c) => !c.passesCorroboration);
  assert.ok(corroboration.length > 0 || r.overlapPairs.length > 0,
    `expected uncorroborated claims or content overlap, got: corroboration passes=${r.corroborationClaims.map(c => c.passesCorroboration)}, overlap pairs=${r.overlapPairs.length}`);

  assert.equal(r.clean, false);

  // Gaps should cover the failure modes that apply
  const gaps = diversityGaps(r);
  const gapTypes = gaps.map((g) => g.type);
  // content_overlap: [1] and [3] are identical text from different domains
  // single_source_type: all citations are web
  // uncorroborated_claim: corroboration language with overlapping text
  assert.ok(gapTypes.includes("content_overlap"), `expected content_overlap in ${JSON.stringify(gapTypes)}`);
  assert.ok(gapTypes.includes("single_source_type"), `expected single_source_type in ${JSON.stringify(gapTypes)}`);
});

// ── Upload source type ───────────────────────────────────────────────────────

test("upload sources are classified and mixed with other types", () => {
  const citations = [
    { index: 1, source_id: "source:frankenstein.txt:100", text: "I am by birth a Genevese." },
    { index: 2, source_id: "upload:reader-notes.pdf:10", text: "The reader's analysis suggests Geneva's republican tradition shaped the narrator's identity." },
    { index: 3, source_id: "https://wikipedia.org", title: "Wikipedia", text: "Geneva is a city in Switzerland." },
  ];
  const r = checkSourceDiversity("Analysis [1][2][3].", citations);
  assert.equal(r.uniqueSourceTypes, 3);
  assert.equal(r.sourceTypeCounts.corpus, 1);
  assert.equal(r.sourceTypeCounts.web, 1);
  assert.equal(r.sourceTypeCounts.upload, 1);
  assert.equal(r.typeDiversityScore, 0.75); // 3 out of 4 known types
});
