// project-instructions.js — compile a project's free-form instruction text
// into folds the existing instruction gate can surf and fold.
//
// The problem this solves: a reader pastes their project's rules as one
// document of whatever length they like. The model cannot be handed all of it
// every turn — that is exactly the context pressure instruction-gate.js was
// built for — but neither can it be handed a summary, because INSTRUCTION-LAW
// R1 is "verbatim, or not at all": an instruction that is in force must reach
// the model word for word, or the model is obeying something nobody wrote.
//
// So the text is SEGMENTED, never rewritten. Every fold body produced here is
// an exact substring of what the reader typed; `compileInstructionFolds`
// asserts that before returning. What the gate then does per turn — surface
// the relevant folds verbatim, reduce the rest to a named fingerprint index —
// is the same mechanism the built-in instruction set already uses, not a
// second one (R3: relevance is one mechanism).
//
// The length rule is the honest one: if the whole text fits the budget, none
// of it is folded. Folding is a response to not fitting, not a house style.

import { countTokens, createInstructionGate, DEFAULT_INSTRUCTION_BUDGET } from "./instruction-gate.js";

// Terms too common to distinguish one section from another. Kept small on
// purpose: this list only has to stop signals that would match every turn, not
// model English.
const STOPWORDS = new Set(`
a an the and or but if then than that this these those of in on at to for with
from by as is are was were be been being do does did doing have has had having
it its it's you your yours we our ours they them their i me my mine he she his
her not no nor so such can could should would may might must will shall about
into over under again further once here there when where why how all any both
each few more most other some only own same too very just also let
please make sure use used using when-ever whenever always never
`.trim().split(/\s+/));

const MAX_SIGNALS = 12;
const MIN_SIGNAL_LENGTH = 4;

// Two constraints pull against each other once instructions get long, and both
// are laws.
//
// R4 says every folded instruction must be NAMED in the block's index, so the
// reader and the model can always see which rules exist but are out of force.
// That index costs roughly one line per fold, so its size grows with the
// number of folds. R5 says the whole block must fit its budget. Segment a
// 200-page manual at every heading and the index alone overruns the budget
// before a single rule has been surfaced.
//
// The resolution is that granularity is derived from the budget rather than
// fixed: the index gets a fixed share, that share divided by the cost of a
// line gives the most folds that can all be named, and sections are merged
// until the count fits. Merging keeps bodies contiguous, so R1 survives it.
// A fold must also be small enough to actually surface — one bigger than the
// budget could never be given verbatim and would be a wall (R3) — so bodies
// get their own ceiling, and when the two ceilings cannot both be met the
// report says so instead of the block quietly overflowing.
const INDEX_SHARE = 0.35;
const BODY_SHARE = 0.45;
const INDEX_LINE_TOKENS = 14;

function budgetGeometry(budgetTokens) {
  const maxFolds = Math.max(4, Math.floor((budgetTokens * INDEX_SHARE) / INDEX_LINE_TOKENS));
  const maxFoldTokens = Math.max(120, Math.floor(budgetTokens * BODY_SHARE));
  return { maxFolds, maxFoldTokens };
}

function slugify(text, fallback) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9'’-]+/i)
    .filter(Boolean);
}

// Split on markdown ATX headings, keeping each heading with the body beneath
// it. Offsets are tracked so every produced body can be proven to be a literal
// slice of the source.
function splitSections(text) {
  const lines = String(text).split("\n");
  const sections = [];
  let current = null;
  let offset = 0;

  for (const line of lines) {
    const lineLength = line.length + 1; // +1 for the newline split removed
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = {
        level: heading[1].length,
        title: heading[2].trim(),
        start: offset,
        end: offset + lineLength,
      };
    } else if (current) {
      current.end = offset + lineLength;
    } else if (line.trim()) {
      // Preamble: text before any heading.
      current = { level: 0, title: null, start: offset, end: offset + lineLength, preamble: true };
    }
    offset += lineLength;
  }
  if (current) sections.push(current);
  return sections;
}

// Every offset where a fold may legally end: paragraph breaks AND sentence
// ends, merged. A wall of prose with no blank lines still has sentences, and
// splitting at one keeps the part a contiguous slice — which is all R1
// requires. Cutting mid-word is what would break it.
//
// These were once tried in order, falling back to sentences only when there
// were no paragraph breaks at all. That let a single blank line at the end of
// a section count as "this text has paragraph structure" and suppress the
// sentence fallback entirely, so 900-token sections came back unsplit against
// a 360-token ceiling and could never be surfaced. Offering every boundary and
// letting the greedy fill choose is both simpler and correct: it still cuts at
// the coarsest boundary that fits, because it cuts at the LAST one that fits.
function breakpoints(body) {
  const points = new Set();
  for (const re of [/\n[ \t]*\n/g, /(?<=[.!?])\s+/g]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) points.add(m.index + m[0].length);
  }
  return [...points].sort((a, b) => a - b);
}

// Break one oversized section into contiguous runs, each under the per-fold
// ceiling, preferring the coarsest boundary that works.
function splitOversized(text, start, end, maxFoldTokens) {
  const body = text.slice(start, end);
  if (countTokens(body) <= maxFoldTokens) return [{ start, end }];

  const points = breakpoints(body);
  if (!points.length) return [{ start, end }];

  const parts = [];
  let partStart = start;
  let lastGood = start;
  for (const p of points) {
    const boundary = start + p;
    if (countTokens(text.slice(partStart, boundary)) > maxFoldTokens && lastGood > partStart) {
      parts.push({ start: partStart, end: lastGood });
      partStart = lastGood;
    }
    lastGood = boundary;
  }
  if (partStart < end) parts.push({ start: partStart, end });
  return parts.length ? parts : [{ start, end }];
}

// Merge adjacent pieces until there are few enough that every one of them can
// be named in the block's index (R4). Merging is by concatenating neighbours,
// so a merged body is still one contiguous slice of the source and still
// verbatim. Preamble pieces are never merged into a following section: the
// preamble is the standing rule set and has to stay separately addressable.
function mergeToFit(pieces, text, maxFolds) {
  if (pieces.length <= maxFolds) return pieces;
  const head = pieces.filter((p) => p.preamble);
  const rest = pieces.filter((p) => !p.preamble);
  const room = Math.max(1, maxFolds - head.length);
  if (rest.length <= room) return pieces;

  const perGroup = Math.ceil(rest.length / room);
  const merged = [];
  for (let i = 0; i < rest.length; i += perGroup) {
    const group = rest.slice(i, i + perGroup);
    merged.push({
      level: Math.min(...group.map((g) => g.level || 1)),
      title: group.length === 1
        ? group[0].title
        : `${group[0].title || "Instructions"} … ${group[group.length - 1].title || ""}`.trim(),
      start: group[0].start,
      end: group[group.length - 1].end,
      mergedFrom: group.length,
    });
  }
  return [...head, ...merged];
}

// Distinctive terms: frequent inside this fold, rare across the others. No
// learned system, no model — a count and a document-frequency divisor, which
// is what makes the surfacing decision inspectable after the fact (R3).
function deriveSignals(foldWordLists, index, titleTerms) {
  const own = foldWordLists[index];
  const counts = new Map();
  for (const w of own) {
    if (w.length < MIN_SIGNAL_LENGTH || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const docFreq = new Map();
  for (let i = 0; i < foldWordLists.length; i++) {
    for (const w of new Set(foldWordLists[i])) {
      docFreq.set(w, (docFreq.get(w) || 0) + 1);
    }
  }
  const scored = [...counts.entries()]
    .map(([w, n]) => [w, n / (docFreq.get(w) || 1)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w);

  // The heading's own words lead: they are the reader's chosen name for this
  // rule and the likeliest thing they will echo when they ask about it.
  const out = [];
  for (const t of titleTerms) {
    if (t.length >= MIN_SIGNAL_LENGTH && !STOPWORDS.has(t) && !out.includes(t)) out.push(t);
  }
  for (const w of scored) {
    if (out.length >= MAX_SIGNALS) break;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function firstSentence(body, limit = 120) {
  const flat = String(body).replace(/^#{1,6}\s+.*\n?/, "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const dot = flat.indexOf(". ");
  const raw = dot > 20 ? flat.slice(0, dot + 1) : flat;
  return raw.length > limit ? raw.slice(0, limit - 1).trimEnd() + "…" : raw;
}

// What the block costs before any conditional fold is surfaced: the framing,
// every always-on body, and the full index naming every folded rule. This is
// the floor a turn starts from, and if the floor is already over budget no
// amount of per-turn skipping can save it. Measured by asking the real gate
// with a cue that matches nothing, so the number is the gate's own arithmetic
// rather than a second copy of it that can drift.
function baseBlockTokens(folds, budgetTokens) {
  if (!folds.length) return 0;
  const probe = createInstructionGate({ folds, budgetTokens });
  return probe.gate({ question: " " }).stats.blockTokens;
}

// Segment, merge and label one candidate granularity. Split out from
// `compileInstructionFolds` so the fit loop can try several.
function buildFolds(source, { maxFolds, maxFoldTokens, idPrefix, budgetTokens }) {
  const sections = splitSections(source);
  let pieces = [];
  for (const section of sections) {
    const parts = splitOversized(source, section.start, section.end, maxFoldTokens);
    parts.forEach((part, partIndex) => {
      pieces.push({ ...section, start: part.start, end: part.end, partIndex, partCount: parts.length });
    });
  }
  const beforeMerge = pieces.length;
  pieces = mergeToFit(pieces, source, maxFolds);

  // The preamble — whatever the reader wrote before their first heading — is
  // the closest thing to "rules that always apply", so it is always-on when it
  // is small enough to afford. When it is not, it is folded like everything
  // else and the report says so rather than letting it silently vanish.
  const preambleBudget = Math.floor(budgetTokens / 2);
  let preambleTokens = 0;
  for (const p of pieces) if (p.preamble) preambleTokens += countTokens(source.slice(p.start, p.end));
  const preambleAlwaysOn = preambleTokens > 0 && preambleTokens <= preambleBudget;

  const bodies = pieces.map((p) => source.slice(p.start, p.end).trim());
  const wordLists = bodies.map((b) => words(b));

  const folds = [];
  const unroutable = [];
  const partCounter = new Map();

  pieces.forEach((piece, i) => {
    const body = bodies[i];
    if (!body) return;
    const titleTerms = words(piece.title || "");
    const baseSlug = slugify(piece.title, piece.preamble ? "preamble" : `section-${i + 1}`);
    const seen = partCounter.get(baseSlug) || 0;
    partCounter.set(baseSlug, seen + 1);
    const id = `${idPrefix}-${String(i + 1).padStart(3, "0")}-${baseSlug}${seen ? `-part${seen + 1}` : ""}`;
    const always = piece.preamble ? preambleAlwaysOn : false;
    const signals = always ? [] : deriveSignals(wordLists, i, titleTerms);

    // R3 — a conditional fold with no signals can never be surfaced: it is a
    // wall, not a gap-in-waiting. Rather than drop the reader's text or fail
    // the whole compile, such a fold is promoted to always-on and named in the
    // report, so it is still in force and the reader can see why.
    if (!always && signals.length === 0) {
      unroutable.push(id);
      folds.push({
        id, title: piece.title || "Instructions", always: true, weight: 0,
        signals: [], fingerprint: firstSentence(body), body,
      });
      return;
    }

    folds.push({
      id,
      title: piece.title || (piece.preamble ? "Project instructions (preamble)" : "Instructions"),
      always,
      // Every part of a split section shares its signals, so they tie on score
      // and the tie-break decides which one the reader actually gets. It must
      // favour the HEAD: a section states its rule first and elaborates
      // afterwards, so surfacing part 3 over part 1 hands the model the
      // commentary and withholds the rule. Measured on exactly that — a refund
      // section whose "fourteen days from dispatch" sat in part 1 while part 3
      // (smaller, so it fit) was the one surfaced.
      weight: piece.preamble ? 100 : Math.max(0, 10 - (piece.level || 1)) - (piece.partIndex || 0) * 0.01,
      signals,
      // A continuation's fingerprint is redundant — it names the same section
      // as its head — and the index is charged for every one of them. Naming
      // it as a continuation keeps R4 satisfied (the fold is still listed and
      // still identified) at a fraction of the tokens, which is budget that
      // goes back to surfacing actual rules.
      fingerprint: piece.partIndex
        ? `(continues ${piece.title || "the previous fold"}, part ${piece.partIndex + 1})`
        : firstSentence(body),
      body,
    });
  });

  return { folds, unroutable, beforeMerge, pieces, preambleAlwaysOn, preambleTokens };
}

/**
 * Compile free-form instruction text into gate folds.
 *
 * @param {string} text            the reader's instructions, verbatim
 * @param {object} [opts]
 * @param {number} [opts.budgetTokens]  the gate budget these folds will face
 * @param {string} [opts.idPrefix]      namespace for fold ids
 * @returns {{folds: object[], report: object}}
 */
export function compileInstructionFolds(text, { budgetTokens = DEFAULT_INSTRUCTION_BUDGET, idPrefix = "proj" } = {}) {
  const source = String(text ?? "");
  const trimmed = source.trim();
  if (!trimmed) {
    return { folds: [], report: { mode: "empty", totalTokens: 0, folds: 0, alwaysOn: 0, conditional: 0, budgetTokens } };
  }

  const totalTokens = countTokens(source);

  // Short enough to hand over whole: no folding, no signals, no index. Folding
  // exists to fit a budget — applying it to text that already fits would hide
  // rules behind a relevance test for no reason, and a rule the reader wrote
  // that never surfaces is worse than one they can see is long.
  if (totalTokens <= budgetTokens) {
    return {
      folds: [{
        id: `${idPrefix}-all`,
        title: "Project instructions",
        always: true,
        weight: 100,
        signals: [],
        fingerprint: firstSentence(source),
        body: source.trim(),
      }],
      report: {
        mode: "whole",
        reason: `The instructions are ${totalTokens} tokens, within the ${budgetTokens}-token budget, so all of them are in force on every turn — nothing is folded.`,
        totalTokens, folds: 1, alwaysOn: 1, conditional: 0, budgetTokens,
      },
    };
  }

  // Granularity is chosen by MEASURING the resulting block, not by predicting
  // it. The first version estimated an index line at a fixed token cost and
  // was wrong by a factor of three — fingerprints are longer than ids — so a
  // 10 960-token corpus produced a 453-token block against a 400-token budget:
  // an R5 overflow introduced by the very code meant to prevent one. The
  // estimate is now only a starting point; the real gate is asked what the
  // block actually costs, and granularity coarsens until it fits. Measuring
  // beats predicting for the same reason the rest of this codebase prefers it.
  let { maxFolds, maxFoldTokens } = budgetGeometry(budgetTokens);
  let built = buildFolds(source, { maxFolds, maxFoldTokens, idPrefix, budgetTokens });
  let fitAttempts = 0;
  while (baseBlockTokens(built.folds, budgetTokens) > budgetTokens && maxFolds > 2 && fitAttempts < 8) {
    maxFolds = Math.max(2, Math.floor(maxFolds * 0.6));
    built = buildFolds(source, { maxFolds, maxFoldTokens, idPrefix, budgetTokens });
    fitAttempts++;
  }
  const { folds, unroutable, beforeMerge, pieces, preambleAlwaysOn, preambleTokens } = built;

  // R1 is a property of this function's OUTPUT, so it is asserted here rather
  // than trusted: every body must be findable, character for character, in
  // what the reader wrote. A segmentation bug that silently altered an
  // instruction would produce a model obeying a rule nobody authored, which is
  // the precise failure the law exists to forbid.
  for (const fold of folds) {
    if (!source.includes(fold.body)) {
      throw new Error(`project-instructions: fold ${fold.id} is not a verbatim slice of the source (R1)`);
    }
  }

  const alwaysOn = folds.filter((f) => f.always).length;

  // A fold larger than what the gate could ever spend on one body cannot be
  // surfaced, which would make it a wall (R3). That is a real limit of trying
  // to fit this much instruction into this small a budget, and the honest
  // response is to report it — with the remedy — not to let the reader believe
  // a rule is in force that can never appear.
  const oversized = folds.filter((f) => !f.always && countTokens(f.body) > maxFoldTokens).map((f) => f.id);

  return {
    folds,
    report: {
      mode: "folded",
      reason: `The instructions are ${totalTokens} tokens, over the ${budgetTokens}-token budget, so they are folded: the relevant sections are given to the model verbatim each turn and the rest are listed by name.`,
      totalTokens,
      folds: folds.length,
      alwaysOn,
      conditional: folds.length - alwaysOn,
      budgetTokens,
      preambleAlwaysOn,
      preambleTokens,
      // Granularity is derived from the budget so that every fold can still be
      // named in the index (R4) without the block overrunning it (R5).
      maxFolds,
      maxFoldTokens,
      merged: beforeMerge > pieces.length ? beforeMerge - pieces.length : 0,
      // Named, not silent: these had no distinctive terms to route on, so they
      // are always in force instead of being unreachable.
      unroutable,
      oversized,
      ...(oversized.length ? {
        warning: `${oversized.length} fold(s) are larger than the ${maxFoldTokens}-token ceiling one fold may spend, so they cannot be surfaced at this budget. Raise the instruction budget or split these sections with more headings.`,
      } : {}),
    },
  };
}
