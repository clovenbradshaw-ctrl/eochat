#!/usr/bin/env node
// probe-navigate-with-small-model.mjs — the payoff this whole investigation
// was aimed at: can a SMALL local model (qwen2.5:0.5b by default, CPU-only,
// no GPU, via ollama) answer a question about a 3.27M-char novel by
// navigating the byte-verified index from
// eoreader6/scripts/navigation-index-war-and-peace.mjs, without the novel
// ever entering its context?
//
// v1 of this script asked the model to pick a waypoint number from the
// index — the model was STEERING navigation. Measured, not assumed: across
// three model sizes (0.5b, 1.5b, 3b) every one picked the WRONG waypoint on
// "How does the book compare Napoleon and Kutuzov as commanders?", even
// though the exact right entry ("russian military kutuzov · napoleon
// defeats kutuzov") appeared THREE separate times in the 57-item list each
// model was shown. Free-form selection by a generative model is not a
// navigation mechanism, it is a guess with confidence dressed on top — and
// this codebase already knew that: eochat's server/instruction-gate.js
// scores every fold against the question by real signal match, never by
// asking a model to pick one, for exactly this reason.
//
// Fixed here: the SURF step is mechanical — deterministic keyword overlap
// between the question and each waypoint's own relation triple + preview,
// no model call, fully reproducible (same question + same index always
// picks the same waypoint). The model's ONLY job is to read the
// mechanically-selected, independently re-verified real text and answer —
// generation, never steering. Every quoted phrase in the model's answer is
// then checked against the real passage before being trusted.
//
// Usage: node scripts/probe-navigate-with-small-model.mjs "<question>" [model] [indexPath] [textPath]
// Requires: ollama running locally (`ollama serve`) with the model pulled.

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR } from "../server/paths.js";

const OLLAMA = "http://127.0.0.1:11434/api/generate";
const question = process.argv[2] || "How does the book compare Napoleon and Kutuzov as commanders?";
const MODEL = process.argv[3] || "qwen2.5:0.5b";
const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
const INDEX_PATH = process.argv[4] || path.join(CACHE_DIR, "war-and-peace-eoreader6-navigation-index.json");
const TEXT_PATH = process.argv[5] || path.join(CACHE_DIR, "war-and-peace-en.lf.txt");

async function ask(prompt, { temperature = 0.2 } = {}) {
  const res = await fetch(OLLAMA, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature } }),
  });
  if (!res.ok) throw new Error(`ollama request failed: ${res.status} — is 'ollama serve' running and is ${MODEL} pulled?`);
  return (await res.json()).response?.trim() ?? "";
}

const STOPWORDS = new Set(["how", "does", "the", "book", "compare", "and", "as", "a", "an", "of", "in", "to", "is", "are", "was", "were", "what", "who", "which", "with", "for", "on", "at", "by", "this", "that", "it", "its"]);
const tokenize = (s) => (s.toLowerCase().match(/[a-zà-ÿ]+/g) ?? []).filter((w) => !STOPWORDS.has(w) && w.length > 2);

const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
const entries = [];
for (const [tier, data] of Object.entries(index.tiers)) {
  for (const w of data.waypoints) entries.push({ n: entries.length + 1, tier, relation: w.relation, preview: w.text.slice(0, 200), byteOffset: w.byteOffset, byteLength: w.byteLength });
}

console.log(`QUESTION: ${question}\n`);
console.log(`${entries.length} waypoints available. Selection is MECHANICAL — no model call — before any generation happens.\n`);

// ── SURF (mechanical) ── score every waypoint by real keyword overlap
// against the question. No model involved. Fully deterministic.
const qTokens = new Set(tokenize(question));
function score(entry) {
  const candTokens = tokenize(`${entry.relation} ${entry.preview}`);
  const matched = new Set();
  for (const t of candTokens) if (qTokens.has(t)) matched.add(t);
  return { hits: matched.size, matched: [...matched] };
}
const scored = entries.map((e) => ({ ...e, ...score(e) })).sort((a, b) => b.hits - a.hits);

console.log("--- SURF (mechanical keyword overlap, top 5) ---");
for (const s of scored.slice(0, 5)) {
  console.log(`  #${s.n} [${s.tier}] hits=${s.hits} matched=[${s.matched.join(",")}]  ${s.relation}`);
}

const top = scored[0];
if (top.hits === 0) {
  console.log("\nNo waypoint shares any keyword with the question — mechanical surf found nothing. Reporting the");
  console.log("gap honestly rather than falling back to a model guess.");
  process.exit(1);
}
console.log(`\nSelected #${top.n} mechanically (${top.hits} keyword hits: ${top.matched.join(", ")}), byteOffset=${top.byteOffset}\n`);

// ── Independently re-fetch the real bytes at the mechanically-chosen offset ──
const fd = fs.openSync(TEXT_PATH, "r");
const buf = Buffer.alloc(top.byteLength + 4000);
const readStart = Math.max(0, top.byteOffset - 1500);
const n = fs.readSync(fd, buf, 0, buf.length, readStart);
fs.closeSync(fd);
const context = buf.subarray(0, n).toString("utf8");
console.log(`--- Independently re-fetched ${n.toLocaleString()} real bytes from ${path.relative(process.cwd(), TEXT_PATH)} at the mechanically-picked offset ---\n`);

// ── ANSWER (model, read-only) ── the model never chose where to look; it
// only reads what mechanical surf handed it and answers.
const answerPrompt = `Answer the question using ONLY the passage below. If the passage doesn't fully answer it, say what it does say and note the limit. Quote at least one short phrase directly from the passage, copied exactly.

Passage:
"""
${context}
"""

Question: ${question}

Answer:`;

const answer = await ask(answerPrompt);
console.log(`--- ANSWER (${MODEL}, reads only the mechanically-surfaced real passage, ${context.length.toLocaleString()} chars) ---`);
console.log(answer);

// ── Grounding check: does the model's answer actually quote real text? ──
// Extract anything in quotes and verify it's a real substring of the
// passage it was given — never trust a small model's citation blind.
const quotedPhrases = [...answer.matchAll(/"([^"]{8,})"/g)].map((m) => m[1]);
if (quotedPhrases.length === 0) {
  console.log("\n[grounding check] no quoted phrase found in the answer to verify.");
} else {
  console.log("\n[grounding check] verifying every quoted phrase is a real substring of the passage shown to the model:");
  for (const q of quotedPhrases) {
    const found = context.includes(q);
    console.log(`  "${q.slice(0, 80)}" -> ${found ? "REAL, found in passage" : "NOT FOUND -- possible fabrication"}`);
  }
}
