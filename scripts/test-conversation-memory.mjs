#!/usr/bin/env node
// Tests for the per-conversation working memory (conversation-memory.js).
//
// The properties that matter are the ones the desk exists for, asserted
// directly:
//
//   - verbatim: a stated fact survives into the memory message quoted exactly;
//   - survivability: a fact stays in the desk long after it left the sliding
//     history window (the needle-in-haystack failure this module fixes);
//   - acknowledgment: a "Noted." reply confirms the fact and raises its weight
//     above an unconfirmed restatement;
//   - bounded: the rendered message never exceeds its budget, no matter how
//     many turns elapse;
//   - decay: idle turns fade a hot trace instead of deleting it, and the trace
//     still ranks by weight;
//   - denial review: an answer that denies a recorded fact is flagged (the
//     "I was never given the code" shape), and an honest unrelated denial is
//     not.

import assert from "node:assert";

import {
  applyTurn, buildMemoryMessage, checkRecallDenial, contentTerms,
  emptyMemory, extractStatedFacts, isAcknowledgment, isDenialSentence, normalizeFactText,
  sameFact, updateHotTerms, updateStatedFacts,
  FACT_CHAR_BUDGET, FACTS_MAX,
} from "../server/conversation-memory.js";
import { countTokens } from "../server/instruction-gate.js";

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

// ── contentTerms ─────────────────────────────────────────────────────────────

test("codes survive tokenization whole", () => {
  const terms = contentTerms("the vault access code is X9-Falcon-42");
  assert.ok(terms.includes("x9-falcon-42"), `code term missing: ${terms}`);
  assert.ok(terms.includes("vault") && terms.includes("access") && terms.includes("code"));
});

test("stopwords are not content terms", () => {
  const terms = contentTerms("the and of is in it this");
  assert.deepEqual(terms, []);
});

// ── Stated facts ─────────────────────────────────────────────────────────────

test("stated facts are extracted verbatim", () => {
  const facts = extractStatedFacts(
    "The vault access code is 'X9-Falcon-42'. What about the weather today?",
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0], "The vault access code is 'X9-Falcon-42'.");
});

test("a denial sentence is not stored as a fact", () => {
  const facts = extractStatedFacts("I was never given any access code in this conversation.");
  assert.deepEqual(facts, []);
});

test("normalize strips case, punctuation and quotes", () => {
  assert.equal(
    normalizeFactText("  THE vault access code is 'X9-Falcon-42'.  "),
    "the vault access code is x9-falcon-42",
  );
});

test("sameFact merges a restatement with extra detail", () => {
  assert.ok(sameFact(
    "the vault access code is 'x9-falcon-42'",
    "the vault access code is 'x9-falcon-42' which changes monthly",
  ));
  assert.ok(!sameFact(
    "the vault access code is 'x9-falcon-42'",
    "the backup access code is 'x9-falcon-24'",
  ));
});

test("a fact survives long past the history window", () => {
  let memory = emptyMemory();
  memory = applyTurn(memory, 0, {
    userText: "The vault access code is 'X9-Falcon-42'.",
    assistantText: "Noted.",
    confirmed: true,
  });
  for (let t = 1; t <= 40; t++) {
    memory = applyTurn(memory, t, {
      userText: `Distractor message number ${t} about the orchard harvest and the harbour ledger.`,
      assistantText: "I will keep that in mind.",
    });
  }
  const msg = buildMemoryMessage(memory);
  assert.ok(msg.includes("X9-Falcon-42"), "code missing after 40 turns");
  assert.ok(msg.includes("acknowledged"), "acknowledgment marker lost");
});

test("acknowledgment confirms a fact and outranks an unconfirmed one", () => {
  let memory = emptyMemory();
  memory = applyTurn(memory, 0, { userText: "My dog is named Biscuit." });
  memory = applyTurn(memory, 1, {
    userText: "The vault access code is 'X9-Falcon-42'.",
    assistantText: "Noted.",
    confirmed: true,
  });
  const sorted = [...memory.facts].sort((a, b) => b.weight - a.weight);
  assert.equal(sorted[0].text, "The vault access code is 'X9-Falcon-42'.");
  assert.equal(sorted[0].confirmed, true);
  assert.equal(sorted[1].confirmed, false);
});

test("an assistant restating a fact confirms it even without 'noted'", () => {
  let memory = emptyMemory();
  memory = applyTurn(memory, 0, { userText: "The code is 'X9-Falcon-42'." });
  memory = applyTurn(memory, 1, {
    userText: "What is the code?",
    assistantText: "The code is 'X9-Falcon-42'.",
  });
  const code = memory.facts.find((f) => f.text.includes("X9-Falcon-42"));
  assert.ok(code && code.confirmed, "restated fact not confirmed");
});

// ── Boundedness ──────────────────────────────────────────────────────────────

test("the memory message stays within budget under many facts", () => {
  let memory = emptyMemory();
  for (let t = 0; t < 30; t++) {
    memory = applyTurn(memory, t, {
      userText: `Statement ${t}: the notebook on shelf ${t} records a total of ${t + 7} invoices from the autumn quarter.`,
      assistantText: "Understood.",
      confirmed: true,
    });
  }
  const msg = buildMemoryMessage(memory);
  assert.ok(memory.facts.length <= FACTS_MAX, `fact count ${memory.facts.length} > ${FACTS_MAX}`);
  const chars = msg.length;
  assert.ok(chars <= FACT_CHAR_BUDGET + 512,
    `message ${chars} chars exceeds budget plus header slack`);
});

test("older stated facts are evicted under pressure, keeping a stable size", () => {
  let memory = emptyMemory();
  for (let t = 0; t < 60; t++) {
    memory = applyTurn(memory, t, {
      userText: `Statement ${t}: row ${t * 3} of the tide ledger shows a depth of ${(t % 9) + 1} fathoms on the last day of the quarter.`,
      assistantText: "Got it.",
      confirmed: true,
    });
  }
  assert.ok(memory.facts.length <= FACTS_MAX);
  assert.ok(memory.facts.length >= 1);
});

// ── Hot trace ────────────────────────────────────────────────────────────────

test("hot terms decay over idle turns but persist above the floor", () => {
  const hot = updateHotTerms([], { userText: "breakwater construction", turn: 0 });
  assert.equal(hot[0].weight, 1);
  const later = updateHotTerms(hot, { userText: "orchard harvest", turn: 5 });
  assert.ok(later.find((t) => t.term === "breakwater"), "old trace vanished");
  assert.ok(later.find((t) => t.term === "breakwater").weight < 1, "old trace did not decay");
  assert.ok(later[0].term === "orchard" || later[0].term === "harvest", "recent subject should rank first");
});

test("echoing a user term back reinforces it", () => {
  let hot = updateHotTerms([], { userText: "vault access", turn: 0 });
  hot = updateHotTerms(hot, { userText: "what is the vault access code?", assistantText: "The vault access code is X9-Falcon-42.", turn: 1 });
  const vault = hot.find((t) => t.term === "vault");
  assert.ok(vault && vault.weight > 1, "echo did not reinforce vault");
});

// ── Recall-denial review ─────────────────────────────────────────────────────

test("denying a recorded code is flagged", () => {
  const result = checkRecallDenial({
    question: "What is the vault access code?",
    answer: "I was never given any vault access code in this conversation.",
    facts: [{ text: "The vault access code is 'X9-Falcon-42'.", confirmed: true }],
  });
  assert.equal(result.verdict, "FLAGGED");
  assert.equal(result.flags[0].type, "false_denial");
  assert.ok(result.flags[0].fact.includes("X9-Falcon-42"));
});

test("a correct citation is not mistaken for a denial just because it also uses 'not' elsewhere", () => {
  // Found empirically against two independent real model answers: a
  // sentence that correctly cites a recorded fact using one of the
  // DENIAL_SUBJECT words ("stated", "mentioned", "provided") is not a
  // denial just because an unrelated negation appears later in the same
  // sentence for a different reason ("...so it's not overdue").
  assert.ok(!isDenialSentence(
    "You stated that the last full cleaning and sanitizing cycle was Sunday night, so it's not overdue on that front.",
  ));
  assert.ok(!isDenialSentence(
    "This is an important piece of information for troubleshooting, but it's not typically what you'd expect from a normal operating condition.",
  ));
  // A real denial keeps the negation and the record-word close together —
  // must still be caught.
  assert.ok(isDenialSentence("That information was never provided in this conversation."));
});

test("an unrelated denial is not flagged", () => {
  const result = checkRecallDenial({
    question: "What is the vault access code?",
    answer: "I have no information about the weather in Lisbon today.",
    facts: [{ text: "The vault access code is 'X9-Falcon-42'.", confirmed: true }],
  });
  assert.equal(result.verdict, "PASS");
});

test("a denial with no record in the desk passes", () => {
  const result = checkRecallDenial({
    question: "What is the vault access code?",
    answer: "I was never given any vault access code in this conversation.",
    facts: [],
  });
  assert.equal(result.verdict, "PASS");
});

test("isAcknowledgment recognises the shapes that mean 'noted'", () => {
  assert.ok(isAcknowledgment("Noted."));
  assert.ok(isAcknowledgment("Got it, I will keep that in mind."));
  assert.ok(isAcknowledgment("OK"));
  assert.ok(!isAcknowledgment("The vault access code is X9-Falcon-42."));
  assert.ok(!isAcknowledgment(""));
});

// ── Render shape ─────────────────────────────────────────────────────────────

test("the memory message names acknowledged and stated facts distinctly", () => {
  let memory = emptyMemory();
  memory = applyTurn(memory, 0, { userText: "My dog is named Biscuit and answers to a whistle." });
  memory = applyTurn(memory, 1, {
    userText: "The vault access code is 'X9-Falcon-42'.",
    assistantText: "Noted.",
    confirmed: true,
  });
  const msg = buildMemoryMessage(memory);
  assert.ok(msg.includes("CONVERSATION WORKING MEMORY"));
  assert.ok(msg.includes("[acknowledged]"));
  assert.ok(msg.includes("[stated]"));
  assert.ok(msg.includes("X9-Falcon-42"));
});

test("an empty desk renders to null", () => {
  assert.equal(buildMemoryMessage(emptyMemory()), null);
});

// Token budget sanity: the whole block must be tiny enough to inject on every
// turn. Measured, because the budget is the point.
const sample = buildMemoryMessage({
  hot: [{ term: "vault", weight: 2 }, { term: "access", weight: 1.5 }],
  facts: [
    { text: "The vault access code is 'X9-Falcon-42'.", confirmed: true },
    { text: "My dog is named Biscuit and answers to a whistle.", confirmed: false },
  ],
});
console.log(`\n  desk render: ${countTokens(sample)} tokens / ${sample.length} chars`);

if (process.exitCode) console.error(`\n${passed} passed, with failures`);
else console.log(`\n${passed} tests passed`);
