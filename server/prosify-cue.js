// prosify-cue.js — expand a terse follow-up into a self-contained cue.
//
// The turn controller passes the reader's raw message straight through to
// both retrieval (engineGroundQuery) and the instruction gate's question
// channel (instruction-gate.js). That is correct for a self-contained
// question, but a follow-up like "read it again" or "make it shorter"
// carries no keyword signal of its own — "it" and "again" are exactly the
// terms conversation-memory.js's STOPWORDS strips, on purpose, because they
// are not content. Retrieval and the gate both score on content terms, so a
// message built entirely from stripped words is invisible to both.
//
// This module does not classify the turn onto any fixed set of categories —
// that approach (an EO-cell classifier reading content and assigning it a
// cube coordinate) was built, tested, and rejected: shuffling the words
// inside 2,527 paragraphs left 95.7% of its assignments unchanged, which
// means it tracked vocabulary, not meaning (see CUBE.md). What this module
// produces instead is one rewritten sentence, grounded only in this
// conversation's own recorded state (the desk's hot terms and stated facts,
// plus recent raw history) — never a guess at what the reader "really"
// means beyond what was actually said.
//
// Pure: no IO, no model call. The turn controller owns calling the model and
// applying the result, the same IMPURE-boundary split model-router.js uses.

// A rewrite is only attempted when the message is short AND leans on a
// referent it does not itself resolve. A longer message, or one with no such
// referent, is already self-contained — expanding it would risk introducing
// meaning that was not there, which is the one thing this module must never
// do (see applyProsifyResult's degeneracy guard below).
const REFERENT_RE = /\b(it|it's|its|that|this|those|these|again|more|less|shorter|longer|expand|continue|redo|repeat|another|same|more|deeper)\b/i;
const MAX_WORDS = 10;

export function needsProsify(question) {
  const text = String(question ?? "").trim();
  if (!text) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_WORDS) return false;
  return REFERENT_RE.test(text);
}

// Builds the model call's messages. The system prompt is explicit about the
// one failure mode that matters here: inventing a detail that was not in the
// state it was given. The desk's own discipline is "a paraphrase is where a
// fact turns into a guess" (conversation-memory.js) — this prompt asks the
// model to hold to the same rule for the rewrite it produces.
export function buildProsifyMessages({ question, history = [], hot = [], facts = [] }) {
  const lines = [
    "You rewrite a terse follow-up message as ONE self-contained sentence a retrieval system can search on.",
    "Resolve pronouns and references such as \"it\", \"that\", or \"again\" using ONLY the conversation state below.",
    "Never introduce a name, fact, or detail that is not already present in that state or in recent history.",
    "If the state does not resolve a reference, leave the message close to as-is rather than guessing.",
    "Output the rewritten sentence alone: no preamble, no quotation marks, no explanation.",
  ];
  if (facts.length) {
    lines.push("", "Stated in this conversation:");
    for (const f of facts.slice(0, 8)) lines.push(`- ${f.text}`);
  }
  if (hot.length) {
    lines.push("", `In focus now: ${hot.slice(0, 8).map((t) => t.term).join(", ")}.`);
  }
  if (history.length) {
    lines.push("", "Recent messages, oldest first:");
    for (const h of history.slice(-4)) lines.push(`- ${h}`);
  }
  return [
    { role: "system", content: lines.join("\n") },
    { role: "user", content: String(question ?? "") },
  ];
}

// Validates the model's output before it is trusted to drive retrieval or
// the gate. Empty output and a runaway completion (the model padding far
// past what a one-sentence rewrite should ever need) both fall back to the
// raw question unchanged — the same behavior as if prosify had never run,
// so a bad model output degrades to today's behavior rather than to noise.
export function applyProsifyResult({ question, modelText }) {
  const raw = String(question ?? "");
  let cue = String(modelText ?? "").trim().replace(/^["']|["']$/g, "").trim();
  if (!cue) return { cue: raw, raw, changed: false, reason: "empty" };
  if (cue.length > Math.max(280, raw.length * 12)) {
    return { cue: raw, raw, changed: false, reason: "degenerate" };
  }
  return { cue, raw, changed: cue !== raw, reason: "expanded" };
}
