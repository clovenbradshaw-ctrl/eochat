# AGENTS.md

Lineage governance lives in `../eo-constitution/` — the amendable EO
constitution and routing oracle. Read `CONSTITUTION.md` before any placement
decision: engine `eoreader6` / priors `eoPriors` / apps / legacy. A change
the oracle refutes does not ship. This repo is an application — a thin host
that owns clock, I/O, routing, and UX, and must change no engine reading.

`LAWS.md` binds how this host behaves once placement is settled — no dead air
after a trigger (L1), audit reachable from wherever the doubt forms (L2), no
silent truncation (L3). Each law names the failure it forbids and the check
that catches it. Run `npm run check:laws` against a live proxy before shipping
a change to ingest, retrieval, citation, or any surface that reports progress;
it exits non-zero on violation. A measured violation is recorded in `LAWS.md`
as a known violation and fixed in code — never answered by softening the law.
