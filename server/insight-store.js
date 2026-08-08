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
import { fileURLToPath } from "node:url";
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
// eoreader5's referents/discover-cast.js solves the sibling problem for
// character names ("Victor" / "Victor Frankenstein" / "Frankenstein" are one
// referent) with a structural containment test (namesCorefer) that auto-
// merges. An earlier version of this module ported that rule directly —
// wrong, on eoreader6's own more considered position, not just a different
// vintage of the same codebase. eoreader6's referents/consequence.js retired
// appearance-based identity entirely for its harder version of this exact
// problem (binding two surfaces to one being): "No stem table, no edit
// distance, no transliteration. Not even here." Its own measured reason: a
// containment-shaped merge rule pooled two DIFFERENTLY-admitted brothers
// (Juhani, Tuomas) as readily as it bound one brother's own two halves —
// appearance-matching cannot tell a real match from a false one, only a
// statistical test of real, independent evidence can (segregation +
// displacement against a bootstrapped null, in that module's case).
//
// This module has no equivalent evidence to test against — a canonical key's
// label is a persisted name, not a surface with arrival positions in a
// reading, so consequence.js's actual statistical machinery has no input
// here. What transfers is the PRINCIPLE it was built to enforce: containment
// is still appearance-matching, and appearance-matching produces false
// merges. So the tier line here is stricter than the first draft's:
//
//   AUTO-APPLY — ONLY literal identity after normalization (case/punctuation/
//   diacritics stripped). This is not an inference about meaning; it is the
//   same short-circuit consequence.js's own identityByConsequence makes
//   before doing any statistical work at all ("if (surfaceA === surfaceB)
//   return relation: 'same'"). Two spellings of literally the same text are
//   the same key; nothing else is auto-merged.
//
//   CANDIDATE — everything else: structural containment (keysStructurallyCorefer,
//   kept as a ranking/labeling signal — "this generic-word-excluded token set
//   is a real signal, worth ranking first"), Jaccard overlap, or anything a
//   model proposes (see proposeFactsWithModel below). ALL of these require a
//   human to confirm via resolveKey() before anything merges — never applied
//   silently, matching discover-cast.js's own explicit rule for its
//   MODEL-tier descriptor synonymy ("an identity is a declaration about
//   SPECIFIC surfaces... a caller declaring one is asserting it on the
//   record") and, more strongly, consequence.js's later refusal to trust
//   appearance for its ENGINE-tier problem either.
//
//   AMBIGUOUS — a raw key that structurally correferes with MORE than one
//   canonical key is never assigned to either; both are offered as
//   candidates. Same as discover-cast.js's clusterSurfaces refusing to
//   assign "Prince" to whichever matching prince sorted first.

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
 * A structural containment test — do these two label strings share a
 * significant (non-generic) token as a subset relationship. "Affordable
 * Housing Units" contains "Housing Units"; "Housing Units" and "Broadband
 * Units" do not corefer, because their only shared token ("units") is
 * generic. Kept as a RANKING signal (a structural match is offered as the
 * top candidate) — never as a merge trigger. See the tier note above for why
 * this stops short of auto-applying, unlike eoreader5's namesCorefer.
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
 *   { status: 'exact',      key, score: 1 }             — literal identity after normalization; the only thing safe to apply without a human
 *   { status: 'candidates', candidates: [...] }         — plausible but unconfirmed (structural containment, ranked first and flagged `structural: true`, and/or Jaccard overlap)
 *   { status: 'unclear',    candidates: [] }             — nothing plausible found
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

  const structural = new Set(registryKeys.filter((k) =>
    keysStructurallyCorefer(rawKey, k.label) || (k.aliases || []).some((a) => keysStructurallyCorefer(rawKey, a))
  ).map((k) => k.key));

  const scored = registryKeys.map((k) => {
    const names = [k.label, ...(k.aliases || [])];
    let score = 0;
    for (const n of names) score = Math.max(score, jaccardSimilarity(rawKey, n));
    return { key: k.key, label: k.label, score, structural: structural.has(k.key) };
  }).filter((s) => s.structural || s.score >= CANDIDATE_THRESHOLD)
    .sort((a, b) => (b.structural - a.structural) || (b.score - a.score));

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

// ── Section-kind / date-prefix detection for extraction ─────────────────────
//
// A fact's kind (goal/current_state/intervention_metric/definition) is set
// ONLY from what the document itself structurally declares — a header, a
// table column name, a "By <year>" prefix — never from scoring a sentence's
// own words. An earlier version of this module did the latter: a hand-
// authored strong/weak keyword vocabulary with log1p-damped, amplitude-
// scored "confidence," modelled on eoreader5's cube/index.js terrain
// classifier. That model's own repo (`CUBE.md`, eoreader6) records why it
// was removed from that engine's runtime entirely rather than merely
// softened: "shuffling words inside 2,527 paragraphs left 95.7% of cell
// assignments unchanged... It is not resurrected here. It is promoted out
// of the code." The identical control run against this module's own
// classifier reproduced the same signature (7 of 8 real sentences kept an
// IDENTICAL kind label after a full word-order-destroying shuffle) — a
// keyword scan cannot distinguish real prose from a meaningless scramble of
// the same words, because it never looks at anything but word presence. It
// is not resurrected here either.
//
// A short, author-written HEADER is a different kind of object than a
// scored sentence: its role is literally to declare what follows, the same
// status a table's own column name already gets here. Matching a header's
// text against a small set of section-title words is reading what the
// author wrote, not inferring semantics from word frequency — kept for that
// reason, while the sentence-level fallback is not.
//
// THE WORDS THEMSELVES ARE A LANGUAGE PRIOR, NOT ENGINE VOCABULARY. A first
// version of this hard-coded one English word list (goal/target/objective,
// current state/baseline/status, ...) directly into this module — the exact
// failure A2/L7 already name for a different organ ("a module being
// legitimately scoped to one language... while its own documentation stays
// silent about that scope"), except this one did not even disclose the
// scope: a real Spanish plan (Málaga's 'Plan Municipal de Vivienda y Suelo')
// declares its goals section 'OBJETIVOS' and its strategic-action sections
// 'ESTRATEGIA 1..5'; a real French PLH (Plaine Commune's 2022-2027 synthesis)
// declares its own goals/targets 'ORIENTATIONS' and its current-state
// section 'DIAGNOSTIC' — none of those survive an English-only regex, and
// "goals may never ever be called goals": the literal string is never a
// safe universal signal, in ANY one language, for a semantic category.
//
// Re-earned on corpus.js's own pattern (loadAbbreviationPrior): `language` is
// RECEIVED, never inferred (SEED.md #1, Amendment V) — a caller that knows
// the document's language passes it, and a NAMED, SOURCED prior
// (bin/priors/insight-kind-vocab/<language>.json, provenance.source required,
// same discipline as bin/priors/lang/*.json) supplies that language's own
// words for each kind. No language declared, or no prior exists for the one
// declared: kind stays an honest null, exactly like any other undeclared
// structural signal — never a silent fall-through to English.
const KIND_VOCAB_PRIORS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "priors", "insight-kind-vocab");
const kindVocabCache = new Map();

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadKindVocabPrior(language) {
  if (!language) return null;
  if (kindVocabCache.has(language)) return kindVocabCache.get(language);
  const file = path.join(KIND_VOCAB_PRIORS_ROOT, `${language}.json`);
  let result = null;
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw.schema !== "InsightKindVocabPrior@1") {
      throw new TypeError(`loadKindVocabPrior: expected InsightKindVocabPrior@1, got ${raw.schema}`);
    }
    if (!raw.provenance?.source) throw new TypeError("loadKindVocabPrior: a prior must name its giver");
    const patterns = {};
    for (const [kind, terms] of Object.entries(raw.vocab || {})) {
      if (!terms.length) continue;
      patterns[kind] = new RegExp(`\\b(${terms.map(escapeRegExp).join("|")})\\b`, "iu");
    }
    result = { language: raw.language, giver: raw.provenance.source, patterns };
  }
  kindVocabCache.set(language, result);
  return result;
}

// A header's SHAPE (short, standalone, not sentence-punctuated) is language-
// general — Unicode letter classes, no English-specific assumption. What the
// shape-matched line is DECLARING is a separate question, answered only when
// a language-specific vocab prior is available (see above); a header with no
// matching prior is still recognized as a header (sectionKind stays at
// whatever it already was), it just contributes no NEW kind signal.
function isHeaderShaped(line) {
  const trimmed = line.trim();
  if (trimmed.length <= 2 || trimmed.length >= 80) return false;
  if (/[.!?]$/.test(trimmed)) return false;
  if (/^#{1,6}\s+/.test(line)) return true;
  return trimmed === trimmed.toUpperCase() && /\p{Lu}/u.test(trimmed) && !/\p{Ll}/u.test(trimmed);
}

function detectSectionKind(line, language) {
  if (!isHeaderShaped(line)) return null;
  const prior = loadKindVocabPrior(language);
  if (!prior) return null;
  for (const [kind, pattern] of Object.entries(prior.patterns)) {
    if (pattern.test(line)) return kind;
  }
  return null;
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

// Strips a TRAILING "by <year>" clause from an already-split VALUE ("500 by
// 2030" -> "500", year 2030) — the mirror image of extractYearPrefix's
// leading clause, and at least as common in practice: found on real sample
// data that "Affordable housing units: 500 by 2030" (the value carrying its
// own year) is a far more natural way to write a plan goal than "By 2030:
// Affordable housing units = 500" (the line carrying it). Without this,
// "500 by 2030" fails parseValue's number pattern outright (the trailing
// digits aren't valid unit text) and silently becomes type "text" — which
// then makes a goal-vs-current delta report "type-mismatch" even though
// both sides are plainly numbers.
function extractTrailingYear(value) {
  const m = value.match(/^(.*\S)\s+by\s+(?:the\s+year\s+)?(\d{4})\.?$/i);
  if (m) return { value: m[1], year: parseInt(m[2], 10) };
  return { value, year: null };
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
 *
 * `language`: RECEIVED from the caller, never inferred (see detectSectionKind
 * above) — the header words that mean "goal"/"current state"/etc. are a
 * per-language prior, not a fact this module derives from the text itself.
 * Omitted: header text still contributes no kind signal at all (an honest
 * gap), never a silent assumption that the document is in English.
 */
export function extractCandidateFacts(text, { defaultKind = null, language = null } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const facts = [];
  let sectionKind = defaultKind;
  let tableHeader = null;

  const pushKV = (rawKey, rawValue, kind, quote, lineNo, asOfYear = null) => {
    const key = String(rawKey || "").trim();
    let value = String(rawValue || "").trim();
    if (!key || !value) return;
    if (key.length > 100 || value.length > 200) return;

    // A leading year (extractYearPrefix, applied by the caller before this
    // point) always wins if present; otherwise check the value itself for a
    // trailing "by <year>" clause — see extractTrailingYear's header. Either
    // way the stored VALUE is the clean number/text, never the raw line —
    // `quote` below still carries the full original line for the audit trail.
    let finalAsOfYear = asOfYear;
    if (!finalAsOfYear) {
      const trailing = extractTrailingYear(value);
      if (trailing.year) { value = trailing.value; finalAsOfYear = trailing.year; }
    }

    // `kind` is whatever structural signal is in force (a header, a table
    // column, a "By <year>" prefix, or the document-level default the
    // caller chose) — trusted as-is. When none of those set anything, kind
    // is an honest null rather than a guess from the line's own words —
    // see this section's header for why a sentence-level fallback was
    // removed rather than kept as a softer "advisory" signal.
    facts.push({ rawKey: key, rawValue: value, kind: kind || null, quote, line: lineNo, asOfYear: finalAsOfYear });
  };

  lines.forEach((raw, i) => {
    const trimmed = raw.replace(/\s+$/, "").trim();
    if (!trimmed) { tableHeader = null; return; }

    const sk = detectSectionKind(trimmed, language);
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
      const kindPrior = loadKindVocabPrior(language);
      // The KIND a target/current column implies is read from the SAME
      // per-language prior detectSectionKind uses, never a second,
      // independently-hardcoded English word list — a document in a
      // language with no prior loaded gets no target/current column split at
      // all (targetIdx/currentIdx below both stay -1), rather than silently
      // matching English words against non-English column headers.
      //
      // keyIdx (which column holds the ROW LABEL, not a kind) is still an
      // English-only heuristic and a known, disclosed scope limit, not yet
      // fixed here: it decides a structural role ("which column names the
      // thing"), not a semantic kind, so it was out of scope for this pass,
      // but it is the same class of bug and should move to a per-language
      // prior too.
      const keyIdx = tableHeader.findIndex((h) => /key|indicator|metric|item|measure|name/i.test(h));
      // A goal/target-named column wins over a current/baseline-named one
      // when a row has both (e.g. "Indicator | Baseline | Target") — the
      // plan's target is the more informative single value to extract, and
      // the baseline is still visible via the quote for anyone who reads it.
      const targetIdx = kindPrior?.patterns.goal
        ? tableHeader.findIndex((h) => kindPrior.patterns.goal.test(h))
        : -1;
      const currentIdx = kindPrior?.patterns.current_state
        ? tableHeader.findIndex((h) => kindPrior.patterns.current_state.test(h))
        : -1;
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
      // A "By <year>" / "(<year>)" prefix names a POINT IN TIME, not a kind —
      // an earlier version defaulted a dated-but-otherwise-unsignaled line to
      // "goal" (the hardcoded English assumption "anything with a target year
      // must be a goal"), which is exactly as unearned as matching the literal
      // word "goal" would be, and wrong on its face for a dated current-state
      // line ("By 2024, current population reached 45,000"). asOfYear is
      // recorded either way; kind still comes only from sectionKind.
      pushKV(m[1], m[2], sectionKind, trimmed, i + 1, year);
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

    if (!kind) {
      rejected.push({ reason: "model gave no valid kind (goal/current_state/intervention_metric/definition) for this candidate", candidate: c });
      continue;
    }

    proposed.push({
      rawKey, rawValue: value, kind,
      // The model's claimed kind is its own semantic judgment about a real,
      // grounded quote — not a structural fact the document declares (a
      // header, a table column). It is deliberately NOT mechanically cross-
      // checked: an earlier version of this function scored the quote
      // against a hand-authored keyword vocabulary and overrode the model on
      // disagreement, which is the same measured-and-refuted mechanism
      // extractCandidateFacts's header explains removing — a keyword scan is
      // not a check, it is a second guess no more grounded than the first.
      // The model's claim stands on its own, same tier as its rawKey→
      // canonical-key guess, and needs the same human confirmation.
      kindConfident: false,
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
   *
   * `language` (e.g. "en", "es", "fr"): the document's declared language,
   * used only to pick which per-language kind-vocabulary prior
   * (server/priors/insight-kind-vocab/<language>.json) reads header/column
   * words like "goal"/"objetivos"/"orientations" — never inferred from the
   * text. Omitted, or no prior exists yet for the language given: headers
   * and table columns still contribute no kind signal, exactly the same
   * honest gap as a document with no headers at all.
   */
  async ingestDocument(projectId, { text, kind = null, asOf = null, sourceId = null, sourceName = null, useModel = false, callModel = null, language = null } = {}) {
    return this.#withLock(projectId, async () => {
      const registry = await this.#readRegistry(projectId);
      const obsStore = await this.#readObservations(projectId);
      // `language` is RECEIVED from the caller (the upload form, an API
      // client that already knows what it's uploading) — never inferred from
      // the text here. Omitted, header/table-column kind words contribute no
      // signal at all rather than assuming English; see detectSectionKind's
      // header for why.
      const heuristicFacts = extractCandidateFacts(text, { defaultKind: kind, language });

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

        if (match.status === "exact") {
          obsKey = match.key;
          keyStatus = "resolved";
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
          // `fact.kind` is set ONLY from a real structural signal (a header,
          // a table column, a "By <year>" prefix) or the document-level kind
          // the caller declared — never a guess from the sentence's own
          // words (see extractCandidateFacts's header on why). No signal at
          // all means an honest gap: kind stays null, kindStatus 'unclear',
          // symmetric with an unresolved key. A model-proposed fact's kind
          // (fact.kindConfident === false, see proposeFactsWithModel) is
          // present but still 'unclear' — a real claim, not yet confirmed.
          kind: fact.kind || null,
          kindStatus: (fact.kind && fact.kindConfident !== false) ? "resolved" : "unclear",
          extractionMethod: fact.extractionMethod || "heuristic",
          rawKey: fact.rawKey,
          key: obsKey,
          keyStatus,
          candidates,
          value: fact.rawValue,
          parsed,
          asOf: fact.asOfYear ? String(fact.asOfYear) : asOf,
          // No mechanical signal in a document's text reliably answers
          // "whose definition/authority is this" — jurisdiction is never
          // guessed here, only ever declared (addObservation, or a future
          // human review pass), same discipline as `language`/`kind`. An
          // honest null, not an assumption of "whatever this project's
          // other facts happen to be under."
          jurisdiction: null,
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
  /**
   * `jurisdiction`: the body/authority a fact is defined or reported under
   * (e.g. "HUD", "City of Houston", "24 CFR 91.5") — declared by the human
   * entering this observation, never guessed. There is no mechanical way to
   * derive "whose definition is this" from a sentence's own wording, the
   * same reasoning `language` and `kind` already rest on elsewhere in this
   * module: an honest null (see defineTerm()) beats a plausible-looking
   * guess about authority.
   */
  async addObservation(projectId, { key = null, rawKey, kind, value, asOf = null, sourceId = null, sourceName = null, quote = null, jurisdiction = null } = {}) {
    return this.#withLock(projectId, async () => {
      const registry = await this.#readRegistry(projectId);
      const obsStore = await this.#readObservations(projectId);
      const now = new Date().toISOString();

      let obsKey = key, keyStatus = "resolved", candidates = [];
      if (!obsKey) {
        const match = matchKey(rawKey, registry.keys);
        if (match.status === "exact") { obsKey = match.key; }
        else { keyStatus = "unclear"; candidates = match.candidates || []; }
      } else if (!registry.keys.some((k) => k.key === obsKey)) {
        throw new Error(`unknown key: ${obsKey}`);
      }

      const parsed = parseValue(value);
      const observation = {
        id: newId(), projectId, kind,
        // A human typing this in has already decided what kind it is —
        // always 'resolved', the same way a manual key mapping never goes
        // through the structural/fuzzy candidate tiers matchKey applies to
        // extracted text.
        kindStatus: "resolved", extractionMethod: "manual",
        rawKey: rawKey || (registry.keys.find((k) => k.key === obsKey)?.label) || obsKey,
        key: obsKey, keyStatus, candidates, value, parsed, asOf, jurisdiction,
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
      const bucketKey = `${o.key} ${o.kind} ${asOfBucket}`;
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

  /**
   * defineTerm: what does this term actually mean, per whom, as of when —
   * for a term directly, not only for a metric that happens to reference it.
   *
   * A goal or current-state NUMBER is not evidence on its own — "affordable
   * housing units: 500" means nothing without knowing what counts as
   * "affordable," under whose definition, and whether that definition is
   * still the one in force. This looks up every `definition`-kind
   * observation for `term`, by the SAME two-tier discipline every other
   * lookup in this module uses: an EXACT normalized match (the term itself,
   * or a raw key already seen with identical normalized text) is returned
   * directly; anything looser (structural/Jaccard) is offered as
   * `candidates` — "did you mean" — never silently folded into the result,
   * for the same reason matchKey() never auto-merges on a fuzzy score.
   *
   * `conflicting: true` means more than one DISTINCT definition text is on
   * file for this term — surfaced, never resolved by picking one, mirroring
   * conflicts() for metrics. A reader comparing a "goal" of 500 units across
   * two documents needs to know if those two documents were even using the
   * same definition of "unit."
   */
  async defineTerm(projectId, term) {
    const registry = await this.#readRegistry(projectId);
    const obsStore = await this.#readObservations(projectId);
    const norm = normalizeKeyText(term);
    const match = matchKey(term, registry.keys);

    const defs = obsStore.observations.filter((o) => {
      if (o.kind !== "definition") return false;
      if (normalizeKeyText(o.rawKey) === norm) return true;
      if (match.status === "exact" && o.keyStatus === "resolved" && o.key === match.key) return true;
      return false;
    }).sort((a, b) => asOfSortKey(a.asOf).localeCompare(asOfSortKey(b.asOf)));

    const distinct = [];
    for (const d of defs) {
      if (!distinct.some((x) => normalizeKeyText(x.value) === normalizeKeyText(d.value))) distinct.push(d);
    }

    return {
      term,
      matchedKey: match.status === "exact" ? match.key : null,
      candidates: match.status === "candidates" ? match.candidates : [],
      definitions: defs.map((d) => ({
        observationId: d.id, value: d.value, quote: d.quote,
        sourceId: d.sourceId, sourceName: d.sourceName,
        asOf: d.asOf, jurisdiction: d.jurisdiction ?? null,
      })),
      conflicting: distinct.length > 1,
    };
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

      // A metric with no linked definition, or with disagreeing ones on
      // file, is flagged rather than silently listed — the number above
      // means nothing without knowing what it measures and whether every
      // source measuring it meant the same thing (see defineTerm()'s header).
      const distinctDefinitions = [];
      for (const d of definitions) {
        if (!distinctDefinitions.some((x) => normalizeKeyText(x.value) === normalizeKeyText(d.value))) distinctDefinitions.push(d);
      }

      return {
        key: entry.key, label: entry.label, category: entry.category, unit: entry.unit, directionality: entry.directionality,
        goal: goalOut, goalConflict: goal.conflict,
        current: currentOut, currentConflict: current.conflict,
        delta, deltaStatus, progress,
        definitions: definitions.map((d) => ({
          id: d.id, value: d.value, sourceId: d.sourceId, sourceName: d.sourceName, quote: d.quote,
          asOf: d.asOf, jurisdiction: d.jurisdiction ?? null,
        })),
        definitionsConflict: distinctDefinitions.length > 1,
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
