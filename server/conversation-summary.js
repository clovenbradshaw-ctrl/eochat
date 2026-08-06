// conversation-summary.js — always-running LLM summary of discourse FLOW.
//
// Operates on TURN-BY-TURN discourse folds, never raw messages. Each turn gets
// folded to its discourse contribution (what changed in the conversation because
// of this turn). The summary tracks how the conversation evolved turn by turn.
// Long messages are compressed to their discourse move. Context window stays
// bounded: summary + N short folds, each ~100 chars.
//
// This module is pure: no IO, no model calls.

const SUMMARY_MAX_CHARS = 200;
const ENTITIES_MAX = 8;
const CONTEXT_MAX_CHARS = 150;
const FLOW_MAX_CHARS = 200;
const FOLD_MAX_CHARS = 100;
const MAX_FOLDS_IN_PROMPT = 12;

export function emptySummary() {
  return {
    topic: null,
    entities: [],
    context: null,
    language: null,
    turnCount: 0,
    flow: null,
    folds: [],
  };
}

export function buildSummarySystemMessage(summary) {
  if (!summary || !summary.topic) return null;
  const parts = [];
  parts.push("PAST DISCOURSE — context from earlier turns ONLY. It is background for threads that started earlier, not the subject of the current turn. Answer the user's current question as a fresh request; use this only to follow along when it clearly refers to something already discussed.");
  parts.push(`Topic: ${summary.topic}`);
  if (summary.flow) parts.push(`Flow: ${summary.flow}`);
  if (summary.entities?.length) parts.push(`Entities: ${summary.entities.join(", ")}`);
  if (summary.context) parts.push(`Carried context: ${summary.context}`);
  return parts.join("\n");
}

export async function updateSummary({ previousSummary, turnFold, callLLM }) {
  const prev = previousSummary || emptySummary();
  const folds = [...(prev.folds || []), turnFold];
  const recentFolds = folds.slice(-MAX_FOLDS_IN_PROMPT);
  const prompt = buildSummaryUpdatePrompt(prev, recentFolds);
  const response = await callLLM(prompt);
  const parsed = parseSummaryResponse(response);
  return normalizeSummary(parsed, prev, folds);
}

function buildSummaryUpdatePrompt(prev, folds) {
  const prevBlock = prev.topic
    ? `PREV: ${prev.topic} | ${prev.flow || ""} | ${prev.entities?.join(",") || ""} | ${prev.context || ""}`
    : "First turn.";

  const foldLines = folds.map((f, i) => `Turn ${i + 1}: ${f}`).join("\n");

  return `${prevBlock}

TURNS:
${foldLines}

Update the summary to include the latest turn. Track DISCOURSE FLOW — how the conversation evolved turn by turn, not message details. Every field stays short. Reply with a JSON object only (no markdown, no extra text), where:
- topic: one short phrase naming what the conversation is about now
- flow: one short sentence on how the thread evolved across all turns
- entities: only the people, organizations, or works actually named so far (max 8) — never turn labels, never prose
- context: what the reader must still know from earlier turns to follow along
- language: ISO 639-1 code of the dominant language
- turnCount: integer, now ${prev.turnCount + 1}

{"topic":"<what this conversation is about now>","flow":"<how the thread evolved>","entities":["<entity>","<entity>"],"context":"<what carries forward>","language":"<ISO code>","turnCount":${prev.turnCount + 1}}`;
}

function parseSummaryResponse(response) {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function normalizeSummary(parsed, prev, folds) {
  if (!parsed) return { ...prev, folds };
  return {
    topic: truncate(parsed.topic || prev.topic, SUMMARY_MAX_CHARS),
    flow: truncate(parsed.flow || prev.flow, FLOW_MAX_CHARS),
    entities: Array.isArray(parsed.entities)
      ? parsed.entities.slice(0, ENTITIES_MAX).map((e) => String(e).slice(0, 40))
      : prev.entities,
    context: truncate(parsed.context || prev.context, CONTEXT_MAX_CHARS),
    language: parsed.language || prev.language,
    turnCount: Number.isFinite(parsed.turnCount) ? parsed.turnCount : prev.turnCount + 1,
    folds,
  };
}

export async function foldTurn({ question, answer, callLLM }) {
  const prompt = `Fold this turn to its DISCOURSE CONTRIBUTION (what changed in the conversation). Max ${FOLD_MAX_CHARS} chars. One line.

Q: ${truncate(question, 300)}
A: ${truncate(answer, 300)}

Fold (one line, what this turn added to the conversation flow):`;
  const raw = (await callLLM(prompt)).trim();
  const fold = extractPlainText(raw);
  return truncate(fold, FOLD_MAX_CHARS);
}

// The fold is a plain-text one-liner, but a caller may hand every summary
// call the same JSON-forced LLM; peel a JSON wrapper when one appears so the
// fold is the bare sentence either way.
function extractPlainText(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return raw.split("\n")[0];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    for (const key of ["fold", "contribution", "result", "summary", "text"]) {
      if (typeof parsed[key] === "string") return parsed[key];
    }
  } catch { /* not JSON after all — keep raw */ }
  return raw.split("\n")[0];
}

function truncate(text, max) {
  const s = String(text || "").trim();
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
