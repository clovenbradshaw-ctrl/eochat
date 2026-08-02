// Mechanical, model-blind citation checks — moved out of proxy.js so
// turn-controller.js can share them without importing proxy.js (which would
// create a cycle: proxy.js -> turn-controller.js -> proxy.js).
//
// Both checks run AFTER the model's answer is complete, compare against
// engine-computed ground truth, and are never fed back into the prompt — the
// model cannot see or influence its own grade (specs/mechanical-citation-surface.md).

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
