#!/usr/bin/env node
// probe-support-conversation.mjs — a full back-and-forth where the agent has a
// 25-page support manual (~9.2k tokens, larger than the 8k context window) but
// is fed only the salient pages, re-chosen mechanically each turn.
//
// The conversation drifts across topics on purpose: troubleshooting → return →
// refund/exchange/shipping → tracking → escalation → privacy (in French). Each
// turn the gate surfaces the folds the message needs and folds the rest; the
// model only ever sees that turn's ACTIVE pages plus the conversation so far.
//
// NOTE on salience: the live server blends the last few user turns into the
// cue. Here each turn is judged on its own message so the surf/fold decision
// stays crisp — every answer is driven only by the pages THIS turn needed.

import path from "node:path";
import { createInstructionGate, countTokens } from "../server/instruction-gate.js";

const OLLAMA = process.env.OLLAMA || "http://localhost:11434";
const MODEL = process.env.MODEL || "llama3.2:latest";
const NUM_CTX = Number(process.env.NUM_CTX || 8192);
const BUDGET = Number(process.env.BUDGET || 3600);
const OUTPUT_RESERVE = 350; // num_predict — the answer itself must fit too

const gate = createInstructionGate({
  dir: path.join(process.cwd(), "instruction-set-support"),
  budgetTokens: BUDGET,
});
const CORE = gate.folds.filter((f) => f.always).map((f) => f.id);

async function chat(messages) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      options: { num_ctx: NUM_CTX, num_predict: 350, temperature: 0.4 },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.message?.content ?? "").trim();
}

const CONVO = [
  {
    q: "Hi! I bought an Aurora One speaker two weeks ago, and now it's making a crackling static noise. Can you help?",
    note: "needs troubleshooting",
  },
  {
    q: "I already tried resetting it and updating the app, but the static is still there. I think I want to return it.",
    note: "needs return + troubleshooting",
  },
  {
    q: "Should I ask for a refund or an exchange? And if they exchange it, how long will the replacement take to get here?",
    note: "needs refund + return + shipping",
  },
  {
    q: "The replacement shipped, but the tracking hasn't updated in three days and I'm worried it's lost. What happens now?",
    note: "needs shipping",
  },
  {
    q: "Honestly this whole thing is taking forever. I'd like to speak to a manager about it.",
    note: "needs escalation + sla",
  },
  {
    q: "Merci, et une dernière chose : si je supprime mon compte, est-ce que mes données sont vraiment supprimées ?",
    note: "needs multilingual + privacy",
  },
];

console.log(`MODEL=${MODEL}  num_ctx=${NUM_CTX}  gate budget=${BUDGET}`);
console.log(`manual: ${gate.folds.length} pages, ${gate.totalTokens()} tokens full (context ${NUM_CTX} — ${gate.totalTokens() > NUM_CTX ? "does not fit whole" : "fits"})`);
console.log(`core pages (always on every turn): ${CORE.join(", ")}\n`);
console.log("─".repeat(72));

const history = []; // the conversation so far, as the model sees it
const foldUsage = {}; // fold id -> turns in which it was active

for (const [i, turn] of CONVO.entries()) {
  const t = i + 1;
  const r = gate.gate({ question: turn.q, debug: true });
  for (const id of r.activeIds) (foldUsage[id] = foldUsage[id] || []).push(`t${t}`);

  console.log(`\n—— turn ${t} · ${turn.note} ——`);
  console.log(`READER: ${turn.q}`);
  console.log(`[gate] surface for this turn — ${r.activeIds.length} active, ${r.foldedIds.length} folded, block ${r.stats.blockTokens}/${r.stats.budget} tokens:`);
  for (const s of r.scores) {
    if (s.score > 0) {
      const mark = r.activeIds.includes(s.id) ? "SURFACED" : "rejected";
      console.log(`  ${mark.padEnd(9)} ${s.id.padEnd(24)} score ${String(s.score).padStart(2)}  matched: ${s.matched.join(", ")}`);
    }
  }
  if (r.scores.filter((s) => s.score > 0).length < r.activeIds.length) {
    console.log(`  (also active: ${r.activeIds.filter((id) => !r.scores.some((s) => s.id === id && s.score > 0)).join(", ")})`);
  }

  const messages = [
    { role: "system", content: r.systemMessage },
    ...history,
    { role: "user", content: turn.q },
  ];
  // R5 — fit the model that exists. The whole prompt (gate block + history +
  // question + output reserve) must fit the deployed window, or the top is
  // silently truncated and the reader's session drifts.
  const promptTokens = countTokens(JSON.stringify(messages));
  const fits = promptTokens + OUTPUT_RESERVE <= NUM_CTX;
  console.log(`[fit] prompt ${promptTokens} + reserve ${OUTPUT_RESERVE} vs window ${NUM_CTX}: ${fits ? "fits" : "OVER — instructions would be truncated"}`);
  if (r.stats.gap) {
    console.log(`[gap] no fold matched this turn — gate marker names the absence; ${r.stats.rejectedByBudget} relevant fold(s) rejected by budget`);
  }
  const text = await chat(messages);
  history.push({ role: "user", content: turn.q }, { role: "assistant", content: text });

  console.log(`AGENT: ${text}\n`);
  console.log("─".repeat(72));
}

console.log("\nSalience map — which manual pages the agent was actually given, per turn:");
console.log(`  ${"manual page".padEnd(24)} turns active`);
const rows = Object.entries(foldUsage).sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
for (const [id, turns] of rows) console.log(`  ${id.padEnd(24)} ${turns.join(", ")}`);
console.log(`\ncore pages (identity, ethics, tone, gate-control) were active every turn;`);
console.log(`the other 21 policy pages were folded away until a turn needed them.`);
