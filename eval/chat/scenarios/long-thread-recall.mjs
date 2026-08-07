// A fact stated once, early, must still be answerable after enough unrelated
// turns that it has fallen out of the raw HISTORY_TURNS(=6) window. This is
// the single most common "the AI forgot what I just told it" complaint about
// ordinary long-running chats — the thing the desk (conversation-memory.js)
// exists to fix.

import { replay, baselineContext, holonicContext, contextText } from "../pipelines.mjs";
import { contextBoundAnswer } from "../context-model.mjs";

export const id = "long-thread-recall";
export const title = "A fact stated once survives past the raw history window";

const FACT = "X9-Falcon-42";

const SCRIPT = [
  { question: "Please remember this for later.", answer: `Noted — the vault access code is ${FACT}.` },
  { question: "What's the weather like on Mars?", answer: "Mars has a thin CO2 atmosphere and averages around -60C." },
  { question: "Who wrote Moby-Dick?", answer: "Herman Melville wrote Moby-Dick, published in 1851." },
  { question: "What's 17 times 23?", answer: "17 times 23 is 391." },
  { question: "Name a moon of Jupiter.", answer: "Europa is one of Jupiter's moons." },
  { question: "What's the capital of Peru?", answer: "The capital of Peru is Lima." },
  { question: "How many strings does a violin have?", answer: "A violin has four strings." },
  { question: "What's a good book about the ocean?", answer: "The Sea Around Us by Rachel Carson is a classic." },
];

const PROBE = "What was the vault access code I gave you earlier?";

export async function run() {
  const checks = [];
  const check = (name, pass, message = "") => checks.push({ name, pass: !!pass, message });

  const { baselineConv, holonicConv, memory } = replay(SCRIPT);

  const baseMsgs = baselineContext(baselineConv);
  const holoMsgs = holonicContext(holonicConv, memory);

  const baseHasFact = contextText(baseMsgs).toLowerCase().includes(FACT.toLowerCase());
  const holoHasFact = contextText(holoMsgs).toLowerCase().includes(FACT.toLowerCase());

  check(
    "baseline's windowed-only context has genuinely lost the fact (real HISTORY_TURNS=6 cutoff, not assumed)",
    !baseHasFact,
    baseHasFact ? "the fact was still present in the baseline context — the script did not push enough filler turns to exercise the real window" : "",
  );
  check(
    "holonic's desk-augmented context still carries the fact",
    holoHasFact,
    holoHasFact ? "" : "buildMemoryMessage did not surface the fact even though it was stated and acknowledged",
  );

  const baseAnswer = contextBoundAnswer(baseMsgs, FACT);
  const holoAnswer = contextBoundAnswer(holoMsgs, FACT);

  check(
    "a context-bound model fails to recall the fact from the baseline context",
    !baseAnswer.includes(FACT),
    `baseline answer: "${baseAnswer}"`,
  );
  check(
    "a context-bound model recalls the fact from the holonic context",
    holoAnswer.includes(FACT),
    `holonic answer: "${holoAnswer}"`,
  );

  return { checks, probe: PROBE, baseAnswer, holoAnswer };
}
