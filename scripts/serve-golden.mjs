#!/usr/bin/env node
// serve-golden.mjs — Spin up a browser view of the golden longform test.
// Ingests the corpus, runs the pipeline, serves the result as HTML with
// visible citations, gaps, and per-section breakdown.
// Usage: node scripts/serve-golden.mjs [--port 8910]

import http from "node:http";
import { engineGroundQuery, engineIngestText } from "../server/engine-ground.js";
import { runDeliberateAnswer } from "../server/longform-orchestrator.js";

const PORT = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 8910;
const POOL = "golden-browser";

const SOURCE = [
  "Countess Elena Rostova arrived at the Petrov estate on the evening of June 14th, 1812.",
  "She carried a sealed letter from her father, Count Rostov, addressed to Prince Petrov.",
  "The letter stated that the Rostov family would pledge 40,000 rubles to the prince's regiment",
  "in exchange for his protection of their estate during the coming campaign.",
  "Prince Petrov read the letter by candlelight in his study. His steward, a man named Dmitri,",
  "stood waiting by the door. The prince folded the letter and said only: 'It is done.'",
  "Dmitri noted the pledge in the estate ledger — entry number 247 — and sealed it with the Rostov crest.",
  "By morning, word had spread throughout the estate: the Rostovs were under the prince's protection,",
  "and Elena would remain at Petrov as an honored guest.",
  "In the months that followed, when French scouts were sighted near the Rostov lands,",
  "Petrov's cavalry intercepted them before any damage was done. Elena wrote to her father",
  "that the 40,000 rubles had been well spent — the prince honored every term,",
  "and the estate remained untouched throughout the war.",
].join(" ");

const QUESTION = "What arrangement did Countess Rostova negotiate with Prince Petrov?";

function h(text) { return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function renderResult(ground, result, events) {
  const eventLog = events.map(e => `<div class="event"><span class="phase">${h(e.phase)}</span> ${h(JSON.stringify(e).slice(0, 200))}</div>`).join("\n");

  const citations = result.citations.map(c => `
    <div class="citation">
      <span class="idx">[${c.index}]</span>
      <span class="source">${h(c.source_id || "")}</span>
      <span class="score">score: ${(c.score || 0).toFixed(2)}</span>
      <span class="terrain terrain-${(c.terrain || "Field").toLowerCase()}">${c.terrain || "Field"}</span>
      <span class="stance">${c.stance || "Tracing"}</span>
      <blockquote>${h((c.text || "").slice(0, 300))}${(c.text || "").length > 300 ? "…" : ""}</blockquote>
    </div>`).join("");

  const gaps = result.gaps.map(g => `<div class="gap">⚠ ${h(g.type)}: ${h(g.reason || "")}</div>`).join("");

  return `<!DOCTYPE html><html><head><meta charset=utf-8>
<title>Longform Golden Test</title>
<style>
  body { font-family: system-ui; max-width: 900px; margin: 2em auto; padding: 0 1em; background: #111; color: #ddd; }
  h1 { color: #fff; }
  .meta { color: #888; font-size: 0.9em; margin-bottom: 2em; }
  .answer { background: #1a1a2e; padding: 1.5em; border-radius: 8px; line-height: 1.7; white-space: pre-wrap; }
  .answer h2 { color: #7aa2f7; margin-top: 1.5em; }
  .citations { margin-top: 2em; }
  .citation { background: #1e1e2e; padding: 1em; margin: 0.5em 0; border-radius: 6px; border-left: 3px solid #7aa2f7; }
  .citation .idx { font-weight: bold; color: #7aa2f7; margin-right: 1em; }
  .citation .source { color: #666; font-size: 0.85em; }
  .citation .score { color: #888; margin: 0 0.5em; }
  .terrain { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 0.8em; margin: 0 4px; }
  .terrain-entity { background: #2d4a3e; color: #7ecf7e; }
  .terrain-field { background: #3a3a4a; color: #aaa; }
  .terrain-link { background: #4a3020; color: #e0a060; }
  .terrain-network { background: #2a2a4a; color: #7070d0; }
  .terrain-atmosphere { background: #4a2030; color: #e06080; }
  .terrain-lens { background: #3a2040; color: #b080d0; }
  .terrain-paradigm { background: #202040; color: #8080ff; }
  .terrain-kind { background: #3a4030; color: #b0b070; }
  .stance { color: #888; margin: 0 4px; font-style: italic; }
  blockquote { margin: 0.5em 0 0; padding: 0.5em 1em; border-left: 2px solid #444; color: #aaa; font-style: italic; white-space: pre-wrap; word-break: break-word; }
  .gaps { margin-top: 1em; }
  .gap { background: #2a2010; padding: 0.5em 1em; margin: 0.3em 0; border-radius: 4px; color: #d0a040; }
  .events { margin-top: 2em; }
  .event { font-family: monospace; font-size: 0.85em; padding: 2px 0; }
  .phase { color: #7aa2f7; }
  h2 { color: #999; border-bottom: 1px solid #333; padding-bottom: 0.3em; }
</style></head><body>
<h1>${h(QUESTION)}</h1>
<div class="meta">Retrieved ${ground.total} · Folded ${ground.folded} · Dropped ${ground.dropped} · Budget ${ground.budget} tokens · Sections kept ${result.sectionsKept} · Dropped ${result.sectionsDropped}</div>
<div class="answer">${result.text.replace(/\n## /g, "\n<h2>").replace(/\n\n/g, "</p><p>").replace(/^/, "<p>").replace(/$/, "</p>")}</div>
<h2>Citations (${result.citations.length})</h2>
<div class="citations">${citations}</div>
<h2>Gaps</h2>
<div class="gaps">${gaps || '<div class="gap">none</div>'}</div>
<h2>Pipeline Events</h2>
<div class="events">${eventLog}</div>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    // Ingest and run
    engineIngestText(SOURCE, "source:golden-browser.txt", "golden", { pool: POOL });
    const ground = engineGroundQuery(QUESTION, { budget: 4000, maxUnits: 12, limit: 24, pool: POOL });
    const events = [];
    const result = await runDeliberateAnswer({
      question: QUESTION,
      citations: ground.citations,
      generate: async (system, user) => {
        if (system.includes("Name what these passages are ABOUT")) {
          return "The Rostov-Petrov protection arrangement";
        }
        const m = system.match(/You have \[1\] through \[(\d+)\]/);
        const maxCit = m ? Number(m[1]) : 1;
        const parts = ["Countess Rostova delivered her father's sealed letter [1]."];
        if (maxCit >= 2) parts.push("The letter pledged 40,000 rubles for military protection of the Rostov estate [2].");
        if (maxCit >= 3) parts.push("Prince Petrov accepted the terms and his steward Dmitri recorded entry 247 in the ledger [3].");
        return parts.join(" ");
      },
      onProgress: (e) => events.push(e),
    });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(renderResult(ground, result, events));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT} — open this in a browser`);
  console.log(`Corpus: ${SOURCE.length} chars, "${QUESTION}"`);
});
