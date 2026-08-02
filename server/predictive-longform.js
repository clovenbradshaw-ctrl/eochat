// eochat/server · predictive-longform — the SAME spine as narrative-
// longform.js, driving a PREDICTIVE domain instead of a generative one.
//
// This is the proof narrative-longform.js's header promised and did not
// build: "write a symphony or predict the weather with the same underlying
// mechanisms." compose-sonata.js already earned the symphony half (task-
// log.js already drives music, unmodified, alongside essays and fiction).
// This file earns the weather-shaped half.
//
// ── WHAT IS GENUINELY SHARED ────────────────────────────────────────────────
//
//   - task-log.js's spine: createTaskLog/append/projectTasks/foldToWorkingSet,
//     imported here UNCHANGED, exactly as narrative-longform.js and
//     compose-sonata.js already do. Three domains, one organ, zero edits to it.
//   - No lookahead: a step is decided from log state only, never from future
//     values of the series it hasn't seen yet.
//   - Existence-dependency legality: a commitment cannot be legal before its
//     prerequisite exists, whether the prerequisite is a planted fact (fiction)
//     or an OBSERVED REGIME MARKER (here) — holon-level.md's "cannot exist
//     without" test does not care which.
//   - A bounded working set: `foldToWorkingSet` caps what's "in play" the same
//     way regardless of how long the series has run.
//
// ── WHAT IS DELIBERATELY NOT SHARED, AND WHY ────────────────────────────────
//
// generation/tasks.js's own header already drew this line before this file
// existed: "The sibling of prediction/tasks.js, and deliberately built as a
// sibling rather than a generalisation... what they cannot share is the
// reveal procedure, because a continuation is withheld as a WHOLE and a
// one-step forecast is withheld as a point." Fiction's `verifyPayoff`
// (narrative-longform.js) checks FIDELITY — did the generated text carry a
// fact the system itself invented, never wrong in a scoreable sense. A
// storm-risk forecast is checked against an INDEPENDENT, EXTERNAL, UNKNOWN-
// AT-COMMIT-TIME true value, with a PROPER SCORING RULE (CRPS) against a
// baseline — genuinely right-or-wrong, calibratable. Forcing these through
// one reveal function would be exactly the mistake fold.js's own header
// warns against: two different acts wearing one word.
//
// So this file imports eoreader6's REAL, already-built prediction machinery
// (@eoreader/engine/prediction/*) for the reveal/score half, and reuses
// task-log.js for the sequencing/legality half — proving the SPINE
// generalizes to a scored domain without pretending the VERIFICATION does.
//
// Placement: fetches nothing and calls no model — this file is pure enough
// to live in eoreader6, but stays here beside its two siblings
// (narrative-longform.js, longform.js) for the same reason compose-sonata.js
// does: the SEQUENCING policy (which forecast is legal next) is a per-
// application choice (I.4), even when the primitives it calls are pure.

import { createTaskLog, append, projectTasks, foldToWorkingSet, ENTRY_KINDS, OPERATOR_BASIS } from "./task-log.js";
import { createPredictionTask } from "@eoreader/engine/prediction/tasks";
import { commitPrediction, revealAndScore } from "@eoreader/engine/prediction/commitments";
import { defaultNumericBaselines } from "@eoreader/engine/prediction/baselines";
import { score as scoreOutput } from "@eoreader/engine/prediction/scoring";

const WORKING_SET_K = 7; // the same declared mouth-budget, same reason
const SCORING_RULE = "crps";

/**
 * A regime world — the predictive sibling of narrative-longform.js's
 * WORLD_SCHEMA. `series` is the ground truth (synthetic here, but nothing
 * below reads that it's synthetic — a real sensor feed slots in unchanged).
 * `regimes` declares what OBSERVED CONDITION unlocks which forecast
 * commitment, exactly as an ENTITY unlocked a fiction commitment.
 */
export function validateRegimeWorld(world) {
  for (const f of ["series", "warmup", "regimes", "forecasts"]) {
    if (world[f] === undefined) throw new TypeError(`predictive-longform: world must declare "${f}"`);
  }
  return world;
}

/**
 * The next legal step, given the log's current state only — same shape as
 * narrative-longform.js's nextMove, same reason (Rubin's constraint
 * intersection: legality narrows before anything is committed).
 *
 * Returns { kind: "observe" } | { kind: "commit", forecastId } | { kind: "reveal", forecastId } | { kind: "close" }
 */
// INDEX CONVENTION, matching prediction/tasks.js's own walkForward exactly
// (the whole point of reuse is to inherit its already-correct shape rather
// than invent a parallel one): `stepIndex` is the TARGET index about to be
// predicted. `history = series.slice(0, stepIndex)` — indices 0..stepIndex-1,
// never including the target itself. `target = series[stepIndex]`. A
// forecast's task_id is keyed by the TARGET index it names, so `atStep` in a
// reveal move always equals the index actually being scored — there is no
// separate "committed at" vs "target" arithmetic to keep in sync by hand.
export function nextStep(world, tasks, stepIndex) {
  const has = (id) => tasks.some((t) => t.task_id === id);

  // A regime marker becomes an entity the moment the series crosses its
  // OWN declared threshold — checked against DATA, never narrated. This is
  // the predictive-domain analogue of an "introduce" move: a fact about the
  // world becomes available for legality, not authored by the caller.
  //
  // ONLY history through stepIndex-1 is visible here, deliberately — using
  // series[stepIndex] itself (the value about to be predicted) to decide
  // whether a regime shift affecting ITS OWN predictability has occurred
  // would be the exact leakage prediction/commitments.js's sealing exists to
  // refuse, just committed one function earlier.
  for (const [id, r] of Object.entries(world.regimes)) {
    if (has(`regime:${id}`)) continue;
    if (stepIndex >= r.checkFromStep && r.detect(world.series.slice(0, stepIndex))) {
      return { kind: "observe-regime", regimeId: id };
    }
  }

  // A sealed commitment awaiting reveal takes priority — legal once we have
  // moved PAST its target index, i.e. once its own reveal_not_before_step
  // (target index + 1) is no longer in the future.
  for (const [id] of Object.entries(world.forecasts)) {
    const c = tasks.find((t) => t.task_id.startsWith(`forecast:${id}:`) && !t.revealed);
    if (c && stepIndex >= c.reveal_not_before_step) return { kind: "reveal", forecastId: id, atStep: c.targetIndex };
  }

  for (const [id, f] of Object.entries(world.forecasts)) {
    if (f.requires && !has(`regime:${f.requires}`)) continue; // illegal — the regime hasn't been observed yet
    if (stepIndex >= world.series.length) continue; // nothing left to predict
    const already = tasks.some((t) => t.task_id === `forecast:${id}:${stepIndex}`);
    if (!already) return { kind: "commit", forecastId: id };
  }

  if (stepIndex >= world.series.length) return { kind: "close" };
  return { kind: "observe" };
}

/**
 * Run the regime world to closure. Same discipline as writeNarrative: no
 * fixed step count declared anywhere, no model call anywhere — every
 * forecast is a REAL sealed PredictionCommitment, scored with CRPS against
 * a REAL baseline suite from prediction/baselines.js.
 */
export function runRegimeForecast(world, { seed = 20260801, onProgress = null } = {}) {
  validateRegimeWorld(world);
  const progress = onProgress || ((msg) => console.log(msg));

  const task = createPredictionTask({
    target_type: "numeric",
    horizon: 1,
    scoring_rule: SCORING_RULE,
    baseline_ids: defaultNumericBaselines().map((b) => b.id),
    population: "predictive-longform:regime-forecast-v1",
  });

  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "series", description: "the observed regime" });

  const results = [];
  let stepIndex = world.warmup;

  while (true) {
    const tasks = projectTasks(log);
    const step = nextStep(world, tasks, stepIndex);
    if (step.kind === "close") { progress(`closed at step ${stepIndex} — nothing left to predict`); break; }

    if (step.kind === "observe-regime") {
      log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: `regime:${step.regimeId}`, description: world.regimes[step.regimeId].description, depends_on: ["series"], atStep: stepIndex });
      progress(`step ${stepIndex}: regime observed — ${step.regimeId}`);
      continue; // re-evaluate legality immediately; do not advance the step for a pure observation
    }

    if (step.kind === "commit") {
      // history/target match prediction/tasks.js's walkForward exactly:
      // history = series[0..stepIndex-1], target = series[stepIndex]. The
      // target itself is never in `history` — that is the whole leakage
      // guard, stated as an array slice instead of a sentence.
      const history = world.series.slice(0, stepIndex);
      // THE MOUTH, reused exactly: which regime facts are in play is bounded
      // the same way an open commitment set was in narrative-longform.js.
      const openRegimes = tasks.filter((t) => t.task_id.startsWith("regime:"));
      foldToWorkingSet(openRegimes, { k: WORKING_SET_K, score: (t) => -t.atStep }); // bounded, even though this candidate does not read it further

      const candidate = defaultNumericBaselines().find((b) => b.id === world.forecasts[step.forecastId].baselineId);
      const predictive_output = candidate.predict(history);
      const commitment = commitPrediction({
        task_id: task.id,
        candidate_id: candidate.id,
        candidate_version_hash: "v1",
        input_snapshot_hash: `history:${history.length}`,
        predictive_output,
        committed_at_step: stepIndex,
        reveal_not_before_step: stepIndex + 1,
      });
      log = append(log, {
        kind: ENTRY_KINDS.PROPOSE, task_id: `forecast:${step.forecastId}:${stepIndex}`, description: `forecast for series[${stepIndex}]`,
        depends_on: world.forecasts[step.forecastId].requires ? [`regime:${world.forecasts[step.forecastId].requires}`] : [],
        commitment, revealed: false, targetIndex: stepIndex,
        reveal_not_before_step: stepIndex + 1,
      });
      progress(`step ${stepIndex}: committed forecast "${step.forecastId}" for series[${stepIndex}], history=${history.length} points`);
      stepIndex += 1;
      continue;
    }

    if (step.kind === "reveal") {
      const t = tasks.find((tt) => tt.task_id === `forecast:${step.forecastId}:${step.atStep}`);
      const observed = world.series[step.atStep];
      const scored = revealAndScore({ commitment: t.commitment, observed, revealed_at_step: step.atStep + 1, scoring_rule: SCORING_RULE });
      // The comparison baselines are scored on EXACTLY the history the
      // candidate itself saw (series[0..atStep-1], never including the
      // target at atStep) — the same information set, or "beats the
      // baseline" would be comparing two different questions.
      const baselineLosses = Object.fromEntries(
        defaultNumericBaselines().map((b) => [b.id, scoreOutput(b.predict(world.series.slice(0, step.atStep)), observed, { rule: SCORING_RULE }).loss]),
      );
      results.push({ forecastId: step.forecastId, atStep: step.atStep, observed, loss: scored.loss, proper: scored.proper, baselineLosses });
      log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: `forecast:${step.forecastId}:${step.atStep}`, revealed: true, loss: scored.loss, observed });
      // A null loss is scoring.js correctly reporting IMPROPER (e.g. CRPS
      // asked to score a "point" prediction — no spread was justified from
      // too little or too-constant history) — a typed gap, never a value to
      // fake with .toFixed(). Per eochat/LAWS.md's candidate law: a typed gap
      // over a silent wrong answer, here applied to a number instead of text.
      const fmt = (l) => (l === null ? "IMPROPER (no proper score for this prediction kind)" : l.toFixed(4));
      progress(`step ${step.atStep}: revealed "${step.forecastId}" — observed=${observed.toFixed(2)} loss=${fmt(scored.loss)} (baseline:last-value=${fmt(baselineLosses["baseline:last-value"])})`);
      continue;
    }

    // "observe": nothing to commit or reveal yet — the series simply advances,
    // the numeric analogue of a narrative "beat".
    stepIndex += 1;
  }

  return { log, results, task };
}
