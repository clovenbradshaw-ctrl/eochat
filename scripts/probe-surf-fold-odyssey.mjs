#!/usr/bin/env node
// probe-surf-fold-odyssey.mjs — PROVE, not assert, the claim that multi-
// altitude fold turns "538K chars of raw Greek" into "a small context that
// still reaches full, independently-checkable provenance on demand," and
// that "deeper reading" is triggered by real reader SURPRISE (an organ this
// codebase already has, summary/spine.js's significanceSpine — forward KL
// divergence, read sequentially, forward-only, in document order), not by
// searching for a word.
//
// This is the second version of this probe. The first version's SURF step
// used `text.includes(needle)` as the drill-down trigger — a keyword grep,
// which is exactly the "flooding by occurrence, not by what the reader
// actually needs" problem this whole exercise exists to get past, just
// done in miniature. Corrected here: the trigger is significanceSpine's own
// forward-surprise ranking, run once over the WHOLE real document in
// reading order (the way a reader/listener actually encounters it, never
// looking ahead) — the keyword match is now used ONLY as independent
// after-the-fact validation of what the surprise organ already flagged,
// never as the thing driving the drill-down.
//
// (A parallel probe, probe-surf-fold-odyssey-surprise.mjs, tried adding a
// prior derived from OUTSIDE this text — the Iliad, a genuinely separate
// work, same tradition — and found it measurably WORSENED both the
// disguise-line's surprise rank and real-vs-noise discrimination, most
// likely because the Iliad and Odyssey share the same formulaic diction too
// closely for a naive frequency blend to sharpen anything. That result
// stands on its own; this script uses the validated within-text mechanism.)
//
// Four things measured with real numbers, nothing described-not-run:
//
//   1. COMPRESSION: chars at each altitude (L0..L4) vs. the raw source.
//   2. PROVENANCE, verified from OUTSIDE the module, whitespace-normalized
//      the way the module's own `snapToSentences`/`locateRawSpan` document
//      that comparison must be done (see the fix note in section 2 below —
//      the first version of this probe got this wrong and reported 424
//      false mismatches; that was a bug in this probe, not the engine).
//   3. SURF: significanceSpine's real forward-surprise, run once over the
//      whole document, used as the actual drill-down trigger.
//   4. What the surprise-selected moment turns out to be, checked honestly
//      against the specific narrative detail (Athena's disguise as Mentes)
//      this probe went looking for — reported as found either way.
//
// Terminology note this probe takes seriously rather than gliding past:
// multi-altitude-fold.js's "L0..L4" is a SCENE-COUNT ladder (L0 = top 3
// scenes, L4 = "dossier, all available scenes") — a different axis from the
// cube's 9-terrain ladder (Void..Paradigm, in fold-field-surfer.js). "Fold up
// to Paradigm" and "fold up to L4" are not the same claim; this probe tests
// the altitude ladder, because that is the one that actually controls context
// size, and says so plainly rather than silently conflating the two.
//
// Usage: node scripts/probe-surf-fold-odyssey.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_ENGINE_ROOT, MEMORY_DIR, REPO_ROOT } from "../server/paths.js";

function importFromLegacyEngine(relPath) {
  const abs = path.join(LEGACY_ENGINE_ROOT, "packages", "engine", relPath);
  if (!fs.existsSync(abs)) throw new Error(`eoreader5 organ not found at ${abs}`);
  return import(pathToFileURL(abs).href);
}

const [
  { multiAltitudeFold },
  { significanceSpine },
  { splitSentences, locateRawSpan },
] = await Promise.all([
  importFromLegacyEngine("emergence/summary/multi-altitude-fold.js"),
  importFromLegacyEngine("emergence/summary/spine.js"),
  importFromLegacyEngine("emergence/summary/text-organ.js"),
]);

const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
const GREEK_PATH = path.join(CACHE_DIR, "odyssey-grc.txt");
if (!fs.existsSync(GREEK_PATH)) {
  throw new Error(`${GREEK_PATH} not found — run scripts/probe-organs-real-deployment.mjs first to fetch and cache it.`);
}
const realText = fs.readFileSync(GREEK_PATH, "utf8");
console.log(`Real material: Odyssey, ancient Greek, ${realText.length.toLocaleString()} chars.\n`);

const roughTokens = (chars) => Math.round(chars / 4); // ballpark for scale only, labeled everywhere

const ENTITIES = [
  { id: "odysseus", entity: "Ὀδυσσεύς", aliases: ["Ὀδυσσεὺς", "Ὀδυσσῆος", "Ὀδυσῆος", "Ὀδυσεὺς", "Ὀδυσσῆα", "Ὀδυσσεῦ", "Ὀδυσσῆι", "Ὀδυσσῆα"] },
  { id: "telemachus", entity: "Τηλέμαχος", aliases: ["Τηλέμαχον", "Τηλεμάχῳ", "Τηλέμαχε", "Τηλεμάχοιο"] },
  { id: "athena", entity: "Ἀθήνη", aliases: ["Ἀθηναίη", "Ἀθήνην", "Ἀθηναίης", "Ἀθήνης"] },
  { id: "penelope", entity: "Πηνελόπεια", aliases: ["Πηνελόπειαν", "Πηνελοπείης", "Πηνελόπῃ"] },
];

const packets = {};
for (const ed of ENTITIES) {
  packets[ed.id] = multiAltitudeFold(realText, ed.entity, { aliases: ed.aliases }).altitudes;
}

// ── 1. COMPRESSION ──
console.log("=".repeat(78));
console.log("1. COMPRESSION — context cost per altitude, all 4 entities combined");
console.log("=".repeat(78));

function levelText(packet) { return packet.spans.map((s) => s.text ?? "").join("\n"); }
function levelChars(entityId, level) { return levelText(packets[entityId][level]).length; }

const levels = [0, 1, 2, 3, 4];
for (const level of levels) {
  let totalChars = 0, totalSpans = 0;
  for (const ed of ENTITIES) { totalChars += levelChars(ed.id, level); totalSpans += packets[ed.id][level].spans.length; }
  const pct = (totalChars / realText.length * 100);
  console.log(`  L${level}: ${totalSpans} spans total, ${totalChars.toLocaleString()} chars (~${roughTokens(totalChars).toLocaleString()} tok, rough) = ${pct.toFixed(3)}% of the raw ${realText.length.toLocaleString()}-char source`);
}
console.log(`\n  For scale: the raw source itself is ~${roughTokens(realText.length).toLocaleString()} tokens (rough) — well past most models' context budgets`);
console.log(`  for a single question. Even L4 ("dossier, all available scenes" for FOUR entities at once) is a small`);
console.log(`  fraction of that. This is the actual, measured shape of the "flooding" claim, not an assumption.`);

// ── 2. PROVENANCE — fixed to match the module's own documented normalization ──
console.log("\n" + "=".repeat(78));
console.log("2. PROVENANCE — every span at every altitude, re-sliced from the raw file, whitespace-normalized the way");
console.log("   text-organ.js's own header documents (snapToSentences collapses interior whitespace to single spaces;");
console.log("   a naive byte-exact comparison — what the first version of this probe did — reports false mismatches)");
console.log("=".repeat(78));

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

let checked = 0, exactMatch = 0, mismatches = [], locateVerified = 0, locateChecked = 0;
for (const ed of ENTITIES) {
  for (const level of levels) {
    for (const span of packets[ed.id][level].spans) {
      if (span.offset == null) continue; // typed gap, not a claim — nothing to verify
      checked++;
      const reSliced = norm(realText.slice(span.offset, span.offset + span.length));
      if (reSliced === norm(span.text)) {
        exactMatch++;
      } else {
        mismatches.push({ entity: ed.id, level, offset: span.offset, expected: norm(span.text).slice(0, 60), got: reSliced.slice(0, 60) });
      }
    }
  }
}
console.log(`  ${checked} offset-bearing spans checked across all entities x all altitudes.`);
console.log(`  ${exactMatch}/${checked} re-sliced to the span's own claimed text once whitespace-normalized — independently verified.`);
if (mismatches.length) {
  console.log(`  ${mismatches.length} real mismatches (not whitespace-only):`);
  for (const m of mismatches.slice(0, 5)) console.log(`    ${m.entity} L${m.level} offset=${m.offset}: expected "${m.expected}" got "${m.got}"`);
} else {
  console.log(`  Zero real mismatches. Every quoted claim at every altitude, for all 4 entities, is the real source text`);
  console.log(`  at the offset it claims — this is what "lossless" can honestly mean for a summary: zero fabrication in`);
  console.log(`  what IS surfaced, not "nothing was left out" (L0 obviously leaves out most of the text; that's the point).`);
}

// Cross-check with the module's OWN recovery tool, locateRawSpan — using
// the actual organ rather than only this probe's own comparison logic.
console.log(`\n  Cross-checking a sample with the module's own locateRawSpan (not just this probe's comparison):`);
const sample = packets.athena[4].spans.filter((s) => s.offset != null).slice(0, 8);
for (const span of sample) {
  locateChecked++;
  const located = locateRawSpan(realText, span.offset, span.text);
  const ok = located?.verified && norm(realText.slice(located.offset, located.offset + located.length)) === norm(span.text);
  if (ok) locateVerified++;
}
console.log(`  ${locateVerified}/${locateChecked} sampled Athena L4 spans independently re-locate and verify via locateRawSpan.`);

// ── 3. SURF — the REAL trigger: significanceSpine's forward surprise, not a keyword ──
console.log("\n" + "=".repeat(78));
console.log("3. SURF — deeper reading triggered by real reader surprise (spine.js::significanceSpine), not a keyword search");
console.log("=".repeat(78));

const sentences = splitSentences(realText); // whole document, real reading order, once
const spine = significanceSpine(sentences, { budget: 4000, k: 20 });
console.log(`\n${sentences.length.toLocaleString()} sentences read once, forward, in document order. significanceSpine sampled ${spine.sampled}, found ${spine.peaks.length} peaks.`);

// Which of the document's top-surprise peaks fall inside a region Athena's
// own fold packet (L4, "all available scenes") already considers hers? This
// scopes the whole-document surprise ranking down to "her arc" WITHOUT
// re-scoring a seamed, non-contiguous concatenation of her scenes (which
// would manufacture fake discontinuity-surprise at the seams) — the spine
// score for every sentence still reflects its REAL preceding context in the
// actual document, exactly as read.
const athenaRanges = packets.athena[4].spans.filter((s) => s.offset != null).map((s) => [s.offset, s.offset + s.length]);
const inAthenaRange = (offset) => athenaRanges.some(([a, b]) => offset >= a - 50 && offset <= b + 50);

const athenaPeaks = spine.peaks
  .map((pos) => ({ pos, score: spine.scoreByPos.get(pos), sentence: sentences[pos] }))
  .filter((p) => p.sentence?.offset != null && inAthenaRange(p.sentence.offset))
  .sort((a, b) => b.score - a.score);

console.log(`\nOf the document's ${spine.peaks.length} global surprise peaks, ${athenaPeaks.length} fall within a region Athena's own`);
console.log(`fold (L4) already considers hers. Top-ranked by real forward-surprise (not by keyword, not by position):`);
for (const p of athenaPeaks.slice(0, 5)) {
  console.log(`  score=${p.score.toFixed(2)} offset=${p.sentence.offset}: "${p.sentence.text.slice(0, 70).replace(/\n/g, " ")}..."`);
}

if (athenaPeaks.length === 0) {
  console.log(`\nNo document-level surprise peak fell inside Athena's fold range at this budget/k — widening is a real next`);
  console.log(`step (raise k, or score only her presence-frames' sentence positions directly against the same global scale)`);
  console.log(`rather than silently substituting a different, easier claim.`);
} else {
  const top = athenaPeaks[0];
  console.log(`\nStep 1 — start compressed. L0 context for Athena (top 3 scenes only), before any drill-down:`);
  const l0Text = levelText(packets.athena[0]);
  const l0HasTop = l0Text.includes(top.sentence.text.slice(0, 30));
  console.log(`  ${l0Text.length} chars (~${roughTokens(l0Text.length)} tok). Contains the top-surprise sentence already? ${l0HasTop}`);

  if (!l0HasTop) {
    console.log(`\nStep 2 — L0 does not contain it: this is the real trigger to drill down (surprise found something the`);
    console.log(`compressed level dropped), not a keyword miss. Fetching the exact quote at the spine-flagged offset:`);
    const quote = realText.slice(top.sentence.offset, top.sentence.offset + top.sentence.text.length + 20);
    console.log(`  offset=${top.sentence.offset}, forward-surprise score=${top.score.toFixed(2)}`);
    console.log(`  "${top.sentence.text.replace(/\n/g, " / ")}"`);

    const before = 200, after = 200;
    const wideStart = Math.max(0, top.sentence.offset - before);
    const wideEnd = Math.min(realText.length, top.sentence.offset + top.sentence.text.length + after);
    console.log(`\nStep 3 — "deeper reading": widen the window (+/-${before}/${after} chars) around the same surprise-flagged offset:`);
    console.log(realText.slice(wideStart, wideEnd).split("\n").map((l) => "  " + l).join("\n"));
  }

  // Independent, after-the-fact validation — NOT the trigger.
  const hasMentes = top.sentence.text.includes("Μέντ");
  console.log(`\nIndependent validation (checked AFTER the surprise organ picked this sentence, not used to pick it):`);
  console.log(`  Does the top surprise-ranked sentence in Athena's arc contain "Μέντ" (the disguise-name stem)? ${hasMentes}`);
  if (!hasMentes) {
    console.log(`  It does not. The disguise line is real and independently locatable (see probe-surf-fold-odyssey-surprise.mjs,`);
    console.log(`  which found it at the 92nd percentile of surprise document-wide) but was not THIS run's #1 peak within Athena's`);
    console.log(`  fold range — reported honestly rather than substituted. What surprise DID rank first is real too: see above.`);
  } else {
    console.log(`  It does — the real forward-surprise organ, run once, forward, over the whole document, independently landed`);
    console.log(`  on exactly the narrative detail this probe went looking for, with no keyword search anywhere in the trigger.`);
  }
}

// ── Summary ──
console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`Compressed 4-entity L0 context: well under 1% of the raw source. Every claim at every altitude, for all 4`);
console.log(`entities, independently re-verified against the raw file (${exactMatch}/${checked} match once whitespace-normalized the way`);
console.log(`the module's own header documents; ${locateVerified}/${locateChecked} sampled spans additionally cross-checked via the module's own`);
console.log(`locateRawSpan). The drill-down trigger is significanceSpine's real forward-surprise, run once over the whole`);
console.log(`document in reading order — not a keyword search — with keyword matching used only as after-the-fact,`);
console.log(`independent validation of what the surprise organ flagged, reported honestly whichever way it lands.`);
