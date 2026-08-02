// eochat/server · svg-longform — the SAME task-log.js spine as
// narrative-longform.js (fiction), predictive-longform.js (numeric
// prediction), and code-longform.js (multi-file code), now driving a THIRD
// genuinely distinct modality: a vector diagram, not prose and not source
// code. Output is one SVG document, built incrementally element by element.
//
// ── WHAT'S REUSED, NAMED EXPLICITLY ─────────────────────────────────────────
//
//   task-log.js                unmodified — createTaskLog/append/
//                               projectTasks/foldToWorkingSet.
//   code-longform.js's shape    plan → next-legal-move → write → verify →
//                               correct, and its sharedVocabulary discipline
//                               (a name decided ONCE at plan time, read
//                               verbatim by every write AND every
//                               correction — code-longform only learned to
//                               thread it into corrections after a real run
//                               showed the gap; here it's threaded in from
//                               the start).
//
// ── WHAT'S GENUINELY NEW ─────────────────────────────────────────────────────
//
// A diagram is ALREADY graph-shaped, so existence-dependency is not a
// metaphor borrowed from fiction or code here: an edge LITERALLY cannot
// exist without the two node ids it connects. `requires` for an edge is
// DERIVED from its own from/to fields (never trusted as a separately
// model-declared list that might drift from them — see computeRequires).
//
// LAYOUT is a shared, declared prior, exactly the way sharedVocabulary is a
// shared naming prior — a GRID CELL per node, decided ONCE at plan time.
// The pixel center of that cell is then computed by ARITHMETIC in this
// file (computeLayout), never asked of the model. This is the same lesson
// code-longform.js learned reactively (two files independently NAMING the
// same concept drift) applied PROACTIVELY here, because a diagram's version
// of that failure — two nodes silently overlapping, or an edge pointing at
// the wrong coordinate — has no mechanical "undeclared reference" signature
// to catch after the fact the way a wrong CSS class name does. Position is
// computed, not generated, from the very first run.
//
// VERIFICATION: `xmllint` (a system binary already on this machine, not an
// added dependency — checked once, lazily) gives a REAL well-formedness
// check, the SVG-domain equivalent of `new Function` for JS: it catches
// things a tag-balance heuristic cannot, like a bare `&` in text content.
// Falls back to an honest, DECLARED-weak balanced-tag heuristic if xmllint
// is not on PATH — the same "say weak rather than dress it up" choice
// code-longform.js already made for HTML/CSS.
//
// CROSS-REFERENCE CHECK: SVG's own reference grammar (`href="#id"`,
// `url(#id)` inside fill/stroke/marker-end/clip-path/filter) checked
// against declared `id="..."` attributes actually present across every
// written fragment — checkCrossFileReferences' exact mechanism, adapted to
// SVG's reference syntax instead of HTML's.
//
// MEASURED, on the first real run: asking the model to author the
// arrowhead marker as a "def" element produced a MALFORMED element (missing
// id/kind) instead — and because nothing validated per-element shape, it
// collided with a second malformed element on the SAME synthetic task_id
// "el:undefined", silently dropping one. The arrowhead is pure boilerplate
// (one small triangle) with zero real per-diagram variation, so the fix is
// the SAME move as computeLayout: stop asking the model for it at all.
// ARROWHEAD_MARKER is a fixed constant, always present in <defs>, removing
// this entire failure class rather than validating around it. Malformed
// PLAN elements more generally (missing id or an unrecognized kind) are
// still possible for node/edge/title, so those are validated and filtered
// with a reported gap — never silently collided on a shared placeholder id.
//
// DEFERRED, NOT BUILT: escalation (patching an earlier node additively) and
// mid-run discovery of new elements. code-longform.js needed both because
// text models drift on NAMES it can't fully prevent. Here, because layout
// and style are computed/declared rather than generated, the earlier
// classes of drift they existed to catch are largely designed out; adding
// them before a real run demonstrates the need would be exactly the kind of
// speculative complexity this codebase's own discipline argues against.
//
// Placement: this file calls a model (Ollama) and writes to the filesystem
// — both I.4 application concerns, same as code-longform.js. It imports
// only the pure spine from task-log.js.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskLog, append, projectTasks, foldToWorkingSet, ENTRY_KINDS } from "./task-log.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const TEMPERATURE = 0.6;
const ELEMENT_TOKENS = 500; // a single shape/marker/edge fragment, not a whole file — the mouth-sized budget this domain actually needs
const WORKING_SET_K = 7; // the same declared mouth-budget every other domain this spine drives uses
const MAX_ELEMENTS_GUARD = 30;
const MAX_CONTINUITY_REVISIONS = 2;

const CANVAS = Object.freeze({ width: 900, height: 600, padding: 40, titleHeight: 70 });
const VALID_KINDS = new Set(["node", "edge", "title"]);

// Pure boilerplate, zero real per-diagram variation — synthesized here,
// never asked of the model. See the header comment for the real defect
// this replaces.
const ARROWHEAD_MARKER = `<marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker>`;

async function callModel(model, messages, maxTokens, { seed = 0 } = {}) {
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

// Reused verbatim from code-longform.js/holonic-task.js: array-first,
// object-second extraction, because a non-greedy regex truncates on the
// first "]" or "}", which may belong to a NESTED structure.
function parseJSON(text) {
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch {}
  }
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch {}
  }
  return null;
}

/**
 * The plan step: decompose a request into a diagram's ELEMENTS (defs,
 * nodes, edges) plus a shared style vocabulary — the diagram-domain
 * instance of code-longform's sharedVocabulary, decided once and read
 * verbatim by every element, including corrections (see buildFixPrompt).
 */
async function planDiagram(model, request, seed) {
  const prompt = `You are a precise diagram architect. Decompose the following request into a SMALL diagram (4-10 elements) made of NODES connected by EDGES.

REQUEST: ${request}

Respond with a JSON OBJECT with two fields:

"sharedStyle": an array of {"name", "value", "meaning"} — canonical CSS color values (hex) that MORE THAN ONE node might need to share for the same reason (e.g. a color for a normal step vs. a color for an error/rejection step). Decide these ONCE here.

"elements": an array of elements, each one of:
  - a NODE: {"id", "kind": "node", "description", "role": one of the sharedStyle names above if this node's meaning matches one, else null} — do not specify a position; layout is computed automatically from how nodes connect.
  - an EDGE: {"id", "kind": "edge", "description", "from": sourceNodeId, "to": targetNodeId, "label": a short (1-3 word) label for this connection, or null}
  - at most one TITLE: {"id", "kind": "title", "description": the diagram's title text}

There is already a shared arrowhead marker with id="arrowhead" available for edges to use as marker-end — do not define your own. Every element needs a non-empty "id" and one of the three "kind" values above; every "from"/"to" must be an id of a node also present in "elements". Return ONLY the JSON object, nothing else.`;
  const system = "You are a precise diagram architect. Always respond with valid JSON and nothing else.";
  const response = await callModel(model, [{ role: "system", content: system }, { role: "user", content: prompt }], 1400, { seed });
  const parsed = parseJSON(response);
  const rawElements = parsed?.elements;
  const sharedStyle = Array.isArray(parsed?.sharedStyle) ? parsed.sharedStyle : [];
  if (!Array.isArray(rawElements) || rawElements.length < 2) {
    throw new Error(`svg-longform: plan parsing failed. Model returned:\n${response.slice(0, 400)}`);
  }

  // MEASURED: the model returned an element with no id and no kind at all
  // on a real run. Nothing validated per-element shape, so it collided
  // with a SECOND malformed element on the same synthetic task_id
  // "el:undefined", silently dropping one rather than reporting either.
  // Every element is validated here; malformed ones are filtered out and
  // reported as a named gap, never coerced into a fake id.
  const gaps = [];
  const nodeIds = new Set(rawElements.filter((el) => el?.kind === "node" && typeof el.id === "string" && el.id).map((el) => el.id));
  const elements = rawElements.filter((el) => {
    if (!el || typeof el.id !== "string" || !el.id) { gaps.push({ reason: "missing or empty id", element: el }); return false; }
    if (!VALID_KINDS.has(el.kind)) { gaps.push({ id: el.id, reason: `unrecognized kind ${JSON.stringify(el?.kind)}` }); return false; }
    if (el.kind === "edge" && (!nodeIds.has(el.from) || !nodeIds.has(el.to))) {
      gaps.push({ id: el.id, reason: `edge references a node id not present in the plan (from=${el.from}, to=${el.to})` });
      return false;
    }
    return true;
  });
  if (elements.length < 2) {
    throw new Error(`svg-longform: plan had too few VALID elements after filtering ${gaps.length} malformed one(s). Model returned:\n${response.slice(0, 400)}`);
  }

  // requires is DERIVED from from/to for edges, never trusted as a
  // separately model-declared list that might silently drift from them —
  // the one place in this file where deriving beats declaring, because
  // from/to already fully determine the dependency.
  for (const el of elements) {
    el.requires = el.kind === "edge" ? [el.from, el.to].filter(Boolean) : [];
  }
  return { elements, sharedStyle, gaps };
}

/** No lookahead, existence-dependency gated — the same shape as nextCodeMove/nextMove. */
function nextDiagramMove(elements, tasks) {
  const has = (id) => tasks.some((t) => t.task_id === id);
  for (const el of elements) {
    const reqsMet = el.requires.every((r) => has(`el:${r}`) && tasks.find((t) => t.task_id === `el:${r}`)?.written);
    if (reqsMet && !has(`el:${el.id}`)) return { kind: "write", element: el };
  }
  return { kind: "close" };
}

/**
 * LAYOUT: pure arithmetic, never asked of the model. Grid cell -> pixel
 * center. col/row are NOT read from the plan (see below) — they are
 * DERIVED entirely from the edge graph, which is already fully known once
 * elements are parsed, the same "derive what's mechanically derivable
 * rather than ask for it" choice as computeRequires above, one level
 * earlier than pixel math.
 *
 * MEASURED, on the second real run: asking the model to ASSIGN col/row
 * hints per node (removing coordinate ARITHMETIC from the model, as the
 * header describes) still let it assign the SAME cell to different nodes
 * — a real run put "Shipped" and "Payment Verified" on top of each other,
 * and "Inventory Checked"/"Retry Payment" on top of each other, because
 * nothing validated that col/row assignments were distinct. Removing
 * arithmetic wasn't enough; the ASSIGNMENT itself needed to stop being the
 * model's job too. col = each node's rank in the graph (longest path from
 * a source node, cycle-tolerant via bounded relaxation — a back-edge, like
 * this domain's own retry loop, just doesn't get to keep pushing rank
 * forever); row = a node's index among others sharing its rank, in
 * first-appearance order. Two nodes joined by a direct edge can now never
 * collide (the edge forces a strictly later rank); two SIBLINGS (no edge
 * between them) can never collide either (distinct row by construction).
 */
/**
 * True back-edges (an edge to a node currently on the DFS stack — the
 * graph-theory signature of a cycle) are detected once via DFS coloring
 * and EXCLUDED from ranking, not just bounded. A naive "cap the iteration
 * count" relaxation still lets a genuine cycle's ranks grow roughly
 * quadratically before the cap bites (verified: a 3-node all-in-one-cycle
 * graph reached rank 9, not a small bounded number) — capping iterations
 * bounds how long you keep making it worse, not how bad it gets. Removing
 * the back-edge from the relaxation set entirely is what actually keeps
 * rank bounded, and it draws the retry loop the way flowcharts normally
 * depict one anyway: a backwards arrow, not a forward rank.
 */
function findBackEdges(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const succ = new Map(nodes.map((n) => [n.id, []]));
  const relevant = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  for (const e of relevant) succ.get(e.from).push(e);

  const back = new Set();
  const state = new Map(); // "visiting" | "done"
  const visit = (id) => {
    state.set(id, "visiting");
    for (const e of succ.get(id)) {
      const s = state.get(e.to);
      if (s === "visiting") back.add(e); // the cycle-closing edge
      else if (s !== "done") visit(e.to);
    }
    state.set(id, "done");
  };
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  return { relevant, back };
}

function rankNodes(nodes, edges) {
  const { relevant, back } = findBackEdges(nodes, edges);
  const forward = relevant.filter((e) => !back.has(e));
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  // forward is now acyclic by construction, so a longest-path relaxation
  // converges within nodes.length passes — the standard DAG bound, not a
  // tolerance for something that might not converge.
  for (let iter = 0; iter < nodes.length; iter++) {
    let changed = false;
    for (const e of forward) {
      if (rank.get(e.to) < rank.get(e.from) + 1) { rank.set(e.to, rank.get(e.from) + 1); changed = true; }
    }
    if (!changed) break;
  }
  return rank;
}

function rowsWithinRank(nodes, rank) {
  const row = new Map();
  const seenPerRank = new Map();
  for (const n of nodes) { // first-appearance order, so layout is stable across runs of the same plan
    const r = rank.get(n.id);
    const nextRow = seenPerRank.get(r) ?? 0;
    row.set(n.id, nextRow);
    seenPerRank.set(r, nextRow + 1);
  }
  return row;
}

export function computeLayout(elements, canvas = CANVAS) {
  const nodes = elements.filter((e) => e.kind === "node");
  const edges = elements.filter((e) => e.kind === "edge");
  const rank = rankNodes(nodes, edges);
  const row = rowsWithinRank(nodes, rank);

  const cols = Math.max(1, ...nodes.map((n) => rank.get(n.id) + 1));
  const rows = Math.max(1, ...nodes.map((n) => row.get(n.id) + 1));
  const availW = canvas.width - 2 * canvas.padding;
  const availH = canvas.height - canvas.titleHeight - 2 * canvas.padding;
  const cellW = availW / cols;
  const cellH = availH / rows;
  const box = { w: Math.min(150, cellW - 20), h: Math.min(64, cellH - 20) };

  const positions = new Map();
  for (const n of nodes) {
    const x = canvas.padding + cellW * rank.get(n.id) + cellW / 2;
    const y = canvas.titleHeight + canvas.padding + cellH * row.get(n.id) + cellH / 2;
    positions.set(n.id, { x, y, ...box });
  }
  return { positions, box, cols, rows };
}

/** THE MOUTH: what already exists, bounded to k regardless of diagram size. */
function workingSetFor(elements, log) {
  const tasks = projectTasks(log);
  const written = elements.filter((e) => tasks.find((t) => t.task_id === `el:${e.id}`)?.written);
  const { working } = foldToWorkingSet(written.map((e) => ({ task_id: `el:${e.id}`, ...e })), { k: WORKING_SET_K, score: () => 0 });
  return working;
}

function styleBlock(sharedStyle) {
  if (!sharedStyle?.length) return "";
  let p = `SHARED STYLE — every element in this diagram uses these EXACT hex values for the meaning given, never a different color for the same meaning:\n`;
  for (const s of sharedStyle) p += `- "${s.name}" = ${s.value} — ${s.meaning}\n`;
  return p + "\n";
}

function buildWritePrompt(element, request, working, sharedStyle, layout) {
  let p = `DIAGRAM: ${request}\n\n`;
  p += styleBlock(sharedStyle);
  if (working.length) {
    p += `ELEMENTS ALREADY PLACED — reference their ids EXACTLY, do not invent different ones:\n`;
    for (const w of working) p += `- ${w.id} (${w.kind})${w.role ? ` — role: ${w.role}` : ""}\n`;
    p += `\n`;
  }
  p += `NOW WRITE the SVG markup fragment for element "${element.id}" (${element.kind}).\n${element.description}\n\n`;
  if (element.kind === "title") {
    const { width } = CANVAS;
    p += `Write ONE <text> element, x="${width / 2}" y="35" text-anchor="middle", a large readable font-size (e.g. 26), containing this title text.\n`;
  } else if (element.kind === "node") {
    // MEASURED, on the third real run: giving the model an ABSOLUTE center
    // and asking it to place its own shape there produced a `rotate(90)
    // skewX(-10)` transform nobody asked for, a `<g x="..." y="...">`
    // (not a real SVG attribute — silently ignored, so the shape defaulted
    // to the origin), and a label positioned nowhere near its own shape.
    // Edges, given two absolute points, mostly got this right — it's
    // specifically an OWN BOX's placement a weak local model can't reliably
    // do. Fix: never give it absolute coordinates at all. It draws inside
    // a LOCAL box anchored at (0,0); code wraps the result in its own
    // <g transform="translate(...)"> computed from the real position —
    // guaranteed correct by construction, since SVG transforms compose,
    // regardless of what the model draws inside.
    const pos = layout.positions.get(element.id);
    const styleHint = element.role && sharedStyle?.find((s) => s.name === element.role);
    p += `Draw this node's shape and its label text inside a LOCAL box ${pos.w.toFixed(0)} wide by ${pos.h.toFixed(0)} tall, with the box's top-left corner at LOCAL coordinates (0, 0) — do NOT use absolute page coordinates, and do NOT add a "transform" attribute of your own; positioning on the page is handled automatically. Do NOT wrap your output in a <g> with an id — write only the shape and text elements directly (e.g. <rect .../><text>...</text>).\n`;
    if (styleHint) p += `Use fill="${styleHint.value}" (the declared "${styleHint.name}" color) for the shape.\n`;
  } else if (element.kind === "edge") {
    const from = layout.positions.get(element.from);
    const to = layout.positions.get(element.to);
    // MEASURED: an edge fragment invented its OWN <symbol>/<glyphDef>
    // "redefining" the arrowhead, apparently unsure whether one already
    // existed — syntactically well-formed (xmllint has no opinion on
    // whether a tag name is a real SVG element), just inert clutter that
    // never should have been asked for. Stated explicitly, not left
    // implicit, the same "declared, not assumed" discipline as everything
    // else in this project.
    p += `Draw a single <path> or <line> from x1="${from.x.toFixed(0)}" y1="${from.y.toFixed(0)}" to x2="${to.x.toFixed(0)}" y2="${to.y.toFixed(0)}", stroke="#333", stroke-width="2", marker-end="url(#arrowhead)". Wrap it in <g id="${element.id}">...</g>. The "arrowhead" marker ALREADY EXISTS — do NOT define your own <marker>, <symbol>, or similar; only reference it by url(#arrowhead).\n`;
    if (element.label) p += `Include a short <text> near the midpoint of the line reading exactly "${element.label}".\n`;
  }
  // MEASURED: a text element used x="50%" y="40%" — percentage units
  // resolve against the ROOT viewport, not this element's local box, so
  // the label rendered far outside its own shape. There is no nested
  // viewport here for a percentage to be meaningful against, so it is
  // NEVER correct in this design, not just usually risky.
  p += `Use only plain numbers for every coordinate (e.g. x="40"), never a percentage like "50%" — there is no viewport here for a percentage to be relative to, so it would render in the wrong place entirely.\n`;
  p += `\nWrite ONLY the raw SVG markup fragment for this one element — no <svg> tag, no <?xml?> declaration, no markdown fences, no commentary.`;
  return p;
}

const stripFences = (text) => text.replace(/^```[\w]*\n?/, "").replace(/```\s*$/, "").replace(/^"""\n?/, "").replace(/\n?"""$/, "").trim();

// xmllint is a system binary, checked once, lazily — not an added
// dependency, the same reasoning that makes `new Function` an acceptable
// REAL check for JS in code-longform.js rather than a heuristic.
let xmllintAvailable = null;
function hasXmllint() {
  if (xmllintAvailable === null) {
    try { execFileSync("xmllint", ["--version"], { stdio: "ignore" }); xmllintAvailable = true; }
    catch { xmllintAvailable = false; }
  }
  return xmllintAvailable;
}

/**
 * Verification, honestly graded by what's actually available. A REAL XML
 * well-formedness check via xmllint when present — it catches things a
 * balance heuristic cannot, like a bare "&" in text content. An honest,
 * DECLARED-weak floor otherwise, the same choice code-longform.js already
 * made for HTML/CSS rather than dressing up a heuristic as a validator.
 */
export function verifySyntax(fragment) {
  if (hasXmllint()) {
    // MEASURED: a real fragment used xlink:href (legal, common SVG1.1
    // syntax for <use>) without the xlink namespace declared anywhere.
    // xmllint printed a namespace error to stderr but EXITED 0 — silently
    // passing content a real browser refuses to render past. Declaring
    // xmlns:xlink unconditionally (the correct fix either way — it's what
    // a real document needs regardless of whether this particular
    // fragment happens to use it) closes this specific gap.
    const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs></defs><g>${fragment}</g></svg>`;
    try {
      execFileSync("xmllint", ["--noout", "-"], { input: wrapped, stdio: ["pipe", "pipe", "pipe"] });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e.stderr?.toString() || e.message).trim().split("\n")[0] };
    }
  }
  const stripped = fragment.replace(/<[a-zA-Z][^>]*\/>/g, "");
  const opens = (stripped.match(/<[a-zA-Z][^>]*(?<!\/)>/g) ?? []).length;
  const closes = (stripped.match(/<\/[a-zA-Z][^>]*>/g) ?? []).length;
  return opens === closes
    ? { ok: true }
    : { ok: false, reason: `unbalanced tags: ${opens} opening vs ${closes} closing — xmllint not found on PATH, this is a weak floor, not a real XML validator` };
}

function setVerification(verifications, id, result) {
  const existing = verifications.find((v) => v.id === id);
  if (existing) { existing.syntaxOk = result.ok; existing.syntaxReason = result.reason ?? null; }
  else verifications.push({ id, syntaxOk: result.ok, syntaxReason: result.reason ?? null });
}

/**
 * The cross-reference check — checkCrossFileReferences' exact mechanism,
 * adapted to SVG's own reference grammar: href="#id" and url(#id) inside
 * fill/stroke/marker-end/clip-path/filter, checked against every id="..."
 * actually declared across all written fragments.
 */
function checkSvgReferences(elementId, contents) {
  const declared = new Set(["arrowhead"]); // synthesized deterministically, always present — see ARROWHEAD_MARKER
  for (const c of Object.values(contents)) {
    for (const m of c.matchAll(/\bid=["']([\w-]+)["']/g)) declared.add(m[1]);
  }
  const content = contents[elementId];
  if (!content) return [];
  const flags = [];
  for (const m of content.matchAll(/(?:xlink:)?href=["']#([\w-]+)["']/g)) if (!declared.has(m[1])) flags.push({ ref: m[1] });
  for (const m of content.matchAll(/url\(#([\w-]+)\)/g)) if (!declared.has(m[1])) flags.push({ ref: m[1] });
  return flags;
}

/**
 * MEASURED, on the seventh real run: several nodes used font-size="24" (or
 * larger) inside a box only 64px tall — the label overflowed above/below
 * its own box and visually collided with NEIGHBORING nodes' text. Unlike
 * position, font-size has no "undeclared reference" or "invisible" bug
 * shape to flag-and-ask-the-model-to-fix; it's a bounded quantity code
 * already knows the safe range for (the box height, computed, not
 * generated, same as everything else here), so it's clamped directly
 * rather than routed through another correction round-trip. Percentage
 * font-sizes are left to the existing percent-coordinate check — clamping
 * "50%" as if it were 50 raw units would silently reinterpret it wrong,
 * not fix it.
 */
function clampFontSize(fragment, box) {
  const maxSize = Math.max(10, Math.min(20, Math.floor(box.h * 0.3)));
  const cap = (num) => Math.min(parseFloat(num), maxSize);
  return fragment
    .replace(/font-size:\s*(\d+(?:\.\d+)?)(px)?/gi, (_, num, unit) => `font-size:${cap(num)}${unit || ""}`)
    .replace(/font-size=(["'])(\d+(?:\.\d+)?)(px)?\1/gi, (_, q, num, unit) => `font-size=${q}${cap(num)}${unit || ""}${q}`);
}

/**
 * MEASURED, on the fourth real run: a node's fragment was a self-closing
 * `<text ... />` — syntactically valid (xmllint passes it), reference-clean
 * (nothing undeclared), and utterly invisible: a self-closed text element
 * renders no content at all. Neither existing check catches this — it is
 * a THIRD kind of defect (missing content), not a syntax or reference
 * problem, so it needs its own mechanical check rather than being folded
 * into either existing one and mislabeled.
 */
function hasVisibleText(fragment) {
  const matches = [...fragment.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)];
  return matches.some((m) => m[1].trim().length > 0);
}

/**
 * Four more mechanically-detectable defects, all MEASURED on real runs,
 * none caught by syntax or reference checking because none of them are a
 * syntax or reference problem:
 *   percent-coordinate  — a text used x="50%" y="40%". Percentages resolve
 *     against the ROOT viewport, not this element's local box, and there
 *     is no nested viewport here for one to be meaningful against — NEVER
 *     correct in this design, not just usually risky.
 *   invented-definition — an edge fragment defined its OWN <marker>/
 *     <symbol>/<glyphDef>, apparently unsure whether the shared arrowhead
 *     already existed. Well-formed XML (xmllint has no opinion on whether
 *     a tag name is a real SVG element), just inert clutter nobody asked
 *     for.
 *   no-renderable-geometry — an edge's <path> carried x1/y1/x2/y2
 *     attributes (only meaningful on <line>) and no "d" attribute at all.
 *     A <path> with no "d" draws NOTHING — well-formed, reference-clean,
 *     and INVISIBLE. Half the edges on a real run vanished this way.
 * Collected together with the missing-label check as one function so the
 * write loop drives correction off a single list, not four parallel
 * booleans.
 */
function hasPathWithoutD(fragment) {
  const pathTags = fragment.match(/<path\b[^>]*>/gi) ?? [];
  return pathTags.some((tag) => !/\bd\s*=/.test(tag) && /\b(x1|x2|y1|y2)\s*=/.test(tag));
}

function detectIssues(element, raw) {
  const issues = [];
  if ((element.kind === "node" || element.kind === "title") && !hasVisibleText(raw)) issues.push("missing-label");
  if (/\b(?:x|y|x1|y1|x2|y2|cx|cy)=["'][\d.]+%["']/.test(raw)) issues.push("percent-coordinate");
  if (/<(marker|symbol|glyphDef)\b/i.test(raw)) issues.push("invented-definition");
  if (element.kind === "edge" && hasPathWithoutD(raw)) issues.push("no-renderable-geometry");
  return issues;
}

const ISSUE_DESCRIPTIONS = Object.freeze({
  "missing-label": (element) => `It has no visible label text — either there is no <text> element, or it is self-closed / empty (e.g. <text .../>), which renders NOTHING. You MUST include a real <text>...</text> with readable content describing: ${element.description}`,
  "percent-coordinate": () => `It uses a percentage coordinate (e.g. x="50%"). There is no viewport here for a percentage to be relative to, so it renders in the wrong place — replace every percentage with a plain number.`,
  "invented-definition": () => `It defines its own <marker>, <symbol>, or similar. The "arrowhead" marker already exists — remove your own definition and just reference it with url(#arrowhead).`,
  "no-renderable-geometry": () => `Its <path> has x1/y1/x2/y2 attributes (those only work on <line>) and no "d" attribute — a <path> with no "d" draws NOTHING. Either use <line x1=".." y1=".." x2=".." y2=".."/> or give the <path> a real "d" attribute (e.g. d="M x1,y1 L x2,y2").`,
});

/**
 * Wraps a node's LOCAL-frame fragment in the code-computed positioning —
 * the mechanical half of the fix described in buildWritePrompt's node
 * branch. Guaranteed correct regardless of what the model drew inside,
 * because SVG transforms compose: whatever local shape the model produced,
 * translating its (0,0)-anchored box to the real computed position is
 * enough, with no dependence on the model having used any coordinate
 * correctly itself.
 */
function finalizeFragment(element, raw, layout) {
  if (element.kind !== "node") return raw;
  const pos = layout.positions.get(element.id);
  const tx = (pos.x - pos.w / 2).toFixed(1);
  const ty = (pos.y - pos.h / 2).toFixed(1);
  return `<g id="${element.id}" transform="translate(${tx}, ${ty})">\n${raw}\n</g>`;
}

function buildFixPrompt(element, content, flags, sharedStyle, issues) {
  let p = `Here is an SVG fragment you wrote (element "${element.id}"):\n"""\n${content}\n"""\n\n`;
  if (flags.length) {
    p += `It references ids that do not exist in any element written so far:\n`;
    for (const f of flags) p += `- "${f.ref}" — never declared anywhere\n`;
  }
  for (const issue of issues) p += `- ${ISSUE_DESCRIPTIONS[issue](element)}\n`;
  p += styleBlock(sharedStyle);
  p += `\nRewrite the ENTIRE fragment, fixing the issue(s) above. Keep everything else the same. Raw SVG fragment only, no commentary.`;
  return p;
}

/**
 * Drive the plan to closure and assemble one SVG document. No fixed
 * element count declared anywhere — nextDiagramMove decides one element at
 * a time from what already legally can be written.
 */
export async function writeDiagram(request, { model = "llama3.2:latest", outPath, seed = 20260801, onProgress = null, maxElements = MAX_ELEMENTS_GUARD, canvas = CANVAS } = {}) {
  const progress = onProgress || ((msg) => console.log(msg));
  mkdirSync(dirname(outPath), { recursive: true });

  progress(`planning diagram for: ${request}`);
  const { elements, sharedStyle, gaps } = await planDiagram(model, request, seed);
  progress(`planned ${elements.length} valid elements: ${elements.map((e) => `${e.id}(${e.kind})`).join(", ")}`);
  for (const g of gaps) progress(`  PLAN GAP: dropped a malformed element (${g.id ?? "no id"}) — ${g.reason}`);
  if (sharedStyle.length) progress(`shared style: ${sharedStyle.map((s) => `${s.name}=${s.value}`).join(", ")}`);

  const layout = computeLayout(elements, canvas);
  progress(`layout: ${layout.cols}x${layout.rows} grid, box ${layout.box.w.toFixed(0)}x${layout.box.h.toFixed(0)}`);

  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "diagram", description: request });

  const contents = {};
  const verifications = [];
  const continuityFlags = [];
  let count = 0;

  while (count < maxElements) {
    const tasks = projectTasks(log);
    const move = nextDiagramMove(elements, tasks);
    if (move.kind === "close") break;

    count += 1;
    const element = move.element;
    const working = workingSetFor(elements, log);

    const prompt = buildWritePrompt(element, request, working, sharedStyle, layout);
    progress(`writing ${element.id} (${element.kind})...`);
    const t0 = Date.now();
    // `raw` is exactly what the model wrote — for a node, still in ITS OWN
    // local (0,0)-anchored frame. `content` is what actually gets kept:
    // `raw`, wrapped with the code-computed absolute position for a node,
    // unchanged for an edge/title. Verification and the correction loop
    // below operate on `content` (what's real), but the FIX prompt shows
    // the model `raw` (its own frame), not a wrapper it never wrote and
    // shouldn't be asked to reason about.
    let raw = stripFences(await callModel(model, [{ role: "system", content: "You write clean, minimal SVG markup fragments. Output raw markup only — never markdown fences, never commentary." }, { role: "user", content: prompt }], ELEMENT_TOKENS, { seed: seed + count }));
    if (element.kind === "node") raw = clampFontSize(raw, layout.positions.get(element.id));
    let content = finalizeFragment(element, raw, layout);
    progress(`  ${element.id}: ${raw.length} chars in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    const syntax = verifySyntax(content);
    if (!syntax.ok) progress(`  SYNTAX CHECK FAILED: ${syntax.reason}`);
    setVerification(verifications, element.id, syntax);

    // STABLE SUB-ASSEMBLY DISCIPLINE, same as code-longform.js: verify and
    // correct THIS element now, before anything depending on it is written.
    // Two independently mechanically-checked signals drive correction: an
    // undeclared reference, and detectIssues' three defects (missing
    // label, percent coordinates, invented definitions) — each one passes
    // BOTH syntax and reference checking while still being wrong, so none
    // of them can be caught as a side effect of either existing check.
    let flags = checkSvgReferences(element.id, { ...contents, [element.id]: content });
    let issues = detectIssues(element, raw);
    let attempts = 0;
    while ((flags.length > 0 || issues.length > 0) && attempts < MAX_CONTINUITY_REVISIONS) {
      attempts += 1;
      progress(`  ${element.id}: ${flags.length} undeclared reference(s)${issues.length ? ` + ${issues.join(", ")}` : ""}, attempting correction ${attempts}/${MAX_CONTINUITY_REVISIONS}...`);
      const fixPrompt = buildFixPrompt(element, raw, flags, sharedStyle, issues);
      raw = stripFences(await callModel(model, [{ role: "system", content: "You write clean, minimal SVG markup fragments. Output raw markup only — never markdown fences, never commentary." }, { role: "user", content: fixPrompt }], ELEMENT_TOKENS, { seed: seed + 1000 + count * 10 + attempts }));
      if (element.kind === "node") raw = clampFontSize(raw, layout.positions.get(element.id));
      content = finalizeFragment(element, raw, layout);
      const resyntax = verifySyntax(content);
      setVerification(verifications, element.id, resyntax);
      flags = checkSvgReferences(element.id, { ...contents, [element.id]: content });
      issues = detectIssues(element, raw);
    }
    if (attempts > 0 && flags.length === 0 && issues.length === 0) {
      progress(`  ${element.id}: CORRECTED after ${attempts} attempt(s)`);
      continuityFlags.push({ id: element.id, resolved: true, attempts });
    }
    for (const fl of flags) {
      progress(`  CONTINUITY FLAG (unresolved after ${attempts} attempt(s)): ${element.id} references undeclared "${fl.ref}"`);
      continuityFlags.push({ id: element.id, ref: fl.ref, resolved: false, attempts });
    }
    for (const issue of issues) {
      progress(`  CONTINUITY FLAG (unresolved after ${attempts} attempt(s)): ${element.id} — ${issue}`);
      continuityFlags.push({ id: element.id, issue, resolved: false, attempts });
    }

    contents[element.id] = content;
    log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: `el:${element.id}`, description: element.description, depends_on: ["diagram"], written: true });
  }

  const body = elements.filter((e) => contents[e.id]).map((e) => contents[e.id]).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">\n<defs>\n${ARROWHEAD_MARKER}\n</defs>\n${body}\n</svg>\n`;
  writeFileSync(outPath, svg);

  return { elements, contents, svg, verifications, continuityFlags, layout, gaps, outPath };
}
