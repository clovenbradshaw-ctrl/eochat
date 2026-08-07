import test from "node:test";
import assert from "node:assert/strict";
import { planChatTurn, parsePlannerReply, runHolonicEssay } from "./holonic-chat.js";

const LOCAL_EVIDENCE = [{
  span_id: "tide", source_id: "source:tide-recorder.md",
  text: "The Halvorsen Type-7 Tide Recorder was designed by Kristoffer Halvorsen and first built in his Bergen workshop in 1887.",
}];

const WEB_TOPIC = {
  topic: "Halvorsen tide recorder",
  article: { title: "Tide recorder", url: "https://en.wikipedia.org/wiki/Tide_recorder", text: "Maritime tide recorders were built in Norway from the 1880s.", kind: "secondary" },
  primarySources: [{ title: "Norwegian Maritime Museum records", url: "https://marmuseum.example.org/halvorsen", text: "Kristoffer Halvorsen's workshop log shows the Type-7 delivered to Bergen harbor in 1887.", kind: "primary" }],
};

test("planner parses a clean essay reply", () => {
  const p = parsePlannerReply('{"depth":"essay","reason":"user asked for an essay","sections":[{"title":"History","topic":"halvorsen tide recorder history"},{"title":"Design","topic":"type-7 design"}]}');
  assert.equal(p.depth, "essay");
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[0].topic, "halvorsen tide recorder history");
});

test("planner tolerates code fences and noise around the JSON", () => {
  const p = parsePlannerReply("Sure!\n```json\n{\"depth\":\"riff\",\"reason\":\"a short ask\",\"sections\":[]}\n```\n");
  assert.equal(p.depth, "riff");
});

test("planner falls back to heuristic when the model reply is not JSON", () => {
  const p = parsePlannerReply("Let me write you a 5 page report about this.");
  assert.equal(p.depth, "essay");
});

test("planner salvages a genuine riff depth field even when the rest of the JSON is corrupted", () => {
  // Reproduces a small local model (llama3.2:1b) answering "hello there":
  // it got the depth field right, then broke the JSON by echoing the
  // prompt's own `"riff"|"essay"` type union literally into the reply —
  // which used to make the whole-text keyword heuristic see "essay" and
  // route a plain greeting into the multi-section essay pipeline.
  const p = parsePlannerReply('{"depth":"riff",""|"essay","sections":[{"title":"Unrelated","topic":"Unrelated"}]}');
  assert.equal(p.depth, "riff");
});

test("planChatTurn passes local-evidence and web state into the planner", async () => {
  let sawPrompt = null;
  const generate = async (system, user) => { sawPrompt = user; return '{"depth":"riff","reason":"simple","sections":[]}'; };
  await planChatTurn({ question: "hi", history: [], localEvidence: { count: 3 }, webEnabled: true, generate });
  assert.match(sawPrompt, /3 passage\(s\)/);
  assert.match(sawPrompt, /Web research enabled: yes/);
});

test("essay: per-section research writes with a folded window and mechanical citations", async () => {
  const events = [];
  const generate = async (system, user) => {
    // The writer sees ONLY the section material — never planner output.
    assert.match(user, /MATERIAL:/);
    return "Halvorsen built the Type-7 in his Bergen workshop in 1887, working from maritime records.";
  };
  const localRetrieve = async (topic) => {
    assert.equal(topic, "halvorsen tide recorder history");
    return LOCAL_EVIDENCE;
  };
  const webResearch = async () => [WEB_TOPIC];

  const result = await runHolonicEssay({
    question: "who built the tide recorder",
    sections: [{ title: "History", topic: "halvorsen tide recorder history" }],
    generate, localRetrieve, webResearch, webEnabled: true,
    onProgress: (e) => events.push(e),
  });

  assert.ok(result.text.startsWith("## History"));
  assert.match(result.text, /\[1\]/); // mechanically attached bracket
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].source_id, "source:tide-recorder.md");
  // Provenance includes the web hops even though only the local passage was cited.
  assert.ok(result.references.some((r) => r.url === "https://marmuseum.example.org/halvorsen"));
  assert.ok(events.some((e) => e.phase === "section_research"));
});

test("essay: web research fires only when local evidence is thin and the toggle is on", async () => {
  let webCalls = 0;
  const generate = async () => "Grounded prose about the tide recorder.";
  const richLocal = [1, 2, 3].map((i) => ({
    span_id: `s${i}`, source_id: `source:doc${i}.md`,
    text: `Halvorsen tide recorder fact number ${i}: the Type-7 was designed by Kristoffer Halvorsen and first built in his Bergen workshop in 1887, then installed in Norwegian harbors. `.repeat(4),
  }));
  const webResearch = async () => { webCalls++; return [WEB_TOPIC]; };

  // Rich local evidence + toggle on → no web call.
  await runHolonicEssay({
    question: "q", sections: [{ title: "History", topic: "halvorsen" }],
    generate, localRetrieve: async () => richLocal, webResearch, webEnabled: true,
  });
  assert.equal(webCalls, 0, "sufficient local evidence must not trigger web research");

  // Toggle off → no web call even when local is thin.
  await runHolonicEssay({
    question: "q", sections: [{ title: "History", topic: "nonexistent thing" }],
    generate, localRetrieve: async () => [], webResearch, webEnabled: false,
  });
  assert.equal(webCalls, 0, "the web toggle must be respected");

  // Thin local + toggle on → web call.
  await runHolonicEssay({
    question: "q", sections: [{ title: "History", topic: "nonexistent thing" }],
    generate, localRetrieve: async () => [], webResearch, webEnabled: true,
  });
  assert.equal(webCalls, 1, "thin local evidence with the toggle on must trigger web research");
});

test("essay: an ungrounded section is written but named as a gap", async () => {
  const generate = async () => "Some general prose written from memory.";
  const result = await runHolonicEssay({
    question: "q", sections: [{ title: "History", topic: "nothing at all" }],
    generate, localRetrieve: async () => [], webResearch: null, webEnabled: false,
  });

  assert.ok(result.text.includes("## History"));
  assert.equal(result.ungrounded.length, 1);
  assert.ok(result.gaps.some((g) => g.type === "ungrounded_section"));
  assert.equal(result.citations.length, 0);
});
