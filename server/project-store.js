import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

const PROJECTS_DIR = path.join(MEMORY_DIR, "projects");

function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

export class ProjectStore {
  constructor({ dir = PROJECTS_DIR } = {}) {
    this.dir = dir;
    this._locks = new Map();
  }

  #file(id) { return path.join(this.dir, `${id}.json`); }

  async #withLock(id, fn) {
    const prior = this._locks.get(id) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this._locks.set(id, prior.then(() => gate));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #readFile(file) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async #save(project) {
    project.updatedAt = new Date().toISOString();
    await writeAtomic(this.#file(project.id), JSON.stringify(project, null, 2));
    return project;
  }

  async list() {
    await ensureDir(this.dir);
    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const project = await this.#readFile(path.join(this.dir, name));
      if (!project || !project.id) continue;
      out.push({
        id: project.id,
        name: project.name,
        description: project.description,
        pool: project.pool,
        conversationCount: (project.conversationIds || []).length,
        sourceCount: (project.sourceIds || []).length,
        instructionsChars: project.instructionsChars || 0,
        instructionBudget: project.instructionBudget || null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    }
    out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return out;
  }

  async create({ name, description = "" } = {}) {
    const now = new Date().toISOString();
    const id = newId();
    const project = {
      id,
      name: name || "Untitled project",
      description,
      pool: id,
      conversationIds: [],
      sourceIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeAtomic(this.#file(id), JSON.stringify(project, null, 2));
    return project;
  }

  async get(id) {
    return this.#readFile(this.#file(id));
  }

  async update(id, patch) {
    return this.#withLock(id, async () => {
      const project = await this.get(id);
      if (!project) throw new Error(`project not found: ${id}`);
      if (patch.name !== undefined) project.name = patch.name;
      if (patch.description !== undefined) project.description = patch.description;
      // How many tokens this project's instructions may spend per turn. A long
      // manual needs more room than a short one, and the ceiling that suits a
      // page of house style will crowd out a rule from a 300-section policy
      // book — measured: the same 333KB manual whose rules never surfaced at
      // 2800 tokens surfaces them correctly at 6000. Every token here is one
      // the retrieved passages cannot use, so it is the reader's call.
      if (patch.instructionBudget !== undefined) {
        const n = Number(patch.instructionBudget);
        project.instructionBudget = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
      }
      return this.#save(project);
    });
  }

  async remove(id) {
    return this.#withLock(id, async () => {
      const project = await this.get(id);
      if (!project) throw new Error(`project not found: ${id}`);
      await fsp.unlink(this.#file(id)).catch(() => {});
      // The instructions sidecar goes with it. Leaving it behind is not just
      // clutter: ids are generated from a timestamp and a random suffix, so a
      // future project could in principle land on the same name and silently
      // inherit a deleted project's rules — instructions nobody wrote for it
      // and nobody can see in its own editor.
      await fsp.unlink(this.#instructionsFile(id)).catch(() => {});
      return { deleted: true, id };
    });
  }

  // ── Instructions ──
  //
  // A project's instructions are the rules the model must obey while working
  // in it, and they are stored beside the project rather than inside its JSON
  // for two reasons: they may be of any length, and they must survive
  // byte-for-byte. INSTRUCTION-LAW R1 ("verbatim, or not at all") is a promise
  // about what reaches the model, and it cannot be kept if the text is
  // reshaped on the way to disk. A .md sidecar is the text itself.
  //
  // Nothing here segments, summarizes or caps. Fitting the budget is the
  // gate's job at turn time (project-instructions.js + instruction-gate.js);
  // storage's only job is to lose nothing.
  #instructionsFile(id) { return path.join(this.dir, `${id}.instructions.md`); }

  // Public so the turn path can stat-and-cache the file synchronously without
  // reaching through a private field. The turn path must stay synchronous: it
  // runs per turn, and an await there would be a new opportunity for the block
  // to arrive after the model call it is supposed to govern.
  instructionsPath(id) { return this.#instructionsFile(id); }

  async getInstructions(id) {
    const project = await this.get(id);
    if (!project) throw new Error(`project not found: ${id}`);
    let text = "";
    let updatedAt = null;
    try {
      const file = this.#instructionsFile(id);
      text = await fsp.readFile(file, "utf8");
      updatedAt = (await fsp.stat(file)).mtime.toISOString();
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return { projectId: id, text, chars: text.length, updatedAt };
  }

  async setInstructions(id, text) {
    return this.#withLock(id, async () => {
      const project = await this.get(id);
      if (!project) throw new Error(`project not found: ${id}`);
      const body = String(text ?? "");
      if (body.trim()) {
        await writeAtomic(this.#instructionsFile(id), body);
      } else {
        // Clearing is deleting the file, not writing an empty one: an absent
        // instruction set and an empty one must not be two states that behave
        // the same but read differently.
        await fsp.unlink(this.#instructionsFile(id)).catch(() => {});
      }
      project.instructionsChars = body.trim() ? body.length : 0;
      await this.#save(project);
      return this.getInstructions(id);
    });
  }

  async addConversation(projectId, conversationId) {
    return this.#withLock(projectId, async () => {
      const project = await this.get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (!project.conversationIds.includes(conversationId)) {
        project.conversationIds.push(conversationId);
      }
      return this.#save(project);
    });
  }

  async removeConversation(projectId, conversationId) {
    return this.#withLock(projectId, async () => {
      const project = await this.get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      project.conversationIds = (project.conversationIds || []).filter(id => id !== conversationId);
      return this.#save(project);
    });
  }

  async addSource(projectId, sourceId) {
    return this.#withLock(projectId, async () => {
      const project = await this.get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (!project.sourceIds.includes(sourceId)) {
        project.sourceIds.push(sourceId);
      }
      return this.#save(project);
    });
  }

  async removeSource(projectId, sourceId) {
    return this.#withLock(projectId, async () => {
      const project = await this.get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      project.sourceIds = (project.sourceIds || []).filter(id => id !== sourceId);
      return this.#save(project);
    });
  }
}

export const projectStore = new ProjectStore();
