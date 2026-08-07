import test from "node:test";
import assert from "node:assert/strict";
import { defineAnswerSpec, parsePlannerReply, distillSubject, deriveSectionsFromQuestion, runHolonicEssay, evaluateUnit, reconcileUnit } from "./holonic-chat.js";

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

test("planner parses the DEFINE shape: form, units with instructions, and compliance", () => {
  const p = parsePlannerReply(
    '{"depth":"essay","form":"screenplay","reason":"asks for a script","units":[{"id":"The Harbor","instruction":"Open with a scene heading and introduce the tide recorder","topic":"bergen harbor 1887 tide recorder"}],"compliance":{"minWords":200,"require":["INT./EXT. scene headings","ALL-CAPS dialogue"],"forbid":[]}}'
  );
  assert.equal(p.depth, "essay");
  assert.equal(p.form, "screenplay");
  assert.equal(p.units.length, 1);
  assert.equal(p.units[0].id, "The Harbor");
  assert.match(p.units[0].instruction, /scene heading/i);
  assert.equal(p.compliance.minWords, 200);
  assert.equal(p.compliance.require.length, 2);
  // legacy view stays in sync
  assert.equal(p.sections[0].title, "The Harbor");
});

test("planner defaults form by depth when the reply omits it", () => {
  assert.equal(parsePlannerReply('{"depth":"essay","reason":"ok","sections":[]}').form, "prose");
  assert.equal(parsePlannerReply('{"depth":"riff","reason":"ok","sections":[]}').form, "reply");
});

test("planner tolerates code fences and noise around the JSON", () => {
  const p = parsePlannerReply("Sure!\n```json\n{\"depth\":\"riff\",\"reason\":\"a short ask\",\"sections\":[]}\n```\n");
  assert.equal(p.depth, "riff");
});

test("planner falls back to heuristic when the model reply is not JSON", () => {
  const p = parsePlannerReply("Let me write you a 5 page report about this.");
  assert.equal(p.depth, "essay");
});

test("planner tolerates prose wrapped around the JSON", () => {
  const p = parsePlannerReply(
    'I would be happy to help! Here is my plan: {"depth":"essay","reason":"explicit essay ask","sections":[{"title":"Evolution","topic":"dolphin evolution"},{"title":"Communication","topic":"dolphin communication"}]} Let me know if you want changes!'
  );
  assert.equal(p.depth, "essay");
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[1].title, "Communication");
});

test("planner survives a second JSON blob in the reply", () => {
  const p = parsePlannerReply('{"foo":"bar"} {"depth":"essay","reason":"ok","sections":[{"title":"A","topic":"a topic"}]}');
  assert.equal(p.depth, "essay");
  assert.equal(p.sections[0].title, "A");
});

test("planner parses a numbered list plan when the model skips JSON", () => {
  const p = parsePlannerReply(
    "Here are the sections:\n1. Dolphin Evolution - dolphin evolution\n2. Dolphin Communication: how dolphins communicate\n* Dolphin Intelligence — dolphin intelligence"
  );
  assert.equal(p.depth, "essay");
  assert.equal(p.sections.length, 3);
  assert.equal(p.sections[1].topic, "how dolphins communicate");
});

test("distillSubject pulls the searchable subject out of essay phrasing", () => {
  assert.equal(distillSubject("Write me a 5 page essay about dolphins, after researching online first."), "dolphins");
  assert.equal(distillSubject("Could you write a report on the history of the Roman Empire please?"), "history of the Roman Empire");
  assert.equal(distillSubject("Tell me about deep sea vents."), "deep sea vents");
  // Topical questions pass through intact.
  assert.equal(distillSubject("how do dolphins communicate?"), "how do dolphins communicate");
});

test("deriveSectionsFromQuestion yields a real multi-section plan with clean queries", () => {
  const sections = deriveSectionsFromQuestion("Write me a 5 page essay about dolphins, after researching online first.");
  assert.ok(sections.length >= 3);
  assert.ok(sections.length <= 6);
  assert.equal(sections[0].id, "Overview");
  assert.ok(sections.every((s) => s.id && s.topic && s.instruction));
  assert.match(sections[0].topic, /^dolphins overview$/);
  assert.ok(!sections.some((s) => /\bessay\b/.test(s.topic)), "no research topic may be an essay instruction");
});

test("planner salvages sections from a malformed JSON near-miss", () => {
  // The exact shape a small model (phi4-mini) actually emitted: a section
  // object closed one brace too early, leaving a stray `","` before the
  // array's closing.
  const p = parsePlannerReply(
    '{\n"depth":"essay",\n"reason":"The reader requested an extended piece with multiple sections covering various aspects of the topic.",\n"sections":[{"title":"Introduction to Dolphins","topic":"General characteristics and classification of dolphins"},{"title":"Habitat and Distribution","topic":"Geographical range, preferred habitats, migration patterns"}, {"title":"Behavior and Social Structure","topic":"Social behaviors, pod formations, communication methods"},"}\n}'
  );
  assert.equal(p.depth, "essay");
  assert.equal(p.sections.length, 3);
  assert.equal(p.sections[1].title, "Habitat and Distribution");
  assert.match(p.reason, /salvaged/i);
});

test("planChatTurn derives sections when an essay-depth reply has none", async () => {
  const generate = async () => '{"depth":"essay","reason":"wants an essay","sections":[]}';
  const plan = await defineAnswerSpec({
    question: "Write a 5 page essay about quantum computing",
    history: [], localEvidence: {}, webEnabled: true, generate,
  });
  assert.equal(plan.depth, "essay");
  assert.ok(plan.sections.length >= 3);
  assert.ok(plan.sections.some((s) => s.topic.includes("quantum")));
});

test("planChatTurn passes local-evidence and web state into the planner", async () => {
  let sawPrompt = null;
  const generate = async (system, user) => { sawPrompt = user; return '{"depth":"riff","reason":"simple","sections":[]}'; };
  await defineAnswerSpec({ question: "hi", history: [], localEvidence: { count: 3 }, webEnabled: true, generate });
  assert.match(sawPrompt, /3 passage\(s\)/);
  assert.match(sawPrompt, /Web research enabled: yes/);
});

test("essay: per-section research writes with a folded window and mechanical citations", async () => {
  const events = [];
  const generate = async (system, user) => {
    // The writer sees ONLY the section material — never planner output.
    assert.match(user, /MATERIAL:/);
    return "Halvorsen built the Type-7 Tide Recorder in his Bergen workshop in 1887, first designed by Kristoffer Halvorsen.";
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
