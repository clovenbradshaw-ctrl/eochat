// Mechanical, model-blind source diversity verification.
//
// The existing citation checks (citation-check.js) verify that every [n]
// resolves to a real passage and that the passage contains what the sentence
// claims. Neither check asks whether [1], [2], and [3] genuinely represent
// DIFFERENT sources of evidence.
//
// A model can cite three different brackets from the same chapter, the same
// page, or even three passages whose text is 90% identical, and the answer
// reads as "corroborated by three sources" when in reality it is one source
// wearing three hats. This file exists to detect that shape.
//
// What "legitimately differ" means, in mechanical terms:
//   Different source_id   — the most basic check
//   Different text        — two passages with >80% token overlap are the same
//                            evidence, different bracket numbers or not
//   Different source type  — corpus vs. web vs. uploaded-file, represented by
//                            source_id prefix patterns
//   Different span         — same source, different region (weaker diversity,
//                            but still genuine when the passages differ)
//
// Every check here is decidable from the citation table and answer text alone
// — no model call, no engine re-query, no external service.

import { parseCitationRefs, splitSentences } from "./citation-check.js";

// ── Source identity classification ──────────────────────────────────────────

const SOURCE_TYPE_PATTERNS = {
  web: /^https?:\/\//i,
  corpus: /^source:/i,
  upload: /^upload:/i,
  prior: /^prior:/i,
};

function classifySource(sourceId) {
  if (!sourceId) return "unknown";
  for (const [type, re] of Object.entries(SOURCE_TYPE_PATTERNS)) {
    if (re.test(sourceId)) return type;
  }
  return "unknown";
}

// ── Text overlap ────────────────────────────────────────────────────────────

function tokenize(s) {
  return String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
}

/** Jaccard similarity of token sets. */
export function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

const OVERLAP_THRESHOLD = 0.80;
const SUSPICIOUS_OVERLAP_THRESHOLD = 0.60;

// ── Source base normalization ────────────────────────────────────────────────
//
// Two passages from "source:frankenstein.txt:100" and "source:frankenstein.txt:200"
// are different spans of the same document. For diversity purposes, they
// share the same base source. Web URLs are stripped to their origin + path
// (no fragment/query) so two pages from the same domain with substantially
// different paths count as different unless the content itself overlaps.
//
// The full source_id is preserved in the report; the base is for grouping only.

function sourceBase(sourceId) {
  if (!sourceId) return `unknown:${sourceId === undefined ? 'undefined' : 'null'}`;
  // source:book.txt:123 -> source:book.txt
  const corpusMatch = sourceId.match(/^(source:[^:]+(?:\.\w+)?):/);
  if (corpusMatch) return corpusMatch[1];
  // upload:file.pdf:45 -> upload:file.pdf
  const uploadMatch = sourceId.match(/^(upload:[^:]+(?:\.\w+)?):/);
  if (uploadMatch) return uploadMatch[1];
  // prior:name:data -> prior:name
  const priorMatch = sourceId.match(/^(prior:[^:]+):/);
  if (priorMatch) return priorMatch[1];
  // https://example.com/page#section?q=1 -> https://example.com/page
  try {
    const u = new URL(sourceId);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return sourceId;
  }
}

// ── Build the source map ────────────────────────────────────────────────────

function sourceGroups(citations) {
  const bySource = new Map();
  for (const c of citations || []) {
    const norm = sourceBase(c.source_id);
    const key = norm && norm !== "unknown:undefined" && norm !== "unknown:null"
      ? norm
      : `unknown:${c.index || c.span_id || Math.random().toString(36)}`;
    let group = bySource.get(key);
    if (!group) { group = []; bySource.set(key, group); }
    group.push(c);
  }
  return bySource;
}

// ── Source diversity checks ─────────────────────────────────────────────────

/**
 * Detect pairs of citations that have different source_ids but whose passage
 * text is so similar that they are functionally the same evidence.
 *
 * @returns Array of { a, b, similarity, aIndex, bIndex, aSource, bSource }
 */
export function detectContentOverlap(citations, threshold = OVERLAP_THRESHOLD) {
  const pairs = [];
  const entries = (citations || []).filter((c) => c.text && c.text.length >= 40);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (sourceBase(a.source_id) === sourceBase(b.source_id)) continue; // same base source is expected to share content
      const sim = jaccardSimilarity(a.text, b.text);
      if (sim >= threshold) {
        pairs.push({
          aIndex: a.index, bIndex: b.index,
          aSource: a.source_id, bSource: b.source_id,
          similarity: Math.round(sim * 100) / 100,
          aText: a.text.slice(0, 200), bText: b.text.slice(0, 200),
        });
      }
    }
  }
  return pairs;
}

/**
 * Measure how concentrated the citation table is on individual sources.
 *
 * Returns per-source counts and a Gini-style concentration metric (0–1),
 * where 1 means every citation is from the same source and 0 means each
 * citation is from a truly distinct source.
 */
export function measureSourceConcentration(citations) {
  const groups = sourceGroups(citations);
  const counts = Array.from(groups.values()).map((g) => g.length).sort((a, b) => b - a);
  const total = counts.reduce((s, n) => s + n, 0);
  if (total === 0) return { perSource: {}, uniqueSources: 0, concentration: 0, counts: [] };

  // Concentration: 0 = every citation from a distinct source, 1 = all from one source.
  // Formula: 1 - ((uniqueSources - 1) / (totalCitations - 1)), clamped to [0, 1].
  // With 1 citation: uniqueSources=1, total=1 → 1 - (0/0) which is NaN, so treat as 0.
  const uniqueSources = groups.size;
  const concentration = total <= 1
    ? 0
    : Math.max(0, Math.min(1, 1 - ((uniqueSources - 1) / (total - 1))));

  const perSource = {};
  for (const [sourceId, group] of groups) {
    perSource[sourceId] = group.length;
  }

  return {
    perSource,
    uniqueSources,
    concentration: Math.round(concentration * 100) / 100,
    counts,
  };
}

/**
 * Measure the type diversity of cited sources (corpus vs. web vs. upload vs. prior).
 *
 * Returns a type breakdown and a diversity score (0–1), where:
 *   0 = all citations from one source type
 *   1 = citations spread across every possible type
 */
export function measureSourceTypeDiversity(citations) {
  const typeCounts = new Map();
  for (const c of citations || []) {
    const t = classifySource(c.source_id);
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  }
  const types = typeCounts.size;
  const maxTypes = Object.keys(SOURCE_TYPE_PATTERNS).length;
  const diversity = types <= 1 ? (citations?.length > 0 ? 0 : 1) : types / maxTypes;

  return {
    typeCounts: Object.fromEntries(typeCounts),
    uniqueTypes: types,
    diversityScore: Math.round(diversity * 100) / 100,
  };
}

/**
 * For each cited sentence in the answer, check whether the sources it cites
 * legitimately differ. A sentence citing [1,2] when passage 1 text is 85%
 * identical to passage 2 text is drawing from one source, not two.
 *
 * Also checks: when the answer's own language signals multiple-source
 * corroboration ("both sources agree", "independently confirmed by", etc.),
 * do the cited passages actually support that claim?
 */
export function detectPseudoDiverseGroups(answerText, citations) {
  const refs = parseCitationRefs(answerText);
  const sentences = splitSentences(answerText);
  const byIndex = new Map((citations || []).map((c) => [c.index, c]));
  const overlapPairs = detectContentOverlap(citations, SUSPICIOUS_OVERLAP_THRESHOLD);

  const pseudoDiverse = [];

  for (const s of sentences) {
    const local = parseCitationRefs(s.text);
    const nums = [...new Set(local.flatMap((r) => r.nums))].sort((a, b) => a - b);
    if (nums.length < 2) continue; // single-source claim — nothing to diversify

    const valid = nums.filter((n) => byIndex.has(n));
    if (valid.length < 2) continue;

    const citedSources = [...new Set(valid.map((n) => sourceBase(byIndex.get(n).source_id)).filter(Boolean))];
    const uniqueSources = citedSources.length;

    if (uniqueSources >= valid.length) continue; // every bracket = distinct source

    // Check overlap between each pair of cited passages
    let maxOverlap = 0;
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const a = byIndex.get(valid[i]), b = byIndex.get(valid[j]);
        const sim = jaccardSimilarity(a.text, b.text);
        if (sim > maxOverlap) maxOverlap = sim;
      }
    }

    if (uniqueSources < valid.length || maxOverlap >= SUSPICIOUS_OVERLAP_THRESHOLD) {
      pseudoDiverse.push({
        sentence: s.text.slice(0, 300),
        start: s.start, end: s.end,
        citedNums: valid,
        uniqueSources,
        totalSources: valid.length,
        maxOverlap: Math.round(maxOverlap * 100) / 100,
        // Source ids behind each bracket, for the reader to inspect
        sourceMap: Object.fromEntries(valid.map((n) => [n, byIndex.get(n).source_id])),
      });
    }
  }

  return { pseudoDiverse, overlapPairs };
}

// ── Corroboration-language detection ─────────────────────────────────────────

const CORROBORATION_LANGUAGE = [
  /\bboth\s+sources?\b/i,
  /\bindependently\s+(verified|confirmed|reported|corroborated)\b/i,
  /\bmultiple\b.{0,20}\b(sources|reports|studies|accounts)\b/i,
  /\bcorroborated\s+by\b/i,
  /\bconfirmed\s+by\s+(multiple|several|other)\b/i,
  /\ball\s+sources?\s+agree\b/i,
  /\beach\s+(source|report|study)\s+(confirms|shows|indicates)\b/i,
  /\bseparate\s+(source|report|study|account)\b/i,
  /\breported\s+by\s+(multiple|several|different)\b/i,
];

function hasCorroborationLanguage(sentence) {
  return CORROBORATION_LANGUAGE.some((re) => re.test(sentence));
}

/**
 * When an answer uses language implying independent corroboration from multiple
 * sources, check whether the cited sources actually differ.
 */
export function checkCorroborationClaims(answerText, citations) {
  const refs = parseCitationRefs(answerText);
  const sentences = splitSentences(answerText);
  const byIndex = new Map((citations || []).map((c) => [c.index, c]));

  const claims = [];

  for (const s of sentences) {
    if (!hasCorroborationLanguage(s.text)) continue;
    const local = parseCitationRefs(s.text);
    const nums = [...new Set(local.flatMap((r) => r.nums))].sort((a, b) => a - b);
    const valid = nums.filter((n) => byIndex.has(n));
    const sourceIds = [...new Set(valid.map((n) => sourceBase(byIndex.get(n).source_id)).filter(Boolean))];

    // Check pairwise overlap among all sources cited in the corroborating sentence
    let highestOverlap = 0;
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const a = byIndex.get(valid[i]), b = byIndex.get(valid[j]);
        if (sourceBase(a.source_id) !== sourceBase(b.source_id)) {
          const sim = jaccardSimilarity(a.text, b.text);
          if (sim > highestOverlap) highestOverlap = sim;
        }
      }
    }

    const passes =
      sourceIds.length >= 2 &&
      highestOverlap < SUSPICIOUS_OVERLAP_THRESHOLD &&
      [...new Set(sourceIds.map((id) => classifySource(id)))].length >= 1;

    claims.push({
      sentence: s.text.slice(0, 300),
      start: s.start, end: s.end,
      citedNums: valid,
      uniqueSourceIds: sourceIds.length,
      uniqueSourceTypes: [...new Set(sourceIds.map((id) => classifySource(id)))],
      highestOverlap: Math.round(highestOverlap * 100) / 100,
      passesCorroboration: passes,
      issue: !passes
        ? (sourceIds.length < 2
          ? "corroboration language but only one source cited"
          : highestOverlap >= SUSPICIOUS_OVERLAP_THRESHOLD
            ? "sources cited as corroborating have substantially overlapping text"
            : "corroboration language but sources do not legitimately differ")
        : null,
    });
  }

  return claims;
}

// ── The full report ─────────────────────────────────────────────────────────

/**
 * The complete source diversity check for one answer.
 *
 * @param {string} answerText    the model's full answer
 * @param {Array<{index:number, source_id?:string, span_id?:string, text?:string, title?:string, url?:string}>} citations
 * @param {object} [opts]
 * @param {string} [opts.question]
 * @returns a report with diversity metrics and findings
 */
export function checkSourceDiversity(answerText, citations, opts = {}) {
  const table = (citations || []).map((c, i) => ({ ...c, index: c.index ?? i + 1 }));
  const concentration = measureSourceConcentration(table);
  const typeDiversity = measureSourceTypeDiversity(table);
  const overlapPairs = detectContentOverlap(table);
  const { pseudoDiverse } = detectPseudoDiverseGroups(answerText, table);
  const corroborationClaims = checkCorroborationClaims(answerText, table);

  // Each source's base, type, and the brackets that cite it.
  const sourceMap = {};
  for (const c of table) {
    const key = sourceBase(c.source_id) || c.source_id || `unknown:${c.index}`;
    if (!sourceMap[key]) sourceMap[key] = { type: classifySource(c.source_id), brackets: [], title: c.title, url: c.url, sourceIds: new Set() };
    sourceMap[key].brackets.push(c.index);
    sourceMap[key].sourceIds.add(c.source_id);
  }
  // Convert sets to arrays for JSON-safety
  for (const v of Object.values(sourceMap)) {
    v.sourceIds = [...v.sourceIds];
    v.bracketCount = v.brackets.length;
  }

  const totalSources = Object.keys(sourceMap).length;
  const totalCitations = table.length;
  const hasOverlap = overlapPairs.length > 0;
  const hasPseudoDiverse = pseudoDiverse.length > 0;
  const hasUncorroborated = corroborationClaims.some((c) => !c.passesCorroboration);

  return {
    // What was examined
    totalCitations,
    totalSources,
    sourceMap,

    // Concentration: are citations spread across sources, or clustered on one?
    concentration: concentration.concentration,
    uniqueSources: concentration.uniqueSources,
    sourceCounts: concentration.perSource,
    concentrationLevel:
      concentration.concentration >= 0.75 ? "high" :
      concentration.concentration >= 0.5 ? "moderate" : "low",

    // Type diversity: corpus, web, upload, prior?
    uniqueSourceTypes: typeDiversity.uniqueTypes,
    sourceTypeCounts: typeDiversity.typeCounts,
    typeDiversityScore: typeDiversity.diversityScore,

    // Content overlap: two "different" sources that say the same thing
    overlapPairs,

    // Pseudo-diverse citations: a sentence cites [1,2,3] but they're not really different
    pseudoDiverse,

    // Corroboration claims that don't hold up
    corroborationClaims,

    // One boolean a client can read without interpreting metrics.
    // Clean means every check passes: no overlap, no pseudo-diverse groups,
    // no uncorroborated claims. Single-citation answers are clean by default
    // (you can't claim diversity with one citation). Zero-citation answers
    // are also clean.
    clean: totalCitations === 0
           ? true
           : totalCitations === 1
             ? (!hasOverlap && !hasPseudoDiverse && !hasUncorroborated)
             : (!hasOverlap && !hasPseudoDiverse && !hasUncorroborated
                && concentration.uniqueSources > 1
                && typeDiversity.uniqueTypes > 0),
  };
}

// ── The void markers, applied additively ─────────────────────────────────────

const DIVERSITY_MARKERS = {
  pseudoDiverse: (f) =>
    `[⊘ pseudo-diverse: ${f.citedNums.length} citations from ${f.uniqueSources} source(s)]`,
  uncorroborated: (f) =>
    `[⊘ uncorroborated: corroboration language but sources do not legitimately differ (${f.sourceIds?.length || 0} distinct source(s))]`,
  overlap: (p) =>
    `[⊘ overlap: source [${p.aIndex}] and [${p.bIndex}] are ${Math.round(p.similarity * 100)}% similar]`,
};

/**
 * Annotate the answer text with diversity-related findings, additive and
 * applied right-to-left for offset stability (same convention as
 * citation-check.js's annotateVoids).
 */
export function annotateDiversityVoids(answerText, report) {
  if (!answerText || !report) return answerText;

  const markers = [];

  for (const f of report.pseudoDiverse || []) {
    if (f.end != null) markers.push({ at: f.end, marker: DIVERSITY_MARKERS.pseudoDiverse({ ...f, uniqueSources: f.uniqueSources }) });
  }

  for (const c of report.corroborationClaims || []) {
    if (!c.passesCorroboration && c.end != null) {
      markers.push({ at: c.end, marker: DIVERSITY_MARKERS.uncorroborated({ ...c, sourceIds: c.uniqueSourceIds }) });
    }
  }

  markers.sort((a, b) => b.at - a.at);
  let out = answerText;
  for (const m of markers) out = out.slice(0, m.at) + m.marker + out.slice(m.at);
  return out;
}

// ── Typed gaps ──────────────────────────────────────────────────────────────

/**
 * The diversity report as typed gaps, matching the convention in citation-check.js.
 */
export function diversityGaps(report) {
  const gaps = [];
  if (!report) return gaps;

  if (report.totalCitations > 0 && report.uniqueSources === 1) {
    gaps.push({
      type: "single_source",
      reason: `All ${report.totalCitations} citations point to the same source (${Object.keys(report.sourceCounts || {})[0] || "unknown"}). This is a single-source answer, not multi-source corroboration.`,
    });
  }

  if (report.concentrationLevel === "high" && report.totalSources > 1) {
    const top = report.counts?.[0];
    if (top >= report.totalCitations * 0.75) {
      gaps.push({
        type: "source_concentration",
        reason: `${top} of ${report.totalCitations} citations come from one source. Citations are concentrated rather than diverse.`,
      });
    }
  }

  for (const p of report.overlapPairs || []) {
    gaps.push({
      type: "content_overlap",
      reason: `Source [${p.aIndex}] and [${p.bIndex}] are ${Math.round(p.similarity * 100)}% textually similar (different source_ids, same content). They do not provide genuinely independent evidence.`,
      aIndex: p.aIndex, bIndex: p.bIndex,
      aSource: p.aSource, bSource: p.bSource,
    });
  }

  for (const pd of report.pseudoDiverse || []) {
    gaps.push({
      type: "pseudo_diverse",
      reason: `"${pd.sentence.slice(0, 120)}" cites [${pd.citedNums.join(", ")}] but only ${pd.uniqueSources} distinct source(s) back them`,
      citedNums: pd.citedNums,
      uniqueSources: pd.uniqueSources,
      sourceMap: pd.sourceMap,
      maxOverlap: pd.maxOverlap,
    });
  }

  for (const cc of report.corroborationClaims || []) {
    if (!cc.passesCorroboration) {
      gaps.push({
        type: "uncorroborated_claim",
        reason: `Answer claims corroboration ("${cc.sentence.slice(0, 140)}") but the cited sources do not legitimately differ. ` + (cc.issue || ""),
        citedNums: cc.citedNums,
        uniqueSourceIds: cc.uniqueSourceIds,
        highestOverlap: cc.highestOverlap,
      });
    }
  }

  if (report.totalSources > 0 && report.uniqueSourceTypes === 1) {
    const onlyType = Object.keys(report.sourceTypeCounts || {})[0] || "unknown";
    gaps.push({
      type: "single_source_type",
      reason: `All cited sources are of type "${onlyType}". No cross-type corroboration.`,
    });
  }

  return gaps;
}
