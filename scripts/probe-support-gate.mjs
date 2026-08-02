#!/usr/bin/env node
// probe-support-gate.mjs — the surf-and-fold experiment on a customer-support
// instruction set that is too large for the local model's context.
//
// The support manual (instruction-set-support/, 25 folds) is ~9.2k tokens. The
// local model runs at num_ctx 8192, so the FULL manual cannot fit. Per turn,
// the instruction gate builds a MECHANICAL instruction block: it surfaces the
// folds this turn needs (verbatim, chosen by keyword signals) and folds the
// rest to one-line fingerprints. The model is fed only that block.
//
// For each probe question this script shows:
//   - which folds surfaced and the exact signals that matched (mechanical)
//   - the block's token accounting vs budget and vs the 8192 window
//   - the model's answer with the gated prompt
// It also runs the un-gated baseline (full manual as one system message) to
// show what happens when instructions don't fit.

import path from "node:path";
import { createInstructionGate, countTokens } from "../server/instruction-gate.js";

const OLLAMA = process.env.OLLAMA || "http://localhost:11434";
const MODEL = process.env.MODEL || "gemma2:2b";
const NUM_CTX = Number(process.env.NUM_CTX || 8192);
const BUDGET = Number(process.env.BUDGET || 3600);
const OUTPUT_RESERVE = 500; // num_predict — the answer itself must fit too

const SUPPORT_DIR = path.join(process.cwd(), "instruction-set-support");
const gate = createInstructionGate({ dir: SUPPORT_DIR, budgetTokens: BUDGET });
const CORE = gate.folds.filter((f) => f.always).map((f) => f.id);

async function chat({ messages, numPredict = 500 }) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      options: { num_ctx: NUM_CTX, num_predict: numPredict, temperature: 0.4 },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { text: (j.message?.content ?? "").trim(), promptEval: j.prompt_eval_count, evalTokens: j.eval_count };
}

const PROBES = [
  {
    q: "Respond as a customer support agent: I got an email about a suspicious login on my account. What should I do?",
    expect: ["account-issues", "security-fraud"],
  },
  {
    q: "How do I return my Aurora One speaker? I bought it a week ago.",
    expect: ["return-policy"],
  },
  {
    q: "I was charged twice for my subscription this month. Can you help?",
    expect: ["billing-invoices", "subscription-plans"],
  },
  {
    q: "Mi altavoz Aurora One no suena y no conecta con el móvil. ¿Me podéis ayudar?",
    expect: ["multilingual-support", "troubleshooting"],
  },
  {
    q: "How long until my repair comes back? It's been at the service center.",
    expect: ["warranty-policy", "sla-response"],
  },
];

function describeSurfaced(r) {
  const lines = [];
  for (const s of r.scores.filter((x) => x.score > 0)) {
    const active = r.activeIds.includes(s.id);
    lines.push(`   ${active ? "SURFACED " : "rejected "} ${s.id.padEnd(24)} score ${String(s.score).padStart(2)}  matched: ${s.matched.join(", ")}`);
  }
  return lines.join("\n");
}

console.log(`MODEL=${MODEL}  num_ctx=${NUM_CTX}  gate budget=${BUDGET}`);
console.log(`support manual: ${gate.folds.length} folds, ${gate.totalTokens()} tokens full`);
console.log(`→ full manual ${gate.totalTokens() > NUM_CTX ? "EXCEEDS" : "fits"} the ${NUM_CTX}-token context window by ${gate.totalTokens() - NUM_CTX} tokens\n`);

const base = gate.gate({ question: PROBES[0].q, debug: true });
console.log(`core (always-on): ${CORE.join(", ")}`);
console.log(`gated core-only block: ${base.stats.blockTokens} tokens (budget ${base.stats.budget})\n`);

for (const [i, p] of PROBES.entries()) {
  console.log(`━━━ question ${i + 1} ━━━`);
  console.log(`Q: ${p.q}`);
  const r = gate.gate({ question: p.q, debug: true });

  const missing = p.expect.filter((id) => !r.activeIds.includes(id));
  console.log(describeSurfaced(r));
  console.log(`\nACTIVE (${r.activeIds.length}): ${r.activeIds.join(", ")}`);
  console.log(`FOLDED (${r.foldedIds.length}): ${r.foldedIds.slice(0, 4).join(", ")}${r.foldedIds.length > 4 ? " …" : ""}`);
  console.log(`block ${r.stats.blockTokens}/${r.stats.budget} tokens · used ${r.stats.usedTokens} · index ${r.stats.indexTokens} · overflow ${r.stats.overflow}`);
  console.log(`expected folds surfaced: ${missing.length === 0 ? "yes" : `NO — missing ${missing.join(", ")}`}`);

  const messages = [{ role: "system", content: r.systemMessage }, { role: "user", content: p.q }];
  const promptTokens = countTokens(JSON.stringify(messages));
  const fits = promptTokens + OUTPUT_RESERVE <= NUM_CTX;
  console.log(`[fit] prompt ${promptTokens} + reserve ${OUTPUT_RESERVE} vs window ${NUM_CTX}: ${fits ? "fits" : "OVER — instructions would be truncated"}`);
  const { text, promptEval } = await chat({ messages });
  if (i === 0) {
    console.log("\nmechanical block preview (what the model actually received, first 900 chars):");
    console.log(r.systemMessage.slice(0, 900));
  }
  console.log(`\nprompt_eval_count ${promptEval} (window ${NUM_CTX})`);
  console.log(`\n— answer —\n${text}\n`);
}

console.log(`━━━ UNGATED BASELINE: full manual as one system message ━━━`);
const full = gate.folds.map((f) => `### ${f.id}\n${f.body}`).join("\n\n");
const messages = [
  { role: "system", content: `You are Aurora Devices customer support.\n\n${full}` },
  { role: "user", content: PROBES[0].q },
];
try {
  const { text, promptEval } = await chat({ messages, numPredict: 500 });
  const est = gate.totalTokens();
  const dropped = est > promptEval;
  console.log(`full manual: ${est} tokens (gate estimate) into a ${NUM_CTX}-token window — cannot fit whole`);
  console.log(`prompt_eval_count ${promptEval} → Ollama kept only the most recent ${promptEval} tokens;`);
  console.log(`the manual's START — the identity/persona folds — was ${dropped ? `silently dropped (~${est - promptEval} tokens by estimate)` : "kept"}`);
  console.log(`[R5 verdict] ${dropped ? "VIOLATION — instructions were truncated by the window (ungated baseline)" : "ok — full manual actually fit"}`);
  console.log(`\n— ungated answer (persona/identity missing from context) —\n${text.slice(0, 600)}`);
} catch (err) {
  console.log(`ungated call failed: ${err.message}`);
}
