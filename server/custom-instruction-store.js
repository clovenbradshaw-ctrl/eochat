// custom-instruction-store.js — user-uploaded instruction folds, persisted per-project.
//
// Unlike the old instruction-set/*.md files (which were baked into the repo),
// these folds are created, edited, and deleted by the reader at runtime.
// Each fold is a JSON object mirroring the front-matter + body structure of
// the old markdown files, but stored as JSON for programmatic access.
//
// Storage: memory/custom-instructions/<projectId>.json
// Each file holds an array of fold objects:
//   { id, title, always, weight, signals, fingerprint, body, createdAt, updatedAt }

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

const CUSTOM_INSTRUCTIONS_DIR = path.join(MEMORY_DIR, "custom-instructions");

function newId() {
  return `instr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, file);
}

function projectFile(projectId) {
  return path.join(CUSTOM_INSTRUCTIONS_DIR, `${projectId}.json`);
}

async function readProject(projectId) {
  try {
    const raw = await fsp.readFile(projectFile(projectId), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export class CustomInstructionStore {
  async list(projectId) {
    const folds = await readProject(projectId);
    return folds.map(f => ({
      id: f.id,
      title: f.title,
      always: f.always,
      weight: f.weight,
      signals: f.signals,
      fingerprint: f.fingerprint,
      bodyLength: f.body?.length || 0,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
  }

  async get(projectId, foldId) {
    const folds = await readProject(projectId);
    return folds.find(f => f.id === foldId) || null;
  }

  async create(projectId, { title, always = false, weight = 50, signals = [], fingerprint = "", body = "" }) {
    const folds = await readProject(projectId);
    const now = new Date().toISOString();
    const fold = {
      id: newId(),
      title,
      always,
      weight: Number.isFinite(weight) ? weight : 50,
      signals: Array.isArray(signals) ? signals : [],
      fingerprint,
      body,
      createdAt: now,
      updatedAt: now,
    };
    folds.push(fold);
    await writeAtomic(projectFile(projectId), JSON.stringify(folds, null, 2));
    return fold;
  }

  async update(projectId, foldId, patch) {
    const folds = await readProject(projectId);
    const idx = folds.findIndex(f => f.id === foldId);
    if (idx < 0) throw new Error(`instruction fold not found: ${foldId}`);
    const existing = folds[idx];
    const updated = { ...existing, ...patch, id: foldId, updatedAt: new Date().toISOString() };
    folds[idx] = updated;
    await writeAtomic(projectFile(projectId), JSON.stringify(folds, null, 2));
    return updated;
  }

  async remove(projectId, foldId) {
    const folds = await readProject(projectId);
    const filtered = folds.filter(f => f.id !== foldId);
    if (filtered.length === folds.length) throw new Error(`instruction fold not found: ${foldId}`);
    await writeAtomic(projectFile(projectId), JSON.stringify(filtered, null, 2));
    return { deleted: true, id: foldId };
  }

  async clear(projectId) {
    await writeAtomic(projectFile(projectId), "[]");
    return { deleted: true, projectId };
  }

  // Bulk load all folds for a project (used by the gate).
  async loadFolds(projectId) {
    return await readProject(projectId);
  }
}

export const customInstructionStore = new CustomInstructionStore();
