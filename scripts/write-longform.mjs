#!/usr/bin/env node
// Longform prose with the lessons the sonata taught.
//
// Usage: node scripts/write-longform.mjs "<question>" [--model llama3.2:latest] [--out essay.md]
//
// The shape, in order:
//   retrieve   engine sweeps wide (mechanical, ~400ms, no model)
//   earn       an outline from the evidence's own dependency structure
//   fold       to a handful BEFORE any generation — the mouth
//   produce    one small generation per section, each with its own passages
//   re-read    the same grounding check, applied to our own output
//   revise     supersede what its evidence does not carry; append, never mutate
//   assemble   with the withheld and the unresolved visible

import fs from "node:fs";
import { engineGroundQuery } from "../server/engine-ground.js";
import { outlineFromEvidence, reviseDraft, fidelityResidual, attributionResidual } from "../server/longform.js";
import { loadCorefPrior, earnNesting } from "../server/borrowed-form.js";
import { discoverCast, castSurfaces } from "../vendor/eoreader5/packages/engine/referents/discover-cast.js";
const castedSources = new Set();
import { outlineOfText } from "../server/engine-ground.js";
import { projectTasks } from "../server/task-log.js";

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
async function say(system, user, { maxTokens = 260 } = {}) {
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

// ── narrator frames, so "I" is resolvable ──
//
// A first-person subject is a surface fixed by SCOPE. Frankenstein nests:
// without these spans every "I" in the creature's tale is silently Victor,
// which is exactly the misattribution the essay shipped.
// The cast is DISCOVERED from the sources themselves, so this works on any
// corpus with enough to surf and fold — no hand-typed prior per text. A coref
// prior, where one exists, is UNIONED in: it carries the model-tier referents
// discovery cannot reach (an emanon like "the creature" has no name to cluster).
let narratorSpans = [];
let cast = [];
for (const c of ground.citations) {
  const src = String(c.source_id ?? "").replace(/^source:/, "").replace(/:chunk-\d+$/, "");
  if (!src || castedSources.has(src)) continue;
  castedSources.add(src);
  try {
    const body = fs.readFileSync(src, "utf8");
    const found = discoverCast(body);
    cast.push(...castSurfaces(found.cast));
    console.log(`  cast from ${src.replace(/^.*\//, "")}: ${found.cast.length} referents (${found.gaps.length} gaps)`);
  } catch { /* unreadable source — its referents simply are not nameable */ }
}
try {
  const { prior: coref } = loadCorefPrior("pg84-frankenstein");
  if (coref) {
    cast.push(...(coref.referents ?? []).flatMap((r) => [
      r.id, r.display,
      ...(r.surfaces ?? []).map((s) => s.surface),
    ]).filter(Boolean).map((x) => String(x).toLowerCase()));
    const srcText = fs.readFileSync(new URL("../../pg84.txt", import.meta.url), "utf8");
    const sections = outlineOfText(srcText, { max: 60 }).headings;
    narratorSpans = earnNesting(srcText, sections, coref).spans;
  }
} catch { /* no narrator prior for this corpus — reported as a gap below */ }
cast = [...new Set(cast)];
console.log(`narrator frames resolved: ${narratorSpans.length} · cast: ${cast.length} surfaces (discovered + prior)`);

// ── earn an outline, then fold ──
const { sections, levels, closure, withheld, withheld_ids } = outlineFromEvidence(ground.citations, { maxSections: 5 });
console.log(`outline produced in ${closure.steps} steps, halted by ${closure.halted_by}`);
console.log(`sections reaching the mouth: ${sections.length} (withheld ${withheld})`);
for (const s of sections) {
  const d = levels.find((l) => l.task_id === s.task_id)?.depth ?? 0;
  console.log(`  ${"  ".repeat(d)}[${s.operator}] ${s.description ?? "(title earned from evidence)"} · ${s.evidence.length} passage(s)`);
}

// Evidence per section, numbered so citations are mechanical.
const byId = new Map(ground.citations.map((c) => [c.span_id, c]));
const evidenceBySection = new Map(
  sections.map((s) => [s.task_id, s.evidence.map((id) => byId.get(id)).filter(Boolean)])
);

// ── produce: one small generation per section ──
const drafts = new Map();
const titles = new Map();
const titleOf = (t) => titles.get(t.task_id) ?? titles.get(String(t.task_id).replace(/@r\d+$/, "")) ?? t.description ?? "(untitled)";
for (const s of sections) {
  const cited = evidenceBySection.get(s.task_id) ?? [];
  if (!cited.length) continue;
  const block = cited.map((c, i) => `[${i + 1}] ${String(c.text).slice(0, 700)}`).join("\n\n");
  const system =
    `You are writing ONE short section of a longer piece. Write 3-5 sentences, no heading, no preamble. ` +
    `Use only the numbered passages below and cite each claim like [1]. ` +
    `You have [1] through [${cited.length}] — never cite outside that range.\n\n` +
    `PASSAGES:\n${block}`;
  // Name the section from its own evidence — another small production, not a
  // filename. Six words, so it stays a claim rather than becoming a paragraph.
  if (!s.description) {
    const title = await say(
      `Name what these passages are ABOUT, in at most six words. Reply with the phrase only — ` +
      `no quotes, no punctuation, no preamble.\n\nPASSAGES:\n${block}`,
      question, { maxTokens: 24 }
    );
    titles.set(s.task_id, title.replace(/^["'\s]+|["'.\s]+$/g, "").split("\n")[0].slice(0, 70));
  }
  const draft = await say(system, `Section: ${titles.get(s.task_id) ?? s.description}\n\nQuestion: ${question}`);
  drafts.set(s.task_id, draft);
  const att = await attributionResidual(draft, cited, { narratorSpans, cast });
  const lex = fidelityResidual(draft, cited);
  console.log(`  wrote ${s.task_id} (${draft.split(/\s+/).length} words · lexical ${lex.residual === null ? "n/a" : lex.residual.toFixed(2)} · attribution ${att.residual === null ? "n/a" : att.residual.toFixed(2)}${att.misattributions?.length ? ` · ${att.misattributions.length} MISATTRIBUTION` : ""})`);
  for (const m of att.misattributions ?? []) console.log(`      ✗ ${m.message}`);
}

// ── re-read and revise ──
console.log("\nre-reading:");
let log = closure.log, prev = Infinity, round = 0;
while (round < 3) {
  const pass = reviseDraft(log, drafts, evidenceBySection, { tolerance: 0.45 });
  if (pass.residual === null) { console.log("  residual not measurable"); break; }
  console.log(`  round ${round + 1}: residual ${pass.residual.toFixed(3)} · ${pass.revised} section(s) to revise`);
  if (!pass.revised) { console.log("  every section is carried by its evidence — closed"); break; }
  if (pass.residual >= prev - 0.01) { console.log("  residual stopped improving — closed"); break; }
  prev = pass.residual;
  log = pass.log;

  // Rewrite only what was superseded, and tell it exactly what was unsupported.
  for (const t of projectTasks(log).filter((x) => x.variation)) {
    const orig = t.task_id.replace(/@r\d+$/, "");
    const cited = evidenceBySection.get(orig) ?? [];
    if (!cited.length) continue;
    evidenceBySection.set(t.task_id, cited);
    const block = cited.map((c, i) => `[${i + 1}] ${String(c.text).slice(0, 700)}`).join("\n\n");
    const system =
      `Rewrite this section so every claim is carried by the passages. Write 3-5 sentences, cite like [1]. ` +
      `These words were NOT in any passage — do not use them unless a passage supports them: ${(t.avoid || []).slice(0, 12).join(", ")}.\n\n` +
      `PASSAGES:\n${block}`;
    drafts.set(t.task_id, await say(system, `Section: ${titleOf(t)}\n\nQuestion: ${question}`));
  }
  round++;
}

// ── assemble ──
//
// Sections that never closed do NOT reach the page.
//
// The first run shipped one anyway: asked about Frankenstein with War and Peace
// also ingested, retrieval returned Tolstoy passages, and the model wrote that
// the creature was "created by Rostov, an officer in the Russian army". The
// fidelity residual caught it — 0.92, never closing — and it was printed
// regardless. Measuring a failure and then publishing it is worse than not
// measuring, because the number becomes decoration. A section that cannot be
// carried by its evidence is dropped and SAID, not quietly included.
const CLOSE_AT = 0.45;
const live = projectTasks(log).filter((t) => drafts.has(t.task_id));
const dropped = [];
const kept = [];
for (const t of live) {
  const cited = evidenceBySection.get(t.task_id) ?? [];
  const lex = fidelityResidual(drafts.get(t.task_id), cited);
  const att = await attributionResidual(drafts.get(t.task_id), cited, { narratorSpans, cast });

  // A single misattribution is disqualifying on its own. It does not average
  // against the lexical score, because a paragraph that hands one character's
  // act to another is false no matter how well the rest is grounded — and the
  // lexical check scored exactly that paragraph 0.29 and published it.
  if (att.misattributions?.length) {
    dropped.push({ t, residual: lex.residual, why: att.misattributions[0].message });
    continue;
  }
  if (lex.residual === null || lex.residual > CLOSE_AT) {
    dropped.push({ t, residual: lex.residual, why: null });
  } else kept.push(t);
}

const out = [`# ${question}\n`];
const used = [];
for (const t of kept.sort((a, b) => a.first_seq - b.first_seq)) {
  const cited = evidenceBySection.get(t.task_id) ?? [];
  out.push(`## ${titleOf(t)}\n`);
  // Renumber into a single document-wide citation table.
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

out.push(`\n## Sources\n`);
used.forEach((c, i) => {
  const src = String(c.source_id ?? "").replace(/^source:/, "").replace(/:chunk-\d+$/, "").replace(/^.*\//, "");
  out.push(`[${i + 1}] ${src} @ bytes ${c.byte_start}–${c.byte_end}\n> ${String(c.text).slice(0, 220).replace(/\s+/g, " ")}…\n`);
});

// What did not make it, stated rather than quietly dropped.
out.push(`\n## What this leaves out\n`);
out.push(`- ${withheld} section(s) were retrieved but withheld by the fold: ${withheld_ids.join(", ") || "none"}`);
out.push(`- the log holds ${log.entries.length} entries; superseded drafts are retained, not erased`);
for (const g of ground.gaps ?? []) out.push(`- engine gap: ${g.reason || g}`);
for (const d of dropped) {
  out.push(`- DROPPED "${titleOf(d.t)}": ${d.why ? "misattribution — " + d.why : (d.residual === null ? "unmeasurable" : (d.residual * 100).toFixed(0) + "% of its content words were not carried by its evidence")} — not printed rather than printed unsupported`);
}

fs.writeFileSync(OUT, out.join("\n"));
console.log(`\nwrote ${OUT} · ${kept.length} section(s) kept, ${dropped.length} dropped for not closing · ${used.length} sources cited · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const d of dropped) console.log(`  dropped "${titleOf(d.t)}" ${d.why ? "— MISATTRIBUTION" : `(residual ${d.residual === null ? "n/a" : d.residual.toFixed(2)})`}`);
