// A harder version of long-thread-recall: TWO distinct facts stated at
// different points, both past the window by the time they're asked about,
// with unrelated filler interleaved. Proves the desk holds more than one
// live fact at once and keeps them both addressable, not just "a fact" in
// the singular.

import { replay, baselineContext, holonicContext, contextText } from "../pipelines.mjs";
import { contextBoundAnswer } from "../context-model.mjs";

export const id = "multi-fact-recall";
export const title = "Two distinct facts, stated apart, both survive past the window";

const FACT_A = "the launch window opens at 04:17 UTC";
const FACT_B = "the callsign is Meridian-7";

const SCRIPT = [
  // Both facts stated back-to-back, early, so enough filler turns can push
  // BOTH out of the real HISTORY_TURNS(=6) window — not just the first one.
  { question: `Quick note before we start — ${FACT_A}.`, answer: `Understood — ${FACT_A}.` },
  { question: `Also, one more thing — ${FACT_B}.`, answer: `Got it — ${FACT_B}.` },
  { question: "What's the boiling point of nitrogen?", answer: "Nitrogen boils at about -196C at standard pressure." },
  { question: "What's the tallest mountain in Africa?", answer: "Mount Kilimanjaro, at about 5,895 meters." },
  { question: "Name a famous bridge in San Francisco.", answer: "The Golden Gate Bridge." },
  { question: "What year did the Berlin Wall fall?", answer: "1989." },
  { question: "What's a common gas used in weather balloons?", answer: "Helium is commonly used." },
  { question: "Who painted Starry Night?", answer: "Vincent van Gogh." },
];

export async function run() {
  const checks = [];
  const check = (name, pass, message = "") => checks.push({ name, pass: !!pass, message });

  const { baselineConv, holonicConv, memory } = replay(SCRIPT);
  const baseMsgs = baselineContext(baselineConv);
  const holoMsgs = holonicContext(holonicConv, memory);
  const baseText = contextText(baseMsgs).toLowerCase();
  const holoText = contextText(holoMsgs).toLowerCase();

  check("baseline context has lost fact A (launch window)", !baseText.includes(FACT_A.toLowerCase()));
  check("baseline context has lost fact B (callsign)", !baseText.includes(FACT_B.toLowerCase()));
  check("holonic context still carries fact A", holoText.includes(FACT_A.toLowerCase()));
  check("holonic context still carries fact B", holoText.includes(FACT_B.toLowerCase()));

  const holoAnswerA = contextBoundAnswer(holoMsgs, FACT_A);
  const holoAnswerB = contextBoundAnswer(holoMsgs, FACT_B);
  check("a context-bound model recalls fact A from the holonic context", holoAnswerA.includes(FACT_A));
  check("a context-bound model recalls fact B from the holonic context", holoAnswerB.includes(FACT_B));

  return { checks };
}
