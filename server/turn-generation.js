// turn-generation.js — every chat turn's answer runs through the same
// planning discipline longform.js's other consumers already use: fold the
// evidence into an EARNED outline (outlineFromEvidence), generate each
// earned section as its own small, checked production, assemble.
//
// The 1-section case is not a shortcut bolted on afterward — it is what the
// outline correctly returns when the evidence has nothing to structurally
// differentiate (one source, or none at all). That turn gets exactly the
// single call it got before this module existed: same messages, same
// maxTokens, same latency. Nothing here targets a length; every section that
// exists, exists because outlineFromEvidence's SEG/CON/SYN rules discovered
// it, not because this module asked for more.
//
// Multi-section turns get narrative-longform.js's per-section discipline
// (one bounded call per section, a bounded fidelity-checked revision if the
// draft asserts specifics its own cited evidence doesn't carry) — never
// unbounded retries, and never a check that can't terminate.

import { outlineFromEvidence, fidelityResidual } from "./longform.js";

// A chat section is denser prose than narrative-longform.js's SCENE_TOKENS
// (420) but is still one earned unit, not a whole answer — kept well under
// DEFAULT_MAX_TOKENS so a multi-section answer's total stays proportionate
// to how much the evidence actually earned.
export const SECTION_MAX_TOKENS = 1500;
// Mirrors narrative-longform.js's MAX_CONTINUITY_REVISIONS: bounded, not
// retried until it passes — an unresolved flag is reported by the existing
// downstream grounding check, not hidden by an infinite loop here.
export const MAX_SECTION_REVISIONS = 2;
// Same tolerance longform.js's reviseDraft defaults to.
export const FIDELITY_TOLERANCE = 0.45;

function buildSectionScope({ index, total, cited, previous }) {
  const lines = [
    `This answer has ${total} earned parts based on how its evidence structurally splits; you are writing part ${index + 1} of ${total}.`,
    `Write ONLY this part's content — do not restate a heading, "Part ${index + 1}", or summarize the other parts.`,
    `Continue naturally from what has already been written so the whole reads as one voice.`,
  ];
  if (cited.length) {
    const sources = [...new Set(cited.map((c) => c.source_id).filter(Boolean))];
    lines.push(`This part is earned by evidence from: ${sources.join(", ") || "the cited passages"}. Stay within what that evidence supports.`);
  }
  if (previous) {
    lines.push(`What has been written so far:\n${previous}`);
  }
  return lines.join("\n");
}

/**
 * Generate one turn's answer text.
 *
 * `messages` is the FULL, already-assembled message array the caller would
 * otherwise have passed straight to a single streaming call (system +
 * history + grounded citations + the user's question) — this module never
 * rebuilds grounding or citation numbering, so the downstream citation-check
 * pipeline sees exactly the same citation table it always has.
 *
 * `evidence` is the same citation list (needs `span_id`, `source_id`, `text`)
 * used to earn the outline and check each section's fidelity.
 *
 * `callModelStreaming(messages, opts)` is the caller's own streaming call
 * (turn-controller.js's) — this module makes no HTTP/streaming calls itself.
 */
export async function generateAnswer({
  messages, evidence = [], callModelStreaming, onSectionDelta,
  maxSections = 4, singleSectionMaxTokens,
  provider, modelOverride, draftModel, signal,
} = {}) {
  const bySpan = new Map(evidence.filter((p) => p.span_id).map((p) => [p.span_id, p]));
  const outline = outlineFromEvidence(evidence, { maxSections });
  // outlineFromEvidence also earns "cmp"/"synth" sections (comparison /
  // cross-source synthesis claims) the moment 2+ real sections exist — the
  // right call for an essay, but for chat it means ANY two-source answer
  // would always grow by two commentary paragraphs regardless of whether the
  // two facts actually bear on each other. Keep only the sections a source
  // itself earned; never add structural commentary the question didn't ask
  // for. Section count still scales only with genuine source differentiation.
  const sections = outline.sections.filter((s) => s.task_id.startsWith("sec:"));

  if (sections.length <= 1) {
    const result = await callModelStreaming(messages, {
      signal, provider, modelOverride, draftModel,
      maxTokens: singleSectionMaxTokens,
      onDelta: (delta, text) => onSectionDelta?.(delta, text),
    });
    return { text: result.text, model: result.model, sectionCount: 1 };
  }

  let assembled = "";
  let model = null;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const cited = (section.evidence || []).map((id) => bySpan.get(id)).filter(Boolean);
    const scopeMessage = { role: "system", content: buildSectionScope({ index: i, total: sections.length, cited, previous: assembled }) };

    let sectionText = "";
    let avoid = [];
    for (let attempt = 0; attempt <= MAX_SECTION_REVISIONS; attempt++) {
      const attemptMessages = [...messages, scopeMessage];
      if (avoid.length) {
        attemptMessages.push({
          role: "system",
          content: `The previous attempt at this part asserted specifics its cited evidence does not carry: ${avoid.join(", ")}. Do not repeat them.`,
        });
      }

      const prefix = assembled ? `${assembled}\n\n` : "";
      const result = await callModelStreaming(attemptMessages, {
        signal, provider, modelOverride, draftModel, maxTokens: SECTION_MAX_TOKENS,
        onDelta: (delta, text) => onSectionDelta?.(delta, `${prefix}${text}`),
      });
      sectionText = result.text;
      model = result.model;

      if (!cited.length || attempt === MAX_SECTION_REVISIONS) break;
      const { residual, unsupported } = fidelityResidual(sectionText, cited);
      if (residual === null || residual <= FIDELITY_TOLERANCE) break;
      avoid = unsupported;
    }

    assembled = assembled ? `${assembled}\n\n${sectionText}` : sectionText;
  }

  return { text: assembled, model, sectionCount: sections.length };
}
