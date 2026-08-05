// Longform prose, built the way the sonata was built.
//
// The music was the lab. Text is where the lessons have to survive contact with
// a medium that LOOKS like it wants one big generation — and doesn't.
//
//   1. THE MOUTH.  Fold to a working-memory handful before generating anything.
//      Measured in the music: 8 passages in one prompt produced a 27,471-char
//      system message and an answer consisting of the single token "[7]".
//      Measured again in revision: recomposing without re-folding re-admitted
//      the 25 sections the fold had withheld. Revising is not a licence to say
//      more, and it applies to paragraphs exactly as to bars.
//
//   2. SMALL PRODUCTIONS.  No prompt generates much. Each beat of the piece is
//      one small, checkable unit with its own evidence. A 2000-word essay is
//      not one 2000-word generation; it is many small ones that survived.
//
//   3. EARNED STRUCTURE.  The sonata's form came from Frankenstein's narrator
//      spans, resolved to offsets — never from the words "letter" or "chapter".
//      Here the outline comes from the evidence's own dependency structure, and
//      "peer" stays a first-class answer. A section is above another only if
//      the second cannot exist without the first.
//
//   4. RE-LISTENING.  The composer heard its own output through the SAME
//      tracker that heard the source, and superseded what drifted. The prose
//      analogue is exact: re-READ the draft with the same grounding organ that
//      admitted the evidence, and supersede paragraphs whose claims are not
//      carried by the passages they cite. One organ, both directions — two
//      would measure the difference between two readers.
//
//   5. PERMITTER, NOT SEEKER.  The revision loop closes a FIDELITY residual —
//      does this paragraph say what its evidence says — and nothing else. It
//      does not optimize for interest, surprise, or elegance. Those are the
//      text equivalents of chasing ananda, and a loop that pursues them
//      produces flattery. The loop stops when the residual stops improving, not
//      when the prose feels good.
//
// What "Claude-like output" means here, concretely: prose that reads as one
// voice with a spine, where every load-bearing claim is traceable, the
// structure was discovered rather than imposed, and the passages that did not
// survive are visible rather than quietly dropped.

import { createTaskLog, append, projectTasks, deriveLevels, foldToWorkingSet, produce, ENTRY_KINDS, OPERATOR_BASIS } from "./task-log.js";
import { checkAttribution } from "../vendor/eoreader5/packages/def/attribution.js";

/**
 * Check a draft the way the ENGINE checks it: who did what to whom.
 *
 * This replaces the word-overlap residual for the failure that residual could
 * not see. Measured on real output: "prompting Frankenstein to grasp its
 * throat and silence it" cites a passage that says "I grasped his throat" —
 * inside the CREATURE's narrator span, so the act is the creature's and the
 * claim hands it to Victor. Every name in the claim is in the passage and
 * every content word is ordinary, so the residual scored it 0.29 and passed
 * it. Agent and patient were swapped, and the swap is the whole meaning.
 *
 * `narratorSpans` is what makes "I" resolvable — a first-person subject is a
 * surface fixed by scope, not by the token. Without it every "I" in the
 * creature's tale is silently Victor.
 */
export async function attributionResidual(draft, citedPassages, { narratorSpans = [], aliases = [], cast = null, morphology = null } = {}) {
  const evidence = citedPassages.map((p) => String(p.text ?? "")).join("\n\n");
  if (!evidence.trim()) return { residual: null, gap: "no evidence text to check against", vetoes: [] };

  const r = await checkAttribution(draft, evidence, {
    narratorSpans,
    aliases,
    cast,
    morphology,
  });

  const hard = r.vetoes.filter((v) => v.severity === "hard");
  return {
    // A single misattribution is disqualifying, so this is not averaged — one
    // swapped agent makes the paragraph false regardless of how much around it
    // is correct.
    residual: r.checked === 0 ? null : hard.length / Math.max(1, r.checked),
    misattributions: hard,
    vetoes: r.vetoes,
    checked: r.checked,
    gap: r.checked === 0 ? "no relation in this draft could be checked against the evidence" : null,
    engineGaps: r.gaps,
  };
}

/**
 * Earn an outline from evidence, rather than asking a model for headings.
 *
 * Evidence that shares a source and sits adjacent in byte order belongs
 * together (CON). Evidence that stands apart in source or position
 * differentiates (SEG). A claim resting on evidence from MORE THAN ONE source
 * exists only across them, and is produced by SYN — this is the same
 * existence-dependency test the sonata used, and the same one that recovered
 * Frankenstein's frame.
 */
export function outlineFromEvidence(passages, { maxSections = 7 } = {}) {
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "work", description: "the whole" });

  // Group by source, then by contiguity within a source. Nothing here reads a
  // heading string; grouping is positional and structural.
  const bySource = new Map();
  for (const p of passages) {
    const src = String(p.source_id ?? p.source ?? "?").replace(/:chunk-\d+$/, "");
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(p);
  }

  const rules = {
    // Each source stands apart: a differentiation of the whole.
    SEG: (tasks) => {
      const out = [];
      for (const [src, ps] of bySource) {
        const id = `sec:${src}`;
        if (tasks.some((t) => t.task_id === id)) continue;
        out.push({
          task_id: id,
          depends_on: ["work"],
          // A section is a CLAIM, not a file. Naming sections by filename
          // ("## pg84.txt") reported where the evidence came from and said
          // nothing about what the section argues — and it silently made
          // "which file" the organizing principle of the prose, which is a
          // property of the corpus layout, not of the question.
          description: null,
          evidence: ps.map((p) => p.span_id).filter(Boolean),
          source: src,
          extent: ps.reduce((n, p) => n + (p.text?.length ?? 0), 0),
        });
      }
      return out;
    },
    // Two sections whose evidence is comparable in weight bear on each other.
    CON: (tasks) => {
      const secs = tasks.filter((t) => t.task_id.startsWith("sec:"));
      if (secs.length < 2 || tasks.some((t) => t.task_id === "cmp")) return [];
      return [{
        task_id: "cmp",
        depends_on: secs.map((s) => s.task_id),
        description: "what these sources say about each other",
        evidence: secs.flatMap((s) => s.evidence.slice(0, 2)),
        extent: 1,
      }];
    },
    // A claim holding only ACROSS sources — it cannot exist in any one of them.
    SYN: (tasks) => {
      if (!tasks.some((t) => t.task_id === "cmp") || tasks.some((t) => t.task_id === "synth")) return [];
      return [{
        task_id: "synth",
        depends_on: ["cmp"],
        description: "what holds across all of them",
        evidence: [],
        extent: 1,
      }];
    },
  };

  const closure = produce(log, rules);
  const tasks = projectTasks(closure.log);
  const { levels, relations } = deriveLevels(tasks);

  // The mouth, before a single word is generated.
  const { working, withheld, withheld_ids } = foldToWorkingSet(
    tasks.filter((t) => t.task_id !== "work"),
    { k: maxSections, score: (t) => (t.evidence?.length ?? 0) + (t.extent ?? 0) / 1000 }
  );

  return {
    log: closure.log,
    closure,
    sections: working.sort((a, b) => a.first_seq - b.first_seq),
    levels,
    relations,
    withheld,
    withheld_ids,
  };
}

/**
 * The fidelity residual for one paragraph.
 *
 * Re-reads the draft against the evidence it was given, using ONLY term
 * overlap against the actual passage text — deliberately the same shape of
 * check the retrieval ranker uses, so a paragraph is judged by whether its
 * content words are carried by its sources, not by whether it reads well.
 *
 * Returns `unsupported`: content words in the draft that appear in NO cited
 * passage. That is the checkable, bounded thing. It says nothing about quality
 * and must not be asked to.
 */
const STOP = new Set(("the a an and or but of to in on at for with from by as is are was were be been being that this " +
  "these those it its his her their our your my he she they we you i not no nor so if then than there here what which " +
  "who whom whose when where why how all any both each few more most other some such only own same too very can will " +
  "just should now also into over under between about against during before after above below up down out off again")
  .split(" "));

export function fidelityResidual(draft, citedPassages) {
  const words = (s) => String(s || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const evidence = new Set(citedPassages.flatMap((p) => words(p.text)));
  const content = words(draft).filter((w) => !STOP.has(w));
  if (!content.length) return { residual: null, gap: "draft has no content words to check", unsupported: [] };

  // Only SPECIFIC tokens count against the draft.
  //
  // Measured dead end — do not restore plain content-word overlap. Scoring
  // every non-stopword absent from the evidence measures COPYING, not
  // fidelity: prose that paraphrases well scores identically to prose that
  // fabricates. On one run the genuine Frankenstein section scored 0.54 and an
  // invented claim that the creature was "created by Rostov, an officer in the
  // Russian army" scored 0.89 — the same metric, unable to separate the two,
  // and it eventually rejected every section including the true ones.
  //
  // What distinguishes them is SPECIFICITY. A paraphrase reaches for ordinary
  // words the passage happens not to use ("suggests", "reveals", "profound").
  // A fabrication introduces a specific — a name, a place, a number — that the
  // evidence never contained. So the residual counts only tokens that look
  // like specifics: capitalized-in-source names and long rare words. This is
  // the same rarity insight that fixed retrieval ranking, applied to the
  // opposite direction of the same pipeline.
  // Specifics are NAMED THINGS — capitalized tokens that are not sentence
  // furniture. Word length was tried first and failed for the same reason the
  // whole-vocabulary version failed: "experiences", "overwhelming", and
  // "revulsion" are long, absent from the passage, and entirely legitimate
  // paraphrase, so a length rule scored a faithful paraphrase 1.00 — exactly
  // level with the Rostov fabrication. A name is the thing a passage can
  // actually carry or fail to carry.
  const rawDraft = String(draft || "");
  const specifics = [...new Set(
    (rawDraft.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => !STOP.has(w))
  )];
  if (!specifics.length) {
    // Nothing checkable is not the same as nothing wrong. Reported as a gap so
    // an unverifiable paragraph cannot pass as a verified one.
    return { residual: null, gap: "draft asserts no specific the evidence could carry or contradict", unsupported: [] };
  }

  const unsupported = specifics.filter((w) => !evidence.has(w));
  return {
    residual: unsupported.length / specifics.length,
    unsupported: unsupported.slice(0, 24),
    checked: specifics.length,
    gap: null,
  };
}

/**
 * One revision pass over a draft, appending rather than mutating.
 *
 * Sections whose residual exceeds `tolerance` are superseded with a note saying
 * exactly which words were not carried, so the next generation has something
 * specific to fix rather than "try harder".
 */
export function reviseDraft(log, drafts, evidenceBySection, { tolerance = 0.45 } = {}) {
  const tasks = projectTasks(log);
  let next = log;
  const measured = [];

  for (const t of tasks) {
    const draft = drafts.get(t.task_id);
    if (!draft) continue;
    const cited = evidenceBySection.get(t.task_id) ?? [];
    const { residual, unsupported, gap } = fidelityResidual(draft, cited);
    measured.push({ task_id: t.task_id, residual, gap, unsupported });
    if (residual === null || residual <= tolerance) continue;

    next = append(next, {
      kind: ENTRY_KINDS.SUPERSEDE,
      task_id: `${t.task_id}@r${(t.variation ?? 0) + 1}`,
      supersedes: t.task_id,
      description: t.description,
      depends_on: t.depends_on,
      operator: t.operator,
      operator_basis: OPERATOR_BASIS.PRODUCED,
      evidence: t.evidence,
      source: t.source,
      extent: t.extent,
      variation: (t.variation ?? 0) + 1,
      revised_because:
        `${(residual * 100).toFixed(0)}% of content words are not carried by the cited passages` +
        (unsupported.length ? ` (e.g. ${unsupported.slice(0, 8).join(", ")})` : ""),
      // Handed to the next generation so the retry is specific.
      avoid: unsupported,
    });
  }

  const rs = measured.map((m) => m.residual).filter((r) => r !== null);
  return {
    log: next,
    measured,
    residual: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    revised: next.entries.length - log.entries.length,
  };
}
