#!/usr/bin/env node
// Ad-hoc smoke test for the eoCode SESSION stepping API — drives it exactly
// the way the browser's WebLLM client will (start -> generate -> step ->
// repeat), except with a canned scripted "model" instead of a real one, the
// same dry-run discipline eval/adapters/scripted-adapter.mjs already uses.
// Validates the actual server-side stepping protocol independent of whether
// a real WebGPU model is available in this environment.
const base = process.argv[2] || "http://localhost:11435";
const workspace = process.argv[3] || "session-smoke-" + Date.now();

// A tiny scripted "model": ignores the prompt view entirely and just plays
// back a fixed script, same shape react-loop's own tests use.
const script = [
  { tool: "write_file", args: { path: "hi.js", content: "console.log('hi from webllm-shaped session');" } },
  { tool: "run_shell", args: { command: "node hi.js" } },
  { tool: "finish", args: { summary: "wrote hi.js and ran it" } },
];
let i = 0;
function nextRaw() {
  if (i >= script.length) throw new Error("script exhausted");
  return JSON.stringify(script[i++]);
}

async function main() {
  const startRes = await fetch(`${base}/api/eocode/session/start`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace, prompt: "irrelevant — scripted", maxSteps: 10 }),
  });
  if (!startRes.ok) throw new Error(`start: HTTP ${startRes.status}: ${await startRes.text()}`);
  const started = await startRes.json();
  console.log("START:", JSON.stringify({ sessionId: started.sessionId, workspace: started.workspace, promptViewLen: started.promptView.length }));

  let sessionId = started.sessionId;
  let done = false;
  let stepCount = 0;
  let finalResult = null;
  while (!done) {
    const raw = nextRaw();
    const stepRes = await fetch(`${base}/api/eocode/session/${sessionId}/step`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!stepRes.ok) throw new Error(`step: HTTP ${stepRes.status}: ${await stepRes.text()}`);
    const stepped = await stepRes.json();
    stepCount++;
    for (const e of stepped.events) {
      console.log(`  event #${stepCount}:`, e.phase, e.tool || "", e.tool_result ? "" : "");
    }
    done = stepped.done;
    finalResult = stepped.result;
  }
  console.log("DONE:", JSON.stringify(finalResult));
}

main().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
