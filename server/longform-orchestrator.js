// The deliberate long-form answer engine — backend-agnostic.
//
// Extracted from scripts/write-longform.mjs (the proven, real-run-tested CLI:
// retrieve -> earn an outline from evidence -> fold to a working set before
// any generation -> one small production per section -> re-read each draft
// with the same grounding organ that admitted the evidence -> revise what
// drifted -> assemble, with the withheld and the unresolved visible). That
// script hardcoded its own `say()` -> Ollama call; everything here is
// identical except `generate` is now the caller's problem, so the SAME
// verification logic can drive either an Ollama chat completion (server) or
// window.EOWebLLM.stream() (browser) — see ui/webllm-longform.js.
//
// Byte-identical between Node and the browser: this file, and everything it
// imports (./longform.js -> ./task-log.js and the vendored attribution/svo/
// morphology trio), touches no Node-only API. It is served to the browser
// unmodified via the /shared/ route in proxy.js — see that route's comment
// for why the import specifiers below have to keep resolving the same way
// in both runtimes.
import { outlineFromEvidence, fidelityResidual, attributionResidual, reviseDraft } from "./longform.js";
import { projectTasks } from "./task-log.js";

// The instruction-gate fold id(s) that mean "this turn deserves deliberate
// treatment" — checked by both chat backends (turn-controller.js server-side,
// proxy.js's /api/ground for the WebLLM client) against the SAME gate result,
// so the two never drift out of sync on what counts as deliberate.
export const DELIBERATE_FOLD_IDS = new Set(["longform-essay"]);

// A single generate() call is presumed hung, not merely slow, past this —
// long enough for a small in-browser model's honestly-slow token rate, short
// enough that one stuck call cannot silently absorb the whole pipeline's
// wall-clock budget. Timing out is not an error for assembly purposes: a
// timed-out section is dropped and named exactly like a failed fidelity
// check (see runDeliberateAnswer's per-section catch below) — the reader
// gets the sections that DID finish, honestly short of the ones that didn't.
const DEFAULT_PER_CALL_TIMEOUT_MS = 45000;

function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`generate() timed out after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

// A section's title, following the same `@r1`/`@r2` revision-suffix lookup
// write-longform.mjs's own titleOf used — a revised section shares its
// original's title rather than earning a new one.
function titleOf(titles, t) {
  return titles.get(t.task_id) ?? titles.get(String(t.task_id).replace(/@r\d+$/, "")) ?? t.description ?? "(untitled)";
}

function evidenceBlock(cited) {
  return cited.map((c, i) => `[${i + 1}] ${String(c.text).slice(0, 700)}`).join("\n\n");
}

/**
 * Runs the full deliberate pipeline over evidence already retrieved by the
 * caller (one retrieval up front — engineGroundQuery server-side, /api/ground
 * client-side — partitioned into sections structurally; no per-section
 * re-retrieval, exactly as write-longform.mjs already does).
 *
 * `generate(systemPrompt, userPrompt, maxTokens)` is the only backend-specific
 * seam. `onProgress(event)` fires at the same narration points the script's
 * own console.log calls did, so a caller can turn `section_closed` into
 * visible chat text as it happens rather than waiting for full assembly.
 *
 * Returns `{ text, citations, sectionsKept, sectionsDropped, withheld, gaps }`.
 * `citations` is renumbered to match the brackets actually used in `text` —
 * hand this straight to a caller's existing citation-table shape. `gaps`
 * describes withheld/dropped sections in the same `{type, reason}` shape
 * this codebase already uses elsewhere for honest-absence reporting; it is
 * deliberately NOT embedded as prose in `text` — a caller that already has a
 * dedicated citations/gaps surface (both chat backends do) should use that,
 * not read a second, duplicate account out of the answer text itself.
 */
export async function runDeliberateAnswer({
  question,
  citations,
  generate,
  maxSections = 5,
  maxRevisionRounds = 3,
  tolerance = 0.45,
  narratorSpans = [],
  cast = [],
  morphology = null,
  deadlineMs = 120000,
  perCallTimeoutMs = DEFAULT_PER_CALL_TIMEOUT_MS,
  signal = null,
  onProgress = null,
} = {}) {
  const emit = (event) => { if (onProgress) { try { onProgress(event); } catch { /* a listener's own failure must not abort generation */ } } }
  const aborted = () => !!(signal && signal.aborted);
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > deadlineMs;

  const { sections, withheld, withheld_ids, closure } = outlineFromEvidence(citations, { maxSections });
  emit({ phase: "outline", sections: sections.length, withheld });

  const byId = new Map(citations.map((c) => [c.span_id, c]));
  const evidenceBySection = new Map(
    sections.map((s) => [s.task_id, s.evidence.map((id) => byId.get(id)).filter(Boolean)])
  );

  const drafts = new Map();
  const titles = new Map();
  const gaps = [];

  for (const s of sections) {
    if (aborted() || outOfTime()) break;
    const cited = evidenceBySection.get(s.task_id) ?? [];
    if (!cited.length) continue;
    emit({ phase: "section_start", id: s.task_id });

    try {
      if (!s.description) {
        const block = evidenceBlock(cited);
        const title = await withTimeout(
          generate(
            "Name what these passages are ABOUT, in at most six words. Reply with the phrase only — " +
            "no quotes, no punctuation, no preamble.\n\nPASSAGES:\n" + block,
            question,
            24
          ),
          perCallTimeoutMs, `${s.task_id} title`
        );
        titles.set(s.task_id, title.replace(/^["'\s]+|["'.\s]+$/g, "").split("\n")[0].slice(0, 70));
        emit({ phase: "section_titled", id: s.task_id, title: titles.get(s.task_id) });
      }

      const block = evidenceBlock(cited);
      const system =
        "You are writing ONE short section of a longer piece. Write 3-5 sentences, no heading, no preamble. " +
        "Use only the numbered passages below and cite each claim like [1]. " +
        `You have [1] through [${cited.length}] — never cite outside that range.\n\n` +
        `PASSAGES:\n${block}`;
      const draft = await withTimeout(
        generate(system, `Section: ${titles.get(s.task_id) ?? s.description}\n\nQuestion: ${question}`, 260),
        perCallTimeoutMs, `${s.task_id} draft`
      );
      drafts.set(s.task_id, draft);
      emit({ phase: "section_drafted", id: s.task_id, words: draft.split(/\s+/).filter(Boolean).length });
    } catch (err) {
      // A section that never drafted is exactly a section that was later
      // dropped — same honest outcome, named as a gap, pipeline continues.
      gaps.push({ type: "section_failed", reason: `"${s.description ?? s.task_id}" — ${err.message}` });
    }
  }

  // ── re-read and revise ──
  let log = closure.log, prev = Infinity, round = 0;
  while (round < maxRevisionRounds && !aborted() && !outOfTime()) {
    const pass = reviseDraft(log, drafts, evidenceBySection, { tolerance });
    if (pass.residual === null || !pass.revised) break;
    if (pass.residual >= prev - 0.01) break;
    prev = pass.residual;
    log = pass.log;
    emit({ phase: "section_revising", round: round + 1, residual: pass.residual, count: pass.revised });

    for (const t of projectTasks(log).filter((x) => x.variation)) {
      if (aborted() || outOfTime()) break;
      const orig = t.task_id.replace(/@r\d+$/, "");
      const cited = evidenceBySection.get(orig) ?? [];
      if (!cited.length) continue;
      evidenceBySection.set(t.task_id, cited);
      const block = evidenceBlock(cited);
      const system =
        "Rewrite this section so every claim is carried by the passages. Write 3-5 sentences, cite like [1]. " +
        `These words were NOT in any passage — do not use them unless a passage supports them: ${(t.avoid || []).slice(0, 12).join(", ")}.\n\n` +
        `PASSAGES:\n${block}`;
      try {
        drafts.set(t.task_id, await withTimeout(
          generate(system, `Section: ${titleOf(titles, t)}\n\nQuestion: ${question}`, 260),
          perCallTimeoutMs, `${t.task_id} revision`
        ));
      } catch (err) {
        gaps.push({ type: "section_failed", reason: `"${titleOf(titles, t)}" (revision) — ${err.message}` });
      }
    }
    round++;
  }

  // ── assemble: a section reaches the page only if its own evidence carries
  // it. Misattribution is checked first and is disqualifying on its own,
  // regardless of lexical score — a paragraph that hands one entity's act to
  // another is false no matter how well the rest of it is grounded. ──
  const live = projectTasks(log).filter((t) => drafts.has(t.task_id));
  const dropped = [];
  const kept = [];
  for (const t of live) {
    if (aborted()) break;
    const cited = evidenceBySection.get(t.task_id) ?? [];
    const lex = fidelityResidual(drafts.get(t.task_id), cited);
    const att = await attributionResidual(drafts.get(t.task_id), cited, { narratorSpans, cast, morphology });

    if (att.misattributions?.length) {
      dropped.push({ t, why: `misattribution — ${att.misattributions[0].message}` });
      continue;
    }
    if (lex.residual === null || lex.residual > tolerance) {
      dropped.push({ t, why: lex.residual === null ? "unmeasurable" : `${(lex.residual * 100).toFixed(0)}% of its content words were not carried by its evidence` });
      continue;
    }
    kept.push(t);
    emit({ phase: "section_closed", id: t.task_id, title: titleOf(titles, t), text: drafts.get(t.task_id) });
  }

  for (const d of dropped) {
    gaps.push({ type: "section_dropped", reason: `"${titleOf(titles, d.t)}" — ${d.why} — not shown rather than shown unsupported.` });
  }
  if (withheld) {
    gaps.push({ type: "section_withheld", reason: `${withheld} section(s) were retrieved but withheld by the fold: ${withheld_ids.join(", ") || "none"}.` });
  }

  const used = [];
  const out = [];
  for (const t of kept.sort((a, b) => a.first_seq - b.first_seq)) {
    const cited = evidenceBySection.get(t.task_id) ?? [];
    out.push(`## ${titleOf(titles, t)}\n`);
    let body = drafts.get(t.task_id);
    body = body.replace(/\[(\d+)\]/g, (m, n) => {
      const c = cited[Number(n) - 1];
      if (!c) return "[?]";
      let idx = used.findIndex((u) => u.span_id === c.span_id);
      if (idx === -1) { used.push(c); idx = used.length - 1; }
      return `[${idx + 1}]`;
    });
    out.push(body + "\n");
  }

  // Nothing survived — an honest sentence, not an empty reply. The CLI never
  // needed this (a report with zero kept sections is still a valid report on
  // disk); a chat reply cannot be blank.
  const text = out.length
    ? out.join("\n").trim()
    : "None of the retrieved material could be shown to support a written answer to this — every section either failed the fidelity check against its evidence or could not be generated in time.";

  emit({ phase: "assembled", kept: kept.length, dropped: dropped.length, withheld });

  return {
    text,
    citations: used.map((c, i) => ({
      index: i + 1,
      span_id: c.span_id,
      source_id: c.source_id,
      byte_start: c.byte_start,
      byte_end: c.byte_end,
      score: c.score,
      text: c.text,
    })),
    sectionsKept: kept.length,
    sectionsDropped: dropped.length,
    withheld,
    gaps,
  };
}
