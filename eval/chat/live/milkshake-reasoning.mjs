// Critical-thinking probes for the milkshake-machine-repair transcript —
// the harder counterpart to milkshake-scenario.mjs's single-fact recall
// probes. Recall asks "did the exact string survive"; these ask "can the
// pipeline SYNTHESIZE multiple session-specific facts together with
// multiple pieces of domain knowledge established earlier in the same real
// conversation, and reach a defensible, non-contradictory conclusion."
//
// Each probe names the specific real turns (by index into the real,
// API-generated transcript — see build-transcript.mjs) whose content the
// correct answer has to be consistent with. Grading is NOT a substring
// match — an open-ended synthesis answer can be phrased many ways — so
// run-milkshake-reasoning.mjs grades each answer with an LLM judge given
// the actual verbatim ground-truth excerpts, not this file's paraphrase of
// them, so the judge verifies against what was REALLY said, not against a
// guess baked into the rubric ahead of time.

export const REASONING_PROBES = [
  {
    id: "leading-suspect",
    probe:
      "Based on everything I've told you about the symptoms and readings, and everything we've discussed about how this machine fails, what's your single leading suspect for the BEATER OVERLOAD, and what's the strongest piece of evidence pointing to it?",
    // Session facts this probe requires combining (by FACTS[] index in milkshake-scenario.mjs).
    requiresFacts: [0, 1, 2], // amp reading, o-ring already replaced, (serial# not load-bearing here but harmless)
    // Real transcript turn indices whose established domain content the answer must be consistent with.
    requiresGroundTurns: [14], // "a bad o-ring alone rarely causes BEATER OVERLOAD"
    rubric: [
      "Correctly treats the elevated 4.2-amp idle reading as the strongest piece of evidence (not the o-ring, not the mix ratio, not the cleaning schedule).",
      "Names the motor and/or capacitor (the electrical side) as the leading suspect, not the o-ring.",
      "Does NOT claim the o-ring is the leading suspect or a strong candidate — the answer should reflect that it was already replaced without fixing the issue, and/or that a bad o-ring alone rarely causes this fault.",
    ],
  },
  {
    id: "elimination",
    probe:
      "Which of the possible causes we've discussed can we now rule out or de-prioritize, and why, given what I've already told you and already checked?",
    requiresFacts: [1, 4], // o-ring replaced, cleaning current
    requiresGroundTurns: [12, 14], // hardened product possible even with cleaning; o-ring alone rarely sufficient
    rubric: [
      "Correctly de-prioritizes hardened product in the barrel, citing that the cleaning/sanitizing cycle was current (Sunday night) as of this conversation.",
      "Correctly de-prioritizes the o-ring as the SOLE remaining cause, citing that it was already replaced (March 3rd) without resolving the trip.",
      "Does not incorrectly claim something was ruled out that the conversation never actually addressed or that contradicts what was established earlier.",
    ],
  },
  {
    id: "next-step-conditional",
    probe:
      "If I test the capacitor and it comes back fine, what's the very next thing I should physically check, and why does that make sense given the amp reading I mentioned?",
    requiresFacts: [2], // amp reading
    requiresGroundTurns: [17, 26], // capacitor-fine -> drive coupling/gearbox check; coupling wear mimics motor fault, raises amp draw
    rubric: [
      "Correctly identifies the drive coupling/gearbox as the next physical check after a clean capacitor test, consistent with what was established earlier in this same conversation.",
      "Explains the mechanism connecting a worn/rounded coupling to elevated amp draw (it slips under load, so the motor works harder and draws more current) — not a vague or incorrect explanation.",
      "Ties the explanation back to the specific 4.2-amp reading mentioned earlier, rather than speaking only in the abstract.",
    ],
  },
];
