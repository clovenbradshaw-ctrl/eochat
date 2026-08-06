import test from "node:test";
import assert from "node:assert/strict";
import { generateAnswer, SECTION_MAX_TOKENS } from "./turn-generation.js";

const MESSAGES = [{ role: "system", content: "you are a helpful assistant" }, { role: "user", content: "question" }];

function fakeCaller(responses) {
  let call = 0;
  const calls = [];
  const fn = async (messages, opts) => {
    calls.push({ messages, opts });
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    opts.onDelta?.(r, r);
    return { text: r, model: "fake-model" };
  };
  fn.calls = calls;
  return fn;
}

test("single-source evidence collapses to one section, one call — no padding of a small answer", async () => {
  const callModelStreaming = fakeCaller(["a short factual answer."]);
  const evidence = [{ source_id: "doc-a", span_id: "s1", text: "some passage" }];

  const result = await generateAnswer({
    messages: MESSAGES, evidence, callModelStreaming, singleSectionMaxTokens: 8192,
  });

  assert.equal(result.sectionCount, 1);
  assert.equal(callModelStreaming.calls.length, 1);
  assert.equal(result.text, "a short factual answer.");
  // The single-section path calls with the ORIGINAL messages, unmodified —
  // no scoping/continuity system message is appended when nothing split.
  assert.deepEqual(callModelStreaming.calls[0].messages, MESSAGES);
  assert.equal(callModelStreaming.calls[0].opts.maxTokens, 8192);
});

test("no evidence at all also collapses to one section", async () => {
  const callModelStreaming = fakeCaller(["general knowledge answer."]);
  const result = await generateAnswer({ messages: MESSAGES, evidence: [], callModelStreaming, singleSectionMaxTokens: 8192 });

  assert.equal(result.sectionCount, 1);
  assert.equal(callModelStreaming.calls.length, 1);
});

test("evidence from multiple distinct sources earns more than one section", async () => {
  const callModelStreaming = fakeCaller(["part one.", "part two."]);
  const evidence = [
    { source_id: "doc-a", span_id: "s1", text: "passage from source A" },
    { source_id: "doc-b", span_id: "s2", text: "passage from source B" },
  ];

  const result = await generateAnswer({ messages: MESSAGES, evidence, callModelStreaming, maxSections: 4 });

  assert.equal(result.sectionCount, 2);
  assert.equal(result.text, "part one.\n\npart two.");
  // Each section call carries a scoping system message beyond the base messages.
  assert.ok(callModelStreaming.calls[0].messages.length > MESSAGES.length);
  assert.equal(callModelStreaming.calls[0].opts.maxTokens, SECTION_MAX_TOKENS);
});

test("a section whose fidelity residual exceeds tolerance triggers exactly one bounded revision", async () => {
  // First attempt fabricates a specific name absent from its cited evidence;
  // the retry stays within it.
  const callModelStreaming = fakeCaller([
    "part one mentions Rostov, who never appears anywhere.",
    "part one stays within the evidence.",
    "part two.",
  ]);
  const evidence = [
    { source_id: "doc-a", span_id: "s1", text: "Victor Frankenstein created the creature." },
    { source_id: "doc-b", span_id: "s2", text: "The creature confronted its maker." },
  ];

  const result = await generateAnswer({ messages: MESSAGES, evidence, callModelStreaming, maxSections: 4 });

  assert.equal(result.sectionCount, 2);
  // 2 calls for section 1 (fail + revision) + 1 call for section 2 = 3.
  assert.equal(callModelStreaming.calls.length, 3);
  assert.ok(result.text.includes("part one stays within the evidence."));
  assert.ok(!result.text.includes("Rostov"));
});

test("revision is bounded — never retried past MAX_SECTION_REVISIONS", async () => {
  // Every attempt fabricates, forcing the loop to exhaust its retries rather
  // than loop forever.
  const callModelStreaming = fakeCaller(["always mentions Rostov, always fabricated."]);
  const evidence = [
    { source_id: "doc-a", span_id: "s1", text: "Victor Frankenstein created the creature." },
    { source_id: "doc-b", span_id: "s2", text: "The creature confronted its maker." },
  ];

  const result = await generateAnswer({ messages: MESSAGES, evidence, callModelStreaming, maxSections: 4 });

  // 3 attempts per section (1 + MAX_SECTION_REVISIONS=2) x 2 sections = 6.
  assert.equal(callModelStreaming.calls.length, 6);
  assert.equal(result.sectionCount, 2);
});

test("assembled output preserves section order", async () => {
  const callModelStreaming = fakeCaller(["first.", "second.", "third."]);
  const evidence = [
    { source_id: "doc-a", span_id: "s1", text: "alpha" },
    { source_id: "doc-b", span_id: "s2", text: "beta" },
    { source_id: "doc-c", span_id: "s3", text: "gamma" },
  ];

  const result = await generateAnswer({ messages: MESSAGES, evidence, callModelStreaming, maxSections: 4 });

  assert.equal(result.text, "first.\n\nsecond.\n\nthird.");
});
