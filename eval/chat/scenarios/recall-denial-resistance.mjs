// Even with the desk carrying a fact, a weak model can still flatly deny the
// fact was ever given — conversation-memory.js's own header names this
// exact failure. checkRecallDenial is the mechanical, model-blind safety net
// for it. This scenario proves two things about the REAL function, run
// against a REAL multi-turn desk built by applyTurn (not a hand-built facts
// array, which is all the existing unit tests in
// scripts/test-conversation-memory.mjs use):
//
//   1. a false denial of a fact actually on the desk gets FLAGGED
//   2. a denial about something genuinely never discussed does NOT get
//      flagged (no false positive) — the guard must be a scalpel, not a net
//      that catches every "I don't know"

import { replay } from "../pipelines.mjs";
import { checkRecallDenial } from "../../../server/conversation-memory.js";

export const id = "recall-denial-resistance";
export const title = "checkRecallDenial catches a false denial without over-triggering";

const FACT = "X9-Falcon-42";

const SCRIPT = [
  { question: `Please remember this for later — the vault access code is ${FACT}.`, answer: `Noted — the vault access code is ${FACT}.` },
  { question: "What's the weather like on Mars?", answer: "Mars has a thin CO2 atmosphere and averages around -60C." },
  { question: "Who wrote Moby-Dick?", answer: "Herman Melville wrote Moby-Dick, published in 1851." },
];

export async function run() {
  const checks = [];
  const check = (name, pass, message = "") => checks.push({ name, pass: !!pass, message });

  const { memory } = replay(SCRIPT);

  // A weak model, having lost the fact from its own raw window, denies it
  // ever happened — the exact failure shape this guard exists for.
  const falseDenial = checkRecallDenial({
    question: "What was the vault access code I gave you earlier?",
    answer: "That information was never provided in this conversation.",
    facts: memory.facts,
  });
  check(
    "a false denial of the recorded vault code is flagged",
    falseDenial.verdict === "FLAGGED" && falseDenial.flags.length > 0,
    `verdict: ${falseDenial.verdict}, flags: ${JSON.stringify(falseDenial.flags.map((f) => f.type))}`,
  );

  // The same denial SHAPE, but about a topic that genuinely never came up —
  // must not be flagged just because it looks like a denial sentence.
  const genuineAbsence = checkRecallDenial({
    question: "What's the current time in Tokyo?",
    answer: "That information was never provided in this conversation.",
    facts: memory.facts,
  });
  check(
    "a denial about a genuinely undiscussed topic is not flagged",
    genuineAbsence.verdict === "PASS",
    `verdict: ${genuineAbsence.verdict}, flags: ${JSON.stringify(genuineAbsence.flags.map((f) => f.type))}`,
  );

  return { checks };
}
