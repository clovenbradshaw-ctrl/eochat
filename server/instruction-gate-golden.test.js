// instruction-gate-golden.test.js — golden test for the custom instruction system.
//
// This test establishes the reference behavior for:
//   1. Custom instruction fold CRUD (create, read, update, delete)
//   2. Gate surf/fold with signal matching
//   3. Memory feedback influencing surf scoring
//   4. DEF·EVA·REC compliance checking
//   5. Error correction when the system misbehaves
//
// Run: node --test eochat/server/instruction-gate-golden.test.js

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Test directory isolation
const TEST_DIR = path.join(os.tmpdir(), `eo-gate-golden-${Date.now()}`);
const MEMORY_DIR = path.join(TEST_DIR, "memory");

// Override paths before importing modules
process.env.EO_MEMORY_DIR = MEMORY_DIR;

// Dynamic imports after env setup
const { createInstructionGate, countTokens } = await import("./instruction-gate.js");
const { CustomInstructionStore } = await import("./custom-instruction-store.js");
const { WorkspaceMemory } = await import("./workspace-memory.js");
const { checkCompliance } = await import("./instruction-compliance.js");

// ── Golden reference data ──────────────────────────────────────────────────
// These are the reference folds that define correct behavior.

const GOLDEN_FOLDS = [
  {
    id: "core-identity",
    title: "Core Identity",
    always: true,
    weight: 100,
    signals: ["identity", "who are you", "what are you"],
    fingerprint: "You are EO — a grounded reader's companion.",
    body: "You are EO, the reader's research companion. Your job is to help the reader understand their own material. Three commitments: grounded, verbatim, honest.",
  },
  {
    id: "citation-law",
    title: "Citation Law",
    always: true,
    weight: 99,
    signals: ["cite", "citation", "bracket", "source"],
    fingerprint: "Citing is the law of this conversation.",
    body: "Every claim from the material must be followed by its bracket [n]. Never cite [N+1] or higher. A bracket without a real passage is a fabricated citation.",
  },
  {
    id: "role-specialization",
    title: "Respond As a Role",
    always: false,
    weight: 70,
    signals: ["respond as", "act as", "you are a", "expert", "specialist", "role"],
    fingerprint: "When asked to respond as a role, adopt it within core identity bounds.",
    body: "The reader may ask you to respond from a specific role. Adopt that role's frame of reference. You remain EO — grounded, verbatim, honest — even inside a role.",
  },
  {
    id: "resource-declaration",
    title: "Here Is What You Have Access To",
    always: false,
    weight: 70,
    signals: ["you have access to", "here is", "use this", "work with", "attached files"],
    fingerprint: "Acknowledge and use only the resources explicitly declared as available.",
    body: "The reader will declare what you have access to. Treat these declarations as the authoritative boundary. Use only what was declared. If resources are missing, name the gap.",
  },
  {
    id: "no-preamble",
    title: "No Preamble",
    always: false,
    weight: 60,
    signals: ["direct", "no preamble", "just answer", "skip intro"],
    fingerprint: "Answer directly without preamble or throat-clearing.",
    body: "Never start with 'Great question!', 'To answer this...', or similar. Answer what was asked, directly, in the first sentence. No narrating your own reasoning.",
  },
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Custom Instruction System — Golden Reference", () => {
  let store;
  let memory;
  let gate;
  const projectId = `test-project-${Date.now()}`;
  let foldIds = {}; // Shared across test blocks

  before(async () => {
    await fsp.mkdir(MEMORY_DIR, { recursive: true });
    store = new CustomInstructionStore();
    memory = new WorkspaceMemory();
    gate = createInstructionGate();
  });

  after(async () => {
    await fsp.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  // ── 1. Fold CRUD ───────────────────────────────────────────────────────

  describe("1. Custom Instruction Fold CRUD", () => {
    it("creates a fold and assigns an id", async () => {
      const fold = await store.create(projectId, GOLDEN_FOLDS[0]);
      assert.ok(fold.id, "fold must have an id");
      assert.equal(fold.title, "Core Identity");
      assert.equal(fold.always, true);
      assert.equal(fold.weight, 100);
    });

    it("lists all folds for a project", async () => {
      // Create remaining folds
      for (const f of GOLDEN_FOLDS.slice(1)) {
        await store.create(projectId, f);
      }
      const list = await store.list(projectId);
      assert.equal(list.length, 5, "should have 5 folds");
    });

    it("updates a fold", async () => {
      const list = await store.list(projectId);
      const fold = list[0];
      const updated = await store.update(projectId, fold.id, { weight: 95 });
      assert.equal(updated.weight, 95);
    });

    it("removes a fold", async () => {
      const list = await store.list(projectId);
      const toRemove = list[list.length - 1];
      await store.remove(projectId, toRemove.id);
      const after = await store.list(projectId);
      assert.equal(after.length, 4);
    });

    it("loads folds for the gate", async () => {
      const folds = await store.loadFolds(projectId);
      assert.equal(folds.length, 4, "should have 4 folds after removal");
      assert.ok(folds.every(f => f.id && f.title && f.body));
      // Populate foldIds for subsequent tests
      for (const f of folds) {
        foldIds[f.title] = f.id;
      }
    });
  });

  // ── 2. Gate surf/fold ──────────────────────────────────────────────────

  describe("2. Gate surf/fold with signal matching", () => {
    before(async () => {
      // Ensure foldIds is populated
      if (Object.keys(foldIds).length === 0) {
        const folds = await store.loadFolds(projectId);
        for (const f of folds) {
          foldIds[f.title] = f.id;
        }
      }
      gate.setFolds(await store.loadFolds(projectId));
    });

    it("surfaces always-on folds regardless of cue", () => {
      const result = gate.gate({ question: "hello" });
      assert.ok(result.activeIds.includes(foldIds["Core Identity"]), "core-identity should be active");
      assert.ok(result.activeIds.includes(foldIds["Citation Law"]), "citation-law should be active");
    });

    it("surfaces role-specialization when cue matches signals", () => {
      const result = gate.gate({ question: "Respond as a legal expert and review this" });
      assert.ok(result.activeIds.includes(foldIds["Respond As a Role"]), "role-specialization should be active");
    });

    it("surfaces resource-declaration when cue mentions resources", () => {
      const result = gate.gate({ question: "Here are the documents you have access to" });
      assert.ok(result.activeIds.includes(foldIds["Here Is What You Have Access To"]), "resource-declaration should be active");
    });

    it("folds non-matching conditional folds to fingerprint index", () => {
      const result = gate.gate({ question: "hello" });
      assert.ok(result.foldedIds.includes(foldIds["Respond As a Role"]), "role-specialization should be folded");
      assert.ok(result.foldedIds.includes(foldIds["Here Is What You Have Access To"]), "resource-declaration should be folded");
    });

    it("generates a system message with active and folded sections", () => {
      const result = gate.gate({ question: "Respond as a historian" });
      assert.ok(result.systemMessage, "should have a system message");
      assert.ok(result.systemMessage.includes("ACTIVE FOLDS"), "should have active section");
      assert.ok(result.systemMessage.includes("FOLDED FOLDS"), "should have folded section");
      assert.ok(result.systemMessage.includes(foldIds["Respond As a Role"]), "should mention active fold id");
    });

    it("returns null system message when no folds exist", async () => {
      gate.setFolds([]);
      const result = gate.gate({ question: "hello" });
      assert.equal(result.systemMessage, null, "empty gate should return null");
      // Restore folds
      const folds = await store.loadFolds(projectId);
      gate.setFolds(folds);
    });
  });

  // ── 3. Memory feedback ─────────────────────────────────────────────────

  describe("3. Memory feedback influences surf scoring", () => {
    it("records a turn with compliance verdict", async () => {
      const record = await memory.recordTurn(projectId, {
        turnId: "turn-1",
        question: "Respond as a historian",
        activeFoldIds: ["core-identity", "citation-law", "role-specialization"],
        verdict: "compliant",
      });
      assert.equal(record.turnId, "turn-1");
      assert.equal(record.verdict, "compliant");
    });

    it("records negative feedback", async () => {
      await memory.recordTurn(projectId, {
        turnId: "turn-2",
        question: "Respond as a lawyer",
        activeFoldIds: ["core-identity", "citation-law", "role-specialization"],
        verdict: "noncompliant",
        feedback: "negative",
      });
    });

    it("computes fold adjustments from history", async () => {
      const adjustments = await memory.allAdjustments(projectId);
      // role-specialization had one compliant (+1) and one negative (-3) = -2
      const roleAdj = adjustments.get("role-specialization") || 0;
      assert.ok(roleAdj < 0, "role-specialization should have negative adjustment");
    });

    it("applies memory adjustments to gate scoring", () => {
      // Use the actual fold ID from the store
      const roleFoldId = foldIds["Respond As a Role"];
      const adjustments = new Map([[roleFoldId, -5]]);
      const result = gate.gate({
        question: "Respond as a historian",
        memoryAdjustments: adjustments,
        debug: true,
      });
      // The fold should still surface (signal match is strong), but score is lower
      const scoreEntry = result.scores.find(s => s.id === roleFoldId);
      assert.ok(scoreEntry, "should have score entry");
      assert.ok(scoreEntry.memoryAdjustment === -5, "should have memory adjustment applied");
    });

    it("retrieves recent feedback history", async () => {
      const history = await memory.recentFeedback(projectId);
      assert.ok(history.length >= 2, "should have at least 2 entries");
    });
  });

  // ── 4. DEF·EVA·REC compliance ──────────────────────────────────────────

  describe("4. DEF·EVA·REC compliance checking", () => {
    it("DEF extracts criteria from fold bodies", async () => {
      const folds = [
        { id: "no-preamble", title: "No Preamble", body: "Never start with 'Great question!' or similar preamble. Answer directly." },
        { id: "citation-law", title: "Citation Law", body: "Every claim must be cited with brackets [n]. Never fabricate a citation." },
      ];
      const result = await checkCompliance({
        response: "The answer is 42 [1].",
        activeFolds: folds,
        question: "What is the answer?",
      });
      assert.ok(result.criteria.length > 0, "should extract criteria");
    });

    it("EVA passes a compliant response", async () => {
      const folds = [
        { id: "citation-law", title: "Citation Law", body: "Every claim must be cited with brackets [n]." },
      ];
      const result = await checkCompliance({
        response: "According to the source [1], the answer is 42.",
        activeFolds: folds,
        question: "What is the answer?",
      });
      assert.equal(result.verdict, "compliant", "should be compliant");
    });

    it("EVA detects suspicious citations", async () => {
      const folds = [
        { id: "citation-law", title: "Citation Law", body: "Every claim must be cited with brackets [n]. Never cite [N+1] or higher." },
      ];
      const result = await checkCompliance({
        response: "According to the source [999], the answer is 42.",
        activeFolds: folds,
        question: "What is the answer?",
      });
      // Note: mechanical check flags suspicious high numbers
      assert.ok(result.eva.results.some(r => r.note?.includes("suspicious")), "should flag suspicious citation");
    });

    it("EVA detects preamble violations", async () => {
      const folds = [
        { id: "no-preamble", title: "No Preamble", body: "Never start with 'Great question!' or similar. Answer directly. No preamble." },
      ];
      const result = await checkCompliance({
        response: "Great question! The answer is 42.",
        activeFolds: folds,
        question: "What is the answer?",
      });
      // Check if any result detected a violation
      const hasViolation = result.eva.results.some(r => 
        r.violations?.length > 0 || r.note?.includes("preamble")
      );
      assert.ok(hasViolation, "should detect preamble violation");
    });

    it("returns compliant verdict when no criteria extracted", async () => {
      const folds = [
        { id: "vague", title: "Vague", body: "Be helpful and answer questions." },
      ];
      const result = await checkCompliance({
        response: "Here is your answer.",
        activeFolds: folds,
        question: "Help me",
      });
      assert.equal(result.verdict, "compliant", "vague fold should not trigger violations");
    });
  });

  // ── 5. Error correction ────────────────────────────────────────────────

  describe("5. Error correction towards golden", () => {
    it("corrects when fold has no signals (conditional fold must have signals)", async () => {
      // A conditional fold with no signals can never surface — this is an error
      const badFold = {
        id: "bad-fold",
        title: "Bad Fold",
        always: false,
        weight: 50,
        signals: [], // ERROR: conditional fold with no signals
        fingerprint: "This fold can never surface",
        body: "This fold has no signals and can never be surfaced.",
      };
      // The store allows it, but the gate should handle it gracefully
      gate.setFolds([badFold]);
      const result = gate.gate({ question: "anything" });
      // The fold should be in folded, not active (since it can't match)
      assert.ok(result.foldedIds.includes("bad-fold"), "bad fold should be folded, not active");
    });

    it("corrects when memory adjustment would make score negative", () => {
      // Even with heavy negative adjustment, signal matching should still work
      const folds = [
        { id: "test", title: "Test", always: false, weight: 50, signals: ["test"], fingerprint: "Test", body: "Test body" },
      ];
      gate.setFolds(folds);
      const result = gate.gate({
        question: "this is a test",
        memoryAdjustments: new Map([["test", -100]]),
        debug: true,
      });
      // The fold should still surface if signal matches, despite negative adjustment
      const scoreEntry = result.scores.find(s => s.id === "test");
      assert.ok(scoreEntry.rawScore > 0, "raw score should be positive");
    });

    it("corrects when compliance check throws", async () => {
      // Compliance check should not break the turn
      const folds = [{ id: "test", title: "Test", body: "Test" }];
      const result = await checkCompliance({
        response: "Test response",
        activeFolds: folds,
        question: "test",
      });
      assert.ok(result.verdict, "should return a verdict even on edge cases");
    });

    it("corrects when memory file is corrupted", async () => {
      // Memory should handle corrupted files gracefully
      const corruptProjectId = "corrupt-project";
      const memoryFile = path.join(MEMORY_DIR, "workspace-memory", `${corruptProjectId}.jsonl`);
      await fsp.mkdir(path.dirname(memoryFile), { recursive: true });
      await fsp.writeFile(memoryFile, "not valid json\n{also bad");

      // Should not throw
      const adjustments = await memory.allAdjustments(corruptProjectId);
      assert.ok(adjustments instanceof Map, "should return empty map on corrupt file");
    });
  });

  // ── 6. Integration ─────────────────────────────────────────────────────

  describe("6. Full integration flow", () => {
    it("runs a complete turn: gate → compliance → memory → next gate", async () => {
      const integrationProjectId = `integration-${Date.now()}`;

      // Create folds and track their IDs
      const createdFolds = [];
      for (const f of GOLDEN_FOLDS.slice(0, 3)) {
        const created = await store.create(integrationProjectId, f);
        createdFolds.push(created);
      }

      // First turn: gate surfaces role-specialization
      const folds1 = await store.loadFolds(integrationProjectId);
      gate.setFolds(folds1);
      const gate1 = gate.gate({ question: "Respond as a historian" });
      
      // Find the role-specialization fold ID
      const roleFold = createdFolds.find(f => f.title === "Respond As a Role");
      assert.ok(roleFold, "role fold should exist");
      assert.ok(gate1.activeIds.includes(roleFold.id), "role-specialization should be active");

      // Compliance check
      const compliance1 = await checkCompliance({
        response: "As a historian, I would note that the primary sources [1] indicate...",
        activeFolds: gate1.surfaced,
        question: "Respond as a historian",
      });

      // Record to memory
      await memory.recordTurn(integrationProjectId, {
        turnId: "integration-turn-1",
        question: "Respond as a historian",
        activeFoldIds: gate1.activeIds,
        verdict: compliance1.verdict,
      });

      // Second turn: memory influences scoring
      const adjustments = await memory.allAdjustments(integrationProjectId);
      const gate2 = gate.gate({
        question: "Respond as a historian again",
        memoryAdjustments: adjustments,
      });

      // The fold should still surface (signal is strong), but score reflects memory
      assert.ok(gate2.activeIds.includes(roleFold.id), "fold should still surface");
    });
  });
});
