# Plan: #386 - surface a notice when delivery proceeds without graph-RAG on a TS-capable repo

**Ticket:** #386 (parent #182, plugin platform maintenance) - **Kind:** bug/chore
**Base:** main - **Branch:** feat/386-graph-availability-notice

`features.graph` defaults to `false` on a fresh scaffold (TS-repo-specific,
`docs/guides/install.md:47`). Neither `forge:deliver` nor `forge:autopilot` checks or
surfaces this, and `forge:doctor` only warns when `features.graph` is already `true`
(`doctor.mjs:159-171`) — it never flags "you might want this on." Fix scope: extend
`forge:doctor` (the natural home — it already runs health checks) with the inverse
check, not a new check point in deliver/autopilot's hot path. Visibility fix only —
does not force graph on by default.

## AC map

- **AC-386.1** `forge:doctor` on a repo with `tsconfig.json` present and
  `features.graph: false` prints a clear ⚠ advisory line naming graph-RAG as
  available but off, with the exact 3-step enable sequence documented in
  `install.md:47` (`features.graph:true` + `npm i -D ts-morph` +
  `graphctl.mjs rebuild`).
- **AC-386.2** no change in behavior for non-TS repos, repos that already have
  `features.graph: true`, or repos that deliberately disabled it after trying it.
  Nuance chosen: "never configured" (no `features` block at all, e.g. an adopted
  repo) is treated the same as "off" and still gets the advisory — a fresh
  non-adopt `forge:init` always writes an explicit `false` (`init.mjs:180`), so
  "missing vs explicit false" in `forge.json` would NOT actually separate
  never-configured from deliberately-disabled. The cheap, real signal for
  "deliberately disabled after trying" is `.forge/graph.db` already existing
  (the repo built the index once) — when present, the advisory is suppressed.
- **AC-386.3** the check is read-only — no writes to `forge.json` or anywhere else.

## Task 1 (item): add the `graph-availability` doctor check (AC-386.1, AC-386.2, AC-386.3)

New check block in `runDoctor`, positioned next to the existing `features.graph===true`
block it inverts (`doctor.mjs:159-174`), same `ok/warn/fail` helper shapes and
`{name, level, msg, hint}` result shape as every other doctor check. Fires a `warn`
named `graph-availability` when `cfg.ok && cfg.config.features?.graph !== true` AND
`tsconfig.json` exists AND `.forge/graph.db` does NOT exist. Purely additive — the
existing `graph` check (fires only when `features.graph===true`) is untouched, so the
two checks are mutually exclusive by construction.

**Files:** plugin/scripts/doctor.mjs

## Task 2 (test): AC-mapped tests

Six new tests in `tests/doctor.test.mjs` (new `describe` block): tsconfig+off → warn
with hint asserting the 3-step sequence (AC.1); no `features` block at all → same warn
(never-configured nuance); `features.graph:true` → no advisory; no `tsconfig.json` →
no advisory even with graph off; `.forge/graph.db` present → no advisory (deliberate
opt-out, AC.2); doctor run leaves `forge.json` byte-identical (AC.3, read-only).

**Files:** tests/doctor.test.mjs

## Verification

`pnpm verify` (vitest run, full suite). Gates: plandrift clean (this plan's **Files:**
lists cover both touched files), testintent clean (only new assertions, nothing
weakened), depguard clean (no new dependencies), docsync clean (no new/renamed docs).
