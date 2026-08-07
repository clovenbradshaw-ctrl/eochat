// Shared lexical-presence relevance scoring — the cheap, no-embedding-model
// "surf" step this codebase already uses for real corpus search
// (engine-ground.js's engineGroundQuery), applied here to bound a working
// context (react-loop.mjs's conversation history, holon-coder.mjs's
// cross-level handoff text) by RELEVANCE rather than by position. A bounded
// selection that never scores content is truncation wearing a fold's
// report format — see AMENDMENT-13-PROPOSAL.md (eo-constitution) for the
// two real instances, in this exact codebase, that motivated pulling this
// out into one shared place instead of writing it twice more.

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "to", "of", "in", "on", "for", "with", "this", "that", "it", "as", "at", "by", "be", "not", "you", "your", "have", "has", "had", "from", "its", "will", "call", "tool"]);

/** The vocabulary of a text that actually carries information — short
 * function words dropped, so two spans overlap only on words specific
 * enough to mean something. */
export function significantTerms(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9_./]{4,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

/** How many of a text's own significant terms are NOT generic filler —
 * a cheap information-density proxy for "does this unit carry anything
 * specific" (a file path, an identifier, a number), used to choose which
 * unit to keep when there is no separate focus/query to score against. */
export function informationDensity(text) {
  return significantTerms(text).size;
}

/** Overlap between two texts' significant vocabularies — the actual
 * "search" step: how much does this candidate bear on the focus. */
export function overlapScore(focusTerms, candidateText) {
  const terms = significantTerms(candidateText);
  let overlap = 0;
  for (const t of focusTerms) if (terms.has(t)) overlap++;
  return overlap;
}
