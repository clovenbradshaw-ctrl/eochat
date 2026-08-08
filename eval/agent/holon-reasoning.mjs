// The recursive holonic wrapper applied to DIAGNOSTIC SYNTHESIS instead of
// coding tasks — same task-log.js spine holon-coder.mjs already uses
// (createTaskLog/append/projectTasks/foldToWorkingSet, the real PROPOSE/
// SUPERSEDE/RESULT entry kinds, SEG as the Structure operator for splitting
// a task apart), because that spine "knows about structure, not about what
// the structure is made of" (task-log.js's own header) — reused, not
// reimplemented, exactly the same discipline this codebase applies
// everywhere else.
//
// What's different from holon-coder.mjs: the leaf executor. Coding sub-tasks
// run through react-loop.mjs's tool-calling ReAct loop; a diagnostic
// sub-task has no tools to call — it evaluates ONE candidate cause against
// context that's already fully assembled (the fold), so the leaf here is a
// single judged call, not a multi-step loop.
//
// The real failure this exists to fix (measured, not hypothesized — see
// eval/chat/live/run-milkshake-reasoning.mjs's first run): a single
// collapsed generation asked to (1) partition the candidate causes, (2)
// evaluate each against evidence, and (3) rank them, in one ungapped
// paragraph, used correct evidence but attached it to the wrong candidate —
// a Tempus-shaped assembly (Law 2) with no per-candidate checkpoint to catch
// it. This module makes those three operators (SEG, per-candidate EVA,
// final SYN) into three separately checkpointed steps, logged to a real
// task-log, with a bidirectional replan (SUPERSEDE) when two candidates
// come back contradictorily "both primary" — the same low->high
// POSSIBILITY-setting holon-coder.mjs already does for a failed coding
// attempt, applied here to a genuine cross-candidate disagreement instead
// of a tool-loop failure.

import { createTaskLog, append, projectTasks, ENTRY_KINDS, STRUCTURE_OPERATORS, OPERATOR_BASIS, GRAINS, checkCubeProgression } from "../../server/task-log.js";
import { extractJSONObject } from "./lib/parse-action.mjs";

const MAX_CANDIDATES = 5;
const CONTRADICTION_CONFIDENCE = new Set(["medium", "high"]);

function askJSON(adapter, groundingMessages, prompt, maxTokens = 400) {
  const messages = [...groundingMessages, { role: "user", content: prompt }];
  return adapter.generate(messages, { maxTokens }).then((r) => ({ parsed: extractJSONObject(r.text), raw: r.text, wallMs: r.wallMs }));
}

/** SEG: partition the diagnostic question into independent candidate causes to evaluate — grounded in the real context, not a hardcoded domain list. */
async function planCandidates(adapter, groundingMessages, question) {
  const prompt = `You are a careful diagnostic reasoner. Before answering the question below, name the DISTINCT candidate causes/claims that need to be independently checked against the evidence in this conversation. Do not evaluate them yet — only name them, grounded in what has actually been discussed, not a generic checklist.

QUESTION: ${question}

Respond with ONLY a JSON object:
{"candidates": [{"id": "short-id", "claim": "one-sentence candidate claim to evaluate"}]}

Name 2 to ${MAX_CANDIDATES} candidates.`;
  const { parsed } = await askJSON(adapter, groundingMessages, prompt, 400);
  if (!parsed || !Array.isArray(parsed.candidates)) return null;
  const candidates = parsed.candidates.filter((c) => c && typeof c.claim === "string" && c.claim.trim()).slice(0, MAX_CANDIDATES);
  return candidates.length >= 2 ? candidates : null;
}

/** Per-candidate EVA: judge ONE candidate against the evidence, independently — never asked to rank against siblings. */
async function evaluateCandidate(adapter, groundingMessages, question, candidate) {
  const prompt = `You are evaluating ONE candidate cause for this diagnostic question, independently of any other candidate — a separate step will compare candidates against each other, so do not rank or hedge toward "it depends on the others" here.

QUESTION BEING WORKED TOWARD: ${question}
CANDIDATE TO EVALUATE: ${candidate.claim}

Judge ONLY whether the evidence already in this conversation supports or rules out THIS candidate. Respond with ONLY a JSON object:
{"verdict": "supported", "confidence": "low", "evidence": "the SPECIFIC fact or statement from the conversation this rests on", "reasoning": "one or two sentences"}

("verdict" is one of supported / ruled_out / uncertain. "confidence" is one of low / medium / high.)`;
  const { parsed, wallMs } = await askJSON(adapter, groundingMessages, prompt, 350);
  if (!parsed || typeof parsed.verdict !== "string") {
    return { ...candidate, verdict: "uncertain", confidence: "low", evidence: null, reasoning: "evaluation response was not parseable", wallMs };
  }
  return { ...candidate, verdict: parsed.verdict, confidence: parsed.confidence ?? "low", evidence: parsed.evidence ?? null, reasoning: parsed.reasoning ?? null, wallMs };
}

/** Bidirectional replan trigger: two+ candidates independently came back "supported" — real cross-candidate evidence, not a guess, earning a tiebreak. */
async function tiebreak(adapter, groundingMessages, question, contenders) {
  const list = contenders.map((c, i) => `${i + 1}. ${c.claim} — ${c.evidence ?? "(no evidence cited)"}`).join("\n");
  const prompt = `Two or more candidate causes were independently evaluated as SUPPORTED by the evidence for this question:

QUESTION: ${question}

${list}

They were evaluated separately and cannot both simply be asserted as THE single leading cause without reconciling them. Does one actually rule out, subsume, or outrank the other given the full conversation — or are both genuinely live and should be reported together? Respond with ONLY a JSON object:
{"primary": "the claim text of the stronger candidate, or 'both' if genuinely tied", "reasoning": "one or two sentences citing the deciding evidence"}`;
  const { parsed, wallMs } = await askJSON(adapter, groundingMessages, prompt, 350);
  if (!parsed) return null;
  return { primary: parsed.primary ?? null, reasoning: parsed.reasoning ?? null, wallMs };
}

/** SYN: the final verdict, synthesized from already-checkpointed candidate results — never re-deriving them. */
async function synthesizeVerdict(adapter, groundingMessages, question, candidateResults, tiebreakResult) {
  const findings = candidateResults
    .map((c) => `- ${c.claim}: ${c.verdict} (confidence: ${c.confidence}) — evidence: ${c.evidence ?? "none cited"}`)
    .join("\n");
  const tiebreakBlock = tiebreakResult
    ? `\n\nWhen multiple candidates came back "supported," this was reconciled: ${tiebreakResult.reasoning ?? ""} (stronger candidate: ${tiebreakResult.primary ?? "unresolved"})`
    : "";
  const prompt = `Original question: ${question}

Independent, already-checkpointed evaluation results for each candidate cause — do not re-derive these, synthesize your answer FROM them:
${findings}${tiebreakBlock}

Now answer the original question directly and concisely, using these vetted findings as your basis.`;
  const messages = [...groundingMessages, { role: "user", content: prompt }];
  const result = await adapter.generate(messages, { maxTokens: 700 });
  return { text: result.text, wallMs: result.wallMs };
}

/**
 * Run a diagnostic synthesis question as a holonic task: SEG into candidate
 * causes, EVA each independently (checkpointed, logged), bidirectional
 * replan (SUPERSEDE) on a real cross-candidate contradiction, then SYN the
 * final verdict from the checkpointed results.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.question
 * @param {object} opts.adapter  {generate(messages, {maxTokens}) -> {text, wallMs}}
 * @param {{role:string, content:string}[]} opts.groundingMessages  the same folded context a flat pipeline would use
 * @param {import("../../server/task-log.js").TaskLog} [opts.log]
 */
export async function runHolonicReasoningTask({ taskId = "root", question, adapter, groundingMessages, log = createTaskLog() }) {
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: taskId, description: question, depends_on: [] });

  const candidates = await planCandidates(adapter, groundingMessages, question);
  if (!candidates) {
    // Honest fallback: if planning didn't produce a real partition, answer
    // directly rather than fabricating candidates — same "no evidence, no
    // retry" discipline as holon-coder.mjs, applied to planning instead of
    // replanning.
    const direct = await synthesizeVerdict(adapter, groundingMessages, question, [], null);
    log = append(log, { kind: ENTRY_KINDS.RESULT, task_id: taskId, depends_on: [], result: { decomposed: false, reason: "planning did not produce a usable candidate partition" } });
    return { log, text: direct.text, decomposed: false, candidates: [] };
  }

  for (const c of candidates) {
    log = append(log, {
      kind: ENTRY_KINDS.PROPOSE, task_id: `${taskId}/${c.id}`, description: c.claim, depends_on: [taskId],
      operator: STRUCTURE_OPERATORS.SEG, operator_basis: OPERATOR_BASIS.PRODUCED, grain: GRAINS[1], // Figure — a single distinguished candidate pulled out of the undifferentiated question
    });
  }

  const evaluated = await Promise.all(candidates.map((c) => evaluateCandidate(adapter, groundingMessages, question, c)));
  for (const e of evaluated) {
    log = append(log, { kind: ENTRY_KINDS.RESULT, task_id: `${taskId}/${e.id}`, depends_on: [], result: { verdict: e.verdict, confidence: e.confidence, evidence: e.evidence, reasoning: e.reasoning } });
  }

  const supported = evaluated.filter((e) => e.verdict === "supported" && CONTRADICTION_CONFIDENCE.has(e.confidence));
  let tiebreakResult = null;
  if (supported.length >= 2) {
    tiebreakResult = await tiebreak(adapter, groundingMessages, question, supported);
    log = append(log, {
      kind: ENTRY_KINDS.SUPERSEDE, task_id: `${taskId}@tiebreak`, supersedes: taskId, description: question, depends_on: [],
      operator: STRUCTURE_OPERATORS.CON, operator_basis: OPERATOR_BASIS.PRODUCED,
      revised_because: `${supported.length} candidates independently came back "supported": ${supported.map((c) => c.claim).join(" / ")}`,
    });
  }

  const verdict = await synthesizeVerdict(adapter, groundingMessages, question, evaluated, tiebreakResult);
  log = append(log, {
    kind: ENTRY_KINDS.RESULT, task_id: taskId, depends_on: [],
    result: { decomposed: true, candidateCount: candidates.length, tiebreakTriggered: !!tiebreakResult },
  });

  const cubeCheck = checkCubeProgression(log);

  return { log, text: verdict.text, decomposed: true, candidates: evaluated, tiebreak: tiebreakResult, cubeCheck };
}
