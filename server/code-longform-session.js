// eochat/server · code-longform-session — the SAME task-log spine as
// code-longform.js, made sessionful: a multi-file build that SURVIVES across
// chat messages, each new message REVISING what earlier messages built instead
// of rebuilding from zero.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// code-longform.js's writeProject() is one-shot: plan a project, build it,
// done. But "long-form code generation ACROSS MESSAGES" is the whole point of
// building a complicated app in a chat — the first message says what the app
// is, the second adds a feature, the third fixes what the second broke, and
// the state that survives between them is what makes it long-form rather than
// a sequence of unrelated one-shots.
//
// That state is exactly what the single-shot pipeline already MEASURES and
// then throws away: the shared vocabulary (canonical names decided once),
// the declared interface of every file, the verification results, the
// unresolved cross-file references, the asset gaps. A revision that is handed
// that measured record can learn from it — "fix the leftover CSS references"
// becomes an instruction pointed at the actual unresolved names, not a fresh
// guess. This is the code-domain instance of the same discipline the whole
// session has repeated: a declared prior first, a mechanical check second,
// never a mechanical check standing in for a prior that was never given.
//
// ── WHAT'S REUSED, NOT REINVENTED ───────────────────────────────────────────
//
//   code-longform.js   writeFileStable() (the write → verify →
//                      continuity-correct → escalate loop, unchanged),
//                      buildWritePrompt/buildFixPrompt/buildEscalationPrompt,
//                      verifySyntax, checkCrossFileReferences,
//                      discoverReferencedFiles, extractInterface, callModel,
//                      parseJSON, SYSTEM, FILE_TOKENS, MAX_CONTINUITY_REVISIONS
//   task-log.js        imported by code-longform.js; this module never touches
//                      the spine directly — the mouth budget lives inside
//                      writeFileStable.
//
// ── THE WATCHMAKER DISCIPLINE, CONTINUED ─────────────────────────────────────
//
// A revision is ALWAYS additive. code-longform.js's escalation prompt already
// states it ("Do NOT remove, rename, or restructure anything already present;
// other files may depend on it exactly as it is"), and this module extends it
// to every patch action: an existing file is rewritten against the same
// declared vocabulary, and a patch that fails its own syntax check after one
// correction attempt is DISCARDED — the previous verified version is kept and
// the failure is recorded, never a broken edit silently standing on top of
// stable ground.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  writeProject, writeFileStable, planFiles,
  buildWritePrompt, buildFixPrompt, verifySyntax,
  checkCrossFileReferences, extractInterface, stripFences,
  discoverReferencedFiles, callModel, parseJSON,
  SYSTEM, FILE_TOKENS, MAX_CONTINUITY_REVISIONS,
} from "./code-longform.js";

const SESSION_FILE = "SESSION.json";
const REPORT_FILE = "BUILD_REPORT.md";
const LOG_FILE = "build-progress.log";
// The same bounded guard as writeProject's MAX_FILES_GUARD — a single message
// may grow the project, but never without bound.
const MAX_FILES_PER_MESSAGE = 6;

export function loadSession(dir) {
  const path = `${dir}/${SESSION_FILE}`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`code-longform-session: cannot read ${path}: ${err.message}`);
  }
}

export function saveSession(dir, session) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${SESSION_FILE}`, JSON.stringify(session, null, 2));
}

// Read every planned file's content back off disk. Contents are not stored in
// SESSION.json — the files ARE the state, the session file is the map.
export function readContents(dir, files) {
  const contents = {};
  for (const f of files) {
    try {
      contents[f.path] = readFileSync(`${dir}/${f.path}`, "utf8");
    } catch {
      contents[f.path] = null;
    }
  }
  return contents;
}

export function writeAllFiles(dir, contents) {
  for (const [path, content] of Object.entries(contents)) {
    if (content == null) continue;
    mkdirSync(dirname(`${dir}/${path}`), { recursive: true });
    writeFileSync(`${dir}/${path}`, content);
  }
}

// Cumulative, human-readable report — every message regenerates it from the
// whole session, so the file on disk always reflects the project's current
// measured state, not the last message's slice of it.
export function buildReport(session) {
  const lines = [
    `# code-longform session report`,
    ``,
    `request: ${session.request}`,
    `model: ${session.model} · files: ${session.files.length} · messages: ${session.messages.length}`,
    ``,
    `## Message history`,
    ``,
    ...session.messages.map((m) => `- **${m.kind}** (${m.at}): ${m.message}`),
    ``,
    `## Shared vocabulary (canonical names, decided at plan time)`,
    ``,
    ...(session.sharedVocabulary.length
      ? session.sharedVocabulary.map((v) => `- ${v.kind}="${v.name}" — ${v.meaning}`)
      : ["- none declared"]),
    ``,
    `## Files`,
    ``,
    ...session.files.map((f) => `- ${f.path} (${f.language}) — requires: ${(f.requires ?? []).join(", ") || "none"}`),
    ``,
    `## Syntax verification`,
    ``,
    ...(session.verifications.length
      ? session.verifications.map((v) => `- ${v.path}: ${v.syntaxOk ? "OK" : `FAILED — ${v.syntaxReason}`}`)
      : ["- none"]),
    ``,
    `## Cross-file continuity`,
    ``,
    ...(session.continuityFlags.length
      ? session.continuityFlags.map((f) =>
          f.resolved
            ? `- ${f.path}: CORRECTED after ${f.attempts} attempt(s)${f.escalated ? " + structural escalation" : ""}`
            : `- ${f.file}: references undeclared ${f.kind === "undeclared-id" ? "id" : "class"} "${f.ref}" (unresolved after ${f.attempts} attempt(s))`,
        )
      : ["- none flagged — every reference resolves to something the HTML actually declares"]),
    ``,
    `## Asset gaps`,
    ``,
    ...(session.assetGaps.length
      ? session.assetGaps.map((g) => `- ${g.path} (referenced by ${g.referencedBy}) — not html/css/js, cannot be authored here`)
      : ["- none"]),
    ``,
  ];
  return lines.join("\n");
}

function sessionStatePrompt(session, message) {
  const contents = readContents(session.dir, session.files);
  const interfaces = session.files
    .filter((f) => contents[f.path] != null)
    .map((f) => extractInterface(f.path, contents[f.path]))
    .map((i) => `- ${i.path}: ids: ${i.ids.join(", ") || "—"}; classes: ${i.classes.join(", ") || "—"}; functions: ${i.fns.join(", ") || "—"}`);

  const unresolved = session.continuityFlags.filter((f) => !f.resolved);
  const vocab = session.sharedVocabulary.length
    ? session.sharedVocabulary.map((v) => `- ${v.kind}="${v.name}" — ${v.meaning}`).join("\n")
    : "- none";

  return {
    interfaces,
    text: `PROJECT: ${session.request}

EXISTING FILES:
${session.files.map((f) => `- ${f.path} (${f.language})${(f.requires ?? []).length ? ` — requires: ${f.requires.join(", ")}` : ""}`).join("\n")}

SHARED VOCABULARY — canonical identifiers every file uses EXACTLY as declared, never a different name:
${vocab}

WHAT EACH EXISTING FILE DECLARES (reference only these names):
${interfaces.join("\n") || "- (no files readable yet)"}

MEASURED STATE OF THE LAST BUILD:
- syntax verification: ${session.verifications.map((v) => `${v.path}: ${v.syntaxOk ? "ok" : `FAILED — ${v.syntaxReason}`}`).join("; ") || "none recorded"}
- unresolved cross-file references: ${unresolved.map((f) => `${f.file}: ${f.kind.replace("undeclared-", "")} "${f.ref}"`).join("; ") || "none"}
- asset gaps: ${session.assetGaps.map((g) => `${g.path} (referenced by ${g.referencedBy})`).join("; ") || "none"}

THE USER NOW SAYS: ${message}`,
  };
}

/**
 * The revision plan step — one model call that decides the SMALLEST additive
 * change satisfying the new message, handed the session's measured record so
 * it learns from what the last message actually left behind (unresolved
 * references, failed verifications, gaps) instead of guessing from scratch.
 */

// code-longform's parseJSON is array-FIRST (it answers bare-array responses);
// a revision plan is always an OBJECT, and with exactly one array field
// ("actions") the array-first regex matches that array and returns it whole,
// losing the object. Object-first is the same order svg-longform's local
// parseJSON already uses for a multi-array plan object.
function parseRevisionPlan(text) {
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch {}
  }
  return parseJSON(text);
}

async function planRevision(model, session, message, seed) {
  const { text } = sessionStatePrompt(session, message);
  const prompt = `${text}

Respond with a JSON OBJECT with one field:
"actions": an array of revision actions, ordered so dependencies come first:
- {"op":"patch","path":"<an existing file path from the list above>","description":"what to add or change in this file, 1-2 sentences"} — modify an existing file ADDITIVELY (keep every id, class, element, and function that exists today)
- {"op":"add","path":"<a new file path>","language":"html|css|js","description":"what this new file must contain, 2-3 sentences"} — a brand-new file

Prefer patching existing files. Only add a file when a genuinely new concern needs its own home. If the user's message names a defect from the measured state, the actions must address it. Return ONLY the JSON object, nothing else.`;
  const system = "You are a precise software architect working on an existing project. Always respond with valid JSON and nothing else.";
  const response = await callModel(model, [{ role: "system", content: system }, { role: "user", content: prompt }], 1400, { seed });
  const parsed = parseRevisionPlan(response);
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : null;
  if (!actions || !actions.length) {
    throw new Error(`code-longform-session: revision plan parsing failed. Model returned:\n${response.slice(0, 400)}`);
  }
  return actions;
}

/**
 * Patch ONE existing file — additive, verified, and honestly discarded on
 * failure: if the rewritten file fails its own syntax check and one correction
 * attempt does not fix it, the previous verified version is kept and the
 * failure is recorded rather than a broken edit silently standing on top of
 * stable ground (the same discard discipline as code-longform's escalation
 * patch).
 */
export async function patchFileStable({ session, path, description, message, model, seed, progress, verifications, continuityFlags, discoveryLog, assetGaps }) {
  const file = session.files.find((f) => f.path === path);
  if (!file) {
    progress(`  PATCH SKIPPED: "${path}" is not an existing file in this project`);
    return { ok: false, reason: `no such file "${path}"` };
  }
  const contents = readContents(session.dir, session.files);
  const original = contents[path];
  if (original == null) {
    progress(`  PATCH SKIPPED: "${path}" exists on disk but could not be read`);
    return { ok: false, reason: `cannot read "${path}"` };
  }

  const others = session.files
    .filter((f) => f.path !== path && contents[f.path] != null)
    .map((f) => extractInterface(f.path, contents[f.path]));
  const vocab = session.sharedVocabulary.length
    ? session.sharedVocabulary.map((v) => `- ${v.kind}="${v.name}" — ${v.meaning}`).join("\n")
    : "- none";
  const othersText = others.map((i) => `- ${i.path}: ids: ${i.ids.join(", ") || "—"}; classes: ${i.classes.join(", ") || "—"}; functions: ${i.fns.join(", ") || "—"}`).join("\n") || "- none";

  const prompt = `Here is the current content of ${path} (${file.language}):
"""
${original}
"""

PROJECT: ${session.request}

SHARED VOCABULARY — canonical identifiers, use these EXACT names, never a different one:
${vocab}

WHAT OTHER EXISTING FILES DECLARE (reference only these names):
${othersText}

REVISION INSTRUCTION: ${description}

THE USER'S MESSAGE: ${message}

Rewrite this file to satisfy the instruction. ADDITIVE: keep every id, class, element, and function that exists today — other files may reference them exactly as they are. You may add new elements and change content and styles, but never remove or rename a declared id/class/function unless the instruction explicitly demands it. Raw file content only, no commentary.`;
  const system = "You are a senior web developer editing an existing, working file. Output raw file content only — never markdown fences, never commentary.";

  progress(`patching ${path} (${file.language})...`);
  const t0 = Date.now();
  let content = stripFences(await callModel(model, [{ role: "system", content: system }, { role: "user", content: prompt }], FILE_TOKENS, { seed: seed + 100 }));
  progress(`  ${path}: ${content.split("\n").length} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const syntax = verifySyntax(file.language, content);
  if (!syntax.ok) {
    // One honest correction attempt; failure is recorded, not papered over.
    progress(`  ${path}: patch FAILED syntax check (${syntax.reason}) — one correction attempt`);
    const fixPrompt = `Here is a file you just rewrote (${path}):
"""
${content}
"""

It contains a syntax error: ${syntax.reason}

SHARED VOCABULARY — canonical identifiers, use these EXACT names, never a different one:
${vocab}

Rewrite the ENTIRE file correctly, keeping the intended change and everything else identical. Raw file content only, no commentary.`;
    content = stripFences(await callModel(model, [{ role: "system", content: system }, { role: "user", content: fixPrompt }], FILE_TOKENS, { seed: seed + 200 + path.length }));
    const resyntax = verifySyntax(file.language, content);
    if (!resyntax.ok) {
      progress(`  ${path}: patch STILL broken after correction (${resyntax.reason}) — the previous verified version is kept, the broken edit is discarded`);
      setVerificationEntry(verifications, path, file.language, { ok: false, reason: `patch discarded — ${resyntax.reason}` });
      return { ok: false, reason: `patch failed syntax check twice — original kept` };
    }
  }

  // Continuity: the patched file must not reference an id/class no HTML
  // declares — the same check the pipeline runs on every new file.
  let flags = checkCrossFileReferences(session.files, { ...contents, [path]: content }).filter((fl) => fl.file === path);
  let attempts = 0;
  while (flags.length > 0 && attempts < MAX_CONTINUITY_REVISIONS) {
    attempts += 1;
    progress(`  ${path}: ${flags.length} undeclared reference(s), attempting correction ${attempts}/${MAX_CONTINUITY_REVISIONS}...`);
    const fixPrompt = buildFixPrompt(file, content, flags, session.sharedVocabulary);
    content = stripFences(await callModel(model, [{ role: "system", content: system }, { role: "user", content: fixPrompt }], FILE_TOKENS, { seed: seed + 300 + path.length + attempts }));
    flags = checkCrossFileReferences(session.files, { ...contents, [path]: content }).filter((fl) => fl.file === path);
  }
  if (attempts > 0 && flags.length === 0) {
    progress(`  ${path}: cross-file references CORRECTED after ${attempts} attempt(s)`);
    continuityFlags.push({ path, resolved: true, attempts, message });
  }
  for (const fl of flags) {
    progress(`  CONTINUITY FLAG (unresolved after ${attempts} attempt(s)): ${path} references undeclared ${fl.kind === "undeclared-id" ? "id" : "class"} "${fl.ref}"`);
    continuityFlags.push({ ...fl, message });
  }

  setVerificationEntry(verifications, path, file.language, { ok: true });

  // The patched content may reference a file nobody planned — discovered
  // mechanically, never guessed.
  const { discovered, gaps } = discoverReferencedFiles(path, file.language, content, new Set(session.files.map((f) => f.path)));
  for (const d of discovered) {
    progress(`  DISCOVERED (from ${path}): ${d.path} — will be written after this batch`);
    discoveryLog.push({ path: d.path, discoveredFrom: path, message });
  }
  for (const g of gaps) {
    assetGaps.push(g);
    progress(`  ASSET GAP: ${path} references "${g.path}" — not html/css/js, cannot be authored here, reported rather than silently skipped`);
  }

  mkdirSync(dirname(`${session.dir}/${path}`), { recursive: true });
  writeFileSync(`${session.dir}/${path}`, content);
  progress(`  ${path}: patch applied`);
  return { ok: true, content, discovered };
}

function setVerificationEntry(verifications, path, language, result) {
  const existing = verifications.find((v) => v.path === path);
  if (existing) {
    existing.syntaxOk = result.ok;
    existing.syntaxReason = result.reason ?? null;
  } else {
    verifications.push({ path, language, syntaxOk: result.ok, syntaxReason: result.reason ?? null });
  }
}

/**
 * Add ONE brand-new file to an existing project, with the FULL stable-sub-
 * assembly discipline — writeFileStable is the exact same mechanism
 * code-longform.js's build loop uses, not a second implementation.
 */
async function addFileStable({ session, action, message, model, seed, progress, verifications, continuityFlags, discoveryLog, assetGaps, fileNumber }) {
  const file = { path: action.path, language: action.language, description: action.description, requires: [] };
  if (session.files.some((f) => f.path === file.path)) {
    progress(`  ADD SKIPPED: "${file.path}" already exists`);
    return { ok: false, reason: `"${file.path}" already exists` };
  }
  session.files.push(file);
  const contents = readContents(session.dir, session.files);
  // A CSS/JS file styling or scripting the app depends on the app's HTML —
  // needed for escalation to know which earlier file to patch additively.
  file.requires = session.files.filter((f) => f.language === "html").map((f) => f.path);
  const content = await writeFileStable({
    file, request: session.request, files: session.files, contents, sharedVocabulary: session.sharedVocabulary,
    model, seed, progress, verifications, continuityFlags, discoveryLog, assetGaps,
    fileNumber: fileNumber + 1000,
  });
  mkdirSync(dirname(`${session.dir}/${file.path}`), { recursive: true });
  writeFileSync(`${session.dir}/${file.path}`, content);
  progress(`  ${file.path}: added (message: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""})`);
  return { ok: true, content, path: file.path };
}

function newSession(request, model) {
  return {
    version: 1,
    dir: null, // filled at save time — the files and SESSION.json live here
    request,
    model,
    createdAt: new Date().toISOString(),
    sharedVocabulary: [],
    files: [],
    verifications: [],
    continuityFlags: [],
    discoveryLog: [],
    assetGaps: [],
    messages: [],
  };
}

/**
 * The entry point every message uses. First call on a directory plans and
 * builds the project from scratch (writeProject — unchanged). Every later call
 * reads the persisted session and runs a REVISION: one plan call handed the
 * measured record, then patch/add actions applied with the same verify →
 * correct → escalate discipline, then the cumulative state written back.
 */
export async function runSessionMessage({ dir, request, model = "llama3.2:latest", onProgress = null }) {
  const progress = onProgress || ((msg) => console.log(msg));
  mkdirSync(dir, { recursive: true });

  const existing = loadSession(dir);
  if (!existing) {
    progress(`no prior build in ${dir} — planning a fresh multi-file build`);
    const result = await writeProject(request, { model, outDir: dir, onProgress: progress });
    const session = newSession(request, model);
    session.dir = dir;
    session.sharedVocabulary = result.sharedVocabulary ?? [];
    session.files = result.files;
    session.verifications = result.verifications;
    session.continuityFlags = result.continuityFlags;
    session.discoveryLog = result.discoveryLog;
    session.assetGaps = result.assetGaps;
    session.messages.push({
      kind: "build", message: request, at: new Date().toISOString(),
      summary: `built ${result.files.length} file(s); ${result.verifications.filter((v) => !v.syntaxOk).length} verification failure(s); ${result.continuityFlags.filter((f) => !f.resolved).length} unresolved reference(s); ${result.assetGaps.length} asset gap(s)`,
    });
    saveSession(dir, session);
    writeFileSync(`${dir}/${REPORT_FILE}`, buildReport(session));
    return { kind: "build", session };
  }

  // REVISION — the session exists, so this message continues it.
  const session = existing;
  session.dir = dir;
  session.model = model;
  progress(`session found (${session.files.length} file(s), ${session.messages.length} prior message(s)) — planning a revision for: ${request}`);
  progress(`measured state from last build: ${session.verifications.filter((v) => !v.syntaxOk).length} verification failure(s), ${session.continuityFlags.filter((f) => !f.resolved).length} unresolved reference(s), ${session.assetGaps.length} asset gap(s)`);

  const seed = Date.now() % 100000;
  const actions = await planRevision(model, session, request, seed);
  progress(`revision plan: ${actions.map((a) => `${a.op} ${a.path}`).join(", ")}`);

  const applied = [];
  const pendingAdds = [];
  const done = new Set();
  const messageIndex = session.messages.length + 1;

  for (const action of actions) {
    if (action.op === "patch") {
      const r = await patchFileStable({
        session, path: action.path, description: action.description || action.op,
        message: request, model, seed: seed + messageIndex * 31, progress,
        verifications: session.verifications, continuityFlags: session.continuityFlags,
        discoveryLog: session.discoveryLog, assetGaps: session.assetGaps,
      });
      applied.push({ ...action, ok: r.ok, reason: r.reason || null });
      if (r.ok && r.discovered) pendingAdds.push(...r.discovered);
      done.add(action.path);
    } else if (action.op === "add") {
      const r = await addFileStable({
        session, action, message: request, model, seed: seed + messageIndex * 31, progress,
        verifications: session.verifications, continuityFlags: session.continuityFlags,
        discoveryLog: session.discoveryLog, assetGaps: session.assetGaps,
        fileNumber: messageIndex * 10,
      });
      applied.push({ ...action, ok: r.ok, reason: r.reason || null });
      done.add(action.path);
    } else {
      progress(`  SKIPPED unknown action op "${action.op}"`);
    }
  }

  // THE PLAN GROWS: files discovered from what was written (a patch adding a
  // <script src> to an unplanned path) are written now — bounded.
  let extra = 0;
  while (pendingAdds.length && extra < MAX_FILES_PER_MESSAGE) {
    const d = pendingAdds.shift();
    if (done.has(d.path)) continue;
    const r = await addFileStable({
      session, action: d, message: request, model, seed: seed + 700 + extra * 7, progress,
      verifications: session.verifications, continuityFlags: session.continuityFlags,
      discoveryLog: session.discoveryLog, assetGaps: session.assetGaps,
      fileNumber: messageIndex * 10 + extra + 1,
    });
    applied.push({ op: "add", ...d, ok: r.ok, reason: r.reason || null });
    done.add(d.path);
    extra += 1;
  }

  // Cumulative residual: what is STILL unresolved across the whole project
  // after this message, so the next message is handed the honest remainder.
  const contents = readContents(session.dir, session.files);
  const finalFlags = checkCrossFileReferences(session.files, contents);
  const finalUnresolved = finalFlags.map((f) => ({ ...f, resolved: false, attempts: MAX_CONTINUITY_REVISIONS, message: request }));
  // Re-verify every file from disk — a patch or discovery may have disturbed
  // an earlier file, and the report must reflect what is on disk, not memory.
  for (const f of session.files) {
    if (contents[f.path] == null) continue;
    setVerificationEntry(session.verifications, f.path, f.language, verifySyntax(f.language, contents[f.path]));
  }

  session.messages.push({
    kind: "revision", message: request, at: new Date().toISOString(), actions: applied,
    summary: `${applied.length} action(s); ${applied.filter((a) => a.ok).length} applied, ${applied.filter((a) => !a.ok).length} skipped; ${finalUnresolved.length} unresolved reference(s) remain`,
  });
  if (finalUnresolved.length) session.continuityFlags.push(...finalUnresolved);

  saveSession(dir, session);
  writeFileSync(`${dir}/${REPORT_FILE}`, buildReport(session));
  progress(`revision complete: ${applied.filter((a) => a.ok).length}/${applied.length} action(s) applied, ${finalUnresolved.length} unresolved reference(s) remain across ${session.files.length} file(s)`);

  return { kind: "revision", session, applied, finalUnresolved };
}
