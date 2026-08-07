// eochat/server · narrative-longform — task-log.js's append-only, self-
// producing, no-lookahead structure, ported from evidence-grounded essays
// (longform.js) to invented fiction.
//
// task-log.js's own header licenses this directly: "The log is medium-
// agnostic — it knows about structure, not about what the structure is made
// of." longform.js's payload is retrieved passages; this file's payload is
// STORY THREADS (roster entries, motifs, commitments) — same log, same
// produce()/foldToWorkingSet()/append-only-supersede discipline, different
// domain. specs/composition-is-retrieval.md is the design record this
// implements; read it for why the shape is this and not a fixed outline.
//
// ── WHAT THIS REPLACES, AND WHY ────────────────────────────────────────────
//
// holonic-task.js already has a creative-writing path (`groundingMode:
// "none"` for scene/dialogue/stanza node types) and it has the defect
// eoreader6/scripts/write-novella.mjs's header records: `plan()` commits a
// fixed scene outline up front (a lookahead commitment surf/fold's own
// doctrine refuses on the reading side), and continuity is carried as
// `previousSections.slice(0, 800)` — always the OPENING of the manuscript,
// never what was just written. Five independently-generated essay sections
// produced from that shape each cold-started ("Sea turtles are..." x5,
// measured on sea-turtles-essay.md).
//
// Here, no scene plan exists until it is proposed. `produce()` fires one
// scene at a time; a scene may itself propose new open threads (a planted
// commitment becomes a task nothing before it could have produced); a
// commitment's own `depends_on` is a genuine existence-dependency (it cannot
// exist without the scene that planted it) rather than an index into a fixed
// array. Production halts at operational closure — no open thread, nothing
// new proposed — which is DISCOVERED, never a declared scene count.
//
// ── LEGALITY, NOT A FIXED PLAN ─────────────────────────────────────────────
//
// `nextMove()` below is a small, declared, deterministic state machine — not
// a model call — because Rubin's constraint intersection and Johnstone's
// offer/accept both say the candidate set should be narrowed by STRUCTURAL
// LEGALITY before anything is generated, not filtered from a free model
// proposal after the fact. It is a first concrete instance of "type-scene
// legality", not the general mechanism specs/composition-is-retrieval.md §3
// describes — a genuine narrowing rule (e.g. the coordinate cannot be planted
// before Voss's logbook exists) rather than the general skeleton system.
//
// ── THE MOUTH, REUSED EXACTLY ──────────────────────────────────────────────
//
// Every scene prompt is built from `foldToWorkingSet(openThreads, {k})` —
// the SAME "the mouth" primitive longform.js already uses for essay
// evidence, with the SAME measured justification (task-log.js: 8 passages in
// one prompt produced a 27,471-character system message and the single
// token "[7]"). A story's open threads never exceed k regardless of how many
// scenes have already been written — this is the fixed-size retrieval cue
// specs/composition-is-retrieval.md's Ericsson-Kintsch section argues for,
// not a new mechanism.
//
// Placement: this file is model routing (fetches Ollama) and lives in
// eochat/server — an application, per eo-constitution I.4. It imports the
// pure log/fold primitives from task-log.js and nothing here would be legal
// inside eoreader6/scripts.
//
// ── GENERIC OVER ANY STORY, NOT JUST THIS ONE ──────────────────────────────
//
// The first version of this file had the lighthouse story's own beats
// hardcoded inside `nextMove` and `buildScenePrompt` — a literal
// `if (!has("entity:logbook"))` check and a literal "Mara retrieves the
// washed-up object..." string sitting in what was supposed to be the generic
// engine. That is the SAME mistake the essay-editing loop made on the
// reading side (a fixed plan baked into code instead of declared as data),
// committed again on the writing side. `WORLD_SCHEMA` below is the fix:
// every piece of content a story needs — its opening beat, what entities
// introduce when, what commitments plant/resolve under what legality, what
// connective beats fill quiet scenes, its prose style and length target — is
// DECLARED on the world object. `nextMove` and `buildScenePrompt` read only
// the schema's shape, never a specific story's content. `LIGHTHOUSE_WORLD` is
// one instance; narrative-longform.test.js proves a second, structurally
// unrelated world (a heist, not a mystery — its own entities, its own
// commitment chain, its own style) drives the identical functions to a clean
// operational-closure with zero code changes.
//
// ── THE TWO SEAMS A DIFFERENT MODALITY WOULD REPLACE ───────────────────────
//
// Per the constitution's II.11 (the omnimodal earning test), medium-
// agnosticism is EARNED by an invariance fixture, never asserted — so this is
// a stated DESIGN INTENTION, not a claim already proven. Everything above
// `renderSceneText` and `verifyPayoff` (the world schema, `nextMove`,
// `task-log.js`'s produce/append/fold) never inspects prose, a token, or a
// word — it reasons over entities, commitments, cooldowns and existence-
// dependencies, which a musical phrase, an image sequence, or a chunk
// sequence have exactly as much as a scene does. Two functions are where
// TEXT enters:
//
//   renderSceneText(move, ...) -> string   asks a model for PROSE. A music
//     organ would ask a model (or a Markov belief, per generation/belief.js)
//     for a MIDI phrase instead; an image organ for a frame description.
//   verifyPayoff(text, checkTerms) -> bool  substring-matches WORDS. A music
//     organ would need a motif-recurrence detector (pitch/rhythm contour, not
//     text) over the rendered audio; an image organ a visual-feature check.
//
// Swapping those two and leaving `nextMove`/task-log untouched is the actual
// experiment that would EARN the omnimodal claim. It has not been run — this
// header states the seam, not the result.

import {
  createTaskLog, append, projectTasks, produce, foldToWorkingSet,
  proposeDiscovered, checkCubeProgression, ENTRY_KINDS, OPERATOR_BASIS,
} from "./task-log.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const TEMPERATURE = 0.75;
// Measured: 340 cut a scene off mid-sentence ("a journey into the unknown
// beckoned, one that only she") on a 220-260 word target — llama3.2 runs
// verbose enough that 340 tokens for ~250 words left no closing headroom.
// DEFAULT only — a world with a bigger targetWords range (chapter-scale
// prose, not LIGHTHOUSE_WORLD's 220-260-word scenes) needs a bigger budget
// or every real scene truncates mid-sentence regardless of what the prompt
// asks for. Declared as an overridable option on writeNarrative (below)
// rather than left a silent constant a bigger world would collide with —
// the same "declared budget, not a buried constant" discipline
// foldToWorkingSet's own `k` argument already models.
const DEFAULT_SCENE_TOKENS = 420;
const TAIL_WORDS = 80;
const WORKING_SET_K = 7; // task-log.js's own declared default; named here so it's visible as a choice
const MAX_SCENES_GUARD = 40; // a runaway guard, never the intended stopping condition — see haltedBy
const MAX_CONTINUITY_REVISIONS = 2; // bounded — an unfixed contradiction is reported, never retried forever

// Sentence-initial capitals and common furniture words, so ad hoc entity
// detection (below) does not register "The", "She", or "Outside" as a new
// character the moment a sentence happens to start with one. Widened after
// the dry run flagged "Write", "Prose", "Near" — sentence-initial adverbs and
// prepositions are exactly what "spare atmospheric style" prose reaches for,
// so this list has to cover that register, not just pronouns/articles.
const NAME_STOP = new Set([
  "the", "she", "he", "it", "they", "as", "with", "but", "and", "when", "after",
  "before", "this", "that", "there", "some", "now", "once", "outside", "inside",
  "instead", "without", "within", "near", "behind", "above", "below", "beneath",
  "during", "through", "under", "along", "across", "between", "beyond", "despite",
  "perhaps", "suddenly", "slowly", "finally", "together", "later", "meanwhile",
  "somewhere", "something", "nothing", "everything", "someone", "nobody", "each",
  "every", "still", "then", "here", "yet", "even", "only", "again", "soon", "far",
  "write", "prose", "only",
  "mara", "tomas", // already-known roster, never re-registered
]);

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

const tailOf = (s, n) => s.trim().split(/\s+/).slice(-n).join(" ");
const wc = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * The world schema. Everything a story needs is declared HERE — nextMove and
 * buildScenePrompt read only this shape and never a specific story's words.
 *
 *   premise        string — shown nowhere except as the root task's own
 *                  description; the actual opening instruction is `openingBeat`.
 *   roster         string[] — cast present from scene 1, always in "established".
 *   motifs         string[] — recurring images/themes, offered but never forced.
 *   openingBeat    string — instruction text for the very first scene.
 *   entities       ordered map: id -> { description, introduceBeat, requires,
 *                  conflictTerms?, origin? }. Introduced in DECLARATION order
 *                  once each one's `requires` (an entity id or a commitment
 *                  id) is met. `description` is what later scenes see in
 *                  "established"; `introduceBeat` is what THIS scene is told
 *                  to write. `conflictTerms` (optional) is a DECLARED
 *                  INVARIANT, not general contradiction detection — phrases
 *                  that would contradict this entity's established
 *                  origin/fact if a later scene used them (e.g. the logbook
 *                  was washed up; "found it in the attic" is a
 *                  contradiction). Mechanically checked and reported as a
 *                  continuity flag; see checkContinuity below for why it
 *                  cannot be a blocking gate. `origin` (optional, required
 *                  only if `conflictTerms` is set) states the TRUE fact in
 *                  prose, fed back to the model verbatim during a correction
 *                  attempt — see reviseForContinuity.
 *   commitments    ordered map: id -> { fact, checkTerms, cooldownScenes, requires }.
 *                  `requires` names an entity (must exist) or another
 *                  commitment (must be RESOLVED) — existence-dependency, per
 *                  holon-level.md, never a scene index.
 *   beatPrompts    string[] — connective/texture scene instructions, rotated
 *                  through by scene count so consecutive beats don't repeat.
 *   style          string — appended to the system prompt; what voice/register.
 *   targetWords    [min, max] — declared per-scene length, never hardcoded.
 *   numericLocks   (optional) [{ id, pattern (RegExp), multi? }] — see
 *                  checkNumericLocks below. Unlike everything above, this is
 *                  genuinely optional: a world with no numbers whose
 *                  consistency matters (nothing like a coordinate or a date)
 *                  has nothing to declare here.
 *
 * Nothing else here is optional-with-a-default: a story that omits a
 * required field gets a thrown error naming which one, the same discipline
 * conventions.js and belief.js already hold generation/priors to — a missing
 * declaration is a wall, not a value this module gets to guess.
 */
export function validateWorld(world) {
  for (const f of ["premise", "roster", "motifs", "openingBeat", "entities", "commitments", "beatPrompts", "style", "targetWords"]) {
    if (world[f] === undefined) throw new TypeError(`narrative-longform: world must declare "${f}"`);
  }
  if (!Array.isArray(world.targetWords) || world.targetWords.length !== 2)
    throw new TypeError(`narrative-longform: targetWords must be [min, max]`);
  if (!Array.isArray(world.beatPrompts) || world.beatPrompts.length === 0)
    throw new TypeError(`narrative-longform: beatPrompts must be a non-empty array — at least one connective move must be legal`);
  return world;
}

/** One instance of WORLD_SCHEMA. A second, unrelated instance (a heist, not
 * a mystery) drives the same nextMove/buildScenePrompt in
 * narrative-longform.test.js — the check that this is a schema and not
 * lighthouse-shaped code wearing a data object's name. */
export const LIGHTHOUSE_WORLD = {
  premise: "Mara, a lighthouse keeper, finds a washed-up logbook belonging to a sailor whose ship sank the same night her brother Tomas disappeared at sea, one year ago.",
  roster: ["Mara (the lighthouse keeper)", "Tomas (her missing brother)"],
  motifs: ["Tomas's brass compass"],
  openingBeat: "Establish the lighthouse, the isolation, and that Tomas disappeared exactly one year ago tonight. Keep his brass compass shut in a drawer. End with Mara noticing something pale in the surf.",
  style: "a spare, atmospheric literary style",
  targetWords: [220, 260],
  entities: {
    logbook: {
      description: "the logbook, and Elian Voss its owner",
      introduceBeat: "Mara retrieves the washed-up object: a sealed logbook, waterlogged but legible, naming its owner. She realizes its dates sit close to the night Tomas vanished.",
      requires: null,
      // MEASURED: a real run (lighthouse-v3.md, scene 26) had Mara find this
      // SAME logbook "in the attic, tucked away between old crates" — 25
      // scenes after it was washed up on the shore. These phrases are the
      // declared conflict with that established origin.
      conflictTerms: ["in the attic", "among old crates", "tucked away between old crates"],
      origin: "the logbook was washed up from the sea onto the shore below the lighthouse — it was never in the attic, a box, or among anyone's stored belongings",
    },
    letters: {
      description: "a bundle of Tomas's own letters, found among his things, one still unopened",
      introduceBeat: "Going through a box of Tomas's belongings she has avoided for a year, Mara finds a bundle of his letters — and one, near the bottom, still sealed and never sent.",
      requires: null,
    },
    inspector: {
      description: "Halvorsen, a mainland lighthouse inspector sent to assess the station",
      introduceBeat: "A mainland inspector named Halvorsen arrives unannounced to assess the station, and by extension, whether Mara is still fit to keep it alone.",
      requires: null,
    },
  },
  beatPrompts: [
    "A quiet scene of rising tension — the weight of the anniversary, or a small ordinary task made strange by what Mara now knows. Do not resolve anything open.",
    "A scene of ordinary lighthouse work — the lamp, the log, the weather — carrying the pressure of everything she is not saying. Do not resolve anything open.",
    "A brief scene of exhaustion or doubt, alone at night, that touches nothing open directly but shows the cost of carrying it all. Do not resolve anything open.",
  ],
  commitments: {
    foghorn: {
      fact: "Mara sometimes hears the foghorn sound on nights when it is switched off, and has never told anyone.",
      checkTerms: ["foghorn"],
      cooldownScenes: 3, // legality: must sit unresolved for at least this many scenes before payoff is legal
    },
    coordinate: {
      fact: "Near the back of the washed-up logbook is a torn page with a set of coordinates in a shaking hand — Mara suspects it marks where the ship went down, possibly where Tomas's boat went down too.",
      checkTerms: ["coordinate"],
      cooldownScenes: 2,
      requires: "logbook", // legality: cannot be planted before the logbook exists
    },
    "keeper-doubt": {
      fact: "Mara doubts she still has the right to tend the light — grief has hollowed the work of its meaning, and she wonders whether someone else should take the post.",
      checkTerms: ["doubt", "worthy", "leave the light", "someone else", "tend"],
      cooldownScenes: 3,
      // No requires — an independent emotional thread running in parallel
      // with the mystery plot, not chained to it. Gives the story texture
      // and more legal "beat" material instead of every scene serving the
      // logbook/coordinate spine alone.
    },
    voyage: {
      fact: "Mara resolves that she must sail out to the coordinates herself, alone, before the season turns — she can no longer just look at the numbers on the page.",
      checkTerms: ["sail", "voyage", "set out", "the boat"],
      cooldownScenes: 2,
      requires: "coordinate", // a COMMITMENT dependency: illegal until "coordinate" is RESOLVED, not merely planted
    },
    arrival: {
      fact: "At the coordinates, Mara finds definitive evidence of what happened to both Voss's ship and Tomas's boat — wreckage, a marker, or something that finally gives her closure.",
      checkTerms: ["wreck", "found", "there it was", "at last", "closure"],
      cooldownScenes: 1, // the climax should land soon after she is underway, not linger
      requires: "voyage",
    },
    "last-letter": {
      fact: "Mara has never been able to bring herself to open the one sealed letter from Tomas, and she still cannot — not tonight either.",
      checkTerms: ["unopened", "could not open", "did not open", "sealed letter", "unread"],
      cooldownScenes: 3,
      requires: "letters",
    },
    "letter-contents": {
      fact: "Mara finally opens Tomas's last letter, and it says something she did not expect — not a goodbye, but an apology, or a plan he never got to carry out.",
      checkTerms: ["opens", "apology", "carry out", "did not expect", "goodbye"],
      cooldownScenes: 2,
      requires: "last-letter", // illegal until she has spent real time NOT opening it
    },
    "inspection-threat": {
      fact: "Halvorsen tells Mara plainly that the station's board is considering whether a keeper living alone, a year after a loss like hers, can be trusted with the light.",
      checkTerms: ["fit to keep", "the board", "alone", "trusted with the light", "assessment"],
      cooldownScenes: 2,
      requires: "inspector",
    },
    "inspection-resolution": {
      fact: "Mara answers Halvorsen — not with an argument, but by doing something in front of him that proves, wordlessly, that she still belongs to this light.",
      checkTerms: ["Halvorsen", "proved", "answer", "satisfied", "convinced"],
      cooldownScenes: 2,
      requires: "inspection-threat",
    },
    "voss-family": {
      fact: "Mara realizes Elian Voss must have a family somewhere who never learned what happened to him — the same unanswered year she has lived herself.",
      checkTerms: ["family somewhere", "never learned what happened", "family", "unanswered"],
      cooldownScenes: 4, // an independent, slow-burning thread — no requires
    },
    "closure-for-voss": {
      fact: "Having finally reached the coordinates herself, Mara decides she will write to Voss's family and tell them what she found — the one certainty she can hand to someone else.",
      checkTerms: ["write to", "his family", "letter to", "tell them"],
      cooldownScenes: 1,
      // A TRUE CONVERGENCE: illegal until BOTH the arrival (the mystery
      // spine) and voss-family (the independent subplot) have resolved —
      // the climax is earned by two threads meeting, not one alone.
      requires: ["arrival", "voss-family"],
    },
  },
  // MEASURED: both defects below are real, from lighthouse-v3.md — the
  // coordinate (the one fixed location the whole voyage plot depends on)
  // drifted across three separate mentions, and Voss/Tomas were given
  // contradicting years in the same scene despite the premise's own "the
  // same night". See checkNumericLocks's header for exactly which strings.
  numericLocks: [
    { id: "coordinate", pattern: /\d+(?:\.\d+)?°/g, multi: true },
    { id: "disappearance-year", pattern: /19\d{2}/g },
  ],
};

/** verifyPayoff — one of the two text-specific seams; see the module header. */
const verifyPayoff = (text, terms) => terms.some((t) => text.toLowerCase().includes(t.toLowerCase()));

/**
 * The continuity residual — a DECLARED-INVARIANT checker, not general
 * contradiction detection.
 *
 * MEASURED DEFECT this exists to catch: a real run on real llama3.2 output
 * (lighthouse-v3.md, 31 scenes) established in scene 1-2 that the logbook was
 * WASHED UP FROM THE SEA, then scene 26 said Mara "found it in the attic,
 * tucked away between old crates" — a genuine plot contradiction `verifyPayoff`
 * cannot see, because it only checks whether a PLANNED payoff's keyword
 * appears, never whether a scene contradicts an already-established fact.
 *
 * This is NOT a general fix for that class of defect — catching an arbitrary
 * contradiction needs real semantic understanding of "attic" and "washed up
 * on the shore" as competing claims about the same origin, which no cheap
 * mechanical check provides. What IS cheap and honest: the WORLD declares,
 * per entity, phrases that would contradict its established origin
 * (`conflictTerms`) — the same "declared, never derived" discipline II.2
 * already holds priors to, applied to a continuity fact instead of a
 * convention. A world that does not anticipate a contradiction risk will not
 * catch it here; that is a real, stated limitation, not a bug.
 *
 * Reported, never blocking: unlike a payoff (which the loop can legitimately
 * retry until the specific required words appear), there is no guarantee a
 * retry fixes a contradiction — the model might just invent a DIFFERENT wrong
 * origin. So this returns flags for the final report, the same "typed gap,
 * surfaced honestly" discipline as the ad hoc entities that go untracked.
 */
export function checkContinuity(world, text) {
  const flags = [];
  for (const [id, e] of Object.entries(world.entities)) {
    if (!e.conflictTerms?.length) continue;
    for (const term of e.conflictTerms) {
      if (text.toLowerCase().includes(term.toLowerCase())) flags.push({ entityId: id, term });
    }
  }
  return flags;
}

/**
 * A SECOND, differently-shaped continuity check — DYNAMIC rather than
 * declared. `checkContinuity` above catches a scene contradicting a fact the
 * WORLD stated in advance; this catches a scene contradicting a fact an
 * EARLIER SCENE stated, which no one declared ahead of time because no one
 * knew what number the model would pick.
 *
 * MEASURED DEFECTS this exists to catch, both from lighthouse-v3.md:
 *   - The coordinate itself drifted across three mentions of "the one fixed
 *     location the whole voyage plot depends on": "14° 32' N, 45° 15' W"
 *     (scene 6), "45.2137° N, 73.4213° W" (scene 12), "N 43° 12' W" (scene
 *     20) — three different values for a number that is a fixed fact by the
 *     story's own premise. ACROSS scenes.
 *   - Voss and Tomas were established as dying "the same night" (the
 *     premise itself), then given contradicting years in the SAME sentence
 *     pair of the SAME scene: "Voss – 23rd April 1923" and "Tomas – 24th
 *     October 1922". WITHIN one scene.
 *
 * Both shapes had to be handled, and testing against the real strings above
 * is what found that a "keyword proximity, first match only" design (the
 * first draft of this function) catches neither: the coordinate drift in
 * scene 20 never co-occurs with the word "coordinate" at all, and a
 * first-match-only search over scene 22's text would find "1923" and never
 * even look far enough to see "1922" sitting right beside it in the same
 * call. The fix is FIRST MENTION LOCKS IT, checked two ways per scene:
 * within-scene (does this ONE scene contain more than one distinct value
 * for the pattern?) and across-scene (does this scene's value match what an
 * earlier scene already established?). Neither requires knowing in advance
 * what the coordinate or the year WOULD be — only that, once stated,
 * whatever it is must not change. That is a weaker and more honest claim
 * than checkContinuity's declared conflict terms, which is why this is a
 * separate function rather than merged into a shape that would blur which
 * kind of invariant fired.
 *
 * `locked` is caller-owned, mutable state threaded through every call in
 * one story's run — this function is not pure the way the rest of this
 * module's checks are, because "first mention" is inherently a fact about
 * history, not about one scene in isolation.
 *
 * `multi: true` on a lock declares that MORE THAN ONE match per scene is the
 * NORMAL case (a lat/long coordinate is two degree-numbers, not one) — found
 * by testing against the real coordinate strings: without this, "14° 32' N,
 * 45° 15' W" — one legitimate, internally consistent coordinate — flagged
 * itself as "inconsistent-within-scene" purely for having a latitude AND a
 * longitude. For a `multi` lock, the whole SET of numbers is what gets
 * locked and compared, sorted so phrasing order doesn't matter; for a
 * non-multi lock (a single fact like a year), more than one distinct value
 * appearing in ONE scene is itself the defect (the actual shape of the
 * Voss/Tomas year contradiction — both years sit in the same scene).
 */
export function checkNumericLocks(world, text, locked) {
  const flags = [];
  for (const lock of world.numericLocks ?? []) {
    const matches = [...new Set(text.match(new RegExp(lock.pattern.source, "g")) ?? [])];
    if (matches.length === 0) continue;

    if (!lock.multi && matches.length > 1) flags.push({ lockId: lock.id, kind: "inconsistent-within-scene", values: matches });

    const key = lock.multi ? [...matches].sort().join("|") : matches[0];
    if (!(lock.id in locked)) {
      locked[lock.id] = key;
    } else if (lock.multi ? locked[lock.id] !== key : !matches.includes(locked[lock.id])) {
      flags.push({ lockId: lock.id, kind: "drift-from-earlier-scene", locked: locked[lock.id], found: lock.multi ? key : matches });
    }
  }
  return flags;
}

/**
 * The next legal move, given the log's CURRENT state only. No lookahead: this
 * function never consults how many scenes will eventually be written, only
 * what has already happened.
 *
 * Returns one of:
 *   { kind: "open" }                          — the opening scene
 *   { kind: "introduce", entityId }            — bring a new roster entity in
 *   { kind: "plant", commitmentId }            — a commitment becomes legal to plant
 *   { kind: "beat" }                           — a connective scene, nothing planted or resolved
 *   { kind: "resolve", commitmentId }          — a commitment becomes legal to pay off
 *   { kind: "close" }                          — no legal move remains; production is done
 */
export function nextMove(world, tasks, sceneCount) {
  const has = (id) => tasks.some((t) => t.task_id === id);
  const isOpen = (id) => has(id) && !tasks.find((t) => t.task_id === id).resolved;

  // A prerequisite is either an ENTITY that must already exist (the torn
  // page cannot be found before the logbook that holds it does) or another
  // COMMITMENT that must already be RESOLVED (deciding to sail cannot exist
  // before knowing where to sail to). Both are genuine existence-dependency
  // claims in holon-level.md's sense — "cannot exist without" — not a scene
  // index. A commitment chained to another commitment is what turns a set of
  // independent threads into an earned causal arc rather than a list.
  //
  // `requires` may be a single id or an ARRAY — a true convergence point,
  // legal only once EVERY named prerequisite is satisfied. This is what lets
  // two independent threads (e.g. a subplot and the main mystery) resolve
  // together at a genuine climax rather than each closing off in isolation.
  const oneReqMet = (id) => has(`entity:${id}`) || !!tasks.find((t) => t.task_id === `commitment:${id}`)?.resolved;
  const prereqMet = (c) => {
    if (!c.requires) return true;
    return Array.isArray(c.requires) ? c.requires.every(oneReqMet) : oneReqMet(c.requires);
  };

  if (!has("scene:1")) return { kind: "open" };

  for (const [id, e] of Object.entries(world.entities)) {
    if (!prereqMet(e)) continue;
    if (!has(`entity:${id}`)) return { kind: "introduce", entityId: id };
  }

  for (const [id, c] of Object.entries(world.commitments)) {
    if (!prereqMet(c)) continue; // illegal — the prerequisite doesn't exist or hasn't resolved yet
    if (!has(`commitment:${id}`)) return { kind: "plant", commitmentId: id };
  }

  const openCommitments = Object.keys(world.commitments).filter((id) => isOpen(`commitment:${id}`));
  for (const id of openCommitments) {
    const t = tasks.find((tt) => tt.task_id === `commitment:${id}`);
    const age = sceneCount - t.plantedAtScene;
    if (age >= world.commitments[id].cooldownScenes) return { kind: "resolve", commitmentId: id };
  }

  if (openCommitments.length > 0) return { kind: "beat" }; // something is open but not yet ripe for payoff
  return { kind: "close" };
}

function buildScenePrompt(move, world, tasks, sceneNumber, prevTail) {
  const openThreads = tasks.filter((t) => t.task_id.startsWith("commitment:") && !t.resolved);
  // THE MOUTH: bounded regardless of how many scenes have already run.
  const { working, withheld } = foldToWorkingSet(openThreads, { k: WORKING_SET_K, score: (t) => -t.plantedAtScene });
  const roster = tasks.filter((t) => t.task_id.startsWith("entity:")).map((t) => t.description);

  let p = `STORY SO FAR — established, stay consistent:\n`;
  p += roster.length ? `Characters/things introduced: ${roster.join("; ")}.\n` : "(nothing yet — this is the opening scene)\n";
  if (world.motifs.length) p += `Recurring image available if natural: ${world.motifs.join(", ")}.\n`;
  if (working.length) {
    p += `\nUNRESOLVED THREADS (do not resolve unless told to below):\n`;
    for (const t of working) p += `- ${t.evidence[0]}\n`;
  }
  if (withheld > 0) p += `(${withheld} older thread(s) not shown — out of the working set)\n`;
  if (prevTail) p += `\nTHE PREVIOUS SCENE ENDED:\n"...${prevTail}"\n`;

  // Every branch below reads ONLY the world object — nothing here is
  // lighthouse-shaped. A different world.openingBeat/entities/beatPrompts
  // drives an entirely different story through the identical function.
  p += `\nNOW WRITE THIS SCENE:\n`;
  if (move.kind === "open") p += `${world.premise} ${world.openingBeat}`;
  else if (move.kind === "introduce") p += world.entities[move.entityId].introduceBeat;
  // Neutral framing, not "Mara reads further" — a heist story's plant is not
  // a discovery-in-a-document, so the frame cannot assume one.
  else if (move.kind === "plant") p += `A new development enters the story, arising naturally from what has already happened: ${world.commitments[move.commitmentId].fact}`;
  else if (move.kind === "beat") p += `${world.beatPrompts[sceneNumber % world.beatPrompts.length]} Do not resolve anything open.`;
  else if (move.kind === "resolve") p += `This scene must resolve, explicitly and unambiguously: ${world.commitments[move.commitmentId].fact}`;

  p += `\n\nWrite roughly ${world.targetWords[0]}-${world.targetWords[1]} words. Prose only, no headings.`;
  return p;
}

const buildSystem = (world) => `You are writing a short work, one scene at a time, in ${world.style}. Prose only — no headings, no meta-commentary.`;

/**
 * Closes the loop checkContinuity/checkNumericLocks opened: detect, then
 * attempt a correction, then reverify — never trust the correction blindly.
 * The same "pencil, then ink" discipline as a payoff retry, but IN PLACE:
 * a payoff retry moves forward to a fresh scene number because the failure
 * was "this beat didn't do its job yet"; a continuity fix has to touch the
 * SAME scene, because the failure is "this passage said something false",
 * not "nothing happened here yet".
 *
 * Named facts, not vague instruction: the correction states the SPECIFIC
 * contradicting phrase or number AND the specific correct one, because
 * "please be more careful" is not a fact a model can act on and "the
 * logbook was washed up on the shore, never in the attic" is.
 */
function buildContinuityCorrectionPrompt(priorText, flags, world) {
  let p = `Here is a scene you wrote:\n"""\n${priorText}\n"""\n\n`;
  p += `It contains a factual contradiction that must be fixed:\n`;
  for (const f of flags) {
    if (f.entityId) {
      p += `- You wrote "${f.term}", but the true, already-established fact is: ${world.entities[f.entityId].origin}\n`;
    } else if (f.kind === "inconsistent-within-scene") {
      p += `- This scene states more than one value for the same fact ("${f.lockId}"): ${f.values.join(" and ")}. These must be the SAME value throughout.\n`;
    } else {
      p += `- This scene gives "${f.found}" for "${f.lockId}", but it was already established as ${f.locked} in an earlier scene. Use ${f.locked} consistently — do not introduce a different value.\n`;
    }
  }
  p += `\nRewrite the ENTIRE scene, fixing ONLY these contradictions. Keep everything else that already works — the same events, the same length, the same voice. Prose only, no headings, no meta-commentary about the correction.`;
  return p;
}

/**
 * Names the model introduced without being asked — the honest gap flagged
 * after the first run: an invented character (there, "Mr. Jenkins") stays
 * consistent only as far as the local tail carries it, because the ledger
 * never knew it existed. This does not prevent contradiction, but it stops
 * the FORGETTING half of the failure by surfacing the name in the roster
 * every later scene sees — the same specificity-detection pattern
 * longform.js's `fidelityResidual` already uses (capitalized, not sentence
 * furniture), reused rather than reinvented.
 *
 * MEASURED DEFECT, FIXED HERE (round 1): a real run on real llama3.2 output
 * registered "One", "Was", "Grief", "Had", "Did", "Not", "Tonight" as
 * characters — sentence-initial or emphasis-initial capitals no stopword
 * list will ever fully enumerate, because English has too many
 * capitalizable common words in too many positions to close by exclusion.
 * The fix is not a longer stopword list (a losing battle, tried first). It
 * is a RECURRENCE requirement: a genuine character name gets used more than
 * once in the scene that introduces it; a stray sentence-initial capital
 * does not. This is a cheap sense organ nominating candidates, not a
 * verdict — the constitution's II.9 shape (a cheap sense organ is legal,
 * promoting it to the verdict is refused) applied to naming instead of
 * significance.
 *
 * MEASURED DEFECT, FIXED HERE (round 2): a real run on a structurally
 * different, institution-dense thriller world (campaign-finance/Derby, not
 * lighthouse's spare literary style) found the round-1 fix was itself
 * incomplete in two ways, on real generated prose:
 *
 *   1. A multi-word proper noun ("Blue Larkspur Farm", "Sunlight Desk",
 *      "Bluegrass Forward Fund") fragmented into ONE SPURIOUS ENTITY PER
 *      WORD under the old word-at-a-time regex — "Blue", "Larkspur", and
 *      "Farm" each individually recurred >= 2 times and each got registered
 *      as its own separate "character", polluting the established-roster
 *      line every later scene sees with nonsense fragments standing in for
 *      one real entity. Fixed: match a RUN of consecutive capitalized words
 *      as one candidate phrase, not one word at a time.
 *   2. The recurrence requirement alone was not enough in denser prose: on
 *      this real run, "None", "One", "You", "Names", "Not", and "Man" each
 *      legitimately recurred >= 2 times — coincidentally, always as the
 *      FIRST word of a sentence, which proves nothing about properness
 *      (every sentence starts capitalized regardless of what the word is).
 *      A genuine name recurs at least once somewhere that is NOT a sentence
 *      start; round 1's counter could not tell "Merritt" (which does) from
 *      "None" (which, in this run, never did). Fixed: track sentence-initial
 *      and non-sentence-initial occurrences separately, and require at
 *      least one non-sentence-initial occurrence before a candidate counts.
 *
 * MEASURED DEFECT, FIXED HERE (round 3): round 2's own sentence-initial
 * check missed dialogue. A quotation mark sits BETWEEN the sentence-ending
 * punctuation and the first word of a line of dialogue ('He said. "You
 * heard me."'), so the 3-character lookbehind saw `. "` — ending in the
 * quote mark, not whitespace — and wrongly called it non-initial. On this
 * run, real dialogue-heavy prose let "You" and "Not" both slip through this
 * gap (each recurred once as a TRUE sentence start and once as a
 * quote-masked dialogue start, which this bug counted as "non-initial").
 * Fixed: the lookbehind now tolerates an optional straight or curly quote
 * character between the whitespace and the word. Also fixed in the same
 * pass: a possessive join ("Ledger's Daughter") broke the multi-word run at
 * the apostrophe, fragmenting one real name into two spurious ones — the
 * run pattern now optionally bridges a `'s ` between two capitalized words.
 *
 * MEASURED DEFECT, FIXED HERE (round 4): a run with ZERO declared entities
 * (every name entirely model-invented, no world.entities to lean on at all)
 * exposed a worse failure than fragmentation. "Mrs. Kuroba" — a title
 * abbreviation, period included — recurred 10+ times, always as "Mrs.
 * Kuroba". The period after "Mrs" both (a) broke the multi-word run, same
 * shape as round 3's possessive fix, splitting off a bare "Mrs" fragment,
 * AND (b) made round 2's own sentence-initial check misfire in the OTHER
 * direction from round 3's dialogue bug: EVERY occurrence of "Kuroba"
 * immediately follows "Mrs. " (period + space), which the lookbehind reads
 * as a genuine sentence ending — so "Kuroba" was scored non-initial ZERO
 * times across all 10+ appearances and never crossed the round-2 threshold
 * at all. The actual, recurring, load-bearing surname was invisible to
 * this mechanism entirely, not merely fragmented. Fixed: a small closed set
 * of common English title abbreviations (the same "declared list, not
 * inferred" discipline NAME_STOP already uses) is tried as an optional
 * PREFIX that bridges its own period — "Mrs. Kuroba" now matches as one
 * phrase, so the sentence-initial check runs once on the whole phrase's
 * real start position instead of misfiring mid-abbreviation.
 */
const TITLE_PREFIX = "(?:Mr|Mrs|Ms|Miss|Dr|St|Jr|Sr|Prof|Rev|Gen|Sgt|Capt|Lt|Col|Fr|Msgr)";

function extractNewNames(text, known) {
  const counts = new Map(); // phrase -> { total, nonInitial }
  const runRe = new RegExp(`\\b${TITLE_PREFIX}\\.\\s+[A-Z][a-z]{2,}(?:(?:'s)?\\s+[A-Z][a-z]{2,})*\\b|\\b[A-Z][a-z]{2,}(?:(?:'s)?\\s+[A-Z][a-z]{2,})*\\b`, "g");
  const SENTENCE_INITIAL_RE = /[.!?]\s+["'‘“]?$/;
  let m;
  while ((m = runRe.exec(text))) {
    const phrase = m[0];
    const words = phrase.replace(/'s\b/g, "").split(/\s+/).filter(Boolean);
    // Any word in the run being stop-listed or already known disqualifies
    // the WHOLE phrase — "The Sunlight Desk" would otherwise register the
    // clean "Sunlight Desk" AND separately flag stop-listed "The".
    if (words.some((w) => NAME_STOP.has(w.toLowerCase()) || known.has(w.toLowerCase()))) continue;

    const sentenceInitial = m.index === 0 || SENTENCE_INITIAL_RE.test(text.slice(Math.max(0, m.index - 4), m.index));
    const entry = counts.get(phrase) ?? { total: 0, nonInitial: 0 };
    entry.total += 1;
    if (!sentenceInitial) entry.nonInitial += 1;
    counts.set(phrase, entry);
  }
  return [...counts.entries()].filter(([, c]) => c.total >= 2 && c.nonInitial >= 1).map(([name]) => name);
}

/**
 * Run the story to closure (or the safety guard). No fixed scene count is
 * declared anywhere in this function — `nextMove` decides one step at a
 * time from the log's own state, and the loop stops when it says `close`.
 */
export async function writeNarrative(world, { model = "llama3.2:latest", seed = 20260801, onProgress = null, maxScenes = MAX_SCENES_GUARD, sceneTokens = DEFAULT_SCENE_TOKENS } = {}) {
  validateWorld(world);
  const progress = onProgress || ((msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`));
  const system = buildSystem(world);

  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "story", description: world.premise });

  const texts = [];
  const checks = [];
  const continuityFlags = [];
  const lockedNumbers = {}; // threaded across the whole run — see checkNumericLocks
  let sceneCount = 0;
  let haltedBy = null;

  while (sceneCount < maxScenes) {
    const tasks = projectTasks(log);
    const move = nextMove(world, tasks, sceneCount);
    if (move.kind === "close") { haltedBy = "operational-closure"; break; }

    sceneCount += 1;
    const sceneId = `scene:${sceneCount}`;
    const prevTail = texts.length ? tailOf(texts[texts.length - 1], TAIL_WORDS) : null;
    const prompt = buildScenePrompt(move, world, tasks, sceneCount, prevTail);

    progress(`scene ${sceneCount} (${move.kind}${move.commitmentId ? ":" + move.commitmentId : ""}) — calling model...`);
    const t0 = Date.now();
    let text = await callModel(model, [{ role: "system", content: system }, { role: "user", content: prompt }], sceneTokens, { seed: seed + sceneCount });
    progress(`scene ${sceneCount} done — ${wc(text)} words in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    // Trial checks use a COPY of lockedNumbers — checkNumericLocks locks the
    // FIRST value it sees even when flagging an inconsistency (scene 22's
    // year contradiction locks "1923" the moment it's first seen), so
    // checking a flawed draft must not be allowed to poison the real,
    // persistent lock before a correction has had its chance to replace it.
    let flags = [...checkContinuity(world, text), ...checkNumericLocks(world, text, { ...lockedNumbers })];
    let revisionAttempts = 0;
    while (flags.length > 0 && revisionAttempts < MAX_CONTINUITY_REVISIONS) {
      revisionAttempts += 1;
      progress(`  scene ${sceneCount}: ${flags.length} continuity flag(s), attempting correction ${revisionAttempts}/${MAX_CONTINUITY_REVISIONS}...`);
      const correctionPrompt = buildContinuityCorrectionPrompt(text, flags, world);
      text = await callModel(
        model,
        [{ role: "system", content: system }, { role: "user", content: correctionPrompt }],
        sceneTokens,
        { seed: seed + sceneCount * 100 + revisionAttempts },
      );
      flags = [...checkContinuity(world, text), ...checkNumericLocks(world, text, { ...lockedNumbers })];
    }
    texts.push(text);

    // Commit: the FINAL text (revised or original) is what locks the real,
    // persistent numeric facts and what gets reported — reported honestly
    // even when a fix was attempted and failed, never silently dropped.
    const finalFlags = [...checkContinuity(world, text), ...checkNumericLocks(world, text, lockedNumbers)];
    for (const flag of finalFlags) {
      continuityFlags.push({ ...flag, scene: sceneCount, revisionAttempts, resolved: false });
      progress(
        flag.entityId
          ? `  CONTINUITY FLAG (unresolved after ${revisionAttempts} attempt(s)): scene ${sceneCount} contradicts "${flag.entityId}" — contains "${flag.term}"`
          : flag.kind === "inconsistent-within-scene"
            ? `  CONTINUITY FLAG (unresolved after ${revisionAttempts} attempt(s)): scene ${sceneCount} "${flag.lockId}" is internally inconsistent — ${flag.values.join(" vs ")}`
            : `  CONTINUITY FLAG (unresolved after ${revisionAttempts} attempt(s)): scene ${sceneCount} "${flag.lockId}" drifted — locked as ${flag.locked}, now ${flag.found}`,
      );
    }
    if (revisionAttempts > 0 && finalFlags.length === 0) {
      progress(`  scene ${sceneCount}: continuity CORRECTED after ${revisionAttempts} attempt(s)`);
      continuityFlags.push({ scene: sceneCount, revisionAttempts, resolved: true, kind: "corrected" });
    }

    log = append(log, {
      kind: ENTRY_KINDS.PROPOSE, task_id: sceneId, description: `scene ${sceneCount}: ${move.kind}`,
      depends_on: ["story"], operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED,
    });
    log = append(log, { kind: ENTRY_KINDS.RESULT, task_id: sceneId, result: text, depends_on: ["story"] });

    // Register any character the model introduced unasked, so it survives
    // into later scenes' working set instead of only the local tail carrying
    // it. Known names = world roster + everything already registered.
    const knownLower = new Set([
      ...world.roster.flatMap((r) => r.toLowerCase().match(/[a-z]+/g) ?? []),
      ...projectTasks(log).filter((t) => t.task_id.startsWith("entity:")).map((t) => t.task_id.slice(7).toLowerCase()),
    ]);
    // "Entities are entities": the SAME registration primitive
    // code-longform.js's discoverReferencedFiles now also uses (see
    // task-log.js's proposeDiscovered header) — a character surfaced
    // unasked and a file referenced unasked resolve to the identical cube
    // cell (SEG, Figure), not merely an analogous one.
    const newNames = extractNewNames(text, knownLower).filter(
      (name) => !projectTasks(log).some((t) => t.task_id === `entity:${name.toLowerCase()}`),
    );
    if (newNames.length) {
      log = proposeDiscovered(log, newNames.map((name) => ({
        task_id: `entity:${name.toLowerCase()}`,
        description: `${name} (introduced by the model, scene ${sceneCount})`,
        depends_on: [sceneId],
      })));
      for (const name of newNames) progress(`  new character surfaced: ${name} — registered so later scenes see it`);
    }

    if (move.kind === "introduce") {
      // A single distinguished thing pulled into the story and individually
      // named — SEG (Differentiate) at Figure grain, the same cell every
      // OTHER "something got noticed and named" act in this codebase now
      // resolves to (see proposeDiscovered).
      log = append(log, {
        kind: ENTRY_KINDS.PROPOSE, task_id: `entity:${move.entityId}`, description: world.entities[move.entityId].description,
        depends_on: [sceneId], operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure",
      });
    }
    if (move.kind === "plant") {
      const c = world.commitments[move.commitmentId];
      // CON (Relate): planting a commitment is the story declaring that THIS
      // scene now bears on some future payoff scene — a link entering the
      // field, not yet the payoff itself.
      log = append(log, {
        kind: ENTRY_KINDS.PROPOSE, task_id: `commitment:${move.commitmentId}`, description: c.fact,
        evidence: [c.fact], depends_on: [sceneId], plantedAtScene: sceneCount, resolved: false,
        operator: "CON", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure",
      });
    }
    if (move.kind === "resolve") {
      const c = world.commitments[move.commitmentId];
      const confirmed = verifyPayoff(text, c.checkTerms);
      checks.push({ commitmentId: move.commitmentId, scene: sceneCount, confirmed });
      progress(`  mechanical payoff check "${move.commitmentId}": ${confirmed ? "CONFIRMED" : "NOT FOUND — model skipped the payoff"}`);
      // Never trust the model's say-so: the task is only marked resolved if
      // the generated text actually carries the payoff. An unconfirmed
      // resolve stays open — legality re-evaluates it as a retry next step
      // rather than silently marking it done.
      //
      // Deliberately NOT a SUPERSEDE entry: projectTasks() drops any task_id
      // named in a `supersedes` field from the live set entirely, which would
      // make a resolved commitment vanish rather than persist as resolved —
      // and nextMove()'s `has()` legality check would then read the vanished
      // commitment as never-planted and try to plant it again. An EVIDENCE
      // entry with no `supersedes` and no `depends_on` merges its payload
      // (resolved, resolvedAtScene) onto the SAME live task and leaves its
      // original planting dependency untouched (projectTasks falls back to
      // the prior depends_on when a new entry's own list is empty).
      log = append(log, {
        kind: ENTRY_KINDS.EVIDENCE, task_id: `commitment:${move.commitmentId}`,
        resolved: confirmed, resolvedAtScene: confirmed ? sceneCount : null,
        // SYN (Generate), Figure grain — ONLY when actually confirmed: an
        // unconfirmed attempt synthesized nothing, so tagging it a
        // production act would be exactly the false-positive "labeled after
        // the fact instead of produced" mistake OPERATOR_BASIS.PRODUCED
        // exists to rule out. Left untagged (absent), never defaulted.
        ...(confirmed ? { operator: "SYN", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure" } : {}),
      });
      // SYN: a scene that resolves this thread AND another still-open one in
      // the same text is a genuine convergence — discovered post hoc, never
      // planned. Checked mechanically against every OTHER open commitment's
      // own terms.
      const others = Object.entries(world.commitments).filter(([id]) => id !== move.commitmentId);
      for (const [otherId, otherC] of others) {
        if (isOpenStill(log, otherId) && verifyPayoff(text, otherC.checkTerms)) {
          log = append(log, {
            kind: ENTRY_KINDS.PROPOSE, task_id: `convergence:${sceneCount}`,
            description: `scene ${sceneCount} resolved ${move.commitmentId} and touched ${otherId} together`,
            depends_on: [`commitment:${move.commitmentId}`, `commitment:${otherId}`],
            operator: "SYN", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure",
          });
        }
      }
    }
  }
  if (sceneCount >= maxScenes && haltedBy === null) haltedBy = "max-scenes-guard";

  const manuscript = projectTasks(log)
    .filter((t) => t.task_id.startsWith("scene:"))
    .sort((a, b) => Number(a.task_id.split(":")[1]) - Number(b.task_id.split(":")[1]))
    .map((t) => `## Scene ${t.task_id.split(":")[1]}\n\n${t.result}\n`)
    .join("\n");

  // Advisory only, same as checkContinuity/checkNumericLocks: reports
  // whether any single entity/commitment thread coarsened its own cube
  // grain or ran its own operator backward against SEG->CON->SYN production
  // order (task-log.js's checkCubeProgression) — never blocks the run.
  const cubeFlags = checkCubeProgression(log);

  return { log, manuscript, texts, checks, continuityFlags, cubeFlags, sceneCount, haltedBy };
}

function isOpenStill(log, commitmentId) {
  const t = projectTasks(log).find((tt) => tt.task_id === `commitment:${commitmentId}`);
  return t ? !t.resolved : false;
}
