// holonic-chat.js — the unified chat orchestrator.
//
// Every normal chat turn runs through holonic planning here: ONE model
// planner call decides depth per ask — a riff (short, direct, marked
// ungrounded when nothing backs it) or an essay (multi-section). Essays
// research each section in its own small, folded context window (only that
// section's evidence), write it without the writer ever seeing evidence
// tables or citation numbers, and prove the prose with MECHANICAL post-hoc
// citations (autoAttachCitations' n-gram match, verbatim clause as proof).
//
// The talking model never sees the machinery: no planner output, no evidence
// lists, no fold/gate vocabulary — just "here is the material for your
// section; write it." Everything holonic (plan, sections, research hops,
// provenance) is carried on the returned shape and through onProgress events
// for the UI's Thinking block, never through the prose.
//
// Backend-agnostic exactly like longform-orchestrator.js: `generate` is the
// caller's seam, so this module drives either the server's Ollama/Anthropic
// calls or a browser WebLLM adapter unchanged.

import { autoAttachCitations } from "./citation-check.js";

// ── bounds ──
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

const PLANNER_SYSTEM_PROMPT = `You are the planner for a writing assistant. Decide how deeply THIS ONE reader question should be answered.

Depth options:

- "riff": a short, direct conversational reply. Use for simple questions, greetings, acknowledgments, follow-ups, clarifications, or any question that wants a quick answer. One short paragraph or a few sentences. No sections.
- "essay": a structured multi-section piece. Use when the reader explicitly asks for an essay, report, paper, or "N pages", OR when the question needs several distinct facts or angles to answer well and the reader's phrasing implies weight.

Follow-up questions that reference what the assistant just said are riffs even if the original question was an essay.

Reply with ONLY a JSON object. No prose, no code fences, no commentary:

{"depth":"riff"|"essay","reason":"one short sentence justifying the depth","sections":[{"title":"short section title","topic":"the focused query used to research this section"}]}

- For "riff" set "sections":[].
- For "essay" give 3-6 sections. Each "topic" must be a specific, self-contained research query for that section — the engine will look it up on its own.`;

// Robust JSON extraction: strip fences, take the first balanced {...} span.
export function parsePlannerReply(raw) {
  const text = String(raw || "").replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start > -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && (parsed.depth === "riff" || parsed.depth === "essay")) {
        return {
          depth: parsed.depth,
          reason: String(parsed.reason || ""),
          sections: Array.isArray(parsed.sections)
            ? parsed.sections
                .filter((s) => s && s.title && s.topic)
                .map((s) => ({ title: String(s.title).slice(0, 90), topic: String(s.topic).slice(0, 160) }))
            : [],
        };
      }
    } catch { /* fall through to heuristic */ }
  }
  // The model sometimes gets the depth field right and then corrupts the
  // rest of the JSON — e.g. a small model echoing this prompt's own
  // `"riff"|"essay"` type union literally into its reply, which drags the
  // word "essay" into a reply whose actual depth field said "riff". Salvage
  // that field directly before falling back to scanning the whole reply for
  // essay-shaped words, so a model's genuine (if malformed) "riff" answer
  // isn't overridden by its own leaked schema syntax — observed in practice
  // with small local models (e.g. llama3.2:1b turning a plain "hello there"
  // into a full multi-section essay because its broken reply still
  // contained the literal substring "essay").
  const depthField = text.match(/"depth"\s*:\s*"(riff|essay)"/i);
  if (depthField) {
    return { depth: depthField[1].toLowerCase(), reason: "planner reply unparseable — salvaged depth field", sections: [] };
  }
  // Heuristic fallback: an essay-shaped ask the model failed to parse.
  const depth = /(essay|report|paper|"\d+\s*pages?"|five\s+page|5\s+page|long[\s-]form)/i.test(text) ? "essay" : "riff";
  return { depth, reason: "planner reply unparseable — heuristic depth", sections: [] };
}

export async function planChatTurn({
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
  const depth = parsed.depth === "essay" ? "essay" : "riff";
  return {
    depth,
    reason: parsed.reason,
    sections: depth === "essay" ? parsed.sections.slice(0, MAX_ESSAY_SECTIONS) : [],
    raw,
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

// The writer's folded window: this section's evidence only, capped, no
// citation numbers, no machinery. The writer is never told to cite.
function buildSectionPrompt({ question, section, evidence }) {
  const material = evidence
    .map((e, i) => `[${i + 1}]\n${String(e.text).slice(0, PER_ITEM_EVIDENCE_CHARS)}`)
    .join("\n\n");
  const lines = [
    "You are writing ONE section of an essay that answers the reader's question below.",
    `Section: ${section.title}`,
    "Write only this section, in clear prose, 3-6 sentences. No heading, no preamble, no closing.",
    "Base every factual claim strictly on the MATERIAL below. If the material does not support something you want to say, leave it out. Brief connective analysis between facts is fine.",
    "Do not mention sources, citations, numbers, or the material itself in your prose.",
    "",
    `Reader's question: ${question}`,
    "",
    "MATERIAL:",
    material || "(no material provided — answer from general knowledge, plainly and without invented specifics)",
  ];
  return lines.join("\n");
}

/**
 * Runs the essay path for one turn.
 *
 * `generate(systemPrompt, userPrompt, maxTokens)` — the writer call (the
 * planner's is a separate, earlier call in planChatTurn).
 * `localRetrieve(topic)` — engine grounding for one section topic; returns the
 *   same citation shape engine-ground returns ({span_id, source_id, text}).
 * `webResearch(topic)` — researchTopic() or null when the Web toggle is off.
 *
 * Returns `{ text, sections, citations, references, gaps }` where `text` is
 * the assembled essay with mechanically-attached brackets, `citations` is the
 * global numbered table the brackets resolve to, `references` is the
 * provenance list (titles + URLs, primary vs secondary), and `gaps` names
 * every ungrounded section and empty research hop.
 */
export async function runHolonicEssay({
  question,
  sections,
  generate,
  localRetrieve,
  webResearch,
  webEnabled = false,
  sectionTokens = DEFAULT_SECTION_TOKENS,
  onProgress = null,
} = {}) {
  const emit = (event) => { if (onProgress) { try { onProgress(event); } catch { /* a listener's failure must not abort the essay */ } } };
  const globalCitations = [];
  const sectionRecords = [];
  const gaps = [];
  const references = new Map(); // key -> {kind, title, url, source_id}

  const plan = sections && sections.length ? sections : [{ title: "Overview", topic: question }];
  emit({ phase: "plan", depth: "essay", sections: plan.length });

  for (let i = 0; i < plan.length; i++) {
    const section = plan[i];
    const startIndex = globalCitations.length;
    emit({ phase: "section_start", id: section.title, index: i + 1, total: plan.length });

    // ── research this section's own small evidence set ──
    let local = [];
    try { local = (await localRetrieve(section.topic)) || []; } catch { local = []; }
    local = local.map((c) => ({ id: `local:${c.span_id}`, ...c }));

    const thin = local.length < THIN_LOCAL_ITEMS || local.reduce((n, c) => n + (c.text?.length || 0), 0) < THIN_LOCAL_CHARS;
    let web = [];
    if (webEnabled && webResearch && thin) {
      try {
        const topics = await webResearch(section.topic) || [];
        web = topics.map(webEvidenceFromTopic).flat();
      } catch { web = []; }
    }
    emit({ phase: "section_research", id: section.title, local: local.length, web: web.length, thin });

    const evidence = [...local, ...web];

    // ── write with a small folded window: this section's evidence only ──
    let draft = "";
    try {
      draft = await generate(
        "You are a section writer. Follow the instructions in the prompt.",
        buildSectionPrompt({ question, section, evidence }),
        sectionTokens,
      );
    } catch (err) {
      gaps.push({ type: "section_failed", reason: `"${section.title}" — ${err.message}` });
      emit({ phase: "section_failed", id: section.title, reason: err.message });
      continue;
    }

    if (!evidence.length) {
      gaps.push({ type: "ungrounded_section", reason: `"${section.title}" — no local or web material supported it; written from general knowledge, uncited.` });
      emit({ phase: "section_ungrounded", id: section.title });
    }

    // ── mechanical post-hoc citation: the prose is proven, not the plan ──
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

    const words = text.split(/\s+/).filter(Boolean).length;
    sectionRecords.push({
      title: section.title,
      text,
      cited: sectionCites.length,
      ungrounded: !evidence.length,
    });
    emit({ phase: "section_written", id: section.title, words, cited: sectionCites.length, ungrounded: !evidence.length });
  }

  // ── assemble ──
  const text = sectionRecords.length
    ? sectionRecords.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n")
    : "None of the planned sections could be written.";

  const referenceList = [...references.values()];
  emit({ phase: "assemble", sections: sectionRecords.length, references: referenceList.length });

  return {
    text,
    sections: sectionRecords,
    citations: globalCitations.map((c, i) => ({ index: i + 1, span_id: c.span_id, source_id: c.source_id, text: c.text })),
    references: referenceList,
    gaps,
    ungrounded: sectionRecords.filter((s) => s.ungrounded),
  };
}
