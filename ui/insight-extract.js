// insight-extract.js — the extraction and key-matching core of Community
// Insights, mirrored into the browser so ingesting a document never
// requires a reachable proxy.
//
// server/insight-store.js's InsightStore persists to disk and needs Node,
// but the actual "read a document, guess which facts are which standardized
// key, decide confident-merge vs. needs-review" logic underneath it touches
// nothing but strings — no fs, no network. Every function below is that
// logic, copied unchanged from server/insight-store.js (same names, same
// regexes, same thresholds) so a raw key merges onto the exact same
// canonical key whether a project has an engine behind it or is running
// standalone — GitHub Pages (see .github/workflows/deploy-pages.yml, which
// ships the ui/ directory alone and nothing else), `npm run ui`, or any
// other static hosting with no proxy at all. webllm-client.js and
// file-formats.js already work this way for chat and file reading; this is
// the same treatment for Community Insights.
//
// Loaded as a plain <script type="module">, published on
// window.EOInsightExtract for the same reason as EOFormats/EOWebLLM: the
// dc-runtime Component in index.html is eval'd as a plain script and cannot
// `import`. The localStorage-backed store built on top of this (standing in
// for insight-store.js's registry.json/observations.json) lives in
// index.html itself, next to the offline fallbacks it already has for
// projects and project instructions.
//
// Keep this behaviorally identical to server/insight-store.js's own copy —
// a fix made to one and not the other is a fact that would merge two
// different ways depending on whether the proxy happened to be running.

// ── Key normalization & fuzzy matching ──────────────────────────────────────
//
// Two keys are the "same" if, after stripping case/punctuation/diacritics
// down to a bag of words, they overlap enough (Jaccard over tokens) — cheap,
// dependency-free, and good enough to tell "affordable housing units" from
// "affordable housing target" (different denominators) while still catching
// "Aff. Housing Units" as the same thing as "affordable housing units."

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

// Below this, a raw key is treated as having no plausible relationship to an
// existing canonical key at all — offering it as a "candidate" would be
// noise, not help.
export const CANDIDATE_THRESHOLD = 0.34;
// At or above this, two labels are close enough that requiring a human to
// confirm the merge would be friction without value — "Aff. Housing Units"
// vs "affordable housing units" territory.
export const AUTO_MERGE_THRESHOLD = 0.72;
export const MAX_CANDIDATES = 4;

/**
 * Compare a raw key string against a registry's canonical keys (each
 * `{ key, label, aliases }`). Returns:
 *   { status: 'exact',      key, score: 1 }
 *   { status: 'auto',       key, score }        — confident fuzzy match
 *   { status: 'candidates', candidates: [...] } — plausible but unconfirmed
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

  const scored = registryKeys.map((k) => {
    const names = [k.label, ...(k.aliases || [])];
    let score = 0;
    for (const n of names) score = Math.max(score, jaccardSimilarity(rawKey, n));
    return { key: k.key, label: k.label, score };
  }).filter((s) => s.score >= CANDIDATE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { status: "unclear", candidates: [] };
  if (scored[0].score >= AUTO_MERGE_THRESHOLD) {
    return { status: "auto", key: scored[0].key, score: scored[0].score };
  }
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
export function asOfSortKey(asOf) {
  if (!asOf) return "";
  const s = String(asOf);
  if (/^\d{4}$/.test(s)) return `${s}-99-99`; // a bare year is "as of end of that year"
  return s;
}

// ── Section-kind / date-prefix detection for extraction ─────────────────────

const KIND_SIGNALS = {
  goal: [/\bgoals?\b/i, /\btargets?\b/i, /\bobjectives?\b/i, /\bplan(ned)?\b/i, /\baims?\b/i, /\bby 20\d\d\b/i],
  current_state: [/\bcurrent(ly)?\b/i, /\bbaseline\b/i, /\bas[- ]of\b/i, /\bstatus\b/i, /\btoday\b/i, /\bexisting\b/i, /\bpresent state\b/i],
  intervention_metric: [/\bintervention/i, /\bmetrics?\b/i, /\bprogram(me)?s?\b/i, /\boutcomes?\b/i, /\bkpis?\b/i, /\bindicators?\b/i],
  definition: [/\bdefinitions?\b/i, /\bdefined as\b/i, /\bglossary\b/i, /\bterms?\b/i],
};

function detectSectionKind(line) {
  const isHeader = /^#{1,6}\s+/.test(line)
    || (line === line.toUpperCase() && /[A-Z]/.test(line) && line.trim().length > 2 && line.trim().length < 80 && !/[.!?]$/.test(line.trim()));
  if (!isHeader) return null;
  for (const [kind, patterns] of Object.entries(KIND_SIGNALS)) {
    if (patterns.some((p) => p.test(line))) return kind;
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
 * (the same plain text file-formats.js's extraction already produced from a
 * PDF/DOCX/XLSX/etc — this module never parses document bytes itself).
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
    facts.push({ rawKey: key, rawValue: value, kind: kind || null, quote, line: lineNo, asOfYear });
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

const EOInsightExtract = {
  normalizeKeyText, jaccardSimilarity, matchKey, slugifyKey,
  parseValue, sameValue, asOfSortKey, extractCandidateFacts,
  CANDIDATE_THRESHOLD, AUTO_MERGE_THRESHOLD, MAX_CANDIDATES,
};

if (typeof window !== "undefined") window.EOInsightExtract = EOInsightExtract;
export default EOInsightExtract;
