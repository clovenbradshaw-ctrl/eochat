// Mechanical, model-blind citation checks — moved out of proxy.js so
// turn-controller.js can share them without importing proxy.js (which would
// create a cycle: proxy.js -> turn-controller.js -> proxy.js).
//
// Both checks run AFTER the model's answer is complete, compare against
// engine-computed ground truth, and are never fed back into the prompt — the
// model cannot see or influence its own grade (specs/mechanical-citation-surface.md).

// ── Mechanical citation: char-trigram Jaccard overlap ──
//
// The same mechanism holonic-task.js's _mechanicalCite already uses for the
// long-form path (server/holonic-task.js:1169), now shared with the normal
// chat turn. The model is never told a passage has a number, never asked to
// write [N] — it just answers using the material naturally. Afterward, this
// measures which passages the answer actually overlaps with, by literal
// character trigram overlap against the passage text, and that measurement
// — never the model's own claim — is the citation record. A weak model that
// can't remember bracket syntax is no longer a citation problem, because the
// model was never given a citation task to remember.

function charTrigrams(text) {
  const set = new Set();
  const s = String(text ?? "");
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

// A contiguous shared run of L characters contributes L-2 trigrams to the
// intersection, so this is roughly "at least a ten-character shared phrase,"
// not a handful of common short words landing on the same 3 characters by
// chance. holonic-task.js's own _mechanicalCite has no such floor — but its
// inputs are long-form generated sections (hundreds of words), where
// incidental overlap is proportionally negligible. A single chat turn can be
// one short sentence, where two UNRELATED sentences routinely share a
// trigram or two from ordinary function-word boundaries ("s a", "ng ", " th")
// — measured directly: "This cites a fake [9]." and "The creature demands a
// companion of Victor." share the trigram "s a" despite having nothing to do
// with each other. Below this floor, nonzero is noise, not grounding.
const MIN_SHARED_TRIGRAMS = 8;

/**
 * Match generated `content` against the citation table by literal trigram
 * overlap, never by a bracket the model wrote. Returns every passage whose
 * overlap clears MIN_SHARED_TRIGRAMS, ranked by Jaccard — the reader sees the
 * real number via `.jaccard` and can judge a borderline match themselves.
 */
export function mechanicalCite(content, citations) {
  const contentTri = charTrigrams(String(content ?? "").toLowerCase());
  const resolved = [];
  for (const c of citations || []) {
    const passageTri = charTrigrams(String(c.text ?? "").toLowerCase());
    let intersectionSize = 0;
    for (const tri of contentTri) if (passageTri.has(tri)) intersectionSize++;
    if (intersectionSize < MIN_SHARED_TRIGRAMS) continue;
    const unionSize = contentTri.size + passageTri.size - intersectionSize;
    resolved.push({
      num: String(c.index), resolved: true,
      sourceId: c.source_id, spanId: c.span_id,
      byteStart: c.byte_start, byteEnd: c.byte_end, score: c.score,
      jaccard: Math.round((intersectionSize / unionSize) * 10000) / 10000,
    });
  }
  resolved.sort((a, b) => b.jaccard - a.jaccard);
  return { citations: resolved };
}

/** Replace any [n] the model invented beyond the real citation table with a visible gap marker. */
export function validateCitations(content, maxCitation) {
  if (!content || maxCitation <= 0) return content;
  return content.replace(/\[(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    if (num >= 1 && num <= maxCitation) return match;
    return `[⊘ no source ${numStr}]`;
  });
}

const QUOTE_RE = /[“"]([^“”"]{20,}?)[”"]/g;

export function normalizeForFidelity(s) {
  return String(s || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Every double-quoted run of 20+ chars is treated as a claimed verbatim quote and
// checked by literal substring match against the real cited bytes — not a model
// judgment call, so it cannot be talked past.
export function verifyQuotedFidelity(content, citations) {
  const quotes = [];
  let m;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(content || ""))) quotes.push(m[1]);
  if (!quotes.length) return { quotesChecked: 0, verified: 0, unverified: [] };

  const haystacks = citations.map((c) => ({
    index: c.index,
    source_id: c.source_id,
    norm: normalizeForFidelity(c.text),
  }));

  const unverified = [];
  let verified = 0;
  for (const q of quotes) {
    const normQ = normalizeForFidelity(q);
    const hit = haystacks.find((c) => c.norm.includes(normQ));
    if (hit) verified++;
    else unverified.push({ quote: q.length > 300 ? q.slice(0, 300) + "…" : q });
  }
  return { quotesChecked: quotes.length, verified, unverified };
}
