// eochat/server · predictive-longform.test — proves the SAME task-log.js
// spine drives a properly-scored predictive domain, and pins the index
// convention that a real bug violated during development (see the module
// header's "candidate == baseline:last-value" self-consistency identity).

import test from "node:test";
import assert from "node:assert/strict";
import { nextStep, validateRegimeWorld, runRegimeForecast } from "./predictive-longform.js";

// A small amount of jitter, not a perfectly linear rise — a perfectly linear
// series has EXACTLY zero variance in its first differences, which
// correctly makes every baseline degenerate to a "point" prediction
// (baselines.js's own documented behavior) and CRPS correctly reports that
// as improper rather than inventing a spread. That is scoring.js refusing
// correctly, not a bug — a realistic test series should not manufacture it.
const rise = (n, start) => Array.from({ length: n }, (_, i) => start + i * 0.1 + (i % 3 === 0 ? 0.01 : -0.005));

test("validateRegimeWorld throws naming the missing field", () => {
  assert.throws(() => validateRegimeWorld({ series: [1, 2], warmup: 1 }), /regimes/);
});

test("nextStep never legalizes a forecast before its regime prerequisite is observed", () => {
  const world = {
    series: [1, 1, 1, 1, 1, 1],
    regimes: { r: { checkFromStep: 99, detect: () => false } }, // never fires in this test
    forecasts: { f: { requires: "r", baselineId: "baseline:last-value" } },
  };
  const move = nextStep(world, [], 3);
  assert.notEqual(move.kind, "commit", "a forecast requiring an unobserved regime must never be legal");
});

test("regime detection sees only history strictly BEFORE the target index — no leakage", () => {
  const seenLengths = [];
  const world = {
    series: [10, 10, 10, 999, 10, 10], // a spike at index 3 that must NOT be visible while predicting index 3 itself
    regimes: { r: { checkFromStep: 0, detect: (h) => { seenLengths.push(h.length); return false; } } },
    forecasts: {},
  };
  nextStep(world, [], 3);
  assert.deepEqual(seenLengths, [3], "detect() must see exactly series[0..2], never series[3] — the value about to be predicted");
});

test("a real run: candidate and its own declared baseline agree EXACTLY at every reveal", () => {
  // The candidate IS baseline:last-value by construction — any index or
  // leakage bug between commit-time history and reveal-time baseline
  // recomputation shows up as a numeric mismatch here, not a crash. This is
  // the same self-consistency check that caught a real off-by-one during
  // development (history built as series[0..i-1] but the target read as
  // series[i+1] instead of series[i]).
  const series = [...Array(8).fill(100), 90, 88, 87, 89, 86, 85, 87, 86];
  const world = {
    series, warmup: 5,
    regimes: { drop: { checkFromStep: 5, detect: (h) => h.length >= 2 && (h[h.length - 2] - h[h.length - 1]) > 5 } },
    forecasts: { risk: { requires: "drop", baselineId: "baseline:last-value" } },
  };
  const { results } = runRegimeForecast(world, { onProgress: () => {} });
  assert.ok(results.length > 0, "at least one forecast must have been committed and revealed");
  for (const r of results) {
    assert.ok(
      Math.abs(r.loss - r.baselineLosses["baseline:last-value"]) < 1e-9,
      `step ${r.atStep}: candidate (=baseline:last-value by construction) must score identically to the baseline column`,
    );
  }
});

test("no fixed step count is declared — closure is discovered from series length", () => {
  const world = {
    series: rise(10, 0), warmup: 3,
    regimes: {}, // no regime ever required — every step is legal immediately
    forecasts: { r: { requires: null, baselineId: "baseline:last-value" } },
  };
  const { results } = runRegimeForecast(world, { onProgress: () => {} });
  // warmup=3, series.length=10 -> targets 3..9 = 7 forecasts, discovered, not declared.
  assert.equal(results.length, 7);
});
