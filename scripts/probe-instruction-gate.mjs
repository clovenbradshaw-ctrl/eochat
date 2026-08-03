// probe-instruction-gate.mjs — dry-run the surf/fold instruction gate against a
// set of probe questions, without touching the model or the server.
//
// The point of the experiment: the full instruction set exceeds the context
// window, so each turn surfaces only the relevant folds (verbatim) and folds
// the rest to a fingerprint index. This probe shows, per turn, what got
// surfaced, what got folded, and the honest token accounting of the block.

import { createInstructionGate } from "../server/instruction-gate.js";

const gate = createInstructionGate();

const probes = [
  { question: "Hello.", history: [], note: "no signal — core only" },
  { question: "Translate this into Basque, keeping the formal register.", history: [], note: "expect translation-idiom; basque/multilingual may not fit budget" },
  { question: "Explain how the searchSpans function works in eoreader6.", history: [], note: "expect code-answers" },
  { question: "Summarize the first chapter of the book.", history: [], note: "expect summarization + document-navigation" },
  { question: "Write a sonnet about the creature.", history: [], note: "expect creative-fiction" },
  { question: "Is that figure actually in the report? Trace it for me.", history: [], note: "expect citation-audit" },
  { question: "Give me the raw passages about the dreary night, nothing else.", history: [], note: "expect mode-surf" },
  { question: "Review my draft before I send it.", history: ["Here is the draft: ...", "What do you think?"], note: "expect argument-review" },
];

console.log(`corpus: ${gate.folds.length} folds, ${gate.totalTokens()} tokens full, budget ${gate.budgetTokens}\n`);
console.log("core (always-on):", gate.folds.filter((f) => f.always).map((f) => f.id).join(", "), "\n");

for (const p of probes) {
  const r = gate.gate({ question: p.question, history: p.history });
  const extra = r.activeIds.filter((id) => !gate.folds.find((f) => f.id === id)?.always);
  console.log(`Q: ${p.question}`);
  console.log(`  [${p.note}]`);
  console.log(`  active ${r.activeIds.length}: ${r.activeIds.join(", ")}`);
  console.log(`  extra (conditional surfaced): ${extra.length ? extra.join(", ") : "(none)"}`);
  console.log(`  folded ${r.foldedIds.length} · block ${r.stats.blockTokens}/${r.stats.budget} tokens · overflow ${r.stats.overflow}`);
  console.log("");
}

const all = gate.gate({ question: "Translate this into Basque and write a sonnet about the creature.", history: [] });
console.log(`full-set comparison: all ${gate.folds.length} folds verbatim = ${gate.totalTokens()} tokens vs gated block = ${all.stats.blockTokens} tokens (${Math.round((1 - all.stats.blockTokens / gate.totalTokens()) * 100)}% smaller)`);
