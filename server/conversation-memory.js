// conversation-memory.js — the per-conversation working memory ("the desk").
//
// The turn path only feeds the model the last HISTORY_TURNS turns, so anything
// the reader said before that window is gone: it is neither in context nor
// retrievable. This module is the desk that keeps what matters IN VIEW, the way
// a person keeps hot facts in active memory:
//
//   - small and bounded — a fixed token budget, always injected on every turn,
//     never dependent on the sliding window surviving;
//   - verbatim — stated facts are quoted exactly as said, because a paraphrase
//     is where a fact turns into a guess;
//   - recency and rehearsal — recent subject matter stays "in focus", repeated
//     and acknowledged facts weigh more, and idle turns decay a trace instead
//     of silently deleting it;
//   - acknowledgment signals importance — a fact the assistant acknowledged
//     ("noted", or restated) is marked as such and weighted accordingly.
//
// The desk holds what was stated IN THIS CONVERSATION, not source ground truth.
// It is the mirror of what was said, which is exactly what makes a denial of a
// recorded fact a detectable failure (recall-denial review below).
//
// This module is pure: no IO, no model calls, no global state. The turn
// controller owns the state object and the persistence of it; this file only
// says how the desk changes turn by turn and how it is rendered. Being pure is
// what makes it testable in isolation and auditable in production.

import { splitSentences } from "./citation-check.js";

// ── Budgets ──────────────────────────────────────────────────────────────────

// The desk must stay small enough to inject on every turn without crowding out
// the instruction gate, history, grounding passages, or the answer.
export const FACTS_MAX = 14;            // hard cap on stated facts kept
export const FACT_CHAR_BUDGET = 2400;   // hard ceiling on the facts block (≈680 tokens)
export const FACT_MIN_CHARS = 10;       // shorter sentences are chatter, not facts
export const FACT_MAX_CHARS = 220;      // a fact that long is a paragraph
export const HOT_MAX = 24;              // hot-term trace cap
export const HOT_FLOOR = 0.25;          // below this weight a trace is gone
export const HOT_DECAY_PER_TURN = 0.9;  // weight retained per idle turn
export const HOT_IN_FOCUS = 8;          // how many traces the message names

// ── Stopwords ────────────────────────────────────────────────────────────────
//
// Content terms for the hot-trace and for recall-denial matching. Kept in this
// file because the two uses must agree on what "a word" is, and both operate on
// conversation prose rather than on cited source passages (the CLAIM_STOPWORDS
// in citation-check.js serve a different, narrower job).
const STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "there", "here", "it", "its",
  "he", "she", "they", "them", "his", "her", "hers", "their", "theirs", "we", "us",
  "our", "ours", "you", "your", "yours", "i", "me", "my", "mine", "who", "whom",
  "whose", "which", "what", "where", "why", "how", "when",
  "and", "but", "or", "nor", "so", "yet", "for", "as", "if", "then", "than", "while",
  "after", "before", "since", "because", "although", "though", "unless", "until",
  "whether", "in", "on", "at", "by", "to", "from", "with", "within", "without",
  "of", "about", "into", "onto", "over", "under", "between", "among", "through",
  "during", "against", "toward", "towards", "upon", "across", "per",
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had",
  "do", "does", "did", "will", "would", "shall", "should", "can", "could", "may",
  "might", "must", "let",
  "no", "not", "yes", "both", "each", "every", "either", "neither", "some", "any",
  "all", "none", "few", "many", "much", "more", "most", "less", "least", "several",
  "one", "two", "three", "other", "another", "same", "such", "own", "very", "only",
  "just", "also", "too", "still", "already", "always", "never", "often", "again",
  "first", "second", "third", "next", "last", "later", "earlier", "now", "today",
  "however", "moreover", "therefore", "thus", "hence", "meanwhile", "instead",
  "overall", "finally", "additionally", "furthermore", "nevertheless", "besides",
  "accordingly", "consequently", "similarly", "conversely", "notably", "indeed",
  "perhaps", "maybe", "possibly", "likely", "clearly", "importantly", "generally",
  "specifically", "particularly", "essentially", "ultimately", "together",
  "according", "based", "note", "given", "regarding", "concerning", "despite",
  "well", "actually", "otherwise", "please", "could", "would", "might", "let",
]);

/**
 * Content terms of some prose: lowercased, stopwords removed, hyphenated and
 * digit-bearing tokens kept whole so codes like "X9-Falcon-42" survive as a
 * single matchable unit. The needle-in-haystack tests depend on codes surviving
 * this tokenization.
 */
export function contentTerms(text, { cap = 64 } = {}) {
  const terms = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  const src = String(text || "").toLowerCase();
  let m;
  while ((m = re.exec(src)) !== null && terms.length < cap) {
    let w = m[0];
    if (/['’]$/.test(w)) w = w.slice(0, -1); // possessive "vault's" -> "vault"
    if (w.length < 3) continue;
    if (/^\d+$/.test(w) && w.length < 3) continue; // too-short bare numerals
    if (STOPWORDS.has(w)) continue;
    terms.push(w);
  }
  return terms;
}

// ── Hot-trace: what is in focus ──────────────────────────────────────────────
//
// A recency-weighted, decaying set of content terms. User terms land with full
// weight; the assistant echoing a user term back reinforces it (rehearsal);
// acknowledgment reinforces it harder. Idle turns multiply the whole trace by
// HOT_DECAY_PER_TURN, so old subjects fade instead of vanishing — fading is
// honest about memory, deletion is a lie about what happened.
export function updateHotTerms(hot = [], { userText = "", assistantText = "", turn = 0, confirmed = false } = {}) {
  const map = new Map();
  for (const t of hot) map.set(t.term, { ...t });

  const bump = (term, weight) => {
    const cur = map.get(term);
    if (cur) {
      cur.weight += weight;
      cur.lastTurn = Math.max(cur.lastTurn, turn);
    } else {
      map.set(term, { term, weight, lastTurn: turn });
    }
  };

  const userTerms = new Set(contentTerms(userText));
  for (const term of userTerms) bump(term, 1);
  // Rehearsal: the assistant restating a user term confirms its importance.
  for (const term of contentTerms(assistantText)) {
    if (userTerms.has(term)) bump(term, confirmed ? 2 : 0.5);
  }

  const out = [];
  for (const t of map.values()) {
    const idle = Math.max(0, turn - t.lastTurn);
    const weight = t.weight * Math.pow(HOT_DECAY_PER_TURN, idle);
    if (weight >= HOT_FLOOR) out.push({ term: t.term, weight, lastTurn: t.lastTurn });
  }
  out.sort((a, b) => b.weight - a.weight || b.lastTurn - a.lastTurn || a.term.localeCompare(b.term));
  return out.slice(0, HOT_MAX);
}

// ── Stated facts: verbatim, bounded, weighted ────────────────────────────────
//
// Sentences are stored EXACTLY as stated. A fact's weight rises with repetition
// and with acknowledgment; an acknowledged fact is kept ahead of an unconfirmed
// one under budget pressure, and the renderer labels it so the model can tell
// "the reader told me this and I confirmed it" from "the reader told me this".

// Real speech routinely states something and asks about it in the same
// breath, with no terminal punctuation between the two — "I already replaced
// the o-ring — does that matter?", "...it's Sunday night, right?". splitSentences
// sees one sentence ending in "?", and a naive question-filter would discard
// the whole thing, throwing away the stated half along with the asked half.
// This recovers the declarative lead-in from that specific shape — a dash- or
// tag-question-attached question — WITHOUT touching a sentence that is a
// question from the start (no declarative lead-in exists to recover).
const TAG_QUESTION = /^(.*?),\s*(?:right|correct|isn'?t (?:it|that)|wasn'?t (?:it|that)|didn'?t (?:i|it|you|we)|doesn'?t it|don'?t you think)\?\s*$/i;
function declarativeLeadIn(sentence) {
  const dashParts = sentence.split(/\s+[—–]\s+/);
  if (dashParts.length > 1) {
    const lead = dashParts[0].trim();
    const rest = dashParts.slice(1).join(" — ").trim();
    if (lead && !/\?\s*$/.test(lead) && /\?\s*$/.test(rest)) return lead;
  }
  const tag = sentence.match(TAG_QUESTION);
  if (tag && tag[1] && !/\?\s*$/.test(tag[1].trim())) return tag[1].trim();
  return null;
}

export function extractStatedFacts(text, { cap = 12 } = {}) {
  const out = [];
  for (const s of splitSentences(text)) {
    let t = s.text.trim();
    if (/\?\s*$/.test(t)) {
      const lead = declarativeLeadIn(t);
      if (!lead) continue; // a genuine question states nothing
      t = lead;
    }
    if (t.length < FACT_MIN_CHARS || t.length > FACT_MAX_CHARS) continue;
    // A denial is not a fact — it is a claim about the record that the
    // recall-denial review (below) handles instead of the desk.
    if (isDenialSentence(t)) continue;
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

export function normalizeFactText(text) {
  let s = String(text || "").trim();
  // Quotes are stripped entirely, not at the edges only: a fact restated with
  // quotes and without them ("is 'X9-Falcon-42'" vs "is X9-Falcon-42") must
  // normalise to the same key, and an edge-only strip would leave the opening
  // quote behind when the closing one disappears.
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/["']/g, "");
  s = s.replace(/[.!?]+$/, "");
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Two statements are the same fact if they normalise equal, or if one wholly
 * contains the other (the reader restating with extra detail). Substring
 * containment is only trusted past FACT_MIN_CHARS, so a short echo of a long
 * fact cannot merge with it by accident.
 */
export function sameFact(a, b) {
  const na = normalizeFactText(a);
  const nb = normalizeFactText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= FACT_MIN_CHARS && longer.includes(shorter);
}

const CONFIRMED_WEIGHT = 10;

export function updateStatedFacts(facts = [], { userText = "", assistantText = "", turn = 0, confirmed = false } = {}) {
  const next = facts.map((f) => ({ ...f }));

  const upsertUser = (text, weight) => {
    for (const raw of extractStatedFacts(text)) {
      const existing = next.find((f) => sameFact(f.text, raw));
      const ack = confirmed;
      if (existing) {
        existing.seen += 1;
        existing.lastTurn = Math.max(existing.lastTurn, turn);
        existing.weight = ack ? Math.max(existing.weight, CONFIRMED_WEIGHT) : existing.weight + weight;
        if (ack) existing.confirmed = true;
      } else {
        next.push({
          text: raw,
          turn,
          lastTurn: turn,
          seen: 1,
          confirmed: ack,
          weight: ack ? CONFIRMED_WEIGHT : weight,
        });
      }
    }
  };

  // The assistant restating a fact is the strongest acknowledgment there is —
  // it answered FROM the fact. But "restating" means the assistant's reply
  // actually contains something the READER stated (matched via sameFact
  // against the desk's own existing entries) — not that every declarative
  // sentence the assistant writes is itself a stated fact. A substantive
  // answer to a real question ("HPCO means the compressor overheated...") is
  // the assistant's OWN informative content, not something the reader said;
  // treating it as a confirmed fact at CONFIRMED_WEIGHT floods the desk with
  // the assistant's own prose and evicts facts the reader actually stated —
  // exactly backwards for a desk whose whole job is remembering the reader.
  // Only existing entries get upgraded here; unmatched assistant sentences
  // are never inserted as new facts.
  const acknowledgeFromAssistant = (text) => {
    if (!next.length) return;
    const assistantSentences = extractStatedFacts(text, { cap: 40 });
    if (!assistantSentences.length) return;
    for (const existing of next) {
      const isRestated = assistantSentences.some((s) => sameFact(existing.text, s));
      if (!isRestated) continue;
      existing.weight = Math.max(existing.weight, CONFIRMED_WEIGHT);
      existing.confirmed = true;
      existing.lastTurn = Math.max(existing.lastTurn, turn);
    }
  };

  upsertUser(userText, 1);
  acknowledgeFromAssistant(assistantText);

  // Eviction is honest: sort by weight (acknowledged first), then recency, and
  // keep as much as the budget allows. What is dropped is dropped because it
  // mattered least, and the count is visible in the render.
  next.sort((a, b) => b.weight - a.weight || b.lastTurn - a.lastTurn || b.seen - a.seen);
  const kept = [];
  let budget = FACT_CHAR_BUDGET;
  for (const f of next) {
    if (kept.length >= FACTS_MAX) break;
    if (kept.length > 0 && budget - f.text.length < 0) break;
    kept.push(f);
    budget -= f.text.length;
  }
  return kept;
}

// ── Rendering ────────────────────────────────────────────────────────────────
//
// The desk as the model sees it. Facts first, quoted verbatim, each labelled
// acknowledged/confirmed or merely stated; the hot-trace names what is in
// focus. The header tells the model the one thing it must not do: deny a fact
// that is recorded here.
export function buildMemoryMessage({ hot = [], facts = [] } = {}) {
  const parts = [];
  if (facts.length) {
    const lines = [];
    lines.push("CONVERSATION WORKING MEMORY — verbatim statements made in this conversation.");
    lines.push("This record is authoritative for what was said HERE and is not source passages: never cite these facts with brackets, and never deny or say 'not discussed' about any fact listed below. Anything NOT listed was not stated in this conversation.");
    facts.forEach((f, i) => {
      lines.push(`${i + 1}. [${f.confirmed ? "acknowledged" : "stated"}] ${f.text}`);
    });
    parts.push(lines.join("\n"));
  }
  if (hot.length) {
    parts.push(`In focus now: ${hot.slice(0, HOT_IN_FOCUS).map((t) => t.term).join(", ")}.`);
  }
  return parts.length ? parts.join("\n\n") : null;
}

// ── Recall-denial review ─────────────────────────────────────────────────────
//
// The failure this guard exists for: the reader states a fact, the assistant
// acknowledges it, and later — after enough turns that the fact fell out of the
// context window — the assistant flatly denies the fact was ever given.
// Mechanical and model-blind: an answer sentence that both denies (didn't /
// was never / not discussed…) and talks about the record (information, given,
// provided, the conversation…) is checked against the desk. If the reader's
// question shares ≥2 content terms with a recorded fact — or shares a
// code-like token — the denial is a false denial of a recorded fact.
const DENIAL_VERB = /\b(?:didn'?t|did not|wasn'?t|was not|weren'?t|were not|haven'?t|have not|hasn'?t|has not|hadn'?t|never|can'?t|cannot|can not|couldn'?t|could not|isn'?t|is not|aren'?t|are not|n'?t|not)\b/gi;
const DENIAL_SUBJECT = /\b(?:information|record|records|mention|mentions|knowledge|recall|remember|codes?|facts?|details?|data|conversation|material|discussed|discussion|stated|provided|given|received|shared|mentioned|recorded|sources?|passages?)\b/gi;

// Several of the DENIAL_SUBJECT words ("stated", "mentioned", "provided",
// "given") are exactly what a CORRECT recall answer uses affirmatively
// ("You stated that X was Y", "as you mentioned"). A real denial keeps the
// negation and the subject close together ("never provided", "no record",
// "not discussed") — requiring them within a short distance, rather than
// matching anywhere in the whole sentence, is what tells "You stated X, so
// it's not overdue" (an affirmation with an unrelated negation later in the
// sentence) apart from "that information was never provided" (a real
// denial). Found empirically: two independent real model answers correctly
// cited a recorded fact and were still flagged as denials under the old
// whole-sentence check, purely because an unrelated "not" appeared later in
// the same sentence.
const DENIAL_PROXIMITY_CHARS = 30;

export function isDenialSentence(sentence) {
  const text = String(sentence || "");
  const verbMatches = [...text.matchAll(DENIAL_VERB)];
  if (!verbMatches.length) return false;
  const subjectMatches = [...text.matchAll(DENIAL_SUBJECT)];
  if (!subjectMatches.length) return false;
  for (const v of verbMatches) {
    for (const s of subjectMatches) {
      if (Math.abs(v.index - s.index) <= DENIAL_PROXIMITY_CHARS) return true;
    }
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.question the reader's current message
 * @param {string} opts.answer   the assistant's completed answer
 * @param {object[]} opts.facts  the desk's recorded facts
 * @returns {{verdict:"PASS"|"FLAGGED", flags:object[], denialSentences:string[]}}
 */
export function checkRecallDenial({ question = "", answer = "", facts = [] }) {
  const flags = [];
  const denialSentences = [];
  if (!answer || !facts.length) return { verdict: "PASS", flags, denialSentences };

  for (const s of splitSentences(answer)) {
    if (isDenialSentence(s.text)) denialSentences.push(s.text.trim());
  }
  if (!denialSentences.length) return { verdict: "PASS", flags, denialSentences };

  const qTerms = new Set(contentTerms(question));
  for (const fact of facts) {
    const fTerms = contentTerms(fact.text);
    const shared = [...qTerms].filter((t) => fTerms.includes(t));
    const codeLike = shared.find((t) => /\d/.test(t) || t.length >= 8);
    const strong = shared.length >= 2 || codeLike;
    if (!strong) continue;
    flags.push({
      type: "false_denial",
      fact: fact.text,
      confirmed: fact.confirmed,
      sharedTerms: shared,
      detail: `The answer denies "${shared.slice(0, 3).join(", ")}" was part of this conversation, but it is recorded here verbatim: "${fact.text}".`,
    });
  }
  return { verdict: flags.length ? "FLAGGED" : "PASS", flags, denialSentences };
}

// ── Convenience ──────────────────────────────────────────────────────────────

export function emptyMemory() {
  return { hot: [], facts: [] };
}

/**
 * Advance the desk by one turn. Pure: returns a new state, never mutates.
 */
export function applyTurn(memory, turn, { userText = "", assistantText = "", confirmed = false } = {}) {
  const state = memory || emptyMemory();
  const hot = updateHotTerms(state.hot, { userText, assistantText, turn, confirmed });
  const facts = updateStatedFacts(state.facts, { userText, assistantText, turn, confirmed });
  return { hot, facts };
}

/**
 * Did the assistant's reply do nothing but acknowledge what the reader said
 * ("Noted.", "Got it — I'll remember that.")? Such an answer contains no new
 * fact and no answer; it is the shape of pure acknowledgment, and detecting it
 * is what lets the desk weight the just-stated fact as confirmed.
 */
export function isAcknowledgment(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /^(?:(?:ok(?:ay)?|yes|yeah|sure|right|good|great|done|got it|gotcha|understood|noted|acknowledged|received|recorded|saved|confirmed|memorized|logged|keeping? that in mind)\b[^.!?]*)[.!]?$/i.test(t);
}
