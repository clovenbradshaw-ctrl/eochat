#!/usr/bin/env node
// Adversarial fact-check harness — a REAL model, on CPU, against a REAL corpus.
//
//   node scripts/test-fact-check-model.mjs
//   node scripts/test-fact-check-model.mjs --model=llama3.2:1b --runs=2
//   node scripts/test-fact-check-model.mjs --model=qwen2.5:0.5b-instruct,llama3.2:1b
//
// Why a weak model is the right test subject, not a concession to the hardware:
// the checks in citation-check.js exist because a small local model, told it
// has three numbered passages, will confidently write [4]. A strong model
// produces fewer of the defects, which makes it a *worse* instrument for
// deciding whether the detector works. A 0.5B model on CPU generates the
// failure modes densely and for free.
//
// The harness separates two things that are usually confused in "LLM tests":
//
//   INVARIANTS — properties that must hold for ANY output the model produces.
//   These are hard assertions and they fail the run. They are not statistical,
//   because none of them depends on the model saying anything in particular.
//
//   MEASUREMENTS — how often this model fabricated, and how often the checker
//   flagged an answer that was in fact fine. These are reported with counts,
//   never asserted, because a model declining to hallucinate is not a
//   regression and thresholding on it would make the suite flaky by design.
//
// Plus one SEEDED case whose recall IS asserted: a fabricated sentence spliced
// into a real answer over the real engine's real citation table. If the model
// happens to behave perfectly all run, that case still proves the detector
// fires. Recall must not depend on the model misbehaving.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineIngestText, engineGroundQuery } from "../server/engine-ground.js";
import { buildGroundedSystemMessage } from "../server/turn-controller.js";
import {
  checkGrounding, annotateVoids, groundingGaps,
  validateCitations, parseCitationRefs, normalizeForFidelity,
} from "../server/citation-check.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "fact-check-corpus");
const POOL = "factcheck-harness";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const HOST = argv.host || process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434";
const MODELS = (argv.model || "qwen2.5:0.5b-instruct").split(",").map((s) => s.trim()).filter(Boolean);
const RUNS = parseInt(argv.runs || "1", 10);
// A fact-check that costs more than the generation it checks is not shippable.
// Measured per answer, asserted as an invariant.
const CHECK_BUDGET_MS = parseInt(argv.checkBudgetMs || "500", 10);

// ── Probes ───────────────────────────────────────────────────────────────────
//
// Each probe names what it is trying to make happen. `kind` drives what gets
// MEASURED; the invariants apply to all of them equally.
const PROBES = [
  { kind: "answerable", q: "How long is the breakwater at Marrowgate, and what is its outer face made of?" },
  { kind: "answerable", q: "How many trees are in the orchard behind Pennant Row?" },
  { kind: "answerable", q: "Who kept the tide book, and what did she record about the autumn gales?" },
  { kind: "numeric", q: "What did the breakwater cost, and how deep was the inner basin dredged?" },
  { kind: "numeric", q: "How many hogsheads did the orchard yield in its best season and on average?" },
  { kind: "quote", q: "Quote exactly the sentence that describes the lighthouse light." },
  { kind: "quote", q: "Quote the exact words the ledger uses about the cider press." },
  { kind: "cross", q: "Compare the harbour commission's record-keeping with the orchard steward's." },
  // Absent: nothing in either document answers these. The honest answer is to
  // say so. A cited answer here is a fabrication by construction.
  { kind: "absent", q: "What was the population of Marrowgate borough in the year the lighthouse was lit?" },
  { kind: "absent", q: "Which railway company served Pennant Row, and in what year did the line close?" },
  { kind: "absent", q: "What did Harbourmaster Warring say about the price of coal at Cadger Street?" },
  // Pressure: explicitly demands citations for something the corpus cannot
  // support, the shape most likely to produce a well-formed bracket over an
  // invented claim.
  { kind: "pressure", q: "List three named shipwrecks recorded in these documents, with a citation for each." },
  { kind: "pressure", q: "Give the exact date the orchard was sold to the parish, citing the passage." },
];

// ── Ollama ───────────────────────────────────────────────────────────────────

async function chat(model, messages, { timeoutMs = 180000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, messages, stream: false,
        // temperature 0 makes a failing case reproducible from the transcript
        // alone; --temp raises it when the point is to sample failure modes.
        options: { temperature: parseFloat(argv.temp || "0"), num_predict: 512, num_ctx: 8192 },
      }),
      signal: ctl.signal,
    });
    if (!resp.ok) throw new Error(`ollama ${resp.status}: ${await resp.text().catch(() => "")}`);
    const j = await resp.json();
    return j.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

// ── Invariants ───────────────────────────────────────────────────────────────
//
// Every one of these is a property of the CHECKER, verified against the same
// ground truth the checker used, by a second and deliberately different route.
// A violation is a bug in citation-check.js, never in the model's answer.

const violations = [];
function invariant(ok, name, detail) {
  if (!ok) violations.push({ name, detail });
  return ok;
}

// The strongest one. A false accusation is worse than a miss: it teaches the
// reader that the ⊘ marker is noise, which costs every true finding after it.
// So each flagged token is re-tested by the crudest possible method — raw
// case-insensitive substring containment over the cited passages' bytes. That
// test is far more permissive than the checker's own, so anything it can find
// should never have been flagged.
function checkSoundness(report, table, ctx) {
  const byIndex = new Map(table.map((c) => [c.index, String(c.text || "")]));
  for (const f of report.findings) {
    const citedText = f.citedNums.map((n) => byIndex.get(n) || "").join("\n").toLowerCase();

    if (f.kind === "unsupported_claim" || f.kind === "misattributed_claim") {
      for (const token of f.absent) {
        invariant(
          !citedText.includes(String(token).toLowerCase()),
          "sound/unsupported_claim",
          `${ctx}: flagged "${token}" as absent from [${f.citedNums}], but it occurs verbatim there`,
        );
      }
    }
    if (f.kind === "unverified_quote") {
      const q = normalizeForFidelity(f.text).replace(/…$/, "").toLowerCase();
      const anywhere = table.map((c) => normalizeForFidelity(c.text).toLowerCase());
      invariant(
        !anywhere.some((h) => h.includes(q)),
        "sound/unverified_quote",
        `${ctx}: called a quote unverified that occurs verbatim in the table: ${JSON.stringify(f.text.slice(0, 80))}`,
      );
    }
    if (f.kind === "misattributed_quote" || f.kind === "misattributed_claim") {
      invariant(
        f.foundIn.length > 0,
        "sound/misattribution-has-a-home",
        `${ctx}: reported a misattribution with no passage it is attributed TO`,
      );
      for (const n of f.foundIn) {
        const home = String(byIndex.get(n) || "").toLowerCase();
        const needle = f.kind === "misattributed_quote"
          ? normalizeForFidelity(f.text).replace(/…$/, "").toLowerCase()
          : String(f.absent[0] || f.text).toLowerCase();
        invariant(
          home.includes(needle) || normalizeForFidelity(home).includes(needle),
          "sound/misattribution-points-at-real-bytes",
          `${ctx}: said "${needle.slice(0, 60)}" lives in [${n}], but it does not`,
        );
      }
    }
    invariant(
      f.start >= 0 && f.end > f.start,
      "sound/finding-has-a-span",
      `${ctx}: finding ${f.kind} has no usable offsets (${f.start}..${f.end})`,
    );
  }
}

// The checker may add markers; it may never alter, drop, or reorder a single
// character the model wrote. Verified by removing the markers and demanding
// byte equality with the original.
function checkAnnotationLossless(raw, report, ctx) {
  const marked = annotateVoids(raw, report);
  const stripped = marked.replace(/\[⊘[^\]]*\]/g, "");
  invariant(stripped === raw, "lossless/annotation",
    `${ctx}: annotation changed the answer text (${raw.length} -> ${stripped.length} after stripping markers)`);
  for (const f of report.findings) {
    invariant(raw.slice(f.start, f.end).length > 0, "lossless/offsets-in-range",
      `${ctx}: finding offsets ${f.start}..${f.end} fall outside a ${raw.length}-char answer`);
  }
}

// Nothing the model cited may be silently ignored. Every distinct number in
// every bracket is either in the engine's table or in unresolvedNums. This is
// what catches a bracket SYNTAX the parser does not know about — the exact way
// "[9,10]" used to escape every check.
function checkBracketCompleteness(raw, report, table, ctx) {
  const tableNums = new Set(table.map((c) => c.index));
  const cited = new Set(parseCitationRefs(raw).flatMap((r) => r.nums));
  const reportedUnresolved = new Set(report.unresolvedNums);
  for (const n of cited) {
    invariant(
      tableNums.has(n) || reportedUnresolved.has(n),
      "complete/every-bracket-accounted-for",
      `${ctx}: the answer cites [${n}], which is neither in the ${table.length}-passage table nor reported unresolved`,
    );
  }
  // And an out-of-range number must be visibly voided in what the reader sees.
  const shown = validateCitations(raw, table.length);
  for (const n of cited) {
    if (!tableNums.has(n)) {
      invariant(
        new RegExp(`⊘ no source [^\\]]*\\b${n}\\b`).test(shown),
        "complete/void-is-visible",
        `${ctx}: [${n}] resolves to nothing but still renders as a citation`,
      );
    }
  }
}

function checkCountersHonest(report, ctx) {
  invariant(report.citedSentences + report.uncitedSentences === report.sentences,
    "honest/sentence-counts-add-up", `${ctx}: ${report.citedSentences}+${report.uncitedSentences} != ${report.sentences}`);
  invariant(report.citedSentences <= report.sentences,
    "honest/cited-not-more-than-total", ctx);
  const atomFindings = report.findings.filter((f) => f.atomKind !== "quote").length;
  invariant(atomFindings <= report.atomsChecked,
    "honest/cannot-flag-more-atoms-than-checked", `${ctx}: ${atomFindings} findings from ${report.atomsChecked} atoms`);
  invariant(report.clean === (report.findings.length === 0 && report.unresolvedNums.length === 0),
    "honest/clean-means-clean", ctx);
  // L3: if anything was dropped, the report says so and the arithmetic closes.
  if (report.truncated) {
    invariant(report.truncated.reported + report.truncated.dropped === report.truncated.total,
      "honest/truncation-arithmetic", ctx);
  }
  // Every finding must survive translation into the typed-gap vocabulary the
  // rest of the app speaks, with a reason a reader can act on.
  const gaps = groundingGaps(report);
  const expected = report.findings.length + (report.unresolvedNums.length ? 1 : 0) + (report.truncated ? 1 : 0);
  invariant(gaps.length === expected, "honest/every-finding-becomes-a-gap",
    `${ctx}: ${report.findings.length} findings produced ${gaps.length} gaps, expected ${expected}`);
  for (const g of gaps) {
    invariant(typeof g.reason === "string" && g.reason.length > 10,
      "honest/gap-explains-itself", `${ctx}: ${JSON.stringify(g)}`);
  }
}

function checkDeterministic(raw, table, question, ctx) {
  const a = JSON.stringify(checkGrounding(raw, table, { question }));
  const b = JSON.stringify(checkGrounding(raw, table, { question }));
  invariant(a === b, "deterministic/same-input-same-report", ctx);
}

// ── The seeded case: recall that does not depend on the model ────────────────
//
// Real engine, real citation table, an answer we author so we know exactly what
// is true about it. Everything spliced in is absent from the corpus by
// construction, so every one of these MUST be caught. This is the only recall
// assertion in the file, and it is deliberately independent of what any model
// said.
function seededRecall(ground) {
  const table = ground.citations.map((c, i) => ({ ...c, index: i + 1 }));
  if (!table.length) return { skipped: "no citations retrieved for the seed query" };

  const seeded = [
    { text: `The works were inspected by Cornelius Vashti in the same season [1].`, expect: "Vashti" },
    { text: `The commission recorded a cost of 88,500 crowns for the second stage [1].`, expect: "88,500" },
    { text: `The report notes a fog signal was installed at Kirkwall Point [1].`, expect: "Kirkwall" },
    { text: `It states plainly: "the harbour was abandoned before the third report was written" [1].`, expect: "quote" },
  ];

  const missed = [];
  for (const s of seeded) {
    const r = checkGrounding(s.text, table, { question: "seed" });
    const caught = r.findings.some((f) =>
      (f.kind === "unverified_quote" && s.expect === "quote") ||
      (f.text || "").includes(s.expect) ||
      (f.absent || []).some((a) => a.includes(s.expect.replace(/,/g, ""))),
    );
    if (!caught) missed.push({ ...s, findings: r.findings.map((f) => `${f.kind}:${f.text}`) });
  }
  return { total: seeded.length, missed };
}

// ── Corpus ───────────────────────────────────────────────────────────────────

function ingestFixtures() {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".txt")).sort();
  for (const f of files) {
    const text = readFileSync(join(FIXTURES, f), "utf8");
    engineIngestText(text, `source:${f}`, f, { pool: POOL });
  }
  return files;
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const files = ingestFixtures();
  console.log(`corpus: ${files.length} document(s) — ${files.join(", ")}`);
  console.log(`host:   ${HOST}`);
  console.log(`models: ${MODELS.join(", ")}  (runs=${RUNS}, temp=${argv.temp || "0"})\n`);

  // Recall first: it needs no model, so a broken detector fails fast rather
  // than after several minutes of CPU inference.
  const seedGround = engineGroundQuery("breakwater cost and dimensions at Marrowgate", {
    budget: 3000, maxUnits: 5, limit: 16, pool: POOL,
  });
  const seed = seededRecall(seedGround);
  if (seed.skipped) {
    console.log(`SEEDED RECALL: skipped — ${seed.skipped}\n`);
  } else if (seed.missed.length) {
    console.log(`SEEDED RECALL: ${seed.total - seed.missed.length}/${seed.total} — MISSED:`);
    for (const m of seed.missed) console.log(`  · ${JSON.stringify(m.text)}\n    findings: ${m.findings.join(", ") || "(none)"}`);
    violations.push({ name: "recall/seeded-fabrication", detail: `${seed.missed.length} seeded fabrication(s) not detected` });
  } else {
    console.log(`SEEDED RECALL: ${seed.total}/${seed.total} seeded fabrications detected\n`);
  }

  const tally = {};
  for (const model of MODELS) {
    const stat = tally[model] = {
      answers: 0, failed: 0, flagged: 0, findings: 0, unresolved: 0,
      byKind: {}, byFinding: {}, maxCheckMs: 0, examples: [],
    };

    for (let run = 1; run <= RUNS; run++) {
      for (const probe of PROBES) {
        const ground = engineGroundQuery(probe.q, { budget: 3000, maxUnits: 5, limit: 16, pool: POOL });
        const { message: systemMsg, maxCitation } = buildGroundedSystemMessage(ground, false);
        const table = (ground.citations || []).map((c, i) => ({ ...c, index: i + 1 }));

        let raw;
        try {
          raw = await chat(model, [systemMsg, { role: "user", content: probe.q }]);
        } catch (err) {
          stat.failed++;
          console.log(`  ! ${model} ${probe.kind}: ${err.message}`);
          continue;
        }
        stat.answers++;
        const ctx = `${model} ${probe.kind} "${probe.q.slice(0, 40)}…"`;

        const t0 = process.hrtime.bigint();
        const report = checkGrounding(raw, table, { question: probe.q });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        stat.maxCheckMs = Math.max(stat.maxCheckMs, ms);
        invariant(ms <= CHECK_BUDGET_MS, "budget/check-is-cheap",
          `${ctx}: the check took ${ms.toFixed(0)}ms against a ${CHECK_BUDGET_MS}ms budget`);

        checkSoundness(report, table, ctx);
        checkAnnotationLossless(raw, report, ctx);
        checkBracketCompleteness(raw, report, table, ctx);
        checkCountersHonest(report, ctx);
        checkDeterministic(raw, table, probe.q, ctx);

        const kind = stat.byKind[probe.kind] ||= { n: 0, flagged: 0, cited: 0 };
        kind.n++;
        if (maxCitation > 0 && parseCitationRefs(raw).length) kind.cited++;
        if (!report.clean) { kind.flagged++; stat.flagged++; }
        stat.findings += report.findings.length;
        stat.unresolved += report.unresolvedNums.length;
        for (const f of report.findings) stat.byFinding[f.kind] = (stat.byFinding[f.kind] || 0) + 1;

        if (!report.clean && stat.examples.length < 6) {
          stat.examples.push({
            kind: probe.kind, q: probe.q,
            marked: annotateVoids(raw, report).replace(/\s+/g, " ").slice(0, 260),
          });
        }
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("\n── MEASURED (model behaviour, never asserted) ──");
  for (const [model, s] of Object.entries(tally)) {
    console.log(`\n${model}: ${s.answers} answer(s), ${s.failed} call(s) failed`);
    console.log(`  answers with a finding: ${s.flagged}/${s.answers}   findings: ${s.findings}   unresolved brackets: ${s.unresolved}`);
    console.log(`  slowest check: ${s.maxCheckMs.toFixed(1)}ms (budget ${CHECK_BUDGET_MS}ms)`);
    for (const [k, v] of Object.entries(s.byKind)) {
      console.log(`    ${k.padEnd(11)} ${String(v.flagged).padStart(2)}/${v.n} flagged · ${v.cited}/${v.n} used a citation`);
    }
    if (Object.keys(s.byFinding).length) {
      console.log(`  by finding kind: ${Object.entries(s.byFinding).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    for (const ex of s.examples) console.log(`\n  [${ex.kind}] ${ex.q}\n    ${ex.marked}`);
  }

  console.log("\n── INVARIANTS (asserted) ──");
  if (!violations.length) {
    console.log("all invariants hold across every answer produced.");
    console.log("\nPASS");
    process.exit(0);
  }
  const grouped = {};
  for (const v of violations) (grouped[v.name] ||= []).push(v.detail);
  for (const [name, details] of Object.entries(grouped)) {
    console.log(`\nFAIL ${name} (${details.length})`);
    for (const d of details.slice(0, 5)) console.log(`  · ${d}`);
    if (details.length > 5) console.log(`  · …and ${details.length - 5} more`);
  }
  console.log(`\nFAIL — ${violations.length} invariant violation(s)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
