// Music whose MATERIAL comes from a recording and whose FORM comes from a book.
//
// This is the omnimodal claim under load. Two media, two layers, one set of
// production rules:
//
//   material  <- motion prior derived from real orchestral audio
//                (semitone steps, durations; transposition-invariant, so it is
//                 a statement about how the music MOVES, never about which
//                 pitches it used — a prior keyed to absolute pitch would be
//                 naming things)
//   form      <- Frankenstein's frame narrative, DISCOVERED from the text
//
// The form is the interesting half. Frankenstein nests: Walton's letters
// contain Victor's account, which contains the creature's. Encoding that by
// saying "a letter is above a chapter" would be assigning a scale, which
// holon-level.md forbids. So it is earned instead, from a test that would work
// on a leitmotif just as well as on prose:
//
//   A section whose PRESIDING REFERENT was first admitted in an earlier section
//   cannot exist without that section. The creature speaks only because Victor
//   made him; Victor speaks only because Walton found him. That is
//   existence-dependency, and it is what produces the level relation — not the
//   words "letter" and "chapter", which this file never inspects.
//
// Which surfaces predicate one being is MODEL-tier knowledge, so it is injected
// from live_priors coref priors and never derived here.
// Missing prior => typed gap, never a silently wrong nesting.

import fs from "node:fs";
import path from "node:path";
import { PRIORS_ROOT } from "./paths.js";

/** Load a derived motion prior (see scripts/derive-audio-prior.mjs). */
export function loadMotionPrior(id = "music-motion-overture") {
  const p = path.join(PRIORS_ROOT, "priors", `${id}.json`);
  if (!fs.existsSync(p)) {
    // A missing prior is a typed gap. Substituting invented weights here would
    // be exactly the fabrication this project treats as the cardinal
    // regression — the music would sound authored-by-nobody and claim a source.
    return { gap: `motion prior "${id}" not found at ${p} — derive it first`, prior: null };
  }
  return { gap: null, prior: JSON.parse(fs.readFileSync(p, "utf8")) };
}

/** Load the per-text coref prior. Witness-tier: injected, never derived. */
export function loadCorefPrior(id = "pg84-frankenstein") {
  const p = path.join(PRIORS_ROOT, "priors", "coref", `${id}.json`);
  if (!fs.existsSync(p)) {
    return { gap: `coref prior "${id}" not found — narrative nesting cannot be earned without it`, prior: null };
  }
  return { gap: null, prior: JSON.parse(fs.readFileSync(p, "utf8")) };
}

/**
 * Resolve an anchor quote to an offset.
 *
 * Anchors are stored as QUOTES and resolved at apply time, never as raw
 * offsets — raw offsets rot the moment the text is renormalized, and this
 * project has had that failure more than once. Matching is whitespace-flexible
 * because a quote may sit across a line wrap in the source.
 */
export function resolveAnchor(text, quote, from = 0) {
  if (!quote) return -1;
  const direct = text.indexOf(quote, from);
  if (direct !== -1) return direct;
  // Whitespace-flexible retry: any run of whitespace in the quote may match any
  // run in the text.
  const pattern = quote
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const m = new RegExp(pattern).exec(text.slice(from));
  return m ? from + m.index : -1;
}

/**
 * Earn the narrative nesting from injected narrator spans.
 *
 * `narratorSpans` in the coref prior say where a referent is the one speaking.
 * Frankenstein nests because the creature narrates from INSIDE Victor's
 * account, which sits inside Walton's letters. A section falling within a
 * narrator span is therefore one the frame had to open before it could occur —
 * it cannot exist without it. That is existence-dependency established by
 * containment of resolved offsets, and nothing here reads the words "letter" or
 * "chapter" to reach it.
 *
 * Depth is COUNTED from containment, not assigned. A section contained by no
 * span is at the outer frame; a section inside one is deeper. Sections that
 * share a depth and no containment are PEERS — a first-class result.
 */
export function earnNesting(text, sections, corefPrior) {
  const gaps = [];
  const spans = [];

  for (const ref of corefPrior.referents ?? []) {
    for (const s of ref.narratorSpans ?? []) {
      const start = resolveAnchor(text, s.fromAnchor);
      // The closing anchor must come after the opening one.
      const end = s.toAnchor ? resolveAnchor(text, s.toAnchor, start + 1) : text.length;
      if (start === -1) {
        // Unresolvable anchor is a typed gap, never a guessed offset.
        gaps.push(`narrator anchor did not resolve: "${String(s.fromAnchor).slice(0, 48)}…" — no nesting earned from it`);
        continue;
      }
      spans.push({
        referent: ref.id ?? ref.display,
        start,
        end: end === -1 ? text.length : end,
        fromAnchor: s.fromAnchor,
      });
    }
  }

  const nodes = sections.map((s, i) => {
    const a = s.bodyStart ?? s.start;
    const b = s.end;
    const mid = Math.floor((a + b) / 2);
    // Containing spans, by the section's midpoint — a section straddling a
    // frame boundary belongs to whichever frame holds most of it.
    const containing = spans.filter((sp) => mid >= sp.start && mid < sp.end);
    return {
      index: i,
      section: s,
      start: a,
      end: b,
      // Depth is the count of frames that had to be open for this to occur.
      depth: containing.length,
      narratedBy: containing.length ? containing[containing.length - 1].referent : null,
      containing,
    };
  });

  // depends_on: the nearest EARLIER section at a shallower depth — the one that
  // had to open the frame this section speaks inside of.
  for (let i = 0; i < nodes.length; i++) {
    let dep = null;
    for (let j = i - 1; j >= 0; j--) {
      if (nodes[j].depth < nodes[i].depth) { dep = j; break; }
    }
    nodes[i].depends_on_index = dep;
    if (nodes[i].depth > 0 && dep === null) {
      gaps.push(`section ${i} ("${nodes[i].section.label}") is inside a narrator frame but no shallower section precedes it — nesting not earned`);
    }
  }

  return { nodes, spans, gaps };
}
