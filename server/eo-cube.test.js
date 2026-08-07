import test from "node:test";
import assert from "node:assert/strict";
import {
  MODES, DOMAINS, GRAINS, OPERATORS, CELLS,
  isOperator, isGrain, cellFor, coherence,
} from "./eo-cube.js";

test("the addressable space is operator x grain = 27, not 729", () => {
  assert.equal(Object.keys(OPERATORS).length, 9);
  assert.equal(GRAINS.length, 3);
  assert.equal(Object.keys(CELLS).length, 27);
  // Each face independently ranges over 9 values — operator (mode x domain),
  // terrain (domain x grain), stance (mode x grain) — so freely combining
  // them gives 9 x 9 x 9 = 729 triples; only 27 are mutually coherent
  // (eoreader6/CUBE.md, eoreader4.2/src/core/cube.js: "the other 702 triples
  // are contradictions").
  const operatorCount = MODES.length * DOMAINS.length;
  const terrainCount = DOMAINS.length * GRAINS.length;
  const stanceCount = MODES.length * GRAINS.length;
  assert.equal(operatorCount * terrainCount * stanceCount, 729);
  assert.equal(729 - Object.keys(CELLS).length, 702);
});

test("every operator crossed with every grain is legal by construction", () => {
  for (const op of Object.keys(OPERATORS)) {
    for (const grain of GRAINS) {
      const cell = cellFor(op, grain);
      assert.equal(cell.operator, op);
      assert.equal(cell.grain, grain);
      assert.ok(cell.terrain, `${op}.${grain} must resolve a terrain`);
      assert.ok(cell.stance, `${op}.${grain} must resolve a stance`);
      assert.equal(CELLS[`${op}.${grain}`].terrain, cell.terrain);
    }
  }
});

test("NUL.Ground is Void.Clearing — the E. coli cell (eoreader6/CUBE.md)", () => {
  const cell = cellFor("NUL", "Ground");
  assert.equal(cell.mode, "Differentiate");
  assert.equal(cell.domain, "Existence");
  assert.equal(cell.terrain, "Void");
  assert.equal(cell.stance, "Clearing");
});

test("REC.Ground is Atmosphere.Cultivating — the Ramakrishna cell (eoreader6/CUBE.md)", () => {
  const cell = cellFor("REC", "Ground");
  assert.equal(cell.mode, "Generate");
  assert.equal(cell.domain, "Interpretation");
  assert.equal(cell.terrain, "Atmosphere");
  assert.equal(cell.stance, "Cultivating");
});

test("DEF's stance escalates by grain — clear, dissect, unravel (eoreader6/CUBE.md)", () => {
  assert.equal(cellFor("DEF", "Ground").stance, "Clearing");
  assert.equal(cellFor("DEF", "Figure").stance, "Dissecting");
  assert.equal(cellFor("DEF", "Pattern").stance, "Unraveling");
});

test("an unknown operator or grain is a type error, never a nearest-match guess", () => {
  assert.throws(() => cellFor("ATT", "Ground"), TypeError);
  assert.throws(() => cellFor("SEG", "Depth"), TypeError);
  assert.equal(isOperator("ATT"), false);
  assert.equal(isGrain("Depth"), false);
});

test("coherence agrees when an independently-assembled address lands on the same cell", () => {
  const result = coherence({ operator: "SEG", grain: "Figure", terrain: "Link", stance: "Dissecting" });
  assert.equal(result.ok, true);
  assert.equal(result.cell.terrain, "Link");
  assert.equal(result.cell.stance, "Dissecting");
});

test("coherence names which face disagrees, rather than silently preferring one", () => {
  // SEG.Figure is Structure/Link — Void is Existence's Ground terrain, off-diagonal.
  const result = coherence({ operator: "SEG", grain: "Figure", terrain: "Void" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /terrain "Void" disagrees with SEG\.Figure/);
});

test("coherence with too little supplied reports no cell rather than fabricating one", () => {
  const result = coherence({ operator: "SEG" });
  assert.equal(result.ok, true);
  assert.equal(result.cell, null);
});
