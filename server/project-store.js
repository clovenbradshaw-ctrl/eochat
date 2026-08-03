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
        sourceCount: (project.documents || project.sourceIds || []).length,
        documents: project.documents || [],
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
      documents: [],
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
      return this.#save(project);
    });
  }

  async remove(id) {
    return this.#withLock(id, async () => {
      const project = await this.get(id);
      if (!project) throw new Error(`project not found: ${id}`);
      await fsp.unlink(this.#file(id)).catch(() => {});
      return { deleted: true, id };
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
      if (!project.sourceIds) project.sourceIds = [];
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

  async addDocument(projectId, doc) {
    return this.#withLock(projectId, async () => {
      const project = await this.get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (!project.documents) project.documents = [];
      const existing = project.documents.find(d => d.sourceKey === doc.sourceKey);
      if (!existing) {
        project.documents.push({
          sourceKey: doc.sourceKey,
          name: doc.name,
          chunks: doc.chunks || 0,
          kind: doc.kind || "corpus",
          ingestedAt: doc.ingestedAt || new Date().toISOString(),
        });
      }
      return this.#save(project);
    });
  }

  async removeDocument(projectId, sourceKey) {
    return this.#withLock(projectId, async () => {
      const project = await this.get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      project.documents = (project.documents || []).filter(d => d.sourceKey !== sourceKey);
      project.sourceIds = (project.sourceIds || []).filter(id => id !== sourceKey);
      return this.#save(project);
    });
  }

  async listDocuments(projectId) {
    const project = await this.get(projectId);
    if (!project) return [];
    return project.documents || [];
  }
}

export const projectStore = new ProjectStore();
