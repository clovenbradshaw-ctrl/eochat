# Development state — surf/fold generation engines

Resume point for the "same underlying mechanism across domains" work. Read
this before continuing; it says exactly what's stable, what's mid-edit, and
what to do first.

## The big picture

One question started this: how does a small talking model write something
long, across many small prompts, without losing the thread or getting
overwhelmed? The answer that emerged and got proven across five domains:
**don't hand the model more context as the work grows — hand it a small,
bounded, current state, discover structure one step at a time from what's
already happened, verify every claim mechanically, and never look ahead.**

The full theoretical grounding is `specs/composition-is-retrieval.md` (in the
main project root) — vision science, oral-formulaic composition (Parry/Lord),
Ericsson-Kintsch's Long-Term Working Memory, Sawyer/Johnstone improv, all
converging on the same mechanism.

## The proven spine: `eochat/server/task-log.js`

Unmodified, pure, append-only. `createTaskLog`/`append`/`projectTasks`/
`foldToWorkingSet` — no lookahead, existence-dependency legality, a bounded
"mouth" that never grows regardless of how much history exists. **Six
domains now run on this exact same code:**

| Domain | File | Status |
|---|---|---|
| Music (sonata composition) | `compose-sonata.js` | Pre-existing, already proven — discovered mid-session, not built by us |
| Essays (evidence-grounded) | `longform.js` | Pre-existing |
| Fiction | `narrative-longform.js` + `.test.js` | **Done, stable, fully tested** (19 tests pass) |
| Numeric prediction (weather-shaped) | `predictive-longform.js` + `.test.js` | **Done, stable, fully tested** (5 tests pass) |
| Multi-file code | `code-longform.js` + `.test.js` | **Done, stable, fully tested** (16 tests pass) |
| Vector diagrams (SVG) | `svg-longform.js` + `.test.js` | **Done, stable, fully tested** (26 tests pass) — see below, THIRD MODALITY |

## narrative-longform.js — reference implementation, fully working

Generic over ANY story (world schema: entities/commitments/beats/style, no
lighthouse-specific code left in the engine). Proven with a heist-thriller
world driving the identical engine to closure. Real runs produced a
~7,700-word, 31-scene manuscript (`lighthouse-v6.md` etc., in the main
project root) with a genuine causal chain including a true convergence
(one commitment requiring TWO others resolved together).

Two continuity mechanisms, both validated against real defects found by
close-reading actual model output, both with a working correction loop
(detect → regenerate with the specific contradiction named → reverify → keep
only if fixed, report honestly if not):
- `checkContinuity` — declared conflict terms (a fact stated once, contradicted later)
- `checkNumericLocks` — first-mention-locks-it (a coordinate/date that must stay one value)

## predictive-longform.js — the "weather" proof, fully working

Same spine, but honestly does NOT reuse fiction's fidelity-checking for
verification — prediction needs real sealed commitments and proper scoring
(CRPS) against real baselines from `@eoreader/engine/prediction/*`, matching
eoreader6's own pre-existing distinction between `generation/tasks.js` and
`prediction/tasks.js` (siblings, not one generalization). A real index-
convention bug was found and fixed via a self-consistency check (setting the
"candidate" to literally BE one of the baselines, so any mismatch is
unambiguous proof of a bug) before this was trusted.

## code-longform.js — CURRENTLY MID-EDIT, tests are RED

This is the resume point. Do not treat this file as working until the steps
below are done — **all 12 tests currently fail** because `planFiles` was just
changed to return a different shape and the test stubs haven't been updated
to match.

### What's built and real-run tested (against an actual Ollama model, not just stubs)

1. Plans files from a raw request (reuses `holonic-task.js`'s exact JSON
   decomposition prompt shape, not reinvented).
2. Drives them in dependency order via the same `nextCodeMove`/task-log
   pattern as fiction's `nextMove`.
3. Real JS syntax verification (`new Function`, not a heuristic) + honestly-
   weak HTML/CSS well-formedness floors.
4. Cross-file continuity check: HTML declares ids/classes, CSS/JS reference
   them — a reference to something never declared is the code-domain
   instance of "the logbook was washed up, then later found in the attic."

### Three REAL bugs found on real runs, fixed, and regression-tested

1. **ENOENT crash on nested paths** (`js/script.js`) — the writer only
   created the top-level output dir. Fixed: `mkdirSync(dirname(...))` per
   file before writing.
2. **CSS false positives** — the continuity check was flagging hex colors
   (`#333`, `#fff`) and decimal values (`1.6`, `0.1`) as undeclared
   ids/classes, because a naive regex can't tell a CSS *selector* from a CSS
   *value*. Fixed: only extract from the text preceding each `{` (the
   selector), never from declarations.
3. **`export` in a plain `<script>` file** — `new Function` correctly
   rejects ES module syntax in a non-module context. Fixed: the write prompt
   now explicitly states "PLAIN browser script, NOT an ES module."

### The watchmaker fix (Simon's Hora/Tempus parable, invoked explicitly by the user)

The first version deferred cross-file continuity checking to ONE PASS after
every file already existed — Tempus's mistake: by the time a problem
surfaced, several later files had already been built on unverified ground.
**Fixed: continuity is now checked and corrected INLINE, per file,
immediately after each file is written and BEFORE it's ever treated as a
stable dependency for anything after it** — bringing code-longform.js in
line with what narrative-longform.js already did correctly for scenes.
Proven with a test asserting the exact CALL ORDER (correction happens before
the next file is even written).

### The "plan grows" fix (what if the initial plan needs more files?)

`files` changed from `const` to `let`. After each file is written,
`discoverReferencedFiles` mechanically scans it for references (`<script
src>`, `<link href>`, `<img src>`, CSS `url()`) to paths NOT in the current
plan, and pushes them as new file tasks — the exact same move as
`extractNewNames()` discovering an unplanned character in fiction. A
reference to a non-generatable asset (an image, a font) is reported as a
named gap, never faked as text. Both paths are tested.

### The escalation fix (structural mismatch, not a typo)

A REAL run left 6+ CSS class references unresolved after 2 normal correction
attempts — not a stray wrong name, but a stylesheet written for a
structurally different page than the HTML actually delivered
(`.container`/`.header`/`.services`/`.form`/`.nav` vs. an HTML that only
declared 3 bare ids). `STRUCTURAL_MISMATCH_THRESHOLD = 3`: more than this
many DISTINCT unresolved references after normal correction is the declared
signal to escalate — patch the EARLIER, already-"stable" HTML file instead
of continuing to hammer the later one, **additively only** (never remove or
rename what already exists, so nothing already-verified is put at risk).
Bounded to `MAX_STRUCTURAL_ESCALATIONS = 1`, matching `holonic-task.js`'s own
`replan()` precedent (a correction pass, not a planner that loops until
satisfied). Tested both for success and for "a broken escalation patch is
discarded, not kept."

**Real-run result: escalation fired and made genuine partial progress but did
not fully resolve the mismatch** — the model, even when told the exact
missing class names, sometimes invented a DIFFERENT plausible name
(`.services-container` instead of the required `.services`). This is the
root cause the next fix (below) addresses.

### THE CURRENT IN-FLIGHT CHANGE: shared vocabulary as a declared prior

**Diagnosis** (the user's "not just 2 dimensions" insight): the architecture
so far only tracks files × a single "requires" edge — a flat graph. What's
missing is a THIRD axis: features/concepts that cut across files (the
"services section" is one holon realized partly in HTML, partly in CSS), and
nothing ever gave every file a SHARED, CANONICAL vocabulary to build from.
Detecting-and-patching a name mismatch after the fact (continuity check +
escalation) is a safety net; it doesn't stop two files from independently
*naming* the same concept differently in the first place. This is the exact
same "declared, never derived" discipline `conventions.js` already applies to
word order, now applied to identifier names.

**Fix in progress:** `planFiles` now returns `{ files, sharedVocabulary }`
instead of a bare array — `sharedVocabulary` is a list of `{name, kind,
meaning}` canonical ids/classes decided ONCE at plan time and threaded into
EVERY file's write prompt (`buildWritePrompt` now takes a 4th argument). The
reactive mechanisms (continuity check, discovery, escalation) stay as a
safety net, not the only line of defense.

**Exact state right now:**
- `code-longform.js` itself is fully edited and syntax-valid (`node --check`
  passes).
- `code-longform.test.js` is NOT yet updated — every test's mock for the
  "You are a precise software architect" plan call still returns a bare
  `[...]` array instead of `{sharedVocabulary: [...], files: [...]}`, so
  `planFiles`'s own validation throws immediately and **all 12 tests
  currently fail**.
- The real website build (`work-website/`, built via
  `eochat/scripts/run-code-longform.mjs`) has NOT been re-run since this
  change — the files currently on disk there are from the PRE-vocabulary
  escalation run (partially mismatched, as described above).

### Resume steps 1-3: DONE — back to green, plus one new test

All 7 plan-response stubs in `code-longform.test.js` now return
`{ sharedVocabulary: [...], files: [...] }` instead of a bare array.
`node --test code-longform.test.js` is 14/14 green (12 original + 2 new).
Added the test the fix's own claim didn't have direct coverage for: "a
shared vocabulary entry decided at plan time reaches EVERY file's write
prompt verbatim" — captures the actual prompt text sent for both index.html
and styles.css and asserts both contain the identical declared vocabulary
line, byte for byte.

### TWO MORE real bugs found on the re-run, fixed, and regression-tested

4. **A stray, unmatched `"""` line at the top of a generated file** —
   `styles.css` on a real run started with a bare `"""` (not a markdown
   fence, no closing quote) before the actual CSS, which `stripFences`'s
   fence-only regex didn't touch. Fixed: `stripFences` now also strips a
   leading `"""` line, the same "only assume a LEADING marker, never a
   matched pair" discipline the existing fence-stripping already used.
5. **Syntax verification checked the discarded DRAFT, never the file
   actually kept.** `verifySyntax` ran once, right after the first write,
   before the continuity-correction loop (and, for HTML, escalation) could
   rewrite `content` entirely. A real run reported `script.js: FAILED` in
   `BUILD_REPORT.md` for a file whose KEPT version (after 2 correction
   passes) was in fact syntactically fine — and, worse, the inverse is also
   possible: a correction pass silently introducing a NEW syntax error
   (measured on a later run: `styles.css` correction produced 21 `{` vs 20
   `}`) would previously have been reported as "OK". Fixed: added
   `setVerification(verifications, path, language, result)` that
   overwrites-or-inserts by path, called again after the correction loop
   (if any attempts were made) and again after a successful escalation
   patch (skipped entirely when the patch fails its own syntax check, so a
   discarded broken patch never overwrites a good verification record).
   New test: "syntax verification reflects the file AFTER continuity
   correction, not the discarded first draft."

### Shared vocabulary fix: measured real-run result

Two clean re-runs of the Meridian Structural request (model=llama3.2,
`eochat/scripts/run-code-longform.mjs`) after the vocabulary fix landed:
both left only 2 distinct unresolved references in `styles.css`
(`serviceItem` — a per-item id the vocabulary never covered, only the
container `servicesList` was declared; and `mobileMenuToggle` — the
CORRECT name reused verbatim, but as an id selector `#mobileMenuToggle`
where the vocabulary declared it a CLASS, a new failure mode: right name,
wrong selector KIND). A third re-run's `styles.css` used 4 distinct
undeclared classes and DID cross the structural-mismatch threshold,
escalating successfully. Compared to the pre-fix baseline (8 distinct
flags, completely different naming scheme, escalation making only partial
progress) this is a real, measured improvement — declaring the vocabulary
once eliminated the "two files independently NAME the same concept
differently" failure mode entirely; what's left is narrower: names the
vocabulary never covered, and one case of the right name with the wrong
selector kind. Neither is what this fix targeted, so leaving both as
observed rather than chasing them here.

### The coalgebra-consistency fix: vocabulary reached the first write, not the correction

**Diagnosis**, framed by the hylomorphism/metamorphism reading this session
also did (see `specs/composition-is-retrieval.md`'s neighbors — eoreaderapp's
generation stage is a shared fold feeding independent unfolds, not a fused
hylo, and that's *correct* for L2 audit-locality, not a missed optimization).
The same "every step must consult the SAME declared structure" discipline
that motivated `sharedVocabulary` in the first place was only applied to the
FIRST unfold step (`buildWritePrompt`) — `buildFixPrompt` and
`buildEscalationPrompt` (every correction/escalation step after it) never
received `sharedVocabulary` at all. A real run's CSS wrote the CORRECT name
(`mobileMenuToggle`, right out of the vocabulary) as the WRONG selector kind
(`#mobileMenuToggle`, an id selector, where the vocabulary declares it a
class) and survived 2 correction attempts unresolved — because the fix
prompt only ever said "this doesn't exist," never "the vocabulary already
settles which kind this is."

**Fixed:** `sharedVocabulary` now threads into `buildFixPrompt` (which also
names the SPECIFIC mismatch — "used as an id, but the vocabulary declares it
a class" — not just "doesn't exist") and `buildEscalationPrompt`. New test:
"a correction prompt for a RIGHT-NAME-WRONG-KIND reference tells the model
the vocabulary's declared kind." Tests: 15/15 green before the next fix
below, 16/16 after.

**Confirmed on a real re-run** (model=llama3.2): `styles.css` used
`.mobileMenuToggle` correctly as a class this time — the exact defect this
fix targeted did not recur.

### A third real bug, found while visually verifying: stray `"""` can land on EITHER end

The leading-`"""`-stripping fix (bug #4 above) assumed the marker always
lands at the START. A LATER real run put the same bare, unmatched `"""` at
the END of `styles.css` instead — proving it isn't a half-stripped Python
docstring pair, just an unpredictable one-sided marker. Fixed: `stripFences`
now strips a leading OR trailing `"""` independently, neither implying the
other. New test: "a stray unmatched triple-quote marker is stripped from
EITHER end, never assumed paired." 16/16 green.

### Visual verification: DONE

Loaded `work-website/index.html` in the Browser pane preview, clicked the
`.mobileMenuToggle` button via its accessibility-tree ref: `headerContainer`
correctly gained the `open` class and the button's text flipped
`☰` → `Close Menu` → back to `Menu` on a second click — the full
JS/CSS/HTML interaction genuinely works, verified in a real browser, not
just mechanically. No console errors on `index.html`, `services.html`, or
`contact.html`. `contact.html` and `services.html` render mostly-empty
(vocabulary ids/classes present but no prose content authored for them, and
`services.html`'s `<div id="servicesList">` has no actual service listing
inside it) — a genuine, separate CONTENT-completeness gap, not a naming or
continuity defect; not investigated further this session.

### Still-open, accepted as a documented residual (not a bug — working as designed)

`servicesListContainer` / `serviceItem` / `contactInfoContainer`: on the
clean re-run, `styles.css` styled three WRAPPER concepts the vocabulary
never declared and that don't exist as real HTML elements — not a
name/kind mismatch of a KNOWN vocabulary entry (which the fix above now
handles), but the model inventing new structural concepts outside the
vocabulary's scope entirely. This sits at EXACTLY `STRUCTURAL_MISMATCH_THRESHOLD`
(3 distinct refs), which by design (`> THRESHOLD`, not `>=`) stays under
escalation — 3 is documented as "still normal drift," 4+ escalates. Revisit
only if this specific shape (correction makes zero progress across both
attempts, not just "some refs remain") recurs enough to justify a sharper
signal than raw count; one occurrence isn't a pattern.

### Exact next steps to resume

Nothing blocking. All of steps 1-5 from the original resume plan are done:
tests green (16/16), real re-runs confirm the vocabulary fix, two
correction-loop bugs found and fixed (stale syntax verification,
vocabulary not threaded into corrections), one stray-marker bug found and
fixed on both ends, and visual verification passed in a real browser. The
only open item is the wrapper-concept residual noted above, deliberately
left as observed rather than chased on one occurrence.

### Deferred, scoped honestly (do not build prematurely)

- **Time-as-a-dimension / surf's "surfeit" applied to escalation.** The
  qualitative shape is right (the current fixed threshold of 3 is a crude
  stand-in for "the ride broke"), but a REAL statistical null (reusing
  `loops/surf.js`'s burstiness-over-windows machinery) needs enough files
  for the statistic to have power — the same "no power at novelette scale"
  finding already measured for `seam-cost.mjs` earlier this session applies
  even harder to a 6-10 file build. Worth building properly once projects
  are large enough (dozens of files) for a per-file divergence series to be
  a real time series, not a token gesture at one.
- **Fold's past/contemporary/horizon** already informally justifies why
  declaring the shared vocabulary early (before files become "past") beats
  reactive escalation into settled past — this reasoning is now embedded in
  the code comments but was not built as a literal reusable organ; revisit
  only if a cleaner formalization becomes necessary.
- **A true multi-file replan** (beyond one bounded, one-file-targeted
  escalation) — if the shared-vocabulary fix still leaves real mismatches,
  the next honest step is closer to `holonic-task.js`'s `replan()`: measure
  which files are structurally out of step (not just one), and reconsider
  more than one file's content together rather than patching one at a time.

## `svg-longform.js` — the THIRD modality: vector diagrams, done and proven

Not text, not source code — a single SVG document (a flowchart-style
diagram: nodes + edges) built incrementally, element by element, on the
exact same `task-log.js` spine. A diagram is already graph-shaped, so
existence-dependency is not a metaphor here: an edge LITERALLY cannot exist
without the two node ids it connects (`requires` for an edge is DERIVED
from its own `from`/`to`, never trusted as a separately model-declared list
that might drift from them).

**The core design move, stated once and applied repeatedly:** where a
value can be COMPUTED from already-known structure, compute it — never ask
the model to reproduce it, because every time a weak local model was asked
to reproduce something computable, it introduced a NEW class of defect
that a purely reactive "detect and correct" loop couldn't have anticipated.
Concretely: node LAYOUT is derived from the edge graph itself (topological
ranking via DFS-detected back-edges excluded from a bounded relaxation,
so a genuine cycle — this domain's own retry loop — never blows up rank
unboundedly); the ARROWHEAD marker is synthesized once, never asked of the
model; a node's absolute PAGE POSITION is never given to the model at all
— it draws inside a local (0,0)-anchored box, and code wraps that in a
`<g transform="translate(...)">` computed from the real position,
guaranteed correct by construction because SVG transforms compose.

**Verification:** `xmllint` (a system binary on this machine, not an added
dependency) gives a REAL well-formedness check — the SVG-domain equivalent
of `new Function` for JS. Cross-reference checking (does every
`href="#id"`/`url(#id)` resolve to a real declared id) reuses
`checkCrossFileReferences`'s exact mechanism from `code-longform.js`,
adapted to SVG's reference grammar.

### Eight real bugs found across real runs against `llama3.2:latest`, fixed and regression-tested (26 tests, all pass)

1. **Node-placement failure given absolute coordinates** — given an
   absolute center and asked to place its own shape there, the model
   added an unrequested `rotate(90) skewX(-10)` transform, used a
   nonexistent `<g x=".." y="..">` attribute (silently ignored, so the
   shape defaulted to the origin), and positioned a label nowhere near its
   own shape. Fixed by removing the model's positioning responsibility
   entirely (the local-frame + code-wrapped-translate design above).
2. **Layout collision from model-assigned grid cells** — even after
   removing coordinate ARITHMETIC from the model, asking it to ASSIGN a
   grid cell per node (col/row) still let two different nodes land on the
   same cell (a real run put "Shipped" and "Payment Verified" on top of
   each other). Fixed by deriving col/row entirely from the edge graph
   (topological rank + within-rank row index) — the model is never asked
   for layout at all anymore.
3. **`xlink:href` used without the namespace declared** — `xmllint --noout`
   prints a namespace error to stderr but EXITS 0, so this silently passed
   verification while failing to render in a real browser (`Namespace
   prefix xlink for href on use is not defined`). Fixed by declaring
   `xmlns:xlink` unconditionally on both the verifier's wrapper and the
   real assembled document.
4. **A self-closed, empty `<text/>`** — syntactically valid, reference-
   clean, and utterly invisible. Neither existing check catches "missing
   content" as a category. Fixed with `hasVisibleText`, folded into the
   same correction loop as undeclared references.
5. **A percentage coordinate** (`x="50%" y="40%"`) — resolves against the
   ROOT viewport, not the element's local box (there is no nested viewport
   for it to be meaningful against), so the label rendered nowhere near
   its box. Fixed with a mechanical check + explicit prompt instruction;
   NEVER "fixed" by reinterpreting the percentage as a raw number, which
   would silently produce a different wrong position.
6. **An edge inventing its own `<marker>`/`<symbol>`/`<glyphDef>`**,
   apparently unsure whether the shared arrowhead already existed —
   well-formed XML, inert clutter nobody asked for. Fixed by stating
   explicitly in the edge prompt that the arrowhead already exists, plus a
   mechanical check.
7. **A `<path>` with `x1`/`y1`/`x2`/`y2` and no `d` attribute** — those
   coordinate attributes only work on `<line>`; a `<path>` with no `d`
   draws NOTHING. Well-formed, reference-clean, and half the edges on one
   real run vanished this way. Fixed with `hasPathWithoutD`, careful not
   to flag a legitimate `<line>` (which genuinely uses those attributes).
8. **Oversized font-size overflowing a node's box into NEIGHBORING nodes'
   labels** (`font-size="24"` in a 64px-tall box). Unlike position, the
   safe range is fully known in advance (the box height) — so this is
   CLAMPED directly in code, not routed through a correction round-trip
   like the other seven.

### Real-run comparison: `llama3.2:latest` (3.2B) vs `qwen2.5:14b-instruct` (14.8B)

Same request ("order fulfillment" flowchart with a payment-retry branch),
same fully-fixed pipeline, both models. `llama3.2` (after all 8 fixes):
clean 6-node/4-edge diagram, correct branch layout (3x3 grid), all edges
visible, zero unresolved continuity flags on the final run. `qwen2.5:14b`
(~4-5x slower per call on this hardware, ~10s/element vs ~2-3s): cleaner
typography and a nicer subtle box style, but modeled the plan itself
differently — collapsed "payment failed" into a SELF-LOOP edge
(`payment_retry`: from=`payment_verification` to=`payment_verification`)
rather than a distinct node. A self-loop's two endpoints are IDENTICAL, so
it degenerates to a zero-length line with an arrowhead rendering as a
blob on top of its own node — a genuinely NEW defect class this session
did not encounter on `llama3.2` and has NOT been fixed (not yet a
measured pattern from more than one run; noted, not chased). Bigger model
≠ automatically better diagram — it shifted the failure mode from
rendering-layer (llama3.2's problems) to plan-layer (qwen's problem),
consistent with this file's own earlier lesson from `code-longform.js`
that a stronger model doesn't retire the need for mechanical verification,
just changes what needs verifying.

### Deferred, scoped honestly (do not build prematurely)

- **Self-loop edge rendering** (a small decorative arc instead of a
  zero-length line) — observed exactly once, on `qwen2.5:14b`, not yet a
  measured pattern across multiple runs.
- **Edges clipped to box edges rather than center-to-center** — currently
  an edge's line/path always runs from one node's exact center to
  another's, so the arrowhead often lands visually inside the target
  box's text rather than at its border. Documented as a known v1
  simplification from the start; revisit only if it becomes a readability
  problem in practice, not preemptively.
- **Escalation / mid-run element discovery** (`code-longform.js`'s
  equivalents) — not built here on purpose: because layout, the arrowhead,
  and position are all computed rather than generated, the classes of
  drift those two mechanisms exist to catch are largely designed out
  before they can occur, and adding them speculatively would be exactly
  the kind of complexity this codebase's own discipline argues against.

## Placement note (constitution-relevant)

All of this lives in `eochat/server/` and `eochat/scripts/` deliberately —
these files call a model (Ollama) and touch the filesystem, both of which are
`eo-constitution` Article I.4 application concerns. The pure spine
(`task-log.js`) is imported unmodified; nothing here would be legal inside
`eoreader6/scripts`. See memory: `eo-constitution-placement-rules` and
`eochat-laws` (LAWS.md L1 — no dead air — is why every runner streams
per-file/per-scene progress rather than blocking silently).

## Key files, for quick orientation

- `eochat/server/task-log.js` (+`.test.js`) — the spine, do not modify lightly
- `eochat/server/narrative-longform.js` (+`.test.js`) — fiction, stable reference implementation
- `eochat/server/predictive-longform.js` (+`.test.js`) — numeric prediction, stable
- `eochat/server/code-longform.js` (+`.test.js`) — multi-file code, stable, 16 tests pass
- `eochat/server/svg-longform.js` (+`.test.js`) — vector diagrams (3rd modality), stable, 26 tests pass
- `eochat/scripts/run-narrative.mjs` — CLI runner for fiction
- `eochat/scripts/run-code-longform.mjs` — CLI runner for code
- `eochat/scripts/run-svg-longform.mjs` — CLI runner for diagrams
- `specs/composition-is-retrieval.md` — the theoretical grounding (main project root)
- `work-website/` (main project root) — the real generated site, vocabulary fix confirmed working
- `work-diagram/`, `work-diagram-qwen/` (main project root) — real generated flowcharts, llama3.2 vs qwen2.5:14b comparison
