# eo-constitution

The amendable constitution and routing assay for the EOReader lineage.

`CONSTITUTION.md` is the one governing document. It decides which of the four
domains anything ships into — engine (`eoreader6`), priors (`eoPriors`),
applications (thin hosts), or legacy (`eoreader5`, `eoreader4.2`). The assay
in `assay/` is its enforcement: a placement claim that does not pass the
articles does not ship.

## The metric, in one line

**Prior? → App? → what remains is engine.** Ask in that order, by the three
tests:

- **II.1 Omnimodal** — would a leitmotif in a symphony have this problem? A
  mechanism that needs a name string or a surface is not engine.
- **II.2 Giver** — knowledge about the material is priors and must name its
  giver. Missing giver is a wall: typed gap, never derive.
- **II.3 Host** — knowledge about the reader, host, moment, or interface is
  app: clock, I/O, routing, persistence, UX.
- **II.6 Book** (1st amendment) — a source is addressed; read the book for
  whom it was written, no surrogate stands in for the text, priors come in
  and are adjusted. A claim that consumes a surrogate is refuted everywhere.
- **II.7 Convergence** (2nd amendment) — no one-thing fixes; zoom out. A
  mechanism ships only if it is the one intelligence converges on where
  getting it right is rewarded.
- **II.8 Difference** (3rd amendment) — the engine figures by difference
  against a rebuilt nothing; a mechanism that weights what is present (no
  null, no rebuilt ground) can never differ from itself and is refused as the
  measurement. The host may attend; the engine never does.
- **II.12 Local** (7th amendment) — the AI datacenter with infinite GPU
  compute does not exist; the boundary conditions of the invention are local
  compute and mainstream hardware. A measurement whose correctness depends on
  compute it does not own is refused wherever it is the measurement, and a
  null that does not run locally does not exist.

## Using the assay

```bash
npm test                                          # the constitution's own conformance
npm run route -- check claims/<claim>.json        # verify a placement claim (hard gate)
npm run route -- ask  <evidence>.json             # classify evidence, get the routed tier
```

`check` is the gate: exit 0 = PLACEMENT SUSTAINED, exit 1 = PLACEMENT REFUTED
(gap, wait, or wrong tier), each with the articles cited. Wire it into a
pre-commit hook or CI to make a misplacement fail the build.

### Claim shape

```json
{
  "claim_id": "slug",
  "what": "human description",
  "proposed_placement": "engine | priors | app",
  "evidence": {
    "needs_name_or_surface": false,
    "is_material_knowledge": true,
    "giver": "who gives it",
    "is_host_knowledge": false,
    "medium_agnostic": true,
    "is_one_off_fix": false,
    "weights_present": false,
    "needs_datacenter_compute": false,
    "consumes_source": "direct | surrogate | none",
    "host_dependencies": [],
    "level_test": "above"
  }
}
```

`level_test` is only for engine organs (IV.3 growth rule). `ask` accepts a
bare evidence object or a full claim. `is_one_off_fix` is the 2nd-amendment
convergence veto (II.7); `weights_present` is the 3rd-amendment difference
veto (II.8) — true on an engine placement is refuted, the host may attend;
`consumes_source` is the 1st-amendment book test (II.6) — `surrogate` is
refuted in every tier; `needs_datacenter_compute` is the 7th-amendment local
veto (II.12) — true on an engine placement is refuted, the boundary binds the
measurement, never the host that calls a model it does not own.

## The workflow, as we iterate

1. Something new appears — an organ, an injection, a host feature.
2. Write a claim (`claims/*.claim.json`) proposing its placement.
3. `npm run route -- check claims/<claim>.json` — sustained or refuted, with
   citations.
4. The claim file travels with the code change. Conformance reruns on every
   test run; a refuted placement is a failing build.

The `claims/` directory is the accumulated case law: every ruling recorded
here is a precedent the next iteration can cite.

## Amendment

The constitution is amendable (Article IV). An amendment edits
`CONSTITUTION.md` **and** updates the enforcement in the same change — the
conformance tests or the classification engine. Amendments change the test,
visibly, and are numbered in the amendment log (IV.6). The assay proposes
and checks; it never amends.

## Domain map

| domain | repo | holds |
|---|---|---|
| engine | `eoreader6` | the measurement: the one operation, re-earned organs |
| priors | `eoPriors` | the ground: witness knowledge, gifts that name their giver |
| apps | `eoreader-chat`, `eoreader-proxy`, `eoreaderapp`, `eoreader-mcp` | thin hosts: clock, I/O, routing, UX, session |
| legacy | `eoreader5`, `eoreader4.2` | frozen reference and measured dead ends — trusted, never ported from |
