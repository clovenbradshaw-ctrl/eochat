// Tier 0, invariant "rho / Born-rule salience integrity" — the rho-weighted
// mixture used for ranking must be the actual computed value, not a
// stand-in. Against the REAL eoreader6/packages/engine/generation/belief.js
// (createBelief/witnessForm/relevanceReport), using the rescale-invariance
// test the spec borrows from eoreader5's Born-null relativity check: rescale
// every gift's likelihood by the same constant factor and assert the
// resulting shares are unchanged — softmax over log-likelihoods is invariant
// to a shift added equally to every term, and log(c*p) = log(c) + log(p), so
// this is the actual algebraic property `shares()` must have if rho really is
// being used as a discounted log-likelihood mixture rather than dressed-up.
//
// Minimal stub layers are used here rather than real corpus-backed ones —
// witnessForm/relevanceReport only ever call `layer.massOf(ctx, form)` and
// read `layer.id`/`layer.giver`; the read layer's own fields are never
// touched by this pair of functions, so the stub does not need to implement
// successors()/evidence() for this property to be a real exercise of
// createBelief's own closures, not a reimplementation of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { WORK_ROOT } from "./lib/import-graph.mjs";

const EOREADER6 = resolve(WORK_ROOT, "eoreader6");
const { createBelief } = await import(resolve(EOREADER6, "packages/engine/generation/belief.js"));

const readLayer = Object.freeze({
  tier: "read", id: "read", order: 0, alpha: 1,
  has: () => false,
  evidence: () => 0,
  successors: () => ({ successors: new Map() }),
});

function fixedMassLayer(id, giver, mass) {
  return Object.freeze({
    tier: "received", id, giver, order: 0, world: "other",
    has: () => false,
    successors: () => ({ successors: new Map() }),
    massOf: () => ({ mass, reserve: 0 }),
  });
}

function sharesAfterWitnessing(masses, { rho = 0.9, steps = 6 } = {}) {
  const layers = [readLayer, ...masses.map((m, i) => fixedMassLayer(`gift${i}`, `giver${i}`, m))];
  const belief = createBelief({ layers, rho });
  for (let i = 0; i < steps; i++) belief.witnessForm([], `form${i}`);
  return belief.relevanceReport().layers.map((l) => l.share);
}

test("rho requires a declared forgetting rate in (0,1] when more than one gift is present — never defaulted", () => {
  const layers = [readLayer, fixedMassLayer("g0", "a", 0.3), fixedMassLayer("g1", "b", 0.1)];
  assert.throws(() => createBelief({ layers, rho: undefined }), /forgetting rate/);
  assert.throws(() => createBelief({ layers, rho: 0 }), /forgetting rate/);
  assert.throws(() => createBelief({ layers, rho: 1.5 }), /forgetting rate/);
});

test("BORN-RULE RESCALE INVARIANCE: scaling every gift's likelihood by the same constant leaves shares unchanged", () => {
  const baseline = sharesAfterWitnessing([0.3, 0.1, 0.05]);
  for (const c of [10, 0.01, 1000]) {
    const rescaled = sharesAfterWitnessing([0.3 * c, 0.1 * c, 0.05 * c]);
    assert.equal(rescaled.length, baseline.length);
    for (let i = 0; i < baseline.length; i++) {
      assert.ok(
        Math.abs(rescaled[i] - baseline[i]) < 1e-9,
        `share[${i}] drifted under rescale by ${c}: baseline=${baseline[i]} rescaled=${rescaled[i]}`,
      );
    }
  }
});

test("shares still respond correctly to genuinely DIFFERENT relative likelihood — rescale invariance is not just 'always equal'", () => {
  const equalMass = sharesAfterWitnessing([0.2, 0.2]);
  assert.ok(Math.abs(equalMass[0] - equalMass[1]) < 1e-9, "equal likelihoods must earn equal shares");

  const skewed = sharesAfterWitnessing([0.9, 0.05]);
  assert.ok(skewed[0] > skewed[1] + 0.3, `a gift with much higher likelihood must earn a much larger share, got ${JSON.stringify(skewed)}`);
});

test("relevanceReport declares gated:false for a lone gift, so an unearned share is never mistaken for a measured one", () => {
  const layers = [readLayer, fixedMassLayer("only", "solo", 0.5)];
  const belief = createBelief({ layers, rho: undefined }); // no rho required with <=1 received layer
  belief.witnessForm([], "form0");
  const report = belief.relevanceReport();
  assert.equal(report.gated, false);
  assert.ok(report.ungated_reason, "the reason a lone gift's share is unearned must be stated, not implied");
  assert.equal(report.layers[0].share, 1);
});
