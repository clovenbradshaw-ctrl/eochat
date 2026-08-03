#!/usr/bin/env node
// Tests for the project-global file cabinet (project-memory.js).
//
// The properties that matter are the ones the cabinet exists for, asserted
// directly:
//
//   - entry by acknowledgment: only confirmed desk facts reach the cabinet;
//   - cross-conversation survival: a memo written in one conversation is
//     retrieved in another of the same project (the desk cannot do this — it
//     is per-conversation);
//   - cue-and-retrieve: a memo comes back because its terms matched, and the
//     matched terms are reported; unrelated questions retrieve nothing;
//   - usage strengthens: retrieving a memo raises its weight in the next
//     tie-break;
//   - bounded: the cabinet never exceeds its cap, and a retrieval respects its
//     budget.

import assert from "node:assert";

import {
  buildCabinetBlock, cabinetStats, emptyCabinet, markAccessed,
  mergeDeskFacts, retrieveCabinet, scoreMemo, upsertMemo,
  CABINET_MAX, CABINET_RETRIEVE_BUDGET,
} from "../server/project-memory.js";
import { applyTurn, emptyMemory } from "../server/conversation-memory.js";

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

const CODED_FACT = "The vault access code is 'X9-Falcon-42'.";
const DOG_FACT = "My dog is named Biscuit and answers to a whistle.";

// ── Entry by acknowledgment ──────────────────────────────────────────────────

test("only confirmed desk facts enter the cabinet", () => {
  let desk = emptyMemory();
  desk = applyTurn(desk, 0, { userText: CODED_FACT });
  desk = applyTurn(desk, 1, { userText: DOG_FACT, assistantText: "Noted.", confirmed: true });

  let cabinet = emptyCabinet();
  cabinet = mergeDeskFacts(cabinet, { facts: desk.facts, conversationId: "c-1", turn: 1 });

  const texts = cabinet.memos.map((m) => m.text);
  assert.ok(texts.includes(DOG_FACT), `confirmed fact missing: ${texts}`);
  assert.ok(!texts.includes(CODED_FACT), "unconfirmed fact should not enter the cabinet");
});

test("a restated fact confirms and therefore enters the cabinet", () => {
  let desk = emptyMemory();
  desk = applyTurn(desk, 0, { userText: CODED_FACT });
  desk = applyTurn(desk, 1, {
    userText: "What is the code?",
    assistantText: "The code is X9-Falcon-42.",
  });
  let cabinet = emptyCabinet();
  cabinet = mergeDeskFacts(cabinet, { facts: desk.facts, conversationId: "c-1", turn: 1 });
  assert.ok(cabinet.memos.some((m) => m.text.includes("X9-Falcon-42")));
});

// ── Cross-conversation survival ──────────────────────────────────────────────

test("a memo is retrieved in a later conversation of the same project", () => {
  let cabinet = emptyCabinet();
  cabinet = upsertMemo(cabinet, { text: CODED_FACT, conversationId: "c-1", turn: 0 });

  // A different conversation, many turns later, asks about the code.
  const { memos } = retrieveCabinet(cabinet, {
    question: "What is the vault access code?",
    cue: "",
  });
  assert.ok(memos.some((m) => m.text.includes("X9-Falcon-42")), "code not retrieved across conversations");
});

// ── Cue-and-retrieve ─────────────────────────────────────────────────────────

test("scoring reports the terms that matched", () => {
  const memo = { keys: ["vault", "access", "code", "x9-falcon-42"], text: CODED_FACT };
  const { score, shared } = scoreMemo(memo, "What is the vault access code?");
  assert.ok(score >= 3, `score too low: ${score}`);
  assert.ok(shared.includes("vault") && shared.includes("code"));
});

test("code-like tokens score double", () => {
  const memo = { keys: ["vault", "access", "code", "x9-falcon-42"], text: CODED_FACT };
  const withCode = scoreMemo(memo, "What is the x9-falcon-42 code?");
  const plain = scoreMemo(memo, "What is the vault access code?");
  assert.ok(withCode.score > plain.score, "code token did not add weight");
});

test("an unrelated question retrieves nothing", () => {
  let cabinet = emptyCabinet();
  cabinet = upsertMemo(cabinet, { text: CODED_FACT, conversationId: "c-1", turn: 0 });
  const { memos, stats } = retrieveCabinet(cabinet, { question: "What did the orchard yield last autumn?" });
  assert.equal(memos.length, 0);
  assert.equal(stats.hits, 0);
  assert.equal(stats.scored, 1);
});

test("the retrieval budget bounds the block", () => {
  let cabinet = emptyCabinet();
  for (let i = 0; i < 20; i++) {
    cabinet = upsertMemo(cabinet, {
      text: `Rule ${i}: the archive room on shelf ${i} holds the manifests for quarter ${i + 4}.`,
      conversationId: "c-1",
      turn: i,
    });
  }
  const { memos, stats } = retrieveCabinet(cabinet, {
    question: "Which shelf holds the archive room manifests?",
    budgetChars: CABINET_RETRIEVE_BUDGET,
  });
  assert.ok(memos.length >= 1, "nothing retrieved");
  assert.ok(stats.usedChars <= CABINET_RETRIEVE_BUDGET, `used ${stats.usedChars} > budget`);
});

// ── Usage strengthens the trace ──────────────────────────────────────────────

test("markAccessed breaks a score tie toward the used memo", () => {
  // Two memos tied on every scored term — identical keys, weight and recency.
  const tied = (id) => ({ id, keys: ["dock", "reserve"], text: id, weight: 1, lastTurn: 0, lastAccessed: null, accessCount: 0 });
  let cabinet = { memos: [tied("m-a"), tied("m-b")] };
  const before = retrieveCabinet(cabinet, { question: "where is the reserve dock?" });
  assert.equal(before.memos.length, 2, "expected both tied memos back");
  assert.equal(before.memos[0].id, "m-a", "stable order before access");
  cabinet = markAccessed(cabinet, ["m-b"]);
  const memo = cabinet.memos.find((m) => m.id === "m-b");
  assert.equal(memo.accessCount, 1);
  const after = retrieveCabinet(cabinet, { question: "where is the reserve dock?" });
  assert.equal(after.memos[0].id, "m-b", "accessed memo should win the tie-break");
});

// ── Boundedness ──────────────────────────────────────────────────────────────

test("the cabinet never exceeds its cap", () => {
  let cabinet = emptyCabinet();
  for (let i = 0; i < CABINET_MAX + 40; i++) {
    cabinet = upsertMemo(cabinet, {
      text: `Unique entry ${i}: ledger row ${i} records ${i * 7} bushels from plot number ${i * 3 + 1}.`,
      conversationId: "c-1",
      turn: i,
    });
  }
  assert.ok(cabinet.memos.length <= CABINET_MAX, `cabinet has ${cabinet.memos.length}`);
});

test("re-stating a memo strengthens instead of duplicating", () => {
  let cabinet = emptyCabinet();
  cabinet = upsertMemo(cabinet, { text: CODED_FACT, conversationId: "c-1", turn: 0 });
  cabinet = upsertMemo(cabinet, { text: "the vault access code is X9-Falcon-42 which rotates monthly", conversationId: "c-2", turn: 9 });
  const code = cabinet.memos.find((m) => m.text.includes("X9-Falcon-42"));
  assert.equal(cabinet.memos.length, 1, "duplicate created");
  assert.ok(code.weight >= 2, `weight ${code.weight}`);
  assert.equal(code.lastTurn, 9);
});

// ── Render and stats ─────────────────────────────────────────────────────────

test("the cabinet block names its own authority and never brackets", () => {
  const block = buildCabinetBlock([{ text: CODED_FACT }]);
  assert.ok(block.includes("PROJECT CABINET"));
  assert.ok(block.includes("X9-Falcon-42"));
  assert.ok(!block.includes("[1]"), "cabinet memos must not render as bracketed citations");
});

test("cabinetStats reports counts a client can render", () => {
  let cabinet = emptyCabinet();
  cabinet = upsertMemo(cabinet, { text: CODED_FACT, conversationId: "c-1", turn: 0 });
  const stats = cabinetStats(cabinet);
  assert.equal(stats.memos, 1);
  assert.equal(stats.accessed, 0);
  assert.ok(stats.topKeys.some((k) => k.includes("vault")), `keys: ${stats.topKeys}`);
});

if (process.exitCode) console.error(`\n${passed} passed, with failures`);
else console.log(`\n${passed} tests passed`);
