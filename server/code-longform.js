// eochat/server · code-longform — the SAME task-log.js spine, one level more
// general than narrative-longform.js: instead of a hand-authored world
// (declared entities and commitments), the plan itself is discovered from a
// raw request, reusing holonic-task.js's already-proven decomposition
// prompt rather than inventing a second one. The output is FILES, not prose.
//
// ── WHAT'S REUSED, NAMED EXPLICITLY ─────────────────────────────────────────
//
//   task-log.js            unmodified — createTaskLog/append/projectTasks/
//                          foldToWorkingSet. Fourth domain this exact spine
//                          drives (music, essays, fiction, now code).
//   holonic-task.js's plan()  prompt shape (JSON array of {id, label,
//                          description}) reused for file decomposition
//                          rather than re-invented — see planFiles below.
//   narrative-longform.js's shape  a legality state machine deciding what's
//                          allowed next from existence-dependency, mechanical
//                          verification never trusting the model's say-so,
//                          and a continuity residual that locks a fact the
//                          first time it's declared and flags contradictions.
//
// ── WHAT'S GENUINELY NEW ─────────────────────────────────────────────────────
//
// The PLAN is discovered, not declared — narrative-longform.js's world
// object is hand-authored per story; here one model call decomposes an
// arbitrary request into files. This is legitimate generation (a candidate
// structure proposed, per specs/composition-is-retrieval.md), not derivation
// of a material fact (II.2) — nothing here claims to have discovered a
// pre-existing truth about the request, only proposed one reasonable
// decomposition of it.
//
// VERIFICATION is stronger than fiction's keyword matching where the medium
// allows it: JS gets a REAL syntax check (`new Function`, throws on invalid
// syntax) rather than a fuzzy heuristic. HTML/CSS get honestly weaker
// well-formedness checks — there is no cheap real parser for either here,
// and the header says so rather than pretending a brace-balance count is a
// validator.
//
// The CONTINUITY check is the exact fiction mechanism (checkContinuity /
// checkNumericLocks), applied to code instead of prose: HTML DECLARES ids
// and classes; CSS and JS REFERENCE them. A CSS selector or a JS DOM lookup
// naming something the HTML never declared is the code-domain instance of
// "the logbook was washed up, then later found in the attic" — a later file
// contradicting a fact an earlier one established, caught mechanically
// rather than by reading every file by hand.
//
// Placement: this file calls a model (Ollama) and writes to the filesystem —
// both are I.4 application concerns. It imports only the pure spine from
// task-log.js.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createTaskLog, append, projectTasks, foldToWorkingSet,
  proposeDiscovered, checkCubeProgression, ENTRY_KINDS, OPERATOR_BASIS,
} from "./task-log.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const TEMPERATURE = 0.6; // lower than fiction's 0.75 — code correctness rewards less variance than prose voice does
export const FILE_TOKENS = 900;
export const WORKING_SET_K = 7; // the same declared mouth-budget as every other domain this spine drives
const MAX_FILES_GUARD = 20;
export const MAX_CONTINUITY_REVISIONS = 2;
// MEASURED: a real run left 12 of 13 CSS class references unresolved after
// 2 correction attempts — not a typo, a genuinely different page structure
// than the HTML delivered (.container/.header/.services/.form/.nav vs. an
// HTML that only ever declared 3 ids). This many or more DISTINCT
// references surviving correction is the declared, quantifiable signal
// that the mismatch is structural rather than a stray wrong name — the
// line between "ask the later file to adapt" and "the earlier file was
// under-built relative to what actually depends on it".
export const STRUCTURAL_MISMATCH_THRESHOLD = 3;
export const MAX_STRUCTURAL_ESCALATIONS = 1; // bounded — a correction pass, not a planner that loops until satisfied (holonic-task.js's replan() precedent)

export async function callModel(model, messages, maxTokens, { seed = 0 } = {}) {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: TEMPERATURE, num_predict: maxTokens, seed } }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.message?.content || "").trim();
}

// The same lazy-then-balanced JSON extraction holonic-task.js already
// established, reused rather than re-invented — see its own header comment
// on why the balanced version exists (a non-greedy regex truncates on the
// first "]", which may belong to a NESTED array).
// Same dual-shape extraction holonic-task.js's own _parseJSON already
// performs (array first, object second) — reused because the plan now
// returns an OBJECT ({sharedVocabulary, files}), not a bare array.
export function parseJSON(text) {
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch {}
  }
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch {}
  }
  return null;
}

/**
 * The plan step. Reuses holonic-task.js's decomposition SHAPE (small,
 * described units) aimed at FILES instead of prose sections — AND now also
 * proposes a SHARED VOCABULARY, which is the fix for a real measured defect
 * this file-only plan did not anticipate.
 *
 * MEASURED: a real run's styles.css wanted `.services`; index.html was
 * eventually escalation-patched to add a services area, but the model
 * independently NAMED it `.services-container` — a DIFFERENT, plausible
 * name for the same concept, because nothing ever told either file what
 * the canonical name for "the services section" actually was. Detecting
 * and patching a mismatch AFTER the fact (checkCrossFileReferences,
 * escalation) is a safety net, not a fix for the root cause: two files
 * independently NAMING the same concept will drift, because naming is a
 * choice, and two independent choices are not the same choice.
 *
 * The actual fix is the one this whole session has applied to every other
 * naming problem (word order in conventions.js, coref in live_priors): a name
 * is a DECLARED, received fact, never independently re-derived by whichever
 * file happens to need it. `sharedVocabulary` is exactly that — decided
 * ONCE, here, and handed to EVERY file verbatim, so index.html and
 * styles.css are never guessing at each other's choices; they are both
 * reading from the same one.
 *
 * This does not replace checkCrossFileReferences/escalation — a model can
 * still drift from a vocabulary it was handed, the same way a model can
 * still skip a stated payoff. It replaces relying on drift-then-detect as
 * the ONLY mechanism, the same upgrade specs/composition-is-retrieval.md
 * already argues for: a declared prior first, a mechanical check second,
 * never a mechanical check standing in for a prior that was never given.
 */
export async function planFiles(model, request, seed) {
  const prompt = `You are a precise software architect. Decompose the following request into a SMALL set of files (3-6) for a working, deployable project.

REQUEST: ${request}

Respond with a JSON OBJECT with two fields:

"sharedVocabulary": an array of {"name", "kind", "meaning"} — canonical identifiers that MORE THAN ONE file will need to reference by the EXACT same name (e.g. the section that shows services, which the HTML displays, the stylesheet styles, and a script may query). Decide these ONCE here. "kind" is "id" or "class". Every file will be told to use EXACTLY these names — do not leave out anything two files both need to agree on.

"files": an array of {"path", "language", "description", "requires"}.
  - "path": the file's path, e.g. "index.html"
  - "language": one of "html", "css", "js"
  - "description": what this file must contain (2-3 sentences)
  - "requires": array of OTHER file paths (from this same list) this file depends on. HTML files usually have no requires; CSS/JS files that style or script HTML elements should require the HTML file.

Return ONLY the JSON object, nothing else.`;
  const system = "You are a precise software architect. Always respond with valid JSON and nothing else.";
  const response = await callModel(model, [{ role: "system", content: system }, { role: "user", content: prompt }], 1400, { seed });
  const parsed = parseJSON(response);
  const files = parsed?.files;
  const sharedVocabulary = Array.isArray(parsed?.sharedVocabulary) ? parsed.sharedVocabulary : [];
  if (!Array.isArray(files) || files.length < 2) {
    throw new Error(`code-longform: plan parsing failed. Model returned:\n${response.slice(0, 400)}`);
  }
  return { files, sharedVocabulary };
}

/**
 * The next legal move. Same shape as narrative-longform.js's nextMove: no
 * lookahead, existence-dependency gated, discovers when it's done rather
 * than being told a file count in advance.
 */
export function nextCodeMove(files, tasks) {
  const has = (id) => tasks.some((t) => t.task_id === id);
  for (const f of files) {
    const reqsMet = (f.requires ?? []).every((r) => has(`file:${r}`) && tasks.find((t) => t.task_id === `file:${r}`)?.written);
    if (reqsMet && !has(`file:${f.path}`)) return { kind: "write", file: f };
  }
  return { kind: "close" };
}

const GENERATABLE_EXT = { html: "html", css: "css", js: "js" };

/**
 * The plan GROWS, it is never fixed at planFiles()'s one call — the same
 * mistake write-novella.mjs's header records for fiction ("plan() commits a
 * fixed scene outline up front") would recur here in code form if the file
 * list from planFiles() were treated as final. A written HTML file may
 * reference a script, stylesheet, or image the plan never anticipated; a
 * written CSS file may reference a font or background image. Those
 * references are discovered MECHANICALLY from what was actually written —
 * never guessed upfront — the exact same move as extractNewNames()
 * discovering a character the model introduced without being asked.
 *
 * Non-generatable assets (images, fonts, anything not html/css/js) are
 * named as a TYPED GAP, never silently produced as fake text pretending to
 * be a binary file — the file is referenced, real, and simply outside what
 * a text model can be asked to author.
 */
export function discoverReferencedFiles(path, language, content, knownPaths) {
  const refs = new Set();
  if (language === "html") {
    for (const m of content.matchAll(/<script[^>]+src=["']([^"':]+)["']/g)) refs.add(m[1]);
    for (const m of content.matchAll(/<link[^>]+href=["']([^"':]+)["']/g)) refs.add(m[1]);
    for (const m of content.matchAll(/<img[^>]+src=["']([^"':]+)["']/g)) refs.add(m[1]);
    for (const m of content.matchAll(/<a[^>]+href=["']([^"':#]+\.html)["']/g)) refs.add(m[1]);
  } else if (language === "css") {
    for (const m of content.matchAll(/url\(["']?([^"')]+)["']?\)/g)) refs.add(m[1]);
  }

  const discovered = [];
  const gaps = [];
  for (const ref of refs) {
    if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("//")) continue; // external, not this project's to author
    if (knownPaths.has(ref)) continue;
    const ext = ref.split(".").pop().toLowerCase();
    if (GENERATABLE_EXT[ext]) {
      discovered.push({
        path: ref, language: GENERATABLE_EXT[ext],
        description: `Referenced by ${path} but not in the original plan — discovered from the reference itself, not guessed in advance.`,
        requires: [], discoveredFrom: path,
      });
    } else {
      gaps.push({ path: ref, referencedBy: path });
    }
  }
  return { discovered, gaps };
}

/**
 * THE MOUTH for code: a bounded summary of what earlier files already
 * declared — never the full file contents, and never growing past k
 * regardless of how many files exist. Extracted mechanically (regex over
 * ids/classes/function names), not asked of the model.
 */
export function extractInterface(path, content) {
  const ids = [...new Set([...content.matchAll(/\bid=["']([\w-]+)["']/g)].map((m) => m[1]))];
  const classes = [...new Set([...content.matchAll(/\bclass=["']([^"']+)["']/g)].flatMap((m) => m[1].split(/\s+/)))];
  const fns = [...new Set([...content.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map((m) => m[1]))];
  return { path, ids, classes, fns };
}

export function buildWritePrompt(file, request, interfaces, sharedVocabulary) {
  let p = `PROJECT: ${request}\n\n`;
  // THE DECLARED VOCABULARY comes first and is stated as non-negotiable —
  // every file reads the SAME list, decided once at plan time, rather than
  // each file guessing at a name a DIFFERENT file already chose. This is
  // what interfaces (below) cannot be: interfaces are extracted AFTER a
  // file exists, so the first file to touch a concept is still guessing.
  if (sharedVocabulary?.length) {
    p += `SHARED VOCABULARY — every file in this project uses these EXACT names. Never invent a different name for something already listed here:\n`;
    for (const v of sharedVocabulary) p += `- ${v.kind}="${v.name}" — ${v.meaning}\n`;
    p += `\n`;
  }
  if (interfaces.length) {
    p += `FILES ALREADY WRITTEN — reference these EXACTLY, do not invent different names:\n`;
    for (const i of interfaces) {
      const parts = [];
      if (i.ids.length) parts.push(`ids: ${i.ids.join(", ")}`);
      if (i.classes.length) parts.push(`classes: ${i.classes.join(", ")}`);
      if (i.fns.length) parts.push(`functions: ${i.fns.join(", ")}`);
      p += `- ${i.path}${parts.length ? " — " + parts.join("; ") : ""}\n`;
    }
    p += `\n`;
  }
  p += `NOW WRITE: ${file.path} (${file.language})\n${file.description}\n\n`;
  // MEASURED: a real run wrote `export { renderServices, renderContact };`
  // in a file linked via a plain <script src="..."> tag (not
  // type="module"), which verifySyntax's `new Function` correctly rejects —
  // import/export are only legal inside an actual ES module, and nothing
  // here declares one. Stated explicitly rather than left implicit, the
  // same "declared, not assumed" discipline as everything else this session
  // has built.
  if (file.language === "js") p += `This is a PLAIN browser script loaded via <script src="...">, NOT an ES module — do not use "import" or "export" anywhere.\n\n`;
  p += `Write ONLY the raw file content. No markdown code fences, no explanation, no commentary.`;
  return p;
}

export const SYSTEM = "You are a senior web developer writing clean, working, minimal code. Output raw file content only — never markdown fences, never commentary.";

// MEASURED: a real run's styles.css began with a stray unmatched `"""` line
// (no markdown fence, no closing quote — the model just emitted it as if
// opening a Python-style docstring instead of a code fence) before the
// actual CSS. A LATER run put the same stray `"""` at the END instead —
// confirming it's not a paired docstring wrapper being half-stripped, but
// an unpredictable one-sided marker that can land on EITHER side. Both
// ends are stripped independently, each optional, neither assumed to
// imply the other.
export const stripFences = (text) => text.replace(/^```[\w]*\n?/, "").replace(/```\s*$/, "").replace(/^"""\n?/, "").replace(/\n?"""$/, "").trim();

/**
 * Verification, honestly graded by what the medium allows. JS gets a REAL
 * syntax check. HTML/CSS get a declared, weak well-formedness heuristic —
 * stated as weak rather than dressed up as validation neither language has
 * a zero-dependency parser for here.
 */
// MEASURED: verifySyntax was only ever run on the FIRST draft of a file,
// before the continuity-correction loop (and, for HTML, before escalation)
// could rewrite its content entirely. A real run reported script.js's
// syntax check FAILED even though the version actually kept on disk — the
// one written after two correction passes — was syntactically fine. The
// verifications array is a report about what got WRITTEN, not about a draft
// that was discarded; every place content is replaced must re-verify and
// overwrite the existing entry, never leave a stale one standing.
export function setVerification(verifications, path, language, result) {
  const existing = verifications.find((v) => v.path === path);
  if (existing) {
    existing.syntaxOk = result.ok;
    existing.syntaxReason = result.reason ?? null;
  } else {
    verifications.push({ path, language, syntaxOk: result.ok, syntaxReason: result.reason ?? null });
  }
}

export function verifySyntax(language, content) {
  if (language === "js") {
    try {
      new Function(content);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  if (language === "css") {
    const open = (content.match(/{/g) ?? []).length;
    const close = (content.match(/}/g) ?? []).length;
    return open === close ? { ok: true } : { ok: false, reason: `unbalanced braces: ${open} { vs ${close} }` };
  }
  if (language === "html") {
    const hasHtml = /<html[\s>]/i.test(content);
    const hasClose = /<\/html>/i.test(content);
    return hasHtml && hasClose ? { ok: true } : { ok: false, reason: "missing <html>...</html> — this is a well-formedness floor, not a real HTML validator" };
  }
  return { ok: true };
}

/**
 * The cross-file continuity check — checkContinuity's exact mechanism
 * (a fact declared once, contradicted or ignored later), applied to code.
 * HTML declares ids/classes; a CSS selector or JS DOM lookup naming
 * something no HTML file ever declared is flagged. Declared invariant
 * discipline, same as narrative-longform.js: this does not understand CSS
 * or JS, it mechanically diffs two sets of identifiers.
 */
export function checkCrossFileReferences(files, contents) {
  const declaredIds = new Set();
  const declaredClasses = new Set();
  for (const f of files.filter((f) => f.language === "html")) {
    const c = contents[f.path];
    if (!c) continue;
    for (const m of c.matchAll(/\bid=["']([\w-]+)["']/g)) declaredIds.add(m[1]);
    for (const m of c.matchAll(/\bclass=["']([^"']+)["']/g)) m[1].split(/\s+/).forEach((cl) => declaredClasses.add(cl));
  }

  const flags = [];
  for (const f of files.filter((f) => f.language === "css")) {
    const c = contents[f.path];
    if (!c) continue;
    // MEASURED: scanning the whole file for /#([\w-]+)/ and /\.([\w-]+)/
    // flagged "333", "f9f9f9", "fff" (hex colors — #333, #f9f9f9) and "6",
    // "1" (decimal VALUES — line-height: 1.6, opacity: 0.1) as undeclared
    // ids/classes on a real generated stylesheet. A "#" or "." inside a
    // DECLARATION (between { and }, i.e. a value) is not a selector at all
    // — only the text BEFORE each "{" is. This is the CSS-domain version of
    // the same lesson seam-cost.mjs and checkNumericLocks each already
    // learned once: a naive pattern match over raw text catches the SHAPE
    // of the thing, not what it actually is in context.
    const selectors = c.match(/[^{}]+(?=\{)/g) ?? [];
    for (const sel of selectors) {
      for (const m of sel.matchAll(/#([\w-]+)/g)) if (!declaredIds.has(m[1])) flags.push({ file: f.path, kind: "undeclared-id", ref: m[1] });
      for (const m of sel.matchAll(/\.([a-zA-Z_-][\w-]*)/g)) if (!declaredClasses.has(m[1])) flags.push({ file: f.path, kind: "undeclared-class", ref: m[1] });
    }
  }
  for (const f of files.filter((f) => f.language === "js")) {
    const c = contents[f.path];
    if (!c) continue;
    for (const m of c.matchAll(/getElementById\(["']([\w-]+)["']\)/g)) if (!declaredIds.has(m[1])) flags.push({ file: f.path, kind: "undeclared-id", ref: m[1] });
    for (const m of c.matchAll(/querySelector\(["']\.([\w-]+)["']\)/g)) if (!declaredClasses.has(m[1])) flags.push({ file: f.path, kind: "undeclared-class", ref: m[1] });
  }
  return flags;
}

// MEASURED: sharedVocabulary reached buildWritePrompt (the FIRST unfold
// step) but never buildFixPrompt (every correction step after it) — the
// coalgebra was consulting a fixed, declared structure on step one and
// then guessing from scratch on every step after. A real run's CSS wrote
// `#mobileMenuToggle` (the CORRECT name, WRONG selector kind — the
// vocabulary declares it a class) and survived 2 correction attempts
// unresolved, because the fix prompt only ever said "this doesn't exist,"
// never "the vocabulary already says this is a class, not an id" — the one
// fact that would have made the fix a one-line lookup instead of a second
// guess. Every step of an unfold must read from the SAME declared
// structure, not just the first.
export function buildFixPrompt(file, content, flags, sharedVocabulary) {
  let p = `Here is a file you wrote (${file.path}):\n"""\n${content}\n"""\n\n`;
  p += `It references identifiers that do not exist in any HTML file:\n`;
  for (const f of flags) {
    const known = sharedVocabulary?.find((v) => v.name === f.ref);
    const wantedKind = f.kind === "undeclared-id" ? "an id" : "a class";
    if (known && known.kind !== (f.kind === "undeclared-id" ? "id" : "class")) {
      p += `- "${f.ref}" was used as ${wantedKind}, but the shared vocabulary declares it as a ${known.kind} — use ${known.kind === "id" ? "#" : "."}${f.ref} instead, do not invent a different name\n`;
    } else {
      p += `- "${f.ref}" (${wantedKind}) — this was never declared anywhere\n`;
    }
  }
  if (sharedVocabulary?.length) {
    p += `\nSHARED VOCABULARY — every file in this project uses these EXACT names, never a different one:\n`;
    for (const v of sharedVocabulary) p += `- ${v.kind}="${v.name}" — ${v.meaning}\n`;
  }
  p += `\nRewrite the ENTIRE file, removing or correcting these references so they only use ids/classes that are real. Keep everything else the same. Raw file content only, no commentary.`;
  return p;
}

/**
 * The escalation prompt — the fix for a STRUCTURAL mismatch rather than a
 * stray wrong name (see STRUCTURAL_MISMATCH_THRESHOLD's comment for the
 * real defect this answers). ADDITIVE ONLY, said explicitly and repeated:
 * this file may already be depended on by other, already-verified work, so
 * nothing existing may be removed or renamed — only grown. That is the
 * watchmaker discipline applied to the correction itself: even a needed
 * repair must not be allowed to destabilize a sub-assembly other work
 * already treats as finished.
 */
export function buildEscalationPrompt(htmlPath, htmlContent, missingIds, missingClasses, sharedVocabulary) {
  let p = `Here is an HTML file (${htmlPath}) that ALREADY EXISTS and that other files already depend on:\n"""\n${htmlContent}\n"""\n\n`;
  p += `A file that depends on this one needs elements with these identifiers, which do not exist yet:\n`;
  if (missingIds.length) p += `- ids: ${missingIds.join(", ")}\n`;
  if (missingClasses.length) p += `- classes: ${missingClasses.join(", ")}\n`;
  if (sharedVocabulary?.length) {
    p += `\nSHARED VOCABULARY — every file in this project uses these EXACT names; if a name above is also listed here, use the meaning below to decide where it belongs:\n`;
    for (const v of sharedVocabulary) p += `- ${v.kind}="${v.name}" — ${v.meaning}\n`;
  }
  p += `\nADD what is missing — new elements, or classes/ids added to existing ones. Do NOT remove, rename, or restructure anything already present; other files may depend on it exactly as it is. Return the FULL, complete file. Raw file content only, no commentary.`;
  return p;
}

/**
 * Write ONE file with the full stable-sub-assembly discipline: verify,
 * continuity-correct, escalate — all BEFORE the file is ever treated as
 * established ground by anything written after it.
 *
 * Extracted from writeProject's loop (rather than duplicated) so the SAME
 * exact mechanism — not a re-implementation that can drift — is reused by
 * code-longform-session.js when a revision message ADDS a new file to an
 * existing project. Every mutation lands on the caller's live collections:
 * `files`/`contents` grow (THE PLAN GROWS), `verifications`/
 * `continuityFlags`/`discoveryLog`/`assetGaps` accumulate the measured
 * record. `fileNumber` keeps the seed family unique per file the same way
 * the original loop's `fileCount` did.
 *
 * Returns the final, stable content for the file.
 */
export async function writeFileStable({ file, request, files, contents, sharedVocabulary, model, seed, progress, verifications, continuityFlags, discoveryLog, assetGaps, fileNumber = 1 }) {
  const written = files.filter((f) => contents[f.path]).map((f) => extractInterface(f.path, contents[f.path]));
  // THE MOUTH, reused exactly: bounded regardless of how many files exist.
  const { working } = foldToWorkingSet(
    written.map((i) => ({ task_id: `file:${i.path}`, ...i })),
    { k: WORKING_SET_K, score: () => 0 },
  );

  const prompt = buildWritePrompt(file, request, working, sharedVocabulary);
  progress(`writing ${file.path} (${file.language})...`);
  const t0 = Date.now();
  let content = stripFences(await callModel(model, [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], FILE_TOKENS, { seed: seed + fileNumber }));
  progress(`  ${file.path}: ${content.split("\n").length} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const syntax = verifySyntax(file.language, content);
  if (!syntax.ok) progress(`  SYNTAX CHECK FAILED (${file.language}): ${syntax.reason}`);
  setVerification(verifications, file.path, file.language, syntax);

  // STABLE SUB-ASSEMBLY DISCIPLINE: verify AND continuity-correct THIS
  // file NOW, before it is ever relied upon by anything written after it.
  // The first version of this function deferred cross-file continuity to
  // one pass after every file already existed — Tempus's mistake exactly:
  // by the time a problem surfaced, several later files had already been
  // built on the same unverified ground, and fixing one file in isolation
  // could no longer see what state the "stable" fact was actually in when
  // each dependent was written. Checking immediately, file by file, is
  // what narrative-longform.js already does correctly for scenes; this
  // brings code-longform.js in line with it rather than a design that
  // happened to diverge from the pattern already proven to work.
  if (file.language !== "html") {
    let flags = checkCrossFileReferences(files, { ...contents, [file.path]: content }).filter((fl) => fl.file === file.path);
    let attempts = 0;
    while (flags.length > 0 && attempts < MAX_CONTINUITY_REVISIONS) {
      attempts += 1;
      progress(`  ${file.path}: ${flags.length} undeclared reference(s), attempting correction ${attempts}/${MAX_CONTINUITY_REVISIONS}...`);
      const fixPrompt = buildFixPrompt(file, content, flags, sharedVocabulary);
      content = stripFences(await callModel(model, [{ role: "system", content: SYSTEM }, { role: "user", content: fixPrompt }], FILE_TOKENS, { seed: seed + 1000 + fileNumber * 10 + attempts }));
      flags = checkCrossFileReferences(files, { ...contents, [file.path]: content }).filter((fl) => fl.file === file.path);
    }
    // The correction call rewrote `content` wholesale — re-verify THIS
    // version, not the discarded draft the syntax check above already
    // reported on.
    if (attempts > 0) {
      const resyntax = verifySyntax(file.language, content);
      if (!resyntax.ok) progress(`  SYNTAX CHECK FAILED (${file.language}, after correction): ${resyntax.reason}`);
      setVerification(verifications, file.path, file.language, resyntax);
    }

    // ESCALATION: more than STRUCTURAL_MISMATCH_THRESHOLD distinct
    // references still unresolved after the normal correction attempts is
    // the measured signal that this is a structural mismatch, not a
    // stray wrong name (see that constant's own comment for the real run
    // that established it). Patch the EARLIER, already-"stable" HTML
    // file instead of continuing to ask the LATER file to adapt to a
    // structure that was never really there — additive only, so nothing
    // already verified against the HTML is put at risk.
    let escalated = false;
    const distinctRefs = new Set(flags.map((f) => f.ref));
    if (distinctRefs.size >= STRUCTURAL_MISMATCH_THRESHOLD) {
      const htmlDeps = (file.requires ?? []).filter((r) => files.find((ff) => ff.path === r)?.language === "html" && contents[r]);
      for (let esc = 0; esc < MAX_STRUCTURAL_ESCALATIONS && htmlDeps.length > 0 && flags.length > 0; esc++) {
        const htmlPath = htmlDeps[0];
        const missingIds = flags.filter((f) => f.kind === "undeclared-id").map((f) => f.ref);
        const missingClasses = flags.filter((f) => f.kind === "undeclared-class").map((f) => f.ref);
        progress(`  ${file.path}: ${distinctRefs.size} distinct undeclared references exceed the structural-mismatch threshold (${STRUCTURAL_MISMATCH_THRESHOLD}) — escalating to patch ${htmlPath} additively`);
        const escalationPrompt = buildEscalationPrompt(htmlPath, contents[htmlPath], missingIds, missingClasses, sharedVocabulary);
        const patchedHtml = stripFences(await callModel(model, [{ role: "system", content: SYSTEM }, { role: "user", content: escalationPrompt }], FILE_TOKENS, { seed: seed + 2000 + fileNumber * 10 + esc }));
        const htmlSyntax = verifySyntax("html", patchedHtml);
        if (htmlSyntax.ok) {
          contents[htmlPath] = patchedHtml;
          setVerification(verifications, htmlPath, "html", htmlSyntax); // the earlier file's OWN verification entry, stale the moment its content is actually replaced here — never touched when the patch is discarded below
          escalated = true;
          flags = checkCrossFileReferences(files, { ...contents, [file.path]: content }).filter((fl) => fl.file === file.path);
          progress(`  ${htmlPath}: patched — ${flags.length} reference(s) remain unresolved in ${file.path} after escalation`);
        } else {
          progress(`  ${htmlPath}: escalation patch FAILED its own syntax check (${htmlSyntax.reason}) — the original file is kept, not a broken one`);
        }
      }
    }

    if ((attempts > 0 || escalated) && flags.length === 0) {
      progress(`  ${file.path}: cross-file references CORRECTED after ${attempts} attempt(s)${escalated ? " + structural escalation" : ""}`);
      continuityFlags.push({ path: file.path, resolved: true, attempts, escalated });
    }
    for (const fl of flags) {
      progress(`  CONTINUITY FLAG (unresolved after ${attempts} attempt(s)): ${file.path} references undeclared ${fl.kind === "undeclared-id" ? "id" : "class"} "${fl.ref}"`);
      continuityFlags.push({ ...fl, resolved: false, attempts });
    }
  }

  // NOW the file is stable — this is the content everything written after
  // it will see, both as "established" ground (extractInterface, THE
  // MOUTH) and as a dependency other files are legally allowed to require.
  contents[file.path] = content;

  // THE PLAN GROWS: a reference to a file nobody planned is discovered
  // from what was ACTUALLY written, mechanically, never guessed in
  // advance — the exact same move as extractNewNames() discovering a
  // character the model introduced unasked. A new sub-assembly is ADDED;
  // nothing already stable is reopened to make room for it.
  const { discovered, gaps } = discoverReferencedFiles(file.path, file.language, content, new Set(files.map((f) => f.path)));
  for (const d of discovered) {
    files.push(d);
    discoveryLog.push({ path: d.path, discoveredFrom: file.path });
    progress(`  DISCOVERED: ${d.path} (referenced by ${file.path}, not in the original plan) — added to the build`);
  }
  for (const g of gaps) {
    assetGaps.push(g);
    progress(`  ASSET GAP: ${file.path} references "${g.path}" — not html/css/js, cannot be authored here, reported rather than silently skipped`);
  }

  return content;
}

/**
 * Drive the plan to closure. No fixed file count declared anywhere —
 * nextCodeMove decides one file at a time from what already exists.
 */
export async function writeProject(request, { model = "llama3.2:latest", outDir, seed = 20260801, onProgress = null, maxFiles = MAX_FILES_GUARD } = {}) {
  const progress = onProgress || ((msg) => console.log(msg));
  mkdirSync(outDir, { recursive: true });

  progress(`planning files for: ${request}`);
  // let, not const: THE PLAN GROWS. See discoverReferencedFiles below — this
  // is the fix for "what if we learn mid-build that more files are needed
  // than the first plan anticipated", and it is the same principle as
  // Simon's watchmaker parable: Hora built from stable ten-part
  // sub-assemblies that held together the moment they were finished, so a
  // missed piece became one small NEW sub-assembly to add, never a reason
  // to reopen finished work; Tempus built one continuous thousand-part
  // assembly that collapsed completely on any interruption. A fixed file
  // list decided once, up front, is Tempus's watch.
  let { files, sharedVocabulary } = await planFiles(model, request, seed);
  progress(`planned ${files.length} files: ${files.map((f) => f.path).join(", ")}`);
  if (sharedVocabulary.length) progress(`shared vocabulary: ${sharedVocabulary.map((v) => `${v.kind}="${v.name}"`).join(", ")}`);

  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "project", description: request });

  const contents = {};
  const verifications = [];
  const continuityFlags = [];
  const discoveryLog = [];
  const assetGaps = [];
  let fileCount = 0;

  while (fileCount < maxFiles) {
    const tasks = projectTasks(log);
    let move = nextCodeMove(files, tasks);
    if (move.kind === "close") {
      // MEASURED (real run): a plan came back with a CYCLIC requires graph —
      // index.html required the css and js that each required index.html back.
      // Existence-dependency gating then returns "close" with ZERO files
      // written: every file waits on one that can never go first. A plan with
      // no legal first move must not silently write nothing — `requires` is
      // the model's ordering INTENT, not a hard gate that may deadlock. Break
      // the cycle by writing the next unwritten file in plan order; the
      // remaining files then satisfy their dependencies normally.
      const unwritten = files.filter((f) => !tasks.some((t) => t.task_id === `file:${f.path}`));
      if (unwritten.length === 0) break;
      move = { kind: "write", file: unwritten[0] };
      progress(`  plan cycle detected (${unwritten.length} file(s) waiting on each other): writing ${unwritten[0].path} first — requires is an ordering hint, not a deadlock gate`);
    }

    fileCount += 1;
    const file = move.file;
    await writeFileStable({ file, request, files, contents, sharedVocabulary, model, seed, progress, verifications, continuityFlags, discoveryLog, assetGaps, fileNumber: fileCount });

    // "Entities are entities": the SAME registration primitive
    // narrative-longform.js uses for a character the model introduces
    // unasked (task-log.js's proposeDiscovered) — a file entering the build,
    // whether from the original plan or discovered mid-build from a real
    // reference (discoverReferencedFiles above), resolves to the identical
    // cube cell (SEG, Figure) a discovered character does. Both planned and
    // discovered files pass through this one call site, so no separate
    // "discovery" tagging is needed here the way narrative-longform.js needs
    // one — discoverReferencedFiles already queues discovered files into
    // `files` above; every file, planned or discovered, is registered here.
    log = proposeDiscovered(log, [{
      task_id: `file:${file.path}`, description: file.description,
      depends_on: ["project"], written: true, language: file.language,
    }]);
  }

  // MEASURED: a real plan named "js/script.js" — a nested path — and this
  // loop crashed with ENOENT because only outDir itself was ever created.
  // The model is free to propose a directory structure; the writer has to
  // honor whatever structure it proposed, not assume every file is flat.
  for (const [path, content] of Object.entries(contents)) {
    mkdirSync(dirname(`${outDir}/${path}`), { recursive: true });
    writeFileSync(`${outDir}/${path}`, content);
  }

  // sharedVocabulary is handed back so a sessionful caller can persist the
  // canonical names — decided ONCE at plan time — across messages instead of
  // re-deciding them per message (see code-longform-session.js).
  // Advisory only, same as the continuity checks above: reports whether any
  // single file's own thread coarsened its cube grain or ran its operator
  // backward — never blocks the build. See task-log.js's checkCubeProgression.
  const cubeFlags = checkCubeProgression(log);

  return { log, files, contents, sharedVocabulary, verifications, continuityFlags, cubeFlags, discoveryLog, assetGaps, outDir };
}
