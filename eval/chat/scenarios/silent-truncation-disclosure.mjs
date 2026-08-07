// L3 ("no silent truncation") applied to the desk: once a conversation states
// more distinct facts than FACTS_MAX, something must be evicted — but the
// message the model (and, in the real UI, the reader) sees must never claim
// to hold more than it actually kept. This scenario states more than double
// FACTS_MAX worth of distinct facts across a real multi-turn replay and
// checks the real eviction and the real rendered message against each other.

import { FACTS_MAX, FACT_CHAR_BUDGET, buildMemoryMessage } from "../../../server/conversation-memory.js";
import { replay } from "../pipelines.mjs";

export const id = "silent-truncation-disclosure";
export const title = "The desk evicts under pressure but never over-claims what it kept";

const TOPICS = [
  "call sign", "launch pad", "fuel mixture ratio", "recovery zone", "backup frequency",
  "ground crew lead", "weather hold threshold", "abort code", "docking port", "orbital inclination",
  "telemetry channel", "rendezvous altitude", "reentry corridor", "splashdown window", "beacon frequency",
  "checklist revision", "hatch seal batch", "parachute rigger", "tracking station", "flight surgeon",
];

const SCRIPT = TOPICS.map((topic, i) => ({
  question: `Note for the record: the ${topic} is designation ${String(i).padStart(3, "0")}.`,
  answer: `Logged — the ${topic} is designation ${String(i).padStart(3, "0")}.`,
}));

export async function run() {
  const checks = [];
  const check = (name, pass, message = "") => checks.push({ name, pass: !!pass, message });

  const { memory } = replay(SCRIPT);

  check(
    `more distinct facts were stated (${TOPICS.length}) than FACTS_MAX (${FACTS_MAX})`,
    TOPICS.length > FACTS_MAX,
  );
  check(
    `the desk kept at most FACTS_MAX (${FACTS_MAX}) facts`,
    memory.facts.length <= FACTS_MAX,
    `kept ${memory.facts.length}`,
  );
  check(
    `the desk kept at least one fact (eviction did not empty it)`,
    memory.facts.length > 0,
  );

  const message = buildMemoryMessage(memory);
  const numberedLines = (message.match(/^\d+\. \[/gm) || []).length;
  check(
    "the rendered memory message enumerates EXACTLY as many facts as were actually kept — no over- or under-claiming",
    numberedLines === memory.facts.length,
    `rendered ${numberedLines} numbered line(s), desk holds ${memory.facts.length}`,
  );

  const factsCharCount = memory.facts.reduce((n, f) => n + f.text.length, 0);
  check(
    `the kept facts' own text stays within the declared FACT_CHAR_BUDGET (${FACT_CHAR_BUDGET})`,
    factsCharCount <= FACT_CHAR_BUDGET,
    `${factsCharCount} chars`,
  );

  return { checks };
}
