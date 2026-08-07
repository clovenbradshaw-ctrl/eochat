// holonic-chat.js — the unified chat orchestrator.
//
// Every normal chat turn runs through holonic planning here: ONE model
// call (the DEFINE evaluation) reads the ask and decides, per ask:
//   depth      — riff (short, direct, marked ungrounded when nothing backs it)
//                or essay (multi-section);
//   form       — HOW the answer is delivered: prose, screenplay, code, reply.
//                Never pre-determined: the evaluation produces it, so a
//                screenplay ask is written as a screenplay and a code ask as
//                code, and the same engine serves all of them;
//   units      — the per-section work plan (id, writing instruction, research
//                topic), the instruction being the form-specific contract;
//   compliance — what the finished answer must satisfy to count as done.
//
// Essays then research each unit in its own small, folded context window (only
// that unit's evidence), write it without the writer ever seeing evidence
// tables or citation numbers, and prove the prose with MECHANICAL post-hoc
// citations (autoAttachCitations' n-gram match, verbatim clause as proof).
//
// Each unit then runs a DEFINE → EVALUATE → RECONCILE (DEF·EVA·REC) loop:
//   EVA   — evaluateUnit measures the draft mechanically against its OWN
//           folded evidence and the form contract: machinery-leak vocabulary,
//           structural shape (prose/screenplay/code), the fidelity residual
//           (specific names the evidence could carry but the draft did not),
//           and unsupported figures (numbers nowhere in the evidence).
//   REC   — one bounded revision toward the flagged violations (reconcileRounds
//           is small; the loop never spins).
//   Earn-or-drop — a unit that still fails its review is DROPPED and named as
//           a gap; a unit with no evidence at all is shipped honestly labeled
//           ungrounded, never silently invented.
//
// The talking model never sees the machinery: no planner output, no evidence
// lists, no fold/gate vocabulary — just "here is the material for your unit;
// write it." Everything holonic (plan, sections, research hops, provenance,
// sufficiency) is carried on the returned shape and through onProgress events
// for the UI's Thinking block, never through the prose.
//
// Backend-agnostic exactly like longform-orchestrator.js: `generate` is the
// caller's seam, so this module drives either the server's Ollama/Anthropic
// calls or a browser WebLLM adapter unchanged.

import { autoAttachCitations } from "./citation-check.js";

// ── bounds ──
// These are infrastructure ceilings (cost, latency, context budget), not
// content targets — the DEFINE evaluation decides what a given answer
// actually needs (see PLANNER_SYSTEM_PROMPT); nothing here is suggested to
// it as a shape to aim for.
//
// The hard ceiling on how many sections one answer may split into, no matter
// how many the planner's units array actually names — a runaway/malformed
// reply must not turn into an unbounded research-and-write loop.
export const MAX_ESSAY_SECTIONS = 6;
// Each section's folded context window — the writer sees only its OWN
// evidence, capped here, never the whole research pool.
export const MAX_SECTION_EVIDENCE_CHARS = 3500;
export const PER_ITEM_EVIDENCE_CHARS = 900;
// When a section's local evidence is thinner than this, and the web toggle is
// on, the orchestrator researches the web for that section automatically.
export const THIN_LOCAL_ITEMS = 2;
export const THIN_LOCAL_CHARS = 800;
export const DEFAULT_SECTION_TOKENS = 1500;
// How many bounded rewrites a section may earn before it is dropped.
export const DEFAULT_RECONCILE_ROUNDS = 2;
// The smallest a unit may be and still count as written, unless the DEFINE
// evaluation asks for more.
export const DEFAULT_MIN_WORDS = 15;
// defineAnswerSpec's own parse-recovery threshold: a reply with no units but
// a self-chosen compliance.minWords at or above this clearly wanted a
// structured answer and just failed to enumerate it — see defineAnswerSpec.
// Not a length the model is ever told about.
export const STRUCTURED_MIN_WORDS = 100;

// ── the DEFINE evaluation ────────────────────────────────────────────────────
//
// One model call decides KIND, whether outside evidence is needed, FORM,
// units, and the compliance contract for this ask — including what "done"
// even means for it, since that's not a fixed template either (a greeting
// and a report aren't two slots in a menu; "riff" vs "essay" was the old,
// too-rigid version of this and no longer exists as a category the model is
// asked to pick from — see PLANNER_SYSTEM_PROMPT). Form is a first-class
// decision here — an ask that wants a screenplay or working code must
// produce prose-shaped instructions for it, and EVA then tests the writer
// against exactly that contract.
//
// `depth` still appears on the RETURNED plan shape ("riff"/"essay") because
// the rest of the pipeline (the essay-vs-single-reply branch, the UI's
// loading copy, this module's own tests) needs *some* stable signal for
// "does this get the multi-section treatment" — but it's now derived from
// whether the model actually produced units, never asked of the model
// directly.
const PLANNER_SYSTEM_PROMPT = `You are the evaluator-planner for a writing assistant. Read the reader's question and decide how this ONE ask should be answered. There is no fixed template for "a good answer" — you are deciding, for THIS ask specifically, what shape, length, and criteria would actually satisfy it. A greeting and a request for a research report are not two slots in a fixed menu; they're two points on a continuum you're free to place anywhere.

DECIDE:

1. kind — a short label, in your own words, for what this response actually is. Not a fixed category — whatever fits best. Examples: greeting, small talk, factual question, how-to, clarification, opinion, research essay, code request, creative writing. Keep it to a few words.

2. lookup — does answering this WELL require outside evidence (the reader's own documents, or a web search)? true for anything hinging on a specific, checkable fact — current events, statistics, names/dates, "what does X say about Y", anything that could be wrong if guessed. false for greetings, small talk, opinions, requests to reformat/continue/explain what the assistant already said, and questions about the assistant itself — searching the literal sentence for those just pulls in noise and forces fake citations against irrelevant results.

3. units — the sections this answer is actually made of. Most asks need none: an empty list means one direct, unstructured reply — the right shape for a greeting, a short answer, a clarification, or anything else without distinct parts. Give one or more units only when the ask genuinely breaks into that many distinct pieces, and let the ask's own complexity decide how many — could be two, could be a dozen. Never pad a short answer with sections it doesn't need, and never flatten a genuinely multi-part ask into one. Each unit:
   - "id": a short title for the section
   - "instruction": what THIS section must do (cover this angle, follow this form rule, meet this structural requirement)
   - "topic": a specific, self-contained research query for that section — the engine will look it up on its own.

4. form — how the answer is DELIVERED:
   - "prose": normal paragraphs.
   - "screenplay": scene-based script with INT./EXT. scene headings, action lines, and ALL-CAPS character dialogue. Only when the reader asks for a script or screenplay.
   - "code": working source (JavaScript/CSS/HTML). Only when the reader asks for code.
   - "reply": a direct answer with no units.

5. compliance — YOUR OWN definition of what would make this specific answer complete. This is part of what you're deciding, not a preset target:
   - "minWords": the length THIS answer actually needs to do its job — could be under ten words for a greeting, could be whatever a real treatment of the topic takes. Never copy a template number.
   - "require": any structural requirements this ask specifically calls for (scene headings, dialogue blocks, runnable code, etc.) — empty when nothing applies.
   - "forbid": anything the answer must specifically avoid — empty when nothing applies.

Follow-up questions that reference what the assistant just said usually need no units even when the original question did.

Reply with ONLY a JSON object. No prose, no code fences, no commentary. The values below illustrate field TYPES, not recommended settings:

{"kind":"a few words","lookup":true|false,"form":"prose"|"screenplay"|"code"|"reply","reason":"one short sentence justifying the kind, lookup, and form","units":[{"id":"short section title","instruction":"what this section must do","topic":"focused research query for this section"}],"compliance":{"minWords":42,"require":["..."],"forbid":["..."]}}`;

// ── canonical shapes ─────────────────────────────────────────────────────────
//
// A unit is {id, instruction, topic}; the legacy {title, topic} section shape
// is accepted everywhere and normalized to it.
function normalizeUnit(u) {
  if (!u || typeof u !== "object") return null;
  const id = String(u.id || u.title || "").trim().slice(0, 90);
  const topic = String(u.topic || "").trim().slice(0, 160);
  if (!id || !topic) return null;
  return { id, instruction: String(u.instruction || "").trim().slice(0, 240), topic };
}

function normalizeCompliance(c, form) {
  if (!c || typeof c !== "object") return null;
  const minWords = Number.isFinite(c.minWords)
    ? Math.max(0, Math.min(2000, Math.floor(c.minWords)))
    : (form === "code" ? 2 : DEFAULT_MIN_WORDS);
  const list = (x) => (Array.isArray(x) ? x.map((v) => String(v).slice(0, 160)).filter(Boolean).slice(0, 12) : []);
  return {
    minWords,
    require: list(c.require),
    forbid: list(c.forbid),
    language: form === "code" && /^(js|css|html)$/i.test(String(c.language || ""))
      ? String(c.language).toLowerCase()
      : (form === "code" ? "js" : null),
  };
}

// Normalize a parsed planner object into the canonical shape. `sections` is
// kept as a derived view so legacy consumers keep working.
function normalizePlan(p) {
  const rawUnits = Array.isArray(p.units) ? p.units : (Array.isArray(p.sections) ? p.sections : []);
  const units = rawUnits.map(normalizeUnit).filter(Boolean).slice(0, MAX_ESSAY_SECTIONS);
  // The model is no longer asked for "depth" (see PLANNER_SYSTEM_PROMPT) — it
  // emerges from whatever units the model actually gave this ask. A reply
  // that DOES carry an explicit legacy "depth" (older callers, hand-built
  // fixtures, salvage recovery) is honored as-is rather than overridden.
  const depth = (p.depth === "riff" || p.depth === "essay") ? p.depth : (units.length > 0 ? "essay" : "riff");
  // Keyed off depth (not units.length directly) so an explicit legacy
  // depth with as-yet-empty units — before defineAnswerSpec's own fallback
  // derives real sections for it — still defaults to the shape that depth
  // implies, exactly as before this module stopped asking for depth itself.
  const form = /^(prose|screenplay|code|reply)$/i.test(p.form || "")
    ? String(p.form).toLowerCase()
    : (depth === "essay" ? "prose" : "reply");
  // The model's own free-text label for this response; falls back to the
  // derived depth string only when the reply carried no kind at all.
  const kind = String(p.kind || "").trim().slice(0, 60) || depth;
  // A missing/unparseable field defaults to true — the old always-search
  // behavior — so this only ever SUPPRESSES a search the planner positively
  // identified as unnecessary, never adds a new failure mode.
  const lookup = p.lookup !== false;
  return {
    depth,
    kind,
    lookup,
    form,
    reason: String(p.reason || "").slice(0, 240),
    units,
    compliance: normalizeCompliance(p.compliance, form),
    sections: units.map((u) => ({ title: u.id, topic: u.topic })),
  };
}

// A parsed object counts as a plan when it carries a legacy depth, a kind
// label, or a units/sections array — any one of them is enough signal to
// normalize; an object with none of those is something else (a stray JSON
// blob elsewhere in the reply) and must not be accepted as the plan.
function isPlanShaped(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.depth === "riff" || obj.depth === "essay") return true;
  if (typeof obj.kind === "string" && obj.kind.trim()) return true;
  if (Array.isArray(obj.units) || Array.isArray(obj.sections)) return true;
  return false;
}

// Robust JSON extraction: strip fences, then accept a whole-object reply or
// scan every '{' outward to its balanced '}' for the first parseable planner
// object. The scan survives prose before and after the JSON, a second JSON
// blob in the reply, and code-fence-free wrapping — the shapes a small model
// actually emits when it refuses to stick to the strict schema.
export function parsePlannerReply(raw) {
  const text = String(raw || "").replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");

  try {
    const whole = JSON.parse(text);
    if (isPlanShaped(whole)) return normalizePlan(whole);
  } catch { /* scan below */ }

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const p = JSON.parse(text.slice(i, j + 1));
            if (isPlanShaped(p)) return normalizePlan(p);
          } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }

  // A numbered/bulleted plan without JSON is still a plan when it names 2+
  // sections — better than the generic fallback below. normalizePlan derives
  // "essay" depth on its own once units.length > 0, so no depth is passed here.
  const list = parseListPlan(text);
  if (list.length >= 2) {
    return normalizePlan({ reason: "planner reply was a section list, not JSON", units: list });
  }

  // Small models emit JSON-shaped near-misses: a section object closed one
  // brace too early, a stray `"` before the array's `]`, a missing key. When
  // strict parsing fails, salvage the pieces the planner actually consumes.
  const salvaged = salvagePlan(text);
  if (salvaged) {
    return {
      ...normalizePlan(salvaged),
      reason: "planner reply was malformed JSON — salvaged",
    };
  }

  // Last resort: nothing recognizable parsed at all. This heuristic reads
  // the model's own failed reply text (not the user's question) for a sign
  // it was reaching for something structured; normalizePlan derives units:[]
  // → depth "riff" either way unless that's true.
  const essayish = /(essay|report|paper|"\d+\s*pages?"|five\s+page|5\s+page|long[\s-]form)/i.test(text);
  return normalizePlan({ depth: essayish ? "essay" : "riff", reason: "planner reply unparseable — heuristic depth" });
}

// Tolerant piece recovery from malformed planner JSON: kind/depth, lookup,
// reason, form, and every {"id":...,"topic":...,"instruction":...} unit
// object, read straight off the raw text. Returns null when the reply has
// none of the plan-shaped signals isPlanShaped looks for.
function salvagePlan(text) {
  const depthM = text.match(/"depth"\s*:\s*"(riff|essay)"/i);
  const kindM = text.match(/"kind"\s*:\s*"([^"]*)"/i);
  const lookupM = text.match(/"lookup"\s*:\s*(true|false)/i);
  const reasonM = text.match(/"reason"\s*:\s*"([^"]*)"/i);
  const formM = text.match(/"form"\s*:\s*"(prose|screenplay|code|reply)"/i);
  const arrM = text.match(/"sections"\s*:\s*\[\s*(.*)$/is) || text.match(/"units"\s*:\s*\[\s*(.*)$/is);
  const tail = arrM ? arrM[1] : "";
  const ids = [...tail.matchAll(/"id"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
  const titles = ids.length ? ids : [...tail.matchAll(/"title"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
  const topics = [...tail.matchAll(/"topic"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
  const instructions = [...tail.matchAll(/"instruction"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
  const units = [];
  for (let i = 0; i < Math.min(titles.length, topics.length); i++) {
    if (titles[i] && topics[i]) {
      units.push({ id: titles[i], instruction: instructions[i] || "", topic: topics[i] });
    }
  }
  if (!depthM && !kindM && !units.length) return null;
  return {
    depth: depthM ? depthM[1].toLowerCase() : undefined,
    kind: kindM ? kindM[1] : undefined,
    lookup: lookupM ? lookupM[1].toLowerCase() === "true" : undefined,
    form: formM ? formM[1].toLowerCase() : undefined,
    reason: reasonM ? reasonM[1] : "",
    units,
  };
}

function parseListPlan(text) {
  const out = [];
  const lineRe = /^\s*(?:\d+[.)]|[-*•+])\s+(.+)$/gm;
  for (const m of text.matchAll(lineRe)) {
    const line = m[1].trim();
    if (!line) continue;
    const sep = line.match(/^(.{2,90}?)\s*(?:[-—]|:\s)\s*(.{2,160})$/);
    const id = sep ? sep[1].trim() : line.slice(0, 60).trim();
    const topic = sep ? sep[2].trim() : line;
    if (id && topic) out.push({ id: id.slice(0, 90), instruction: "", topic: topic.slice(0, 160) });
    if (out.length >= MAX_ESSAY_SECTIONS) break;
  }
  return out;
}

// Pull a clean, searchable subject out of essay-instruction phrasing like
// "Write me a 5 page essay about dolphins, after researching online first."
// → "dolphins". Left as the whole (cleaned) phrase when no pattern matches, so
// topical questions like "how do dolphins communicate?" pass through intact.
export function distillSubject(question) {
  let q = String(question || "").trim().replace(/\s+/g, " ");
  if (!q) return "";
  q = q.replace(/,\s*(?:after|then|once|using|while|by|and)\s+[^.]*\.?$/i, "");
  q = q.replace(/\s+please[.!?]*$/i, "").replace(/^\s*(?:please|can you|could you|would you|do you think you can)\s+/i, "");
  const essay = q.match(/\b(?:essay|report|paper|write-?up|summary|article|piece|deep[\s-]?dive|long[\s-]?form)\b[^.]*?\b(?:about|on|covering|regarding|concerning)\s+([^,.;?]+)/i);
  if (essay) return cleanSubjectPhrase(essay[1]);
  const ask = q.match(/\b(?:tell me about|what is|what are|what was|explain(?: to me)?|describe)\s+([^,.;?]+)/i);
  if (ask) return cleanSubjectPhrase(ask[1]);
  return cleanSubjectPhrase(q);
}

function cleanSubjectPhrase(s) {
  let t = String(s).trim().replace(/[.!?;:]+$/g, "").replace(/^(?:an?|the)\s+/, "");
  t = t.replace(/\s+(?:of\s+)?\d+\s*(?:pages?|paragraphs?|words?)$/i, "").trim();
  return t;
}

// A real multi-section plan for when the planner reply is unparseable but the
// ask is clearly essay-shaped: generic units anchored to the question's
// subject, each with a writing instruction and a clean, specific research
// query — never the raw reader sentence handed to a search engine.
export function deriveSectionsFromQuestion(question) {
  const subject = distillSubject(question);
  const S = subject && subject.length <= 120 ? subject : "this topic";
  const templates = [
    { id: "Overview", instruction: `Define ${S} and state the most important facts about it.`, topic: `${S} overview` },
    { id: "History and Background", instruction: `Cover the origins and development of ${S}.`, topic: `history and background of ${S}` },
    { id: "Key Aspects", instruction: `Present the central aspects of ${S} and how they work.`, topic: `key aspects of ${S}` },
    { id: "Current State", instruction: `Describe the current state of ${S}.`, topic: `current state of ${S}` },
    { id: "Importance and Significance", instruction: `Explain why ${S} matters.`, topic: `importance and significance of ${S}` },
  ];
  return templates.slice(0, Math.max(1, Math.min(MAX_ESSAY_SECTIONS, templates.length)));
}

// The DEFINE evaluation: one small model call decides depth, form, units, and
// the compliance contract for this ask. `generate(systemPrompt, userPrompt,
// maxTokens)` is the caller's model seam.
export async function defineAnswerSpec({
  question,
  history = [],
  localEvidence = {},
  webEnabled = false,
  generate,
} = {}) {
  const count = Number.isFinite(localEvidence?.count) ? localEvidence.count : 0;
  const localSummary = count > 0
    ? `${count} passage(s) matched the question locally`
    : "no local source passages matched";
  const user = [
    `Question: ${question}`,
    history.length ? `Recent reader messages: ${history.slice(-3).join(" | ")}` : "",
    `Local source material: ${localSummary}`,
    `Web research enabled: ${webEnabled ? "yes" : "no"}`,
  ].filter(Boolean).join("\n");

  const raw = await generate(PLANNER_SYSTEM_PROMPT, user, 220);
  const parsed = parsePlannerReply(raw);
  let units = parsed.units;
  // A reply that came back with no units but DID independently ask for real
  // length (its own compliance.minWords, not a value we suggested) still
  // wanted structure and just didn't enumerate it — recovered as a real,
  // subject-anchored section breakdown rather than shipped as an empty plan.
  // parsed.depth === "essay" covers the legacy/salvaged-reply case where an
  // explicit depth survived without units.
  const wantsStructure = parsed.depth === "essay" || (parsed.compliance?.minWords || 0) >= STRUCTURED_MIN_WORDS;
  if (!units.length && wantsStructure) {
    units = deriveSectionsFromQuestion(question);
  }
  units = units.slice(0, MAX_ESSAY_SECTIONS);
  const depth = units.length > 0 ? "essay" : "riff";
  return {
    depth, kind: parsed.kind, lookup: parsed.lookup, form: parsed.form, reason: parsed.reason,
    units, compliance: parsed.compliance, sections: units.map((u) => ({ title: u.id, topic: u.topic })), raw,
  };
}

// Normalize web research (researchTopic shape) into the evidence table.
function webEvidenceFromTopic(topic) {
  const out = [];
  const push = (item, kind) => {
    if (!item?.url || !item?.text) return;
    out.push({
      id: `web:${item.url}`,
      source_id: item.url,
      text: item.text,
      title: item.title || item.url,
      url: item.url,
      kind,
    });
  };
  push(topic?.article, topic?.article?.kind || "secondary");
  for (const p of topic?.primarySources || []) push(p, "primary");
  return out;
}

function formDirective(form) {
  if (form === "screenplay") {
    return "Write this unit as a SCREENPLAY scene: a scene heading (an INT./EXT. line), action lines, and character dialogue with the speaker's name in ALL CAPS on its own line.";
  }
  if (form === "code") {
    return "Write this unit as CODE only — no prose, no explanation, no commentary about the code.";
  }
  return "Write in clear prose.";
}

// The writer's folded window: this unit's evidence only, capped, no citation
// numbers, no machinery. The writer is never told to cite.
function buildSectionPrompt({ question, unit, evidence }) {
  const material = evidence
    .map((e, i) => `[${i + 1}]\n${String(e.text).slice(0, PER_ITEM_EVIDENCE_CHARS)}`)
    .join("\n\n");
  const lines = [
    "You are writing ONE unit of a longer piece that answers the reader's question below.",
    `Unit: ${unit.id}`,
    unit.instruction ? `Instructions for this unit: ${unit.instruction}` : "",
    formDirective(unit.form || "prose"),
    "Write ONLY this unit. No heading, no preamble, no closing.",
    "Base every factual claim strictly on the MATERIAL below. If the material does not support something you want to say, leave it out. Brief connective analysis between facts is fine.",
    "Do not mention sources, citations, or the material itself in your writing.",
    "",
    `Reader's question: ${question}`,
    "",
    "MATERIAL:",
    material || "(no material provided — answer from general knowledge, plainly and without invented specifics)",
  ];
  return lines.filter(Boolean).join("\n");
}

// ── EVA: the mechanical compliance evaluator ─────────────────────────────────
//
// Deliberately a pure function of {form, unit, draft, evidence, compliance,
// question} — no model call, nothing the writer could have influenced. It
// measures exactly what a section must prove to be earned: no machinery leak,
// the form's structure actually present, specific names carried by the folded
// evidence, and no figure that the evidence never contained.

// Hard leaks block a section outright; soft ones are advisory (e.g.
// "evidence" / "research" are ordinary scientific prose, "source" is not).
const LEAK_HARD = /\b(sources?|citation(s)?|cited|citing|material(s)?|passage(s)?|verbatim)\b/i;
const LEAK_SOFT = /\b(evidence|research(ed|ing)?|the web|online search|brackets?)\b/i;

// The specificity residual — the same metric longform.js's fidelityResidual
// uses, kept self-contained here so this module stays browser-safe (it must
// not pull in the vendored attribution/svo/morphology trio via longform.js).
// Measured dead end — do not restore plain content-word overlap. Scoring every
// non-stopword absent from the evidence measures COPYING, not fidelity: prose
// that paraphrases well scores identically to prose that fabricates. What
// distinguishes them is SPECIFICITY. A name is the thing a passage can
// actually carry or fail to carry.
const STOP = new Set(("the a an and or but of to in on at for with from by as is are was were be been being that this " +
  "these those it its his her their our your my he she they we you i not no nor so if then than there here what which " +
  "who whom whose when where why how all any both each few more most other some such only own same too very can will " +
  "just should now also into over under between about against during before after above below up down out off again")
  .split(" "));

export function specificsResidual(draft, citedPassages) {
  const words = (s) => String(s || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const evidence = new Set(citedPassages.flatMap((p) => words(p.text)));
  const rawDraft = String(draft || "");
  const specifics = [...new Set(
    (rawDraft.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => !STOP.has(w))
  )];
  if (!specifics.length) {
    // Nothing checkable is not the same as nothing wrong. Reported as a gap so
    // an unverifiable paragraph cannot pass as a verified one.
    return { residual: null, gap: "draft asserts no specific the evidence could carry or contradict", unsupported: [], checked: 0 };
  }
  const unsupported = specifics.filter((w) => !evidence.has(w));
  return {
    residual: unsupported.length / specifics.length,
    unsupported: unsupported.slice(0, 24),
    checked: specifics.length,
    gap: null,
  };
}

// Every numeric token in the draft must be present in some evidence passage or
// in the text the reader/planner itself supplied (the question, the unit
// instruction) — a figure is exactly the kind of claim a passage can carry or
// fail to carry.
function unsupportedNumbers(draft, evidence, allowed) {
  const hay = [evidence.map((e) => String(e.text)).join("\n"), String(allowed || "")].join("\n");
  const nums = [...new Set((String(draft).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, "")))];
  return nums.filter((n) => n && !hay.includes(n));
}

function codeSyntaxFloor(language, content) {
  if (language === "js") {
    try { new Function(content); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
  }
  if (language === "css") {
    const open = (content.match(/{/g) ?? []).length;
    const close = (content.match(/}/g) ?? []).length;
    return open === close ? { ok: true } : { ok: false, reason: `unbalanced braces: ${open} { vs ${close} }` };
  }
  if (language === "html") {
    const hasHtml = /<html[\s>]/i.test(content);
    const hasClose = /<\/html>/i.test(content);
    return hasHtml && hasClose ? { ok: true } : { ok: false, reason: "missing <html>...</html>" };
  }
  return { ok: true };
}

export function evaluateUnit({
  form = "prose",
  unit = {},
  draft = "",
  evidence = [],
  compliance = null,
  question = "",
} = {}) {
  const raw = String(draft || "");
  const violations = [];
  const words = raw.split(/\s+/).filter(Boolean).length;
  const minWords = compliance?.minWords ?? (form === "code" ? 2 : DEFAULT_MIN_WORDS);

  // 1. leak — the delivered writing must not mention the machinery it was
  //    built from, and must not arrive already numbered.
  if (form !== "code") {
    const hard = LEAK_HARD.exec(raw);
    if (hard) {
      violations.push({ type: "leak", severity: "blocker", detail: `the writing mentions the machinery it was built from ("${hard[0]}")` });
    } else {
      const soft = LEAK_SOFT.exec(raw);
      if (soft) violations.push({ type: "leak", severity: "warning", detail: `the writing mentions the machinery it was built from ("${soft[0]}")` });
    }
    if (/\[\d+\]/.test(raw)) {
      violations.push({ type: "leak", severity: "blocker", detail: "a citation number is already written into the prose" });
    }
  }

  // 2. structure — the form's shape must actually be present.
  if (words < minWords) {
    violations.push({ type: "structure", severity: "blocker", detail: `only ${words} words — needs at least ${minWords}` });
  }
  if (form === "screenplay") {
    const shaped = /^\s*(?:INT\.?\s*\.?|EXT\.?\s*\.?|INT\.?\s*\/\s*EXT\.?)\s+[A-Z0-9]/im.test(raw)
      || /^\s*[A-Z][A-Z0-9 '.\-]{1,30}$/m.test(raw);
    if (!shaped) {
      violations.push({ type: "structure", severity: "blocker", detail: "no scene heading or dialogue block — this unit was not written as a screenplay" });
    }
  } else if (form === "code") {
    const lang = compliance?.language || "js";
    const s = codeSyntaxFloor(lang, raw);
    if (!s.ok) violations.push({ type: "structure", severity: "blocker", detail: `code syntax floor: ${s.reason}` });
  }

  // 3. carry — evidence-backed specifics and figures, only when evidence exists.
  const specifics = { residual: null, unsupported: [], checked: 0 };
  if (evidence.length) {
    const res = specificsResidual(raw, evidence.map((e) => ({ text: e.text })));
    specifics.residual = res.residual;
    specifics.unsupported = res.unsupported;
    specifics.checked = res.checked;
    if (res.gap) {
      violations.push({ type: "carry", severity: "warning", detail: res.gap });
    } else if (res.residual > 0) {
      violations.push({
        type: "carry",
        severity: res.residual > 0.5 ? "blocker" : "warning",
        detail: `${(res.residual * 100).toFixed(0)}% of specific names are not carried by the evidence` +
          (res.unsupported.length ? ` (e.g. ${res.unsupported.slice(0, 4).join(", ")})` : ""),
        unsupported: res.unsupported,
      });
    }
    const allowed = [unit.id, unit.instruction, question, ...(compliance?.require || []), ...(compliance?.forbid || [])].filter(Boolean).join("\n");
    for (const f of unsupportedNumbers(raw, evidence, allowed)) {
      violations.push({ type: "figure", severity: "blocker", detail: `the figure "${f}" appears in no evidence passage` });
    }
  }

  const compliant = !violations.some((v) => v.severity === "blocker");
  return { compliant, violations, residual: specifics.residual, specifics: specifics.checked };
}

// ── REC: one bounded revision toward the flagged violations ──────────────────
export async function reconcileUnit({
  question,
  unit,
  form,
  draft,
  evidence,
  violations,
  compliance,
  generate,
  maxTokens = 1000,
} = {}) {
  const sys = `You are rewriting ONE unit of a longer piece to pass its compliance review. Fix ONLY the violations listed. Keep the unit's assigned form (${form}). Base every claim strictly on the PASSAGES. Never mention sources, citations, or the material itself in the writing.`;
  const user = [
    `Unit: ${unit.id}`,
    unit.instruction ? `Instructions for this unit: ${unit.instruction}` : "",
    compliance?.require?.length ? `Required of the finished answer: ${compliance.require.join("; ")}` : "",
    `Reader's question: ${question}`,
    "",
    "YOUR DRAFT — rewrite it, fixing ONLY the listed violations:",
    String(draft || ""),
    "",
    "REVIEW FLAGS:",
    violations.map((v) => `- [${v.type}] ${v.detail}`).join("\n") || "(none)",
    "",
    "PASSAGES:",
    evidence.length
      ? evidence.map((e, i) => `[${i + 1}]\n${String(e.text).slice(0, PER_ITEM_EVIDENCE_CHARS)}`).join("\n\n")
      : "(no passages — write plainly, invent no specifics)",
  ].filter(Boolean).join("\n");
  return generate(sys, user, maxTokens);
}

/**
 * Runs the essay path for one turn — the DEFINE → EVALUATE → RECONCILE loop.
 *
 * `generate(systemPrompt, userPrompt, maxTokens)` — the writer call (the
 * DEFINE evaluation is a separate, earlier call in defineAnswerSpec).
 * `localRetrieve(topic)` — engine grounding for one unit topic; returns the
 *   same citation shape engine-ground returns ({span_id, source_id, text}).
 * `webResearch(topic)` — researchTopic() or null when the Web toggle is off.
 *
 * Returns `{ text, form, sections, citations, references, gaps, ungrounded,
 * sufficiency, dropped }` where `text` is the assembled piece with
 * mechanically-attached brackets, `citations` is the global numbered table the
 * brackets resolve to, `references` is the provenance list (titles + URLs,
 * primary vs secondary), `gaps` names every dropped and ungrounded unit,
 * `sufficiency` is the per-unit earn-or-drop report, and `dropped` counts the
 * units that failed their compliance review.
 */
export async function runHolonicEssay({
  question,
  sections = [],
  form = "prose",
  compliance = null,
  generate,
  localRetrieve,
  webResearch,
  webEnabled = false,
  sectionTokens = DEFAULT_SECTION_TOKENS,
  reconcileRounds = DEFAULT_RECONCILE_ROUNDS,
  onProgress = null,
} = {}) {
  const emit = (event) => { if (onProgress) { try { onProgress(event); } catch { /* a listener's failure must not abort the essay */ } } };
  const globalCitations = [];
  const sectionRecords = [];
  const sufficiency = [];
  const gaps = [];
  const references = new Map(); // key -> {kind, title, url, source_id}

  const plan = (sections && sections.length ? sections : deriveSectionsFromQuestion(question))
    .map((u) => normalizeUnit(u))
    .filter(Boolean)
    .map((u) => ({ ...u, form }))
    .slice(0, MAX_ESSAY_SECTIONS);

  emit({ phase: "plan", depth: "essay", form, sections: plan.length });

  for (let i = 0; i < plan.length; i++) {
    const unit = plan[i];
    const startIndex = globalCitations.length;
    emit({ phase: "section_start", id: unit.id, index: i + 1, total: plan.length });

    // ── research this unit's own small evidence set ──
    let local = [];
    try { local = (await localRetrieve(unit.topic)) || []; } catch { local = []; }
    local = local.map((c) => ({ id: `local:${c.span_id}`, ...c }));

    const thin = local.length < THIN_LOCAL_ITEMS || local.reduce((n, c) => n + (c.text?.length || 0), 0) < THIN_LOCAL_CHARS;
    let web = [];
    if (webEnabled && webResearch && thin) {
      try {
        web = ((await webResearch(unit.topic)) || []).map(webEvidenceFromTopic).flat();
      } catch { web = []; }
    }
    emit({ phase: "section_research", id: unit.id, local: local.length, web: web.length, thin, localPassages: local, webPassages: web });

    const evidence = [...local, ...web];

    // ── write with a small folded window: this unit's evidence only ──
    let draft = "";
    let writeErr = null;
    try {
      draft = await generate(
        "You are a section writer. Follow the instructions in the prompt.",
        buildSectionPrompt({ question, unit, evidence }),
        sectionTokens,
      );
    } catch (err) {
      writeErr = err;
    }
    if (writeErr) {
      gaps.push({ type: "section_failed", reason: `"${unit.id}" — ${writeErr.message}` });
      emit({ phase: "section_failed", id: unit.id, reason: writeErr.message });
      sufficiency.push({ id: unit.id, compliant: false, dropped: true, reconciled: 0, residual: null, violations: [{ type: "failure", severity: "blocker", detail: writeErr.message }] });
      continue;
    }

    // ── EVA ──
    let eva = evaluateUnit({ form, unit, draft, evidence, compliance, question });
    emit({ phase: "section_evaluated", id: unit.id, compliant: eva.compliant, residual: eva.residual, violations: eva.violations.map((v) => v.type) });

    // ── REC — bounded revision toward the flagged violations ──
    let reconciled = 0;
    while (!eva.compliant && reconciled < reconcileRounds) {
      let revised = null;
      try {
        revised = await reconcileUnit({ question, unit, form, draft, evidence, violations: eva.violations, compliance, generate, maxTokens: sectionTokens });
      } catch { revised = null; }
      if (!revised || !String(revised).trim()) break;
      draft = String(revised).trim();
      reconciled++;
      eva = evaluateUnit({ form, unit, draft, evidence, compliance, question });
      emit({ phase: "section_reconciled", id: unit.id, round: reconciled, compliant: eva.compliant, violations: eva.violations.map((v) => v.type) });
    }

    const sufficiencyEntry = { id: unit.id, compliant: eva.compliant, reconciled, residual: eva.residual, violations: eva.violations };
    const blockers = eva.violations.filter((v) => v.severity === "blocker");

    if (!eva.compliant && evidence.length) {
      // Earn-or-drop: never ship a section that did not pass its review.
      gaps.push({
        type: "unit_dropped",
        reason: `"${unit.id}" did not pass its compliance review` + (blockers.length ? ` — ${blockers.map((b) => b.detail).join("; ")}` : ""),
      });
      emit({ phase: "unit_dropped", id: unit.id, violations: blockers.map((b) => b.type) });
      sufficiency.push({ ...sufficiencyEntry, dropped: true });
      continue;
    }

    // ── ship: proven when evidence exists, honestly labeled when not ──
    const numbered = evidence.map((e, idx) => ({ ...e, index: startIndex + idx + 1 }));
    let text = autoAttachCitations(draft, numbered);
    text = text.trim();

    const citedNums = new Set();
    const bracketRe = /\[(\d+)\]/g;
    let m;
    while ((m = bracketRe.exec(text))) citedNums.add(Number(m[1]));

    const sectionCites = numbered.filter((c) => citedNums.has(c.index));
    for (const c of sectionCites) globalCitations.push(c);
    for (const c of numbered) {
      const key = c.source_id || c.span_id;
      if (key) references.set(key, { kind: c.kind || (c.url ? "secondary" : "local"), title: c.title || key, url: c.url || "", source_id: key });
    }

    const ungrounded = !evidence.length;
    if (ungrounded) {
      gaps.push({ type: "ungrounded_section", reason: `"${unit.id}" — no local or web material supported it; written from general knowledge, uncited.` });
      emit({ phase: "section_ungrounded", id: unit.id });
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const record = {
      id: unit.id,
      title: unit.id,
      text,
      cited: sectionCites.length,
      ungrounded,
      compliant: eva.compliant,
      reconciled,
    };
    sectionRecords.push(record);
    sufficiency.push({ ...sufficiencyEntry, dropped: false, cited: sectionCites.length, words, ungrounded });
    emit({ phase: "section_written", id: unit.id, words, cited: sectionCites.length, ungrounded, compliant: eva.compliant, reconciled });
  }

  // ── assemble ──
  const text = sectionRecords.length
    ? sectionRecords.map((s) => `## ${s.id}\n\n${s.text}`).join("\n\n")
    : "None of the planned sections passed review and could be written.";

  const referenceList = [...references.values()];
  const dropped = sufficiency.filter((s) => s.dropped).length;
  emit({ phase: "assemble", sections: sectionRecords.length, references: referenceList.length, dropped });

  return {
    text,
    form,
    sections: sectionRecords,
    citations: globalCitations.map((c, i) => ({ index: i + 1, span_id: c.span_id, source_id: c.source_id, text: c.text })),
    references: referenceList,
    gaps,
    ungrounded: sectionRecords.filter((s) => s.ungrounded),
    sufficiency,
    dropped,
  };
}
