import test from "node:test";
import assert from "node:assert/strict";
import { runDeliberateAnswer, DELIBERATE_FOLD_IDS } from "./longform-orchestrator.js";

// One source, one section — keeps the outline step trivial so each test can
// focus on the draft/verify/revise/assemble behavior instead of grouping.
const CITATIONS = [{
  span_id: "a", source_id: "source:tide-recorder.md", byte_start: 0, byte_end: 400, score: 0.9,
  text: "The Halvorsen Type-7 Tide Recorder was designed by Kristoffer Halvorsen and " +
    "first built in his Bergen workshop in 1887. Nine units were installed in Norwegian " +
    "harbors, including Bergen, Ålesund, and Tromsø.",
}];

test("DELIBERATE_FOLD_IDS names the instruction-gate fold both backends key on", () => {
  assert.ok(DELIBERATE_FOLD_IDS.has("longform-essay"));
});

test("web research fires when local evidence is thin, and its results get used", async () => {
  let webSearchCalled = false;
  const webSearch = async (q) => {
    webSearchCalled = true;
    return [{ source_id: "https://example.com/halvorsen", text: "Kristoffer Halvorsen built the Type-7 in Bergen in 1887, per historical maritime records." }];
  };
  const events = [];
  const generate = async (system, user, maxTokens) => (maxTokens === 24)
    ? "Tide Recorder Overview"
    : "Halvorsen built the Type-7 in Bergen in 1887 [1].";

  // Zero LOCAL citations — web research is the only evidence available.
  const result = await runDeliberateAnswer({ question: "q", citations: [], generate, webSearch, onProgress: (e) => events.push(e) });

  assert.ok(webSearchCalled, "web research must fire when local evidence is thin (here, empty)");
  assert.ok(events.some((e) => e.phase === "web_research_started"));
  assert.ok(events.some((e) => e.phase === "web_research_done" && e.added === 1));
  assert.equal(result.sectionsKept, 1);
  assert.equal(result.citations[0].source_id, "https://example.com/halvorsen");
});

test("web research does NOT fire when local evidence is already enough", async () => {
  const plentyOfCitations = [1, 2, 3].map((i) => ({
    span_id: `s${i}`, source_id: `source:doc${i}.md`, byte_start: 0, byte_end: 100, score: 0.5,
    text: `Halvorsen fact number ${i} about the Type-7 built in Bergen in 1887.`,
  }));
  let webSearchCalled = false;
  const webSearch = async () => { webSearchCalled = true; return []; };
  const generate = async (system, user, maxTokens) => (maxTokens === 24) ? "Overview" : "Some grounded claim [1].";

  await runDeliberateAnswer({ question: "q", citations: plentyOfCitations, generate, webSearch });

  assert.equal(webSearchCalled, false, "evidence already above the thin-evidence threshold should not trigger web research");
});

test("a failing web research step degrades gracefully rather than crashing", async () => {
  const webSearch = async () => { throw new Error("network unreachable"); };
  const generate = async () => "unreachable";

  const result = await runDeliberateAnswer({ question: "q", citations: [], generate, webSearch });

  assert.equal(result.sectionsKept, 0);
  assert.match(result.text, /None of the retrieved material/);
});

test("a faithful, cited draft is kept", async () => {
  const generate = async (system, user, maxTokens) => (maxTokens === 24)
    ? "Tide Recorder Overview"
    : "Halvorsen built the Type-7 in Bergen in 1887 [1].";

  const result = await runDeliberateAnswer({ question: "q", citations: CITATIONS, generate });

  assert.equal(result.sectionsKept, 1);
  assert.equal(result.sectionsDropped, 0);
  assert.equal(result.gaps.length, 0);
  assert.match(result.text, /Bergen in 1887 \[1\]/);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].index, 1);
});

test("accurate but uncited content is retried, then dropped if it still cites nothing", async () => {
  // Every word matches the evidence (so fidelityResidual alone would pass
  // it) but no draft, including the retry, ever emits a bracket.
  let calls = 0;
  const generate = async (system, user, maxTokens) => {
    calls++;
    if (maxTokens === 24) return "Tide Recorder Overview";
    return "Halvorsen built the Type-7 in Bergen in 1887.";
  };

  const result = await runDeliberateAnswer({ question: "q", citations: CITATIONS, generate });

  assert.equal(calls, 3, "title + draft + one uncited-retry, no more");
  assert.equal(result.sectionsKept, 0);
  assert.equal(result.sectionsDropped, 1);
  assert.ok(result.gaps.some((g) => g.reason.includes("no citation")));
  assert.doesNotMatch(result.text, /Bergen in 1887/, "uncitable content must not ship even when accurate");
});

test("an uncited first draft that cites correctly on retry is kept", async () => {
  let calls = 0;
  const generate = async (system, user, maxTokens) => {
    calls++;
    if (maxTokens === 24) return "Tide Recorder Overview";
    return calls === 2 ? "Halvorsen built the Type-7 in Bergen in 1887." : "Halvorsen built the Type-7 in Bergen in 1887 [1].";
  };

  const result = await runDeliberateAnswer({ question: "q", citations: CITATIONS, generate });

  assert.equal(result.sectionsKept, 1);
  assert.match(result.text, /\[1\]/);
});

test("a fabrication is caught, revised, and the RECOVERED text is what ships", async () => {
  let calls = 0;
  const generate = async (system, user, maxTokens) => {
    calls++;
    if (maxTokens === 24) return "Tide Recorder Overview";
    // First draft fabricates a city never in the evidence; the revision call
    // (triggered by fidelityResidual scoring it a fabrication) is faithful.
    return calls === 2
      ? "The recorder was deployed in Stavanger, a city never mentioned in any passage."
      : "Halvorsen built the Type-7 in Bergen in 1887 [1].";
  };

  const result = await runDeliberateAnswer({ question: "q", citations: CITATIONS, generate });

  assert.equal(result.sectionsKept, 1, "the revised draft closes and ships");
  assert.equal(result.sectionsDropped, 0);
  assert.match(result.text, /Bergen in 1887/);
  assert.doesNotMatch(result.text, /Stavanger/, "the fabricated draft must not be what ships");
});

test("a fabrication that never recovers is dropped, not shown, and the gap is named", async () => {
  const generate = async (system, user, maxTokens) => (maxTokens === 24)
    ? "Tide Recorder Overview"
    : "The recorder was deployed in Stavanger and Oslo, cities never mentioned in any passage.";

  const result = await runDeliberateAnswer({ question: "q", citations: CITATIONS, generate });

  assert.equal(result.sectionsKept, 0);
  assert.equal(result.sectionsDropped, 1);
  assert.doesNotMatch(result.text, /Stavanger|Oslo/, "unsupported content must never reach the page");
  assert.ok(result.gaps.some((g) => g.type === "section_dropped"), "the drop is stated, not silent");
});

test("a generate() failure is treated as a dropped section, not a crash", async () => {
  const generate = async () => { throw new Error("model unreachable"); };

  const result = await runDeliberateAnswer({
    question: "q", citations: CITATIONS, generate, perCallTimeoutMs: 1000,
  });

  assert.equal(result.sectionsKept, 0);
  assert.ok(result.gaps.some((g) => g.type === "section_failed" && g.reason.includes("model unreachable")));
  assert.match(result.text, /None of the retrieved material/, "an honest fallback, never a blank or thrown error");
});

test("a hung generate() call times out instead of hanging the pipeline", async () => {
  const generate = () => new Promise(() => {}); // never resolves

  const result = await runDeliberateAnswer({
    question: "q", citations: CITATIONS, generate, perCallTimeoutMs: 50,
  });

  assert.equal(result.sectionsKept, 0);
  assert.ok(result.gaps.some((g) => g.type === "section_failed" && g.reason.includes("timed out")));
});

test("no evidence at all produces an honest empty result, not a crash", async () => {
  const generate = async () => "unreachable";
  const result = await runDeliberateAnswer({ question: "q", citations: [], generate });

  assert.equal(result.sectionsKept, 0);
  assert.equal(result.citations.length, 0);
  assert.match(result.text, /None of the retrieved material/);
});
