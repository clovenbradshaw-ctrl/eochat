#!/usr/bin/env node
// Ad-hoc smoke test for the eoCode SSE endpoint — reads it the same way the
// UI will (fetch + getReader), so it is a faithful check of real-time
// disclosure, not just "did the run eventually finish."
const base = process.argv[2] || "http://localhost:11435";
const workspace = process.argv[3] || "smoke-test-2";
const prompt = process.argv[4] || "Write a Node.js script sum.js using CommonJS (module.exports) that exports a function add(a,b) returning a+b. Then run: node -e \"const {add}=require('./sum.js'); if(add(2,3)!==5) throw new Error('bad'); console.log('PASS')\" and confirm it prints PASS.";
const model = process.argv[5] || "qwen2.5-coder:1.5b";

const t0 = Date.now();
const resp = await fetch(`${base}/api/eocode/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workspace, prompt, model, maxSteps: 14 }),
});
if (!resp.ok) {
  console.error(`HTTP ${resp.status}: ${await resp.text()}`);
  process.exit(1);
}
const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = "";
let eventCount = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const chunk = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const eventLine = chunk.split("\n").find((l) => l.startsWith("event:"));
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    eventCount++;
    const event = eventLine.slice("event:".length).trim();
    const data = JSON.parse(dataLine.slice("data:".length).trim());
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    if (event === "step" && data.phase === "tool_call") {
      console.log(`[${t}s] #${eventCount} STEP ${data.step}: → ${data.tool}(${JSON.stringify(data.args).slice(0, 120)})`);
    } else if (event === "step" && data.phase === "tool_result") {
      console.log(`[${t}s] #${eventCount} STEP ${data.step}: ← ${JSON.stringify(data.result).slice(0, 160)}`);
    } else if (event === "step" && data.phase === "assistant_raw") {
      console.log(`[${t}s] #${eventCount} STEP ${data.step}: raw model output (${data.raw.length} chars)`);
    } else if (event === "step") {
      console.log(`[${t}s] #${eventCount} STEP ${data.step ?? ""}: ${data.phase}${data.note ? " — " + data.note : ""}`);
    } else {
      console.log(`[${t}s] #${eventCount} ${event.toUpperCase()}: ${JSON.stringify(data).slice(0, 300)}`);
    }
  }
}
console.log(`\n${eventCount} SSE events total, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
