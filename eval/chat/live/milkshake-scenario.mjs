// A realistic long chat conversation, not a synthetic fact-planting drill: a
// user learning, deeply, how to diagnose and repair an industrial milkshake
// machine (a Taylor C708 soft-serve/shake freezer — a real, common
// commercial unit). This file authors only the USER's side of the
// conversation — what a person troubleshooting a real machine would type.
// The ASSISTANT's answers are never hand-written here: build-transcript.mjs
// generates them for real, turn by turn, via the actual Anthropic API with
// the web_search server tool enabled — the same shape EOchat's own
// turn-controller.js uses for a grounded answer — so any repair-specific
// content (error-code meanings, part names, procedures) comes from a real
// model doing real research, not from this eval pretending to know it.
//
// This is a harder, more honest stress test than eval/chat/live/
// generate-conversation.mjs's trivia-filler scenario: every filler turn
// stays ON TOPIC (more troubleshooting questions about the same machine), so
// the desk's fact-extraction has to separate "this session's specific
// diagnostic details" (serial number, an amp reading, a replacement date,
// the error code that started it) from a long run of adjacent, plausible
// general advice — exactly what a real long technical conversation produces
// and synthetic trivia never does.

export const id = "milkshake-machine-repair";
export const title = "Deep troubleshooting session on an industrial milkshake machine (Taylor C708)";

// ── The specific facts THIS session's user states, planted early ───────────
// Only the `question` (what the user says) and the probe/expected-recall
// shape are authored here. `answer` is filled in for real by
// build-transcript.mjs's live API call before this ever reaches pipelines.mjs.
export const FACTS = [
  {
    topic: "machine serial number",
    probe: "What's the serial number of my machine again?",
    code: "4819273",
    question: "I'm working on a Taylor C708 soft-serve freezer, serial number 4819273. It's been throwing a BEATER OVERLOAD error since Tuesday — can you help me figure out what's causing it?",
  },
  {
    topic: "beater door o-ring replacement date",
    probe: "When did I say I replaced the beater door o-ring?",
    code: "March 3",
    question: "I already replaced the beater door o-ring on March 3rd, but the overload is still tripping. What should I check next?",
  },
  {
    topic: "beater motor idle amp reading",
    probe: "What was the amp draw I measured on the beater motor?",
    code: "4.2 amps",
    question: "When I clamp-meter the beater motor, it reads 4.2 amps at idle, which felt high to me. Is that actually high for this kind of motor?",
  },
  {
    topic: "product mix ratio in use",
    probe: "What mix ratio did I say I was running?",
    code: "4:1",
    question: "For what it's worth, I'm running a 4:1 water-to-mix ratio on the shake side — could that be adding strain on the beater?",
  },
  {
    topic: "last daily cleaning date",
    probe: "When did I say the machine was last cleaned?",
    code: "Sunday night",
    question: "Last full cleaning and sanitizing cycle was Sunday night, so it's not overdue on that front, right?",
  },
];

// ── On-topic filler: more troubleshooting QUESTIONS about the SAME machine,
// generic (not this session's specifics) so the desk has to actually
// distinguish signal from a wall of adjacent, plausible advice. ────────────
export const FILLER_QUESTIONS = [
  "What does the HPCO COMPRESSOR error actually mean on these machines?",
  "Could a dirty condenser cause an HPCO trip?",
  "How often should the condenser be cleaned on a unit like this?",
  "What's the difference between a beater motor fault and a compressor fault, symptom-wise?",
  "Is it normal for scraper blades to dull over time?",
  "What's a reasonable replacement interval for scraper blades?",
  "How do I test a run capacitor without a proper meter?",
  "Could hardened product in the barrel happen even with regular cleaning?",
  "What's the purpose of the beater door o-ring specifically?",
  "Would a bad o-ring alone be enough to trip BEATER OVERLOAD?",
  "What's a normal idle amp draw range for this class of beater motor?",
  "Where would I find the motor's full-load amp rating?",
  "If the capacitor tests fine, what's next after that?",
  "Is it safe to run the machine with the overload tripping intermittently while I troubleshoot?",
  "What does the reset procedure look like when BEATER OVERLOAD trips?",
  "Could product viscosity itself cause more strain on the beater?",
  "What's the role of overrun in all this?",
  "Should I be worried about product safety if the compressor tripped on HPCO?",
  "How long should I let the compressor cool before restarting after HPCO?",
  "Is there a difference in troubleshooting between the shake side and the soft-serve side of a combo machine?",
  "What tools should I have on hand before pulling the beater assembly?",
  "Could a worn drive belt or coupling cause similar symptoms to a beater motor issue?",
  "Is there a daily checklist that would help catch these issues earlier?",
];

/** The full user-side script, in order: facts first, then filler. Answers are absent — filled in by build-transcript.mjs. */
export function userTurns() {
  return [...FACTS.map((f) => f.question), ...FILLER_QUESTIONS];
}

export function factProbes() {
  return FACTS.map(({ topic, probe, code }) => ({ topic, probe, code }));
}
