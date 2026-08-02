// Mechanical, model-blind construction of verbatim excerpts for a completed
// answer — "snipping" the exact bytes a citation already points to, never text
// the model wrote and never a fresh engine read either. It reuses the very
// same citation record (source_id, byte_start, byte_end, text) that
// citation-check.js's verifyQuotedFidelity() already checked the model's
// quoted prose against, so a snippet shown to the reader cannot silently
// diverge from what the fidelity check considers ground truth.
//
// Deliberately narrower than the "passages" panel: only the citations the
// answer actually used ([n] resolved against the real table), not every span
// the engine retrieved. Passages is the retrieval diagnostic; this is the
// reader-facing "here are the book's own words" surface — a summary up top,
// its exact source text right underneath, with nothing in between that a
// model could have touched.

/**
 * @param {Array<{num: string, resolved: boolean}>} brackets - from resolveCitationBrackets()
 * @param {Array<{index: number, source_id: string, span_id: string, byte_start: number, byte_end: number, text: string}>} citations - the turn's own citation table (lastCitations)
 * @returns {Array<{num: string, sourceId: string, spanId: string, byteStart: number, byteEnd: number, text: string}>}
 */
export function buildVerbatimSnippets(brackets, citations) {
  const table = new Map((citations || []).map((c) => [String(c.index), c]));
  const seen = new Set();
  const out = [];
  for (const b of brackets || []) {
    if (!b.resolved || seen.has(b.num)) continue;
    const c = table.get(b.num);
    if (!c || !c.text) continue;
    seen.add(b.num);
    out.push({
      num: b.num,
      sourceId: c.source_id,
      spanId: c.span_id,
      byteStart: c.byte_start,
      byteEnd: c.byte_end,
      text: c.text,
    });
  }
  return out;
}
