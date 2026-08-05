#!/usr/bin/env node
// Longform prose with the lessons the sonata taught.
//
// Usage: node scripts/write-longform.mjs "<question>" [--model llama3.2:latest] [--out essay.md]
//
// This is now a thin CLI wrapper: everything past retrieval is
// server/longform-orchestrator.js — the exact same code eochat's own Chat
// runs (server-side against Ollama, browser-side against WebLLM) for a
// deliberate long-form answer. Running this script after any change to the
// orchestrator is the cheapest real-corpus regression check available.

import fs from "node:fs";
import { engineGroundQuery } from "../server/engine-ground.js";
import { runDeliberateAnswer } from "../server/longform-orchestrator.js";
import { loadMorphologyPrior, discoverNarratorContext } from "../server/longform-node-context.js";

const args = process.argv.slice(2);
const question = args[0];
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const MODEL = argOf("model", "llama3.2:latest");
const OUT = argOf("out", "essay.md");
const OLLAMA = process.env.OLLAMA || "http://localhost:11434";
const NUM_CTX = Number(argOf("num-ctx", 8192));

if (!question) { console.error('usage: write-longform.mjs "<question>"'); process.exit(1); }

// Small generation. num_predict is capped low ON PURPOSE: no prompt generates
// much. This is lesson 2, and it is also what keeps each unit checkable.
async function say(system, user, maxTokens = 260) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Behaviour + content as system, question LAST as the user turn — measured
    // in scripts/probe-prompt-order.mjs: question-first scored 0/2 on citations,
    // this arrangement 2/2 cited with 0 refusals.
    body: JSON.stringify({
      model: MODEL, stream: false,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      options: { temperature: 0.4, num_ctx: NUM_CTX, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(180000),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return (d.message?.content || "").trim();
}

// ── retrieve ──
console.log(`\nquestion: ${question}`);
const t0 = Date.now();
const ground = engineGroundQuery(question, { budget: 4000, maxUnits: 12, limit: 24 });
console.log(`retrieved ${ground.total} passages, ${ground.folded} kept (${Date.now() - t0}ms, no model)`);
if (!ground.citations.length) {
  console.error("no evidence — refusing to write an ungrounded essay");
  process.exit(1);
}

// Narrator/cast context is generic — discovered from whatever sources this
// question's evidence actually came from, not tied to any one book. (This
// script previously also unioned in a hand-curated Frankenstein coref prior;
// that was corpus-specific and has moved out of the shared path — see
// longform-node-context.js's own comment for why a general orchestrator that
// must run on ANY reader-ingested document cannot assume one exists.)
const { narratorSpans, cast } = discoverNarratorContext(ground.citations);
console.log(`narrator frames resolved: ${narratorSpans.length} · cast: ${cast.length} surfaces (discovered)`);
const morphology = loadMorphologyPrior();

const result = await runDeliberateAnswer({
  question,
  citations: ground.citations,
  generate: say,
  narratorSpans,
  cast,
  morphology,
  onProgress: (e) => {
    if (e.phase === "outline") console.log(`outline: ${e.sections} section(s) reaching the mouth (withheld ${e.withheld})`);
    else if (e.phase === "section_titled") console.log(`  titled ${e.id}: "${e.title}"`);
    else if (e.phase === "section_drafted") console.log(`  drafted ${e.id} (${e.words} words)`);
    else if (e.phase === "section_revising") console.log(`re-reading round ${e.round}: residual ${e.residual.toFixed(3)} · ${e.count} section(s) to revise`);
    else if (e.phase === "section_closed") console.log(`  closed ${e.id}: "${e.title}"`);
    else if (e.phase === "assembled") console.log(`assembled: ${e.kept} kept, ${e.dropped} dropped, ${e.withheld} withheld`);
  },
});

// ── assemble the file: prose + a reconstructed Sources / What-this-leaves-out,
// matching this script's existing on-disk format (the orchestrator itself
// returns structured citations/gaps, not prose, since a chat caller already
// has its own dedicated citation/gap UI — a flat file needs it spelled out). ──
const out = [`# ${question}\n`, result.text, `\n## Sources\n`];
result.citations.forEach((c) => {
  const src = String(c.source_id ?? "").replace(/^source:/, "").replace(/:chunk-\d+$/, "").replace(/^.*\//, "");
  out.push(`[${c.index}] ${src} @ bytes ${c.byte_start}–${c.byte_end}\n> ${String(c.text).slice(0, 220).replace(/\s+/g, " ")}…\n`);
});

out.push(`\n## What this leaves out\n`);
for (const g of ground.gaps ?? []) out.push(`- engine gap: ${g.reason || g}`);
for (const g of result.gaps) out.push(`- ${g.reason}`);
if (!ground.gaps?.length && !result.gaps.length) out.push(`- nothing — every retrieved section closed`);

fs.writeFileSync(OUT, out.join("\n"));
console.log(`\nwrote ${OUT} · ${result.sectionsKept} section(s) kept, ${result.sectionsDropped} dropped for not closing · ${result.citations.length} sources cited · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
