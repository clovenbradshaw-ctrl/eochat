// Insight store — a community-insights ledger that sits next to a project's
// document corpus rather than inside it.
//
// The corpus (engine-ground.js) answers "what does the text say, verbatim,
// with a citation." This module answers a different question a plan document
// also carries: "what does this document claim about a STANDARD, STRUCTURED
// fact — a goal, a current state, a definition, an intervention metric — and
// how does that compare to what other documents (or the same document at a
// different time) claim about the same fact."
//
// Two problems make that hard and both are handled explicitly rather than
// papered over:
//
//   1. KEY DRIFT. One plan calls it "affordable housing units," another
//      "affordable units target," a spreadsheet column header calls it
//      "Aff. Housing." These are the same standard key wearing different
//      clothes. matchKey()/resolveKey() merge them under one canonical key —
//      but only when the match is confident. A raw key with no confident
//      match is never silently guessed into the wrong bucket: it is recorded
//      as unclear, with its candidates, and stays that way until a human
//      resolves it (see unclearKeys()/resolveKey()).
//
//   2. CONFLICTING SIGNALS. Two documents (or two rows of the same document)
//      can state different values for what is, after merging, the same key at
//      the same point in time. That is not an error to hide by picking one —
//      it is a fact about the evidence, surfaced by conflicts()/state() so a
//      reader sees both values and where each came from.
//
// Once keys are merged and conflicts are visible, the delta a community plan
// exists to produce falls out mechanically: goal value vs. current value
// (deltaReport()), or current value at one time vs. another (history()).
//
// Storage: one directory per project under memory/insights/<projectId>/ —
// registry.json (the canonical key table) and observations.json (every
// extracted or hand-entered fact, provenance included). Same one-file-per-
// entity-plus-atomic-write discipline as project-store.js/submission-store.js.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";
// Grounding verification for model-proposed facts (proposeFactsWithModel,
// below) reuses this app's own citation-fidelity primitives — the exact
// check LAWS.md L8c requires of a model's chat answer ("every apparent
// quotation... checked against the real source bytes... before being
// shown") applied here to a model's proposed fact instead of its prose.
// Not reinvented: normalizeForFidelity is the one whitespace/quote-mark
// normalization this app uses everywhere a quote is compared to source
// text, and quoteOccursIn is the same case-tolerant substring test
// verifyQuotedFidelity uses on a chat answer's citations.
import { normalizeForFidelity, quoteOccursIn } from "./citation-check.js";

export const INSIGHTS_DIR = path.join(MEMORY_DIR, "insights");

function newId(prefix = "obs") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, file);
}

// ── Key normalization & term binding ────────────────────────────────────────
//
// This is the same problem eoreader5's referents/discover-cast.js solves for
// character names ("Victor" / "Victor Frankenstein" / "Frankenstein" are one
// referent), and it draws the identical tier line rather than a fresh one:
//
//   ENGINE-tier — a STRUCTURAL test (token containment, excluding the generic
//   words a whole document's vocabulary shares) — is the only thing allowed
//   to auto-merge without a human. discover-cast.js's namesCorefer is
//   "containment, or a shared final token (surname)" with an explicit carve-
//   out that a shared LEADING token never merges ("Prince Andrew"/"Prince
//   Vasili" share an honorific, not an identity). Community-plan vocabulary
//   has the mirror-image failure mode at the TRAILING position instead of the
//   leading one — "Affordable Housing Units" and "Broadband Access Units"
//   share only the generic measurement noun "units" — so the excluded set
//   here is GENERIC_TERM_WORDS rather than a leading-honorific list, but the
//   discipline is the same rule, ported to this domain's own vocabulary
//   (constitution amendment A7: same mechanism, native vocabulary per medium).
//
//   MODEL/STATISTICAL-tier — Jaccard overlap, or anything a model proposes —
//   NEVER auto-merges, no matter how high the score. discover-cast.js's own
//   header is explicit about why: "It also must not be applied blindly...
//   an identity is a declaration about SPECIFIC surfaces, never a rule about
//   a token, and a caller declaring one is asserting it on the record." A
//   fuzzy score is offered as a `candidate` for a human (or a model's
//   explicitly-attributed, always-reviewable suggestion — see
//   proposeFactsWithModel below) to confirm, never applied silently. The
//   previous version of this module auto-merged on Jaccard alone above a
//   hand-set 0.72 threshold — exactly the "blind" application the tier line
//   forbids — and is corrected here.
//
//   AMBIGUOUS — a raw key that structurally correferes with MORE than one
//   canonical key is never assigned to either. discover-cast.js's
//   clusterSurfaces does the same for "Prince" matching several princes:
//   dropped to a gap, not guessed into whichever candidate sorted first.

export function normalizeKeyText(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSet(s) {
  return new Set(normalizeKeyText(s).split(" ").filter(Boolean));
}

export function jaccardSimilarity(a, b) {
  const ta = tokenSet(a), tb = tokenSet(b);
  if (!ta.size && !tb.size) return 1;
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

// Generic measurement/plan vocabulary that recurs across genuinely different
// standard keys ("units", "rate", "target", "current") — a shared token from
// this set is never, by itself, evidence that two raw keys name the same
// thing. Deliberately short and reviewable, the same spirit as
// discover-cast.js excluding a shared honorific: this is a fact about
// community-plan document vocabulary, asserted here by name, not derived.
const GENERIC_TERM_WORDS = new Set([
  "units", "unit", "rate", "rates", "percent", "percentage", "pct",
  "count", "counts", "number", "numbers", "level", "levels", "index",
  "total", "totals", "amount", "amounts", "score", "scores", "share",
  "ratio", "target", "targets", "goal", "goals", "value", "values",
  "metric", "metrics", "current", "baseline", "status", "result", "results",
]);

function significantTokens(s) {
  const out = new Set();
  for (const t of tokenSet(s)) if (!GENERIC_TERM_WORDS.has(t)) out.add(t);
  return out;
}

/**
 * The engine-tier structural test: do these two label strings name the same
 * standard key by containment — one's significant token set is a subset of
 * the other's — requiring at least one shared token that ISN'T generic
 * measurement vocabulary. "Affordable Housing Units" contains "Housing
 * Units" — but "Housing Units" and "Broadband Units" do not corefer, because
 * their only shared token ("units") is generic. Mechanical, deterministic,
 * safe to apply without asking — the ONLY thing that produces an "auto" match.
 */
export function keysStructurallyCorefer(a, b) {
  const sa = significantTokens(a), sb = significantTokens(b);
  if (!sa.size || !sb.size) return false;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  if (shared === 0) return false;
  const subset = [...sa].every((t) => sb.has(t)) || [...sb].every((t) => sa.has(t));
  return subset;
}

// Below this, a raw key is treated as having no plausible relationship to an
// existing canonical key at all — offering it as a "candidate" would be
// noise, not help. Never a merge trigger by itself — see the tier note above.
export const CANDIDATE_THRESHOLD = 0.34;
export const MAX_CANDIDATES = 4;

/**
 * Compare a raw key string against a registry's canonical keys (each
 * `{ key, label, aliases }`). Returns:
 *   { status: 'exact',      key, score: 1 }
 *   { status: 'auto',       key, score: 1, reason: 'structural' } — mechanical containment match, safe to apply without asking
 *   { status: 'candidates', candidates: [...] } — plausible but unconfirmed (fuzzy score, OR a structural match against more than one key — ambiguous, never guessed)
 *   { status: 'unclear',    candidates: [] }    — nothing plausible found
 */
export function matchKey(rawKey, registryKeys) {
  const norm = normalizeKeyText(rawKey);
  if (!norm) return { status: "unclear", candidates: [] };

  for (const k of registryKeys) {
    if (normalizeKeyText(k.label) === norm) return { status: "exact", key: k.key, score: 1 };
    for (const alias of k.aliases || []) {
      if (normalizeKeyText(alias) === norm) return { status: "exact", key: k.key, score: 1 };
    }
  }

  const structural = registryKeys.filter((k) =>
    keysStructurallyCorefer(rawKey, k.label) || (k.aliases || []).some((a) => keysStructurallyCorefer(rawKey, a))
  );
  if (structural.length === 1) {
    return { status: "auto", key: structural[0].key, score: 1, reason: "structural" };
  }

  const scored = registryKeys.map((k) => {
    const names = [k.label, ...(k.aliases || [])];
    let score = 0;
    for (const n of names) score = Math.max(score, jaccardSimilarity(rawKey, n));
    return { key: k.key, label: k.label, score };
  }).filter((s) => s.score >= CANDIDATE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (structural.length > 1) {
    // Ambiguous structural match — "Prince" matching several princes.
    // Surfaced as candidates (structural ones ranked first, score 1) rather
    // than guessed into whichever sorted first.
    const structuralCandidates = structural.map((k) => ({ key: k.key, label: k.label, score: 1 }));
    const rest = scored.filter((s) => !structural.some((k) => k.key === s.key));
    return { status: "candidates", candidates: [...structuralCandidates, ...rest].slice(0, MAX_CANDIDATES) };
  }

  if (!scored.length) return { status: "unclear", candidates: [] };
  return { status: "candidates", candidates: scored.slice(0, MAX_CANDIDATES) };
}

// A canonical key slug derived from a label, for when resolveKey() is asked
// to CREATE a new canonical key rather than map to an existing one.
export function slugifyKey(label) {
  const norm = normalizeKeyText(label).replace(/\s+/g, "_");
  return norm || `key_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Value parsing ────────────────────────────────────────────────────────
//
// A value is only ever compared to another value of the same PARSED type —
// two "text" values compare by equality, two "number"/"percent"/"currency"
// values compare arithmetically, and a type mismatch is reported as exactly
// that rather than coerced into a false answer.

export function parseValue(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { type: "empty", text: "" };

  let m = s.match(/^(-?[\d,]+(?:\.\d+)?)\s*%$/);
  if (m) return { type: "percent", number: parseFloat(m[1].replace(/,/g, "")), unit: "%", text: s };

  m = s.match(/^\$\s*(-?[\d,]+(?:\.\d+)?)\s*(k|thousand|m|million|b|billion)?$/i);
  if (m) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[(m[2] || "").toLowerCase()];
    if (mult) n *= mult;
    return { type: "currency", number: n, unit: "$", text: s };
  }

  // A bare 4-digit (optionally full-date) number is far more likely a year
  // than a count in a plan document's value column, so this is checked
  // before the generic number pattern below — otherwise "2030" would parse
  // as the number 2030 and never as the date it almost always means here.
  m = s.match(/^(\d{4})(?:[-\/](\d{1,2})(?:[-\/](\d{1,2}))?)?$/);
  if (m) return { type: "date", year: parseInt(m[1], 10), text: s };

  m = s.match(/^(-?[\d,]+(?:\.\d+)?)\s*([a-zA-Z][a-zA-Z /_-]{0,24})?$/);
  if (m) {
    const unit = (m[2] || "").trim();
    return { type: "number", number: parseFloat(m[1].replace(/,/g, "")), unit: unit || null, text: s };
  }

  if (/^(yes|true|complete(d)?|done|met|achieved|on track)$/i.test(s)) return { type: "boolean", bool: true, text: s };
  if (/^(no|false|incomplete|not met|unmet|off track|pending|not started)$/i.test(s)) return { type: "boolean", bool: false, text: s };

  return { type: "text", text: s };
}

// Two parsed values are "the same value" if types and content agree —
// numeric types tolerate float noise, everything else is exact.
export function sameValue(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (["number", "percent", "currency"].includes(a.type)) {
    if ((a.unit || null) !== (b.unit || null)) return false;
    return Math.abs((a.number ?? NaN) - (b.number ?? NaN)) < 1e-9;
  }
  if (a.type === "date") return a.year === b.year;
  if (a.type === "boolean") return a.bool === b.bool;
  return normalizeKeyText(a.text) === normalizeKeyText(b.text);
}

// A sort key for "most recent" — a bare 4-digit year, an ISO-ish date, or an
// explicit asOf string all compare sensibly as strings once padded; missing
// asOf sorts before anything dated, since an undated claim should never win a
// tie against a dated one purely by string luck.
function asOfSortKey(asOf) {
  if (!asOf) return "";
  const s = String(asOf);
  if (/^\d{4}$/.test(s)) return `${s}-99-99`; // a bare year is "as of end of that year"
  return s;
}

// ── Kind classification — STRONG/WEAK evidence amplitudes ───────────────────
//
// Ported from eoreader5's cube/index.js terrain classifier (see its own
// header): score every candidate kind against a STRONG vocabulary (terms
// that specifically denote it) and a WEAK one (terms that co-occur with it
// but are common in running prose), damp repeated hits with log1p so a word
// used many times doesn't linearly dominate, and take amplitudes across ALL
// kinds at once rather than a first-match cascade. The prior version of this
// module was exactly the cascade cube's own header documents as the failure
// it replaced: a first-pattern-wins scan over section headers only, with no
// signal at all once a line has no header above it. Notably, cube/index.js's
// own "Kind" terrain vocabulary (type|kind|category|class|definition|
// species) and its "DEF" operator (define|declare|specify|stipulate) are,
// almost verbatim, this module's "definition" kind — real evidence this
// tier-of-evidence approach generalizes past the terrain/stance/operator
// dimensions cube was built for, to a fourth: what KIND OF CLAIM a sentence
// in a plan document is making.
//
// cube/index.js's own header calls its outputs advisory: "may inform
// display, ordering, or a prior weight. They may NEVER gate, veto, route, or
// address." Applied identically here — see classifyFactKind's `confident`
// field and its caller in extractCandidateFacts, which records a fact's kind
// as `kindStatus: 'unclear'` rather than trusting a coin-flip margin whenever
// no header/table/date-prefix structural signal set it directly.

const WEAK_KIND_WEIGHT = 0.15;

const KIND_TERMS = {
  goal: {
    strong: /\b(goals?|targets?|objectives?|aims?|aspires?|committed?\s+to|by\s+20\d\d)\b/gi,
    weak: /\b(plan(ned)?|will|shall|intends?|hopes?\s+to|seeks?\s+to)\b/gi,
  },
  current_state: {
    strong: /\b(current(ly)?|baseline|as[- ]of|status\s+quo|present\s+state|today)\b/gi,
    weak: /\b(now|existing|reported|observed|measured)\b/gi,
  },
  intervention_metric: {
    strong: /\b(interventions?|kpis?|indicators?|program(me)?s?|initiatives?)\b/gi,
    weak: /\b(outcomes?|metrics?|effort|activit(?:y|ies)|service)\b/gi,
  },
  definition: {
    strong: /\b(definitions?|defined\s+as|glossary|means?\s+(?:the|a|an)\b|refers?\s+to|is\s+defined)\b/gi,
    weak: /\b(terms?|denotes?|constitutes?)\b/gi,
  },
};

const hits = (t, re) => (t.match(re) ?? []).length;

function kindEvidence(t, { strong, weak }) {
  return Math.log1p(hits(t, strong)) + WEAK_KIND_WEIGHT * Math.log1p(hits(t, weak));
}

/**
 * classifyFactKind(text) -> { kind, confident, amplitudes }
 *
 * `kind` is the argmax kind, or null when there is no evidence at all for
 * any kind — never a silent default. `amplitudes` is every kind's share of
 * the total evidence, strongest first, for a caller that wants to show its
 * reasoning rather than just the winner. `confident` requires the winner to
 * hold both a real plurality (>=0.4) AND a real margin over the runner-up
 * (>=0.15) — a winner at 0.26 against three others at ~0.24 each is
 * "ahead" but not decisive, and is treated as no signal, not as this kind.
 */
export function classifyFactKind(text) {
  const t = String(text ?? "");
  const scored = Object.entries(KIND_TERMS).map(([kind, terms]) => ({ kind, score: kindEvidence(t, terms) }));
  const total = scored.reduce((s, r) => s + r.score, 0);
  const amplitudes = scored
    .map((r) => ({ kind: r.kind, amplitude: total > 0 ? r.score / total : 0 }))
    .sort((a, b) => b.amplitude - a.amplitude);

  if (total === 0) return { kind: null, confident: false, amplitudes };
  const top = amplitudes[0], second = amplitudes[1];
  const confident = top.amplitude >= 0.4 && (top.amplitude - (second?.amplitude ?? 0)) >= 0.15;
  return { kind: top.kind, confident, amplitudes };
}

// ── Section-kind / date-prefix detection for extraction ─────────────────────

function detectSectionKind(line) {
  const isHeader = /^#{1,6}\s+/.test(line)
    || (line === line.toUpperCase() && /[A-Z]/.test(line) && line.trim().length > 2 && line.trim().length < 80 && !/[.!?]$/.test(line.trim()));
  if (!isHeader) return null;
  // A header is short, high-signal, DELIBERATE text — treated as a
  // structural override the same way a table column header is: its
  // classification is trusted at whatever margin it has, not held to the
  // 0.4/0.15 bar a bare sentence needs (see classifyFactKind).
  return classifyFactKind(line).kind;
}

// Strips a leading "By 2030", "As of 2024", "(2026)" clause and reports the
// year it names — the single most common way a plan document ties a fact to
// a point in time inline rather than in a section header.
function extractYearPrefix(line) {
  let m = line.match(/^(?:by|as of|as at)\s+(\d{4})\s*[,:]?\s*(.*)$/i);
  if (m) return { year: parseInt(m[1], 10), rest: m[2] };
  m = line.match(/^\((\d{4})\)\s*(.*)$/);
  if (m) return { year: parseInt(m[1], 10), rest: m[2] };
  return { year: null, rest: line };
}

function splitDelimitedRow(line) {
  if (/^\|.*\|$/.test(line)) {
    return line.split("|").slice(1, -1).map((c) => c.trim());
  }
  if (line.includes("\t")) {
    return line.split("\t").map((c) => c.trim()).filter((c, i, arr) => !(i === arr.length - 1 && c === ""));
  }
  return null;
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c) || c === "");
}

// A tab-separated row (the shape a DOCX/ODT table cell-join produces, with no
// markdown separator convention to lean on) is a HEADER only when it reads
// like column labels — short, non-numeric, and naming something this module
// recognizes — never merely because it's the first row seen. A plan document
// with no header row at all (just "Key<TAB>Value" per line) is the common
// case, not the exception, and must still extract directly rather than
// having its first data row eaten as a false header.
function looksLikeHeaderRow(cells) {
  if (cells.some((c) => !c || c.length > 24 || /\d/.test(c))) return false;
  return cells.some((c) => /key|indicator|metric|item|measure|name|value|target|goal|current|status|result|baseline/i.test(c));
}

/**
 * Best-effort structured-fact extraction from already-decoded document text
 * (the same plain text file-formats.js/engine ingestion already produced from
 * a PDF/DOCX/XLSX/etc — this module never parses document bytes itself).
 *
 * Returns candidate facts: `{ rawKey, rawValue, kind, asOfYear, quote, line }`.
 * `kind` is null when no section/sentence signal named one — callers should
 * fall back to a caller-supplied default kind (e.g. "this whole upload is a
 * goals document") rather than guessing further here.
 */
export function extractCandidateFacts(text, { defaultKind = null } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const facts = [];
  let sectionKind = defaultKind;
  let tableHeader = null;

  const pushKV = (rawKey, rawValue, kind, quote, lineNo, asOfYear = null) => {
    const key = String(rawKey || "").trim();
    const value = String(rawValue || "").trim();
    if (!key || !value) return;
    if (key.length > 100 || value.length > 200) return;

    // `kind` here is already a structural decision (a header, a table
    // column, a "By <year>" prefix, or the document-level default the
    // caller chose) — trusted as-is, same as detectSectionKind's header
    // handling. Only when NONE of those set anything does this fall back to
    // classifyFactKind's sentence-level evidence, and that fallback is the
    // one case tagged with its own confidence for ingestDocument to act on.
    let finalKind = kind || null;
    let kindConfident = !!kind;
    let kindAmplitudes = null;
    if (!finalKind) {
      const classified = classifyFactKind(quote);
      finalKind = classified.kind;
      kindConfident = classified.confident;
      kindAmplitudes = classified.amplitudes;
    }
    facts.push({ rawKey: key, rawValue: value, kind: finalKind, kindConfident, kindAmplitudes, quote, line: lineNo, asOfYear });
  };

  lines.forEach((raw, i) => {
    const trimmed = raw.replace(/\s+$/, "").trim();
    if (!trimmed) { tableHeader = null; return; }

    const sk = detectSectionKind(trimmed);
    if (sk) { sectionKind = sk; tableHeader = null; return; }

    const cells = splitDelimitedRow(trimmed);
    const isPipeRow = /^\|.*\|$/.test(trimmed);
    if (cells && cells.length >= 2) {
      if (isPipeRow && isSeparatorRow(cells)) return;
      if (!tableHeader) {
        // Markdown pipe tables always open with a header row by convention;
        // a tab-separated row only counts as one if its own text looks like
        // column labels (see looksLikeHeaderRow) — otherwise it's data.
        if (isPipeRow || looksLikeHeaderRow(cells)) { tableHeader = cells; return; }
        pushKV(cells[0], cells[cells.length - 1], sectionKind, trimmed, i + 1);
        return;
      }
      const keyIdx = tableHeader.findIndex((h) => /key|indicator|metric|item|measure|name/i.test(h));
      // A goal/target-named column wins over a current/baseline-named one
      // when a row has both (e.g. "Indicator | Baseline | Target") — the
      // plan's target is the more informative single value to extract, and
      // the baseline is still visible via the quote for anyone who reads it.
      const targetIdx = tableHeader.findIndex((h) => /target|goal/i.test(h));
      const currentIdx = tableHeader.findIndex((h) => /current|baseline|status|result/i.test(h));
      const kI = keyIdx >= 0 ? keyIdx : 0;
      const vI = targetIdx >= 0 ? targetIdx : (currentIdx >= 0 ? currentIdx : (kI === 1 ? 0 : 1));
      let rowKind = sectionKind;
      if (vI === targetIdx && targetIdx >= 0) rowKind = "goal";
      else if (vI === currentIdx && currentIdx >= 0) rowKind = "current_state";
      pushKV(cells[kI], cells[vI], rowKind, trimmed, i + 1);
      return;
    }
    tableHeader = null;

    const { year, rest } = extractYearPrefix(trimmed);
    const bulletStripped = rest.replace(/^[-*•]\s+/, "");

    let m = bulletStripped.match(/^([A-Za-z][\w /()'".,-]{1,90}?)\s*[:=]\s*(\S.{0,180})$/);
    if (!m) m = bulletStripped.match(/^([A-Za-z][\w /()'".,-]{1,90}?)\s+[–—-]\s+(\S.{0,180})$/);
    if (m) {
      pushKV(m[1], m[2], year ? (sectionKind || "goal") : sectionKind, trimmed, i + 1, year);
    }
  });

  return facts;
}

// ── Model-assisted extraction ───────────────────────────────────────────────
//
// The heuristic pass above is precise but narrow: real community plans are
// mostly prose ("the city aims to increase affordable housing stock by 40%
// by 2030 through zoning reform"), and a sentence like that has no colon, no
// table, no header naming it — extractCandidateFacts finds nothing there.
// This is a second, optional pass that asks a model to find what the
// heuristics missed, but it is bound by the same discipline LAWS.md L8
// requires of the chat pipeline's own tool loop: the model may propose, it
// may never be the mechanical merge step (L8a/L8b — every proposed fact's
// key still resolves through the exact same matchKey() every heuristic fact
// does), and every apparent quotation it produces is verified against the
// real source bytes before being trusted at all (L8c) — a candidate whose
// quote cannot be found verbatim in the source is rejected outright and
// reported as rejected, never silently dropped or silently kept.
//
// `callModel(prompt) -> Promise<string>` is injected by the caller (see
// server/proxy.js's insights/ingest route) exactly the way turn-generation.js
// and conversation-summary.js already take their model call as a parameter
// rather than reaching for a provider themselves — this module stays
// testable with a stub and provider-agnostic.

const MODEL_EXTRACT_MAX_CHARS = 6000;
const MODEL_EXTRACT_VALID_KINDS = new Set(["goal", "current_state", "intervention_metric", "definition"]);

function buildModelExtractPrompt(text, heuristicFacts, sourceLabel) {
  const already = heuristicFacts.slice(0, 30).map((f) => `- ${f.rawKey}: ${f.rawValue}`).join("\n") || "(none found yet)";
  return [
    `You are extracting structured facts from a community/organizational plan document${sourceLabel ? ` ("${sourceLabel}")` : ""}.`,
    `A mechanical first pass already found these facts from clearly-labeled lines/tables — do NOT repeat any of them:`,
    already,
    ``,
    `Read the document text below and find ADDITIONAL facts stated in ordinary prose (sentences, not tables) about:`,
    `- goal: a target the plan sets ("aims to increase X by 40% by 2030")`,
    `- current_state: a present/baseline fact ("as of 2024, X stands at Y")`,
    `- intervention_metric: a program/initiative's measured effect`,
    `- definition: what a term means in this document`,
    ``,
    `Respond with ONLY a JSON array, no prose, no markdown fences. Each item:`,
    `{"rawKey": "short label for the fact", "value": "the number/percent/text value", "kind": "goal|current_state|intervention_metric|definition", "quote": "the EXACT sentence or clause from the text below that states this, copied verbatim, word for word"}`,
    `The "quote" field is checked against the source text — if it is not an exact substring, the fact is discarded. Do not paraphrase the quote.`,
    `If you find nothing beyond what was already listed, respond with [].`,
    ``,
    `DOCUMENT TEXT:`,
    text,
  ].join("\n");
}

function parseModelExtractJson(raw) {
  const text = String(raw ?? "").trim();
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return null;
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * proposeFactsWithModel(text, opts) -> { proposed, rejected, truncated, truncatedChars }
 *
 * `opts.callModel` is required. `opts.heuristicFacts` (from
 * extractCandidateFacts) is shown to the model so it looks for what that
 * pass missed rather than re-finding the same lines. Every accepted fact in
 * `proposed` carries `extractionMethod: 'model'` and has already had its
 * quote verified against `text` — nothing in `proposed` is unverified.
 * `rejected` lists every candidate the model returned that did NOT verify,
 * each with why, so a caller can disclose rather than silently drop them.
 */
export async function proposeFactsWithModel(text, { callModel, heuristicFacts = [], sourceLabel = null, maxChars = MODEL_EXTRACT_MAX_CHARS } = {}) {
  if (typeof callModel !== "function") throw new TypeError("proposeFactsWithModel requires a callModel(prompt) function");

  const fullText = String(text || "");
  const truncated = fullText.length > maxChars;
  const sent = truncated ? fullText.slice(0, maxChars) : fullText;
  const sourceForVerification = normalizeForFidelity(fullText);

  const prompt = buildModelExtractPrompt(sent, heuristicFacts, sourceLabel);
  const raw = await callModel(prompt);
  const candidates = parseModelExtractJson(raw);

  if (candidates === null) {
    return { proposed: [], rejected: [{ reason: "model response was not a parseable JSON array", raw: String(raw ?? "").slice(0, 500) }], truncated, truncatedChars: truncated ? fullText.length - maxChars : 0 };
  }

  const proposed = [];
  const rejected = [];
  for (const c of candidates) {
    const rawKey = String(c?.rawKey ?? "").trim();
    const value = String(c?.value ?? "").trim();
    const quote = String(c?.quote ?? "").trim();
    let kind = String(c?.kind ?? "").trim();

    if (!rawKey || !value || !quote) {
      rejected.push({ reason: "missing rawKey/value/quote", candidate: c });
      continue;
    }
    if (!MODEL_EXTRACT_VALID_KINDS.has(kind)) kind = null;

    // The non-negotiable check (LAWS.md L2f/L8c): the quote must be a real,
    // literal substring of the source text. quoteOccursIn tolerates only a
    // leading-character case flip (house-style capitalization), never a
    // deeper mismatch — the same tolerance verifyQuotedFidelity gives a
    // chat answer's citations, no looser.
    const quoteNorm = normalizeForFidelity(quote);
    if (!quoteNorm || !quoteOccursIn(sourceForVerification, quoteNorm)) {
      rejected.push({ reason: "quote not found verbatim in the source document — likely fabricated", candidate: c });
      continue;
    }

    // The model's claimed kind is cross-checked against the SAME mechanical
    // classifier a heuristic-only fact would get, using the quote itself
    // (real source text, not the model's paraphrase of it). Agreement, or a
    // mechanical signal that itself isn't confident, trusts the model's
    // kind. A CONFIDENT mechanical disagreement is real counter-evidence and
    // downgrades the fact to kindStatus 'unclear' rather than picking a side.
    const mechanical = classifyFactKind(quote);
    let kindConfident = true;
    if (kind && mechanical.confident && mechanical.kind !== kind) kindConfident = false;
    if (!kind) { kind = mechanical.kind; kindConfident = mechanical.confident; }
    if (!kind) {
      rejected.push({ reason: "no kind could be determined (model gave none and the quote has no mechanical kind signal)", candidate: c });
      continue;
    }

    proposed.push({
      rawKey, rawValue: value, kind, kindConfident,
      kindAmplitudes: mechanical.amplitudes, modelKind: c?.kind ?? null, mechanicalKind: mechanical.kind,
      quote, line: null, asOfYear: null, extractionMethod: "model",
    });
  }

  return { proposed, rejected, truncated, truncatedChars: truncated ? fullText.length - maxChars : 0 };
}

// ── InsightStore ─────────────────────────────────────────────────────────

export class InsightStore {
  constructor({ dir = INSIGHTS_DIR } = {}) {
    this.dir = dir;
    this._locks = new Map();
  }

  #projectDir(projectId) { return path.join(this.dir, projectId); }
  #registryFile(projectId) { return path.join(this.#projectDir(projectId), "registry.json"); }
  #observationsFile(projectId) { return path.join(this.#projectDir(projectId), "observations.json"); }

  async #withLock(projectId, fn) {
    const prior = this._locks.get(projectId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this._locks.set(projectId, prior.then(() => gate));
    await prior;
    try { return await fn(); }
    finally { release(); }
  }

  async #readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch (err) {
      if (err.code === "ENOENT" || err instanceof SyntaxError) return fallback;
      throw err;
    }
  }

  async #readRegistry(projectId) {
    return this.#readJson(this.#registryFile(projectId), { projectId, keys: [] });
  }

  async #readObservations(projectId) {
    return this.#readJson(this.#observationsFile(projectId), { projectId, observations: [] });
  }

  async #writeRegistry(projectId, registry) {
    await writeAtomic(this.#registryFile(projectId), JSON.stringify(registry, null, 2));
  }

  async #writeObservations(projectId, store) {
    await writeAtomic(this.#observationsFile(projectId), JSON.stringify(store, null, 2));
  }

  /** Canonical key table for a project, as-is. */
  async listKeys(projectId) {
    const registry = await this.#readRegistry(projectId);
    return registry.keys;
  }

  /** Create a canonical key directly (no raw-key resolution involved). */
  async createKey(projectId, { key, label, category = null, unit = null, directionality = "unknown" } = {}) {
    return this.#withLock(projectId, async () => {
      const registry = await this.#readRegistry(projectId);
      const finalKey = key || slugifyKey(label);
      if (registry.keys.some((k) => k.key === finalKey)) {
        throw new Error(`key already exists: ${finalKey}`);
      }
      const entry = {
        key: finalKey, label: label || finalKey, category, unit, directionality,
        aliases: [], createdAt: new Date().toISOString(),
      };
      registry.keys.push(entry);
      registry.projectId = projectId;
      await this.#writeRegistry(projectId, registry);
      return entry;
    });
  }

  /**
   * Edit a canonical key's own metadata — label, category, unit, or the
   * directionality that makes progress() meaningful. Never touches aliases
   * or any observation; those are unaffected by what a key is CALLED or
   * which way is good, only by which raw texts merge into it.
   */
  async updateKey(projectId, key, { label, category, unit, directionality } = {}) {
    return this.#withLock(projectId, async () => {
      const registry = await this.#readRegistry(projectId);
      const entry = registry.keys.find((k) => k.key === key);
      if (!entry) throw new Error(`unknown key: ${key}`);
      if (label !== undefined) entry.label = label;
      if (category !== undefined) entry.category = category;
      if (unit !== undefined) entry.unit = unit;
      if (directionality !== undefined) entry.directionality = directionality;
      registry.projectId = projectId;
      await this.#writeRegistry(projectId, registry);
      return entry;
    });
  }

  /**
   * Ingest already-extracted document text as a batch of observations.
   * `kind` is the document-level default (e.g. this whole upload is a plan's
   * "goal" section) — a heading or "By <year>" prefix inside the text can
   * still override it per-fact. Returns a summary plus every observation
   * created, so a caller can show exactly what was recorded and what needs
   * attention (LAWS.md-style: nothing here should surprise the reader later).
   *
   * `useModel`/`callModel`: when set, runs proposeFactsWithModel() after the
   * heuristic pass to catch prose the heuristics can't parse (see that
   * function's header). The two passes are ALWAYS reported separately in the
   * returned `heuristic`/`model` summaries — never blended into one
   * undifferentiated count (LAWS.md L7: disclose scope, don't blend
   * silently). If `useModel` is requested but `callModel` fails or is
   * missing, ingestion still completes with the heuristic results and
   * `model.ran === false` names why, rather than silently returning fewer
   * facts than a caller who asked for the model pass would expect.
   */
  async ingestDocument(projectId, { text, kind = null, asOf = null, sourceId = null, sourceName = null, useModel = false, callModel = null } = {}) {
    return this.#withLock(projectId, async () => {
      const registry = await this.#readRegistry(projectId);
      const obsStore = await this.#readObservations(projectId);
      const heuristicFacts = extractCandidateFacts(text, { defaultKind: kind });

      let modelFacts = [];
      let modelSummary = null;
      if (useModel) {
        if (typeof callModel !== "function") {
          modelSummary = { ran: false, error: "model-assisted extraction was requested but no model call is configured" };
        } else {
          try {
            const result = await proposeFactsWithModel(text, { callModel, heuristicFacts, sourceLabel: sourceName });
            modelFacts = result.proposed;
            modelSummary = {
              ran: true, proposed: result.proposed.length, rejected: result.rejected.length,
              rejectedReasons: result.rejected.map((r) => r.reason),
              truncated: result.truncated, truncatedChars: result.truncatedChars,
            };
          } catch (err) {
            modelSummary = { ran: false, error: err.message };
          }
        }
      }

      const allFacts = [...heuristicFacts, ...modelFacts];
      const created = [];
      for (const fact of allFacts) {
        const match = matchKey(fact.rawKey, registry.keys);
        const now = new Date().toISOString();
        let obsKey = null, keyStatus, candidates = [];

        if (match.status === "exact" || match.status === "auto") {
          obsKey = match.key;
          keyStatus = "resolved";
          if (match.status === "auto") {
            const entry = registry.keys.find((k) => k.key === match.key);
            if (entry && !entry.aliases.some((a) => normalizeKeyText(a) === normalizeKeyText(fact.rawKey))) {
              entry.aliases.push(fact.rawKey);
            }
          }
        } else if (match.status === "candidates") {
          keyStatus = "unclear";
          candidates = match.candidates;
        } else {
          keyStatus = "unclear";
          candidates = [];
        }

        const parsed = parseValue(fact.rawValue);
        const observation = {
          id: newId(),
          projectId,
          kind: fact.kind || kind || "current_state",
          // A fact whose kind came from a structural signal (header, table
          // column, date-prefix, or the model — cross-checked above) is
          // 'resolved'; one that fell back to classifyFactKind's sentence-
          // level guess without clearing its confidence bar is 'unclear' —
          // symmetric with keyStatus, and just as visible to a reviewer.
          kindStatus: fact.kindConfident === false ? "unclear" : "resolved",
          kindAmplitudes: fact.kindAmplitudes || null,
          extractionMethod: fact.extractionMethod || "heuristic",
          rawKey: fact.rawKey,
          key: obsKey,
          keyStatus,
          candidates,
          value: fact.rawValue,
          parsed,
          asOf: fact.asOfYear ? String(fact.asOfYear) : asOf,
          sourceId, sourceName,
          quote: fact.quote,
          line: fact.line,
          manual: false,
          createdAt: now,
          updatedAt: now,
        };
        obsStore.observations.push(observation);
        created.push(observation);
      }

      registry.projectId = projectId;
      obsStore.projectId = projectId;
      await this.#writeRegistry(projectId, registry);
      await this.#writeObservations(projectId, obsStore);

      return {
        added: created.length,
        unclear: created.filter((o) => o.keyStatus === "unclear").length,
        resolved: created.filter((o) => o.keyStatus === "resolved").length,
        kindUnclear: created.filter((o) => o.kindStatus === "unclear").length,
        heuristic: { added: heuristicFacts.length },
        model: modelSummary,
        observations: created,
      };
    });
  }

  /** Manually record a single fact — the correction path for what automatic extraction gets wrong or never sees at all. */
  async addObservation(projectId, { key = null, rawKey, kind, value, asOf = null, sourceId = null, sourceName = null, quote = null } = {}) {
    return this.#withLock(projectId, async () => {
      const registry = await this.#readRegistry(projectId);
      const obsStore = await this.#readObservations(projectId);
      const now = new Date().toISOString();

      let obsKey = key, keyStatus = "resolved", candidates = [];
      if (!obsKey) {
        const match = matchKey(rawKey, registry.keys);
        if (match.status === "exact" || match.status === "auto") { obsKey = match.key; }
        else { keyStatus = "unclear"; candidates = match.candidates || []; }
      } else if (!registry.keys.some((k) => k.key === obsKey)) {
        throw new Error(`unknown key: ${obsKey}`);
      }

      const parsed = parseValue(value);
      const observation = {
        id: newId(), projectId, kind,
        // A human typing this in has already decided what kind it is —
        // always 'resolved', the same way a manual key mapping never goes
        // through the fuzzy/structural tiers matchKey applies to extracted
        // text.
        kindStatus: "resolved", kindAmplitudes: null, extractionMethod: "manual",
        rawKey: rawKey || (registry.keys.find((k) => k.key === obsKey)?.label) || obsKey,
        key: obsKey, keyStatus, candidates, value, parsed, asOf,
        sourceId, sourceName, quote: quote || null, line: null,
        manual: true, createdAt: now, updatedAt: now,
      };
      obsStore.observations.push(observation);
      obsStore.projectId = projectId;
      await this.#writeObservations(projectId, obsStore);
      return observation;
    });
  }

  async removeObservation(projectId, observationId) {
    return this.#withLock(projectId, async () => {
      const obsStore = await this.#readObservations(projectId);
      const before = obsStore.observations.length;
      obsStore.observations = obsStore.observations.filter((o) => o.id !== observationId);
      await this.#writeObservations(projectId, obsStore);
      return { deleted: before !== obsStore.observations.length, id: observationId };
    });
  }

  async listObservations(projectId, { key, kind, keyStatus } = {}) {
    const obsStore = await this.#readObservations(projectId);
    return obsStore.observations.filter((o) =>
      (!key || o.key === key)
      && (!kind || o.kind === kind)
      && (!keyStatus || o.keyStatus === keyStatus)
    );
  }

  /**
   * Raw keys still awaiting a human decision. First grouped by EXACT
   * normalized text (precise), then those groups are clustered when two
   * distinct spellings structurally corefer (keysStructurallyCorefer — the
   * same engine-tier containment test matchKey() uses to auto-merge against
   * an EXISTING canonical key) — e.g. "Affordable Housing Units" and "Aff
   * Housing Units Total" appearing in the same document. This is the display
   * grouping counterpart of matchKey's auto tier: mechanical, never a fuzzy
   * score, so a row is only ever pre-merged here on the same structural
   * evidence that would have auto-merged it against a real canonical key.
   * Each row's `rawKeys` lists every distinct spelling folded in, so
   * resolveKey() can clear all of them at once.
   */
  async unclearKeys(projectId) {
    const obsStore = await this.#readObservations(projectId);
    const byNorm = new Map();
    for (const o of obsStore.observations) {
      if (o.keyStatus !== "unclear") continue;
      const norm = normalizeKeyText(o.rawKey);
      if (!byNorm.has(norm)) byNorm.set(norm, { rawKey: o.rawKey, candidates: o.candidates || [], observationIds: [], count: 0 });
      const g = byNorm.get(norm);
      g.observationIds.push(o.id);
      g.count++;
      if ((o.candidates || []).length > (g.candidates || []).length) g.candidates = o.candidates;
    }

    const clusters = [];
    for (const entry of byNorm.values()) {
      const home = clusters.find((cluster) =>
        cluster.members.some((m) => keysStructurallyCorefer(m.rawKey, entry.rawKey))
      );
      if (home) home.members.push(entry);
      else clusters.push({ members: [entry] });
    }

    return clusters.map((cluster) => {
      const members = cluster.members.slice().sort((a, b) => b.count - a.count);
      const candidateByKey = new Map();
      for (const m of members) {
        for (const c of m.candidates || []) {
          const existing = candidateByKey.get(c.key);
          if (!existing || c.score > existing.score) candidateByKey.set(c.key, c);
        }
      }
      return {
        rawKey: members[0].rawKey,
        rawKeys: members.map((m) => m.rawKey),
        count: members.reduce((sum, m) => sum + m.count, 0),
        candidates: [...candidateByKey.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES),
        observationIds: members.flatMap((m) => m.observationIds),
      };
    }).sort((a, b) => b.count - a.count);
  }

  /**
   * Resolve every observation whose raw key normalizes the same as any of
   * `rawKeys` (or the single `rawKey`, kept for callers with just one).
   * Either maps to `canonicalKey` (must already exist) or, when `createLabel`
   * is given instead, creates a brand-new canonical key from it. Every raw
   * text becomes an alias either way, so the next document using any of this
   * exact wording merges automatically instead of asking again.
   */
  async resolveKey(projectId, { rawKey = null, rawKeys = null, canonicalKey = null, createLabel = null, category = null, unit = null, directionality = "unknown" } = {}) {
    const keysToResolve = (rawKeys && rawKeys.length) ? rawKeys : (rawKey ? [rawKey] : []);
    if (!keysToResolve.length) throw new Error("resolveKey requires rawKey or rawKeys");

    return this.#withLock(projectId, async () => {
      const registry = await this.#readRegistry(projectId);
      const obsStore = await this.#readObservations(projectId);

      let targetKey = canonicalKey;
      if (!targetKey) {
        if (!createLabel) throw new Error("resolveKey requires canonicalKey or createLabel");
        targetKey = slugifyKey(createLabel);
        if (!registry.keys.some((k) => k.key === targetKey)) {
          registry.keys.push({
            key: targetKey, label: createLabel, category, unit, directionality,
            aliases: [], createdAt: new Date().toISOString(),
          });
        }
      }
      const entry = registry.keys.find((k) => k.key === targetKey);
      if (!entry) throw new Error(`unknown key: ${targetKey}`);

      const norms = new Set();
      for (const rk of keysToResolve) {
        norms.add(normalizeKeyText(rk));
        if (!entry.aliases.some((a) => normalizeKeyText(a) === normalizeKeyText(rk))) {
          entry.aliases.push(rk);
        }
      }

      let resolvedCount = 0;
      for (const o of obsStore.observations) {
        if (o.keyStatus === "unclear" && norms.has(normalizeKeyText(o.rawKey))) {
          o.key = targetKey;
          o.keyStatus = "resolved";
          o.candidates = [];
          o.updatedAt = new Date().toISOString();
          resolvedCount++;
        }
      }

      registry.projectId = projectId;
      obsStore.projectId = projectId;
      await this.#writeRegistry(projectId, registry);
      await this.#writeObservations(projectId, obsStore);
      return { key: targetKey, resolvedCount };
    });
  }

  /**
   * Conflicts: for a resolved (key, kind) pair, more than one DISTINCT parsed
   * value claimed for the same point in time (same asOf, or both undated —
   * an undated claim and a dated one are not compared, since the dated one
   * may simply supersede it). Every conflicting value keeps its source, so
   * the reader sees the disagreement instead of a silently-picked winner.
   */
  async conflicts(projectId) {
    const obsStore = await this.#readObservations(projectId);
    const buckets = new Map();
    for (const o of obsStore.observations) {
      if (o.keyStatus !== "resolved" || !o.key) continue;
      const asOfBucket = o.asOf || "—";
      const bucketKey = `${o.key} ${o.kind} ${asOfBucket}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, { key: o.key, kind: o.kind, asOf: o.asOf || null, observations: [] });
      buckets.get(bucketKey).observations.push(o);
    }
    const out = [];
    for (const bucket of buckets.values()) {
      const distinct = [];
      for (const o of bucket.observations) {
        if (!distinct.some((d) => sameValue(d.parsed, o.parsed))) distinct.push(o);
      }
      if (distinct.length > 1) {
        out.push({
          key: bucket.key, kind: bucket.kind, asOf: bucket.asOf,
          values: bucket.observations.map((o) => ({
            observationId: o.id, value: o.value, sourceId: o.sourceId, sourceName: o.sourceName, quote: o.quote,
          })),
        });
      }
    }
    return out;
  }

  // Picks the most-recent-by-asOf observation for a (key, kind); returns
  // null plus a conflict flag when the winner is ambiguous rather than
  // guessing among equally-dated, disagreeing claims.
  #pickLatest(observations, key, kind) {
    const matches = observations.filter((o) => o.key === key && o.kind === kind && o.keyStatus === "resolved");
    if (!matches.length) return { value: null, conflict: false, all: [] };
    const sorted = matches.slice().sort((a, b) => asOfSortKey(b.asOf).localeCompare(asOfSortKey(a.asOf)));
    const topAsOf = sorted[0].asOf || null;
    const tied = sorted.filter((o) => (o.asOf || null) === topAsOf);
    const distinctTied = [];
    for (const o of tied) if (!distinctTied.some((d) => sameValue(d.parsed, o.parsed))) distinctTied.push(o);
    if (distinctTied.length > 1) return { value: null, conflict: true, all: matches };
    return { value: sorted[0], conflict: false, all: matches };
  }

  /**
   * The merged view: for every canonical key, its current goal, its current
   * state, any linked intervention metrics, and the delta between goal and
   * current — the thing a community-insights reader actually wants ("are we
   * where the plan said we'd be").
   */
  async state(projectId) {
    const registry = await this.#readRegistry(projectId);
    const obsStore = await this.#readObservations(projectId);
    const all = obsStore.observations;

    return registry.keys.map((entry) => {
      const goal = this.#pickLatest(all, entry.key, "goal");
      const current = this.#pickLatest(all, entry.key, "current_state");
      const definitions = all.filter((o) => o.key === entry.key && o.kind === "definition" && o.keyStatus === "resolved");
      const interventions = all.filter((o) => o.key === entry.key && o.kind === "intervention_metric" && o.keyStatus === "resolved");

      let delta = null, deltaStatus = "no-data";
      if (goal.conflict || current.conflict) {
        deltaStatus = "conflict";
      } else if (goal.value && current.value) {
        const gv = goal.value.parsed, cv = current.value.parsed;
        if (["number", "percent", "currency"].includes(gv.type) && gv.type === cv.type) {
          if ((gv.unit || null) === (cv.unit || null)) {
            delta = { amount: cv.number - gv.number, pctOfGoal: gv.number !== 0 ? (cv.number / gv.number) * 100 : null };
            deltaStatus = "computed";
          } else {
            deltaStatus = "unit-mismatch";
          }
        } else if (gv.type === cv.type) {
          deltaStatus = sameValue(gv, cv) ? "met" : "differs";
        } else {
          deltaStatus = "type-mismatch";
        }
      } else if (goal.value && !current.value) {
        deltaStatus = "no-current-state";
      } else if (!goal.value && current.value) {
        deltaStatus = "no-goal";
      }

      // Whether the numbers moved the RIGHT way is a separate question from
      // whether a delta could be computed at all, and it is only answerable
      // when the key declares which direction is good — never guessed from
      // the key's name. "unknown" directionality (the default) always
      // yields progress: null rather than a fabricated verdict.
      let progress = null;
      if (deltaStatus === "computed" && (entry.directionality === "higher_is_better" || entry.directionality === "lower_is_better")) {
        const good = entry.directionality === "higher_is_better" ? delta.amount >= 0 : delta.amount <= 0;
        progress = good ? "on-track" : "off-track";
      }

      const goalOut = goal.value ? {
        observationId: goal.value.id, value: goal.value.value, parsed: goal.value.parsed, asOf: goal.value.asOf,
        sourceId: goal.value.sourceId, sourceName: goal.value.sourceName, quote: goal.value.quote,
      } : null;
      const currentOut = current.value ? {
        observationId: current.value.id, value: current.value.value, parsed: current.value.parsed, asOf: current.value.asOf,
        sourceId: current.value.sourceId, sourceName: current.value.sourceName, quote: current.value.quote,
      } : null;

      return {
        key: entry.key, label: entry.label, category: entry.category, unit: entry.unit, directionality: entry.directionality,
        goal: goalOut, goalConflict: goal.conflict,
        current: currentOut, currentConflict: current.conflict,
        delta, deltaStatus, progress,
        definitions: definitions.map((d) => ({ id: d.id, value: d.value, sourceId: d.sourceId, sourceName: d.sourceName, quote: d.quote })),
        interventions: interventions.map((iv) => ({ id: iv.id, value: iv.value, asOf: iv.asOf, sourceId: iv.sourceId, sourceName: iv.sourceName, quote: iv.quote })),
        signalCount: all.filter((o) => o.key === entry.key).length,
      };
    });
  }

  /** Only the keys where a goal-vs-current delta actually exists (or should, but can't be computed) — the report a plan-vs-reality reader wants first. */
  async deltaReport(projectId) {
    const rows = await this.state(projectId);
    return rows.filter((r) => r.goal || r.current);
  }

  /** Every resolved current_state observation for a key, oldest first — the time-over-time delta a reader gets by diffing consecutive entries themselves or via deltaBetween(). */
  async history(projectId, key, { kind = "current_state" } = {}) {
    const obsStore = await this.#readObservations(projectId);
    return obsStore.observations
      .filter((o) => o.key === key && o.kind === kind && o.keyStatus === "resolved")
      .sort((a, b) => asOfSortKey(a.asOf).localeCompare(asOfSortKey(b.asOf)));
  }

  /** Delta between the state nearest `from` and the state nearest `to` (each the latest observation at-or-before that point, falling back to the earliest available if nothing is that old). */
  async deltaBetween(projectId, key, { from, to, kind = "current_state" } = {}) {
    const hist = await this.history(projectId, key, { kind });
    if (!hist.length) return { from: null, to: null, delta: null, status: "no-data" };
    const nearestAtOrBefore = (point) => {
      const eligible = hist.filter((o) => asOfSortKey(o.asOf) <= asOfSortKey(point));
      return eligible.length ? eligible[eligible.length - 1] : hist[0];
    };
    const a = nearestAtOrBefore(from);
    const b = nearestAtOrBefore(to);
    if (a.id === b.id) return { from: a, to: b, delta: null, status: "same-observation" };
    if (["number", "percent", "currency"].includes(a.parsed.type) && a.parsed.type === b.parsed.type && (a.parsed.unit || null) === (b.parsed.unit || null)) {
      return { from: a, to: b, delta: { amount: b.parsed.number - a.parsed.number }, status: "computed" };
    }
    return { from: a, to: b, delta: null, status: sameValue(a.parsed, b.parsed) ? "unchanged" : "changed-non-numeric" };
  }
}

export const insightStore = new InsightStore();
