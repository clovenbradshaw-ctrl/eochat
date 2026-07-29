import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compose } from "./compose-sonata.js";
import { witnessAnanda, LENSES, AUDIT_QUESTION } from "./sonata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── The load-bearing test ──
//
// "Does removing the mechanism change what's rewarded, or only what's
// forbidden?" If ablating the ananda organ changes a single note, we built a
// seeker with better manners. This is the Buber test made mechanical.
test("ABLATION: removing the ananda witness changes nothing about the music", () => {
  const withWitness = compose({ seed: 20260729 });
  const events = witnessAnanda(withWitness.motifs); // observe — must not feed back
  const again = compose({ seed: 20260729 });

  assert.deepEqual(again.notes, withWitness.notes,
    "composing again after witnessing produced different notes — the witness leaked into the composer");
  assert.ok(Array.isArray(events));

  // And the composer must be structurally incapable of consulting it. Comments
  // are stripped first: a comment explaining WHY the witness is absent is the
  // documentation this wall depends on, and must not be what trips the check.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const material = stripComments(fs.readFileSync(path.join(__dirname, "sonata-material.js"), "utf8"));
  const composer = stripComments(fs.readFileSync(path.join(__dirname, "compose-sonata.js"), "utf8"));
  assert.ok(!/from\s+["'].*\bsonata\.js["']/.test(material),
    "sonata-material.js imports the witness — the wall is only a comment now");
  assert.ok(!/from\s+["'].*\bsonata\.js["']/.test(composer),
    "compose-sonata.js imports the witness — the composer can be steered by it");
  assert.ok(!/witnessAnanda|LENSES/.test(material + composer),
    "the composition path references the witness in executable code");
});

test("the witness is permitted to fail permanently — nothing retries or widens", () => {
  const { motifs } = compose({ seed: 7 });
  // An impossible tolerance must simply yield nothing, forever, without the
  // organ compensating. A system that "usually" converges has made convergence
  // the attractor (Levinas).
  const none = witnessAnanda(motifs, { tolerance: -1 });
  assert.deepEqual(none, [], "a permanently-failing witness must stay empty");

  // And failing changes no note.
  const a = compose({ seed: 7 });
  assert.deepEqual(a.notes, compose({ seed: 7 }).notes);
});

test("every witness entry carries irreducible residue and refuses finalization", () => {
  const { motifs } = compose({ seed: 20260729 });
  const events = witnessAnanda(motifs, { tolerance: 1 }); // force some entries
  assert.ok(events.length > 0, "tolerance 1 should admit entries to inspect");
  for (const e of events) {
    assert.equal(e.finalizable, false, "an entry that may be finalized has ended the dialogue");
    assert.match(e.residue, /not recoverable/,
      "an entry without permanent residue is testimony repackaged as a spec (Bakhtin)");
  }
});

test("lenses are computed in real exclusion — each sees only the motif", () => {
  const { motifs } = compose({ seed: 3 });
  const m = motifs[0];
  for (const [name, lens] of Object.entries(LENSES)) {
    assert.equal(lens.length, 1, `${name} takes more than the motif — it can see context it must not`);
    const v = lens(m);
    assert.ok(v >= 0 && v <= 1, `${name} returned ${v}, outside [0,1]`);
    // Pure: same input, same output, no accumulated state.
    assert.equal(lens(m), v, `${name} is not pure`);
  }
});

// ── The music itself ──

test("sonata form is PRODUCED by SEG/CON/SYN, not encoded as a template", () => {
  const { tasks, closure } = compose({ seed: 20260729 });
  const op = (id) => tasks.find((t) => t.task_id === id)?.operator;

  assert.equal(op("exposition/first"), "SEG", "subjects differentiate");
  assert.equal(op("exposition/second"), "SEG");
  assert.equal(op("development"), "CON", "development relates the two subjects");
  assert.equal(op("recapitulation/second"), "SYN", "resolution exists only across the exposition");

  assert.equal(closure.closed, true, "production must reach operational closure");
  assert.equal(closure.halted_by, "operational-closure", "not a depth ceiling, not a guard");
});

test("the recapitulation's resolution is earned by existence-dependency", () => {
  const { tasks, levels } = compose({ seed: 20260729 });
  const recap = tasks.find((t) => t.task_id === "recapitulation/second");

  // It cannot exist without the exposition having put the subject elsewhere.
  assert.ok(recap.depends_on.includes("exposition/second"),
    "the resolution must depend on the tension it resolves");
  const depth = (id) => levels.find((l) => l.task_id === id).depth;
  assert.ok(depth("recapitulation/second") > depth("exposition/second"),
    "level is derived from dependency, and the recapitulation is below what it needs");
});

test("the second subject leaves home and comes back — audibly, not by assertion", () => {
  const { tasks } = compose({ seed: 20260729 });
  const expo = tasks.find((t) => t.task_id === "exposition/second");
  const recap = tasks.find((t) => t.task_id === "recapitulation/second");
  assert.equal(expo.key, 7, "second subject is stated away from the tonic");
  assert.equal(recap.key, 0, "and returns to it");
  assert.equal(expo.motif.referent_id, recap.motif.referent_id,
    "and it is the SAME referent — identity lives in the referent, not a label");
});

test("notes are real, ordered, and in range", () => {
  const { notes } = compose({ seed: 20260729 });
  assert.ok(notes.length > 40, `only ${notes.length} notes`);
  for (const n of notes) {
    assert.ok(Number.isFinite(n.pitch) && n.pitch > 20 && n.pitch < 108, `pitch ${n.pitch} out of range`);
    assert.ok(n.dur > 0, "zero-length note");
  }
  const starts = notes.map((n) => n.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "notes are not in time order");
});

test("same seed, same sonata — noise is an input, not an ambient accident", () => {
  assert.deepEqual(compose({ seed: 42 }).notes, compose({ seed: 42 }).notes);
  assert.notDeepEqual(compose({ seed: 42 }).notes, compose({ seed: 43 }).notes);
});

test("nothing in the composition path names a pitch", () => {
  // Omnimodal discipline: if a decision depended on a note NAME, the design
  // would be string-thinking. Spelling exists only for humans reading output.
  const material = fs.readFileSync(path.join(__dirname, "sonata-material.js"), "utf8");
  const composer = fs.readFileSync(path.join(__dirname, "compose-sonata.js"), "utf8");
  assert.ok(!/["'](?:[A-G]#?\d|do|re|mi|fa|sol|la|ti)["']/.test(material + composer),
    "a pitch name appears in the composition path");
});

test("the audit question is stated, because no architecture catches it", () => {
  assert.match(AUDIT_QUESTION, /design spec/);
});
