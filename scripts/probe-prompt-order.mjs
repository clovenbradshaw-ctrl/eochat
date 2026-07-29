#!/usr/bin/env node
// In what order should the talker be handed BEHAVIOR, CONTENT, and QUESTION?
//
// The talker does no tool calling — a dispatcher has already chosen the
// passages. So the only variables left are how those three parts are ordered
// and how they are split across roles. That is an empirical question, and the
// arms below are held identical in every other respect: same passages, same
// wording of each part, same model, same options. Only order and role change.
//
// Measured per arm:
//   ms        wall time for the single call (no tool loop)
//   cites     emitted at least one [n]
//   valid     every [n] emitted is within the passage range (no invented ones)
//   refused   claimed the sources lack the answer WHILE holding the answer
//
// Usage: node scripts/probe-prompt-order.mjs [model] [num_ctx]

const OLLAMA = process.env.OLLAMA || "http://localhost:11434";
const PROXY = process.env.PROXY || "http://localhost:11435";
const MODEL = process.argv[2] || "llama3.2:latest";
const NUM_CTX = Number(process.argv[3] || 8192);

// Questions whose answer is genuinely present in the corpus, so a refusal is
// always a failure rather than honest silence.
const QUESTIONS = [
  "What does Victor see when the creature first opens its eye?",
  "What happens on the dreary night of November?",
];

const BEHAVIOR = (n) =>
  `Answer the question using ONLY the numbered passages provided. ` +
  `Cite every claim with its bracketed number, like [1] or [2]. ` +
  `You have passages [1] through [${n}] — never cite a number outside that range. ` +
  `Do not add facts the passages do not contain. Be concise.`;

const CONTENT = (passages) =>
  `PASSAGES:\n` +
  passages.map((p, i) => `[${i + 1}] (${(p.source || "").replace(/^.*\//, "")})\n${(p.text || "").slice(0, 700)}`).join("\n\n");

const QUESTION = (q) => `QUESTION: ${q}`;

// Each arm returns the messages array. Same three strings, different order/roles.
const ARMS = {
  "behavior→content→question (all user)": (b, c, q) => [
    { role: "user", content: `${b}\n\n${c}\n\n${q}` },
  ],
  "content→behavior→question (all user)": (b, c, q) => [
    { role: "user", content: `${c}\n\n${b}\n\n${q}` },
  ],
  "question→content→behavior (all user)": (b, c, q) => [
    { role: "user", content: `${q}\n\n${c}\n\n${b}` },
  ],
  "content→question→behavior (all user)": (b, c, q) => [
    { role: "user", content: `${c}\n\n${q}\n\n${b}` },
  ],
  "behavior=system, content+question=user": (b, c, q) => [
    { role: "system", content: b },
    { role: "user", content: `${c}\n\n${q}` },
  ],
  "behavior+content=system, question=user": (b, c, q) => [
    { role: "system", content: `${b}\n\n${c}` },
    { role: "user", content: q },
  ],
};

async function evidenceFor(q) {
  const res = await fetch(`${PROXY}/api/verbatim?q=${encodeURIComponent(q)}&limit=6`, {
    signal: AbortSignal.timeout(60000),
  });
  return (await res.json()).passages || [];
}

async function ask(messages) {
  const t0 = performance.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages,
      // num_ctx is set EXPLICITLY. Left unset, ollama uses the model's trained
      // context — 131072 for phi4-mini — which allocated 20GB and spilled the
      // model onto the CPU, turning a 2.5GB model into the slowest arm here.
      options: { temperature: 0.2, num_ctx: NUM_CTX, num_predict: 512 },
    }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return { text: data.message?.content || "", ms: performance.now() - t0 };
}

console.log(`\nmodel=${MODEL}  num_ctx=${NUM_CTX}  arms=${Object.keys(ARMS).length}  questions=${QUESTIONS.length}\n`);

const prepared = [];
for (const q of QUESTIONS) {
  const passages = await evidenceFor(q);
  prepared.push({ q, passages });
  console.log(`evidence for "${q.slice(0, 50)}…": ${passages.length} passages`);
}
console.log("");

const REFUSAL = /do(es)? not contain|cannot provide|no information|not mentioned|unable to answer|don't have enough/i;
const rows = [];

for (const [name, build] of Object.entries(ARMS)) {
  let totalMs = 0, cites = 0, valid = 0, refused = 0, n = 0;
  for (const { q, passages } of prepared) {
    if (!passages.length) continue;
    const messages = build(BEHAVIOR(passages.length), CONTENT(passages), QUESTION(q));
    let out;
    try { out = await ask(messages); }
    catch (err) { console.log(`  ${name}: ERROR ${err.message}`); continue; }
    n++;
    totalMs += out.ms;
    const nums = [...new Set((out.text.match(/\[(\d+)\]/g) || []).map((s) => Number(s.replace(/\D/g, ""))))];
    if (nums.length) cites++;
    if (nums.length && nums.every((x) => x >= 1 && x <= passages.length)) valid++;
    if (REFUSAL.test(out.text)) refused++;
  }
  const mean = n ? Math.round(totalMs / n) : 0;
  rows.push({ name, mean, cites, valid, refused, n });
  console.log(`${String(mean).padStart(6)}ms  cites ${cites}/${n}  valid ${valid}/${n}  refused ${refused}/${n}   ${name}`);
}

rows.sort((a, b) => (b.cites - a.cites) || (a.refused - b.refused) || (a.mean - b.mean));
console.log(`\nbest arm: ${rows[0]?.name}`);
console.log(`  ${rows[0]?.mean}ms · cites ${rows[0]?.cites}/${rows[0]?.n} · valid ${rows[0]?.valid}/${rows[0]?.n} · refused ${rows[0]?.refused}/${rows[0]?.n}`);
