// cabinet-store.js — durable storage for the project file cabinet
// (project-memory.js). One JSON file per project pool under memory/cabinet/,
// written atomically and serialised per pool, exactly like the conversation
// store and the project store it sits beside.
//
// The cabinet is project-global memory: it must survive every conversation in
// the project, so it is keyed by pool (which projects already use as their
// retrieval boundary) rather than by conversation. The pure state machine in
// project-memory.js decides WHAT a cabinet contains; this file only promises
// it is never lost and never half-written.

import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

export const CABINET_DIR = path.join(MEMORY_DIR, "cabinet");

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, file);
}

export class CabinetStore {
  constructor({ dir = CABINET_DIR } = {}) {
    this.dir = dir;
    // One promise chain per pool — serialises read-modify-write so two turns
    // in different conversations of the same project cannot clobber each
    // other's cabinet update.
    this._locks = new Map();
  }

  #file(pool) { return path.join(this.dir, `${pool}.json`); }

  #withLock(pool, fn) {
    const prior = this._locks.get(pool) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this._locks.set(pool, prior.then(() => gate));
    return (async () => {
      await prior;
      try {
        return await fn();
      } finally {
        release();
      }
    })();
  }

  /** Read a pool's cabinet; null when it does not exist yet. A malformed file is quarantined, not thrown. */
  async get(pool) {
    if (!pool) return null;
    const file = this.#file(pool);
    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      await ensureDir(path.join(this.dir, ".corrupt"));
      const dest = path.join(this.dir, ".corrupt", `${path.basename(file)}.${Date.now()}.bad`);
      try { await fsp.rename(file, dest); } catch { /* best-effort */ }
      console.error(`[cabinet-store] quarantined malformed cabinet ${file} -> ${dest}: ${err.message}`);
      return null;
    }
  }

  async set(pool, cabinet) {
    if (!pool) return;
    return this.#withLock(pool, async () => {
      await writeAtomic(this.#file(pool), JSON.stringify(cabinet || { memos: [] }, null, 2));
      return cabinet || { memos: [] };
    });
  }
}

export const cabinetStore = new CabinetStore();
