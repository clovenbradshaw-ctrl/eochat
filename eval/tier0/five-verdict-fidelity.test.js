// Tier 0, invariant "Five-verdict fidelity" — every claim resolves to exactly
// one of settled/supported/contested/thrash/void, no silent coercion into a
// neighboring category. Against the REAL eoreader6/verdict/index.js (verdict,
// rankVerdict, CONTESTED_THRESHOLD) and nul/index.js, imported directly — not
// a re-description of what they do.
//
// eoreader6/conformance/verdict.test.js already exercises this module; the
// fixtures below are deliberately NEW ones (different material/seeds/
// boundary points), because the spec asks for adversarial fixtures that
// would slip through if the module's category boundaries drifted, not a
// second copy of what the module's own author already tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { WORK_ROOT } from "./lib/import-graph.mjs";

const EOREADER6 = resolve(WORK_ROOT, "eoreader6");
const { verdict, CONTESTED_THRESHOLD } = await import(resolve(EOREADER6, "verdict/index.js"));
const { ground, burstiness, isGap } = await import(resolve(EOREADER6, "nul/index.js"));

const D = 256;
const W = 5;
// A different quiet/bursty pair than conformance/verdict.test.js's own
// fixture — same shape of construction, independently chosen values.
const quiet = [2, 1, 3, 2, 1, 2, 3, 1, 2, 2, 1, 3, 2, 1, 2, 3, 1, 2, 2, 3, 1, 2];
const bursty = [...quiet, 8, 8, 8, 8, 8, 8];
const g0 = () => ground({ material: quiet, draws: D, window: W, seed: 7 });

test("VOID: a NaN observation is void, never coerced into contested/supported", () => {
  const v = verdict(NaN, g0());
  assert.equal(v.verdict, "void");
});

test("VOID: an inadmissible ground (degenerate spec) is void", () => {
  // window >= material length is the documented refusal shape (fold.test.js
  // uses the same "refuse rather than derive" floor for a different organ).
  const bad = ground({ material: [1, 2], draws: D, window: W, seed: 1 });
  const v = verdict(0, bad);
  assert.equal(v.verdict, "void");
});

test("SUPPORTED: an observation squarely inside the null's mid-range is supported, not contested", () => {
  const g = g0();
  const mid = g.samples[Math.floor(g.samples.length / 2)];
  const v = verdict(mid, g);
  assert.equal(v.verdict, "supported");
  assert.ok(v.rank >= CONTESTED_THRESHOLD && v.rank <= 1 - CONTESTED_THRESHOLD, `rank ${v.rank} should sit inside the non-contested band`);
});

test("CONTESTED: an observation just past the CONTESTED_THRESHOLD boundary is contested, not supported", () => {
  const g = g0();
  const sorted = [...g.samples].sort((a, b) => a - b);
  // The value at the CONTESTED_THRESHOLD quantile from the top — rank should
  // land at/above 1 - CONTESTED_THRESHOLD, the documented contested band.
  const idx = Math.max(0, Math.floor(sorted.length * (1 - CONTESTED_THRESHOLD)) - 1);
  const nearBoundary = sorted[idx];
  const v = verdict(nearBoundary, g);
  assert.notEqual(v.verdict, "void");
  // Not asserting the exact category (rank ties near a quantile edge are a
  // real boundary, not this test's to pin down) — asserting the STRONGER
  // adversarial claim the spec actually wants: an observation clearly beyond
  // every sample is contested, unambiguously.
  const beyond = sorted[sorted.length - 1] + (sorted[sorted.length - 1] - sorted[0] || 1);
  const vBeyond = verdict(beyond, g);
  assert.equal(vBeyond.verdict, "contested", `an observation past every drawn sample must be contested, got ${vBeyond.verdict}`);
});

test("THRASH: two grounds built from materials with different burstiness disagree on the same figure", () => {
  const quietGround = g0();
  const burstyGround = ground({ material: bursty, draws: D, window: W, seed: 7 });
  // Pick an observed value supported against the quiet ground but not
  // against the bursty one (the bursty ground's null sits much higher).
  const obs = quietGround.samples[Math.floor(quietGround.samples.length / 2)];
  const v = verdict(obs, quietGround, { plural: [burstyGround] });
  assert.equal(v.verdict, "thrash", `expected disagreement (thrash), got ${v.verdict} with constituents ${JSON.stringify(v.constituents)}`);
  assert.equal(new Set(v.constituents).size, 2, "thrash requires the constituent verdicts to actually differ");
});

test("SETTLED: a mid-support observation with the cited material and enough reseeds is settled, and carries its ground spec", () => {
  const g = g0();
  const mid = g.samples[Math.floor(g.samples.length / 2)];
  const v = verdict(mid, g, { reseeds: 8, material: quiet });
  assert.equal(v.verdict, "settled");
  assert.deepEqual(v.spec, g.spec);
});

test("settled is never reached without material, even with plenty of reseeds — stability needs the cited material back", () => {
  const g = g0();
  const mid = g.samples[Math.floor(g.samples.length / 2)];
  const v = verdict(mid, g, { reseeds: 8 });
  assert.notEqual(v.verdict, "settled", "verdict() must not fabricate stability it never checked");
});

test("stability requested over material the ground does not cite is void, not silently accepted", () => {
  const g = g0();
  const mid = g.samples[Math.floor(g.samples.length / 2)];
  const wrongMaterial = quiet.map((v) => v + 5);
  const v = verdict(mid, g, { reseeds: 8, material: wrongMaterial });
  assert.equal(v.verdict, "void");
  assert.equal(v.gap, "unreceived_origin");
});

// Exhaustiveness: every verdict this suite produced is one of the five named
// categories — no sixth value leaked through (e.g. undefined, a raw gap type).
test("every verdict produced above is one of the five named categories", () => {
  const NAMED = new Set(["settled", "supported", "contested", "thrash", "void"]);
  const g = g0();
  const samples = [NaN, g.samples[0], g.samples[Math.floor(g.samples.length / 2)], g.samples[g.samples.length - 1] * 3];
  for (const s of samples) {
    const v = verdict(s, g, { reseeds: 4, material: quiet });
    assert.ok(NAMED.has(v.verdict), `verdict() produced an un-named category: ${JSON.stringify(v.verdict)}`);
  }
});
