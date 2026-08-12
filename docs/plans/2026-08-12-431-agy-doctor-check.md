# Plan: #431 - agy adapter health check for forge:doctor

**Ticket:** #431 (board #8, child of epic #182) - **Kind:** feature (health-check)
**Base:** main - **Branch:** feat/431-agy-doctor-check

Surfaced by review of the agy host adapter's init -> adopt -> check lifecycle:
`forge:doctor` has zero agy awareness (no hits for `agy|Antigravity` across
`doctor.mjs`, `runner-checks.mjs`, `runner/check.mjs`, `commands/doctor.md`,
`commands/runner-check.md`), and the in-place emit path (`emit.mjs:279-282`)
prints its `agy plugin validate` reminder only when `--out` was passed, so the
recommended primary flow finishes with no verification guidance at all.

**Scope boundary with #433 (PR #441, merged today):** #433 owns the
adopter-facing install/update narrative and explicitly deferred the
health-check plumbing here (its AC.5, and both guides' "tracked in #431, not
built by this guide" lines). This ticket consumes that seam rather than
building a parallel version check: the staleness comparison is "the emitted
`plugin.json`'s version vs. the currently-running forge instance's own
version" — exactly what both guides already tell an adopter to do by hand.

## Gating-signal decision (required by the ticket body)

The trigger for the whole adapter-health block is **an emitted package on
disk** at the conventional `.agents/plugins/forge/` location — **not**
`features.agy`. `features.agy` (`plugin/scripts/agy/core.mjs`) is the
advisory Gemini-offload flag; it says nothing about whether this repo ever
ran `init --host agy`. Conflating the two would nag agy-offload users who
never emitted a package, or stay silent for adopters who did but never
flipped the offload flag. This mirrors `doctor.mjs:200-202`'s runner
precedent exactly: silent unless the *actual feature in use* is detected
(there: `runner.enabled`; here: package presence), never a config-flag proxy
for "in use."

`features.agy` gets its own, independently-gated check (AC.4): it fires
whenever the flag is on, regardless of whether a package was ever emitted,
because the offload path (`agy --print`) needs `agy` on PATH too and has
nothing to do with the adapter package. The two checks are deliberately
decoupled — pinned by a dedicated test (`tests/doctor.test.mjs`, "features.agy
on, no package emitted -> ONLY agy-offload fires").

A custom `--out` staging path is not detected by doctor — only the
documented, recommended default (in-place, no `--out`) is checked. Stated
plainly rather than silently implied.

## Doctor-only vs. doctor-plus-preflight (required by the ticket body)

**Decision: doctor-only.** No dedicated `forge agy check` preflight command.
The #225/#245 precedent (runner health line + a dedicated adoption-readiness
preflight) exists because adopting a self-hosted runner is a one-time,
multi-step, security-relevant setup — private-repo guard, PAT store,
Docker reachability, service registration — worth a dedicated go/no-go gate
*before* flipping a switch that can run untrusted code. The agy adapter has
no comparable moment: emitting is a single idempotent command
(`init --host agy`), and `agy plugin validate forge` is already the
host-side adoption gate, documented end-to-end in `cross-gai.md` Step 4. A
second forge command duplicating that role would add command surface
without adding signal. The checks still live in a shared module
(`plugin/scripts/lib/agy-checks.mjs`, mirroring why `runner-checks.mjs`
exists) so a second consumer costs nothing to add later if that changes.

## AC map

- **AC-431.1** `forge:doctor` reports on the agy adapter when an emitted
  package is present: `agy` on PATH, the three generated files
  (`plugin.json`/`mcp_config.json`/`hooks.json`) valid, plus the deny/capture
  shims. Silent and non-failing when no package is found.
- **AC-431.2** Staleness: the emitted package's `plugin.json` version is
  compared against the currently-running forge instance's own version;
  warns when behind (or ahead — a signal the *doctor instance itself* may be
  stale). Silent when doctor is running as the emitted copy itself (nothing
  to compare against — the one case the guides still ask the operator to
  check by hand).
- **AC-431.3** `emit.mjs`'s verification-guidance line now prints
  unconditionally (in-place AND `--out`), not gated on `viaOut`.
- **AC-431.4** `features.agy` on + `agy` unreachable is reported,
  independent of whether a package was ever emitted.
- **AC-431.5** Tests pin every new check, including the negative case (a
  repo with no emitted package and `features.agy` off produces zero
  `agy-*` rows anywhere in doctor's report).

Non-goal (per the ticket): the emitter's OUTPUT is unchanged — only the
printed guidance (AC.3) and the new doctor checks (AC.1/2/4) are added.

## Task 1 (feature): shared agy-checks module

New `plugin/scripts/lib/agy-checks.mjs`: `readEmittedMarker`,
`resolveOwnManifest`/`ownPluginRoot` (own-version resolution, Claude layout
then co-located agy layout), `checkAgyStaleness`, `checkAgyPackageIntegrity`
(three files + two shims), `findUnrewrittenPlaceholders`/`checkAgyRewrite`
(#294 regression class), `checkAgyJournal` (`.forge/agy-journal.jsonl`
sanity, silent when absent), `checkAgyAdapter` (the gated orchestrator,
AC.1/AC.2) and `checkAgyOffload` (AC.4, independently gated). Every check
degrades to warn/skip on a read failure, never throws — same contract as
`runner-checks.mjs`.

**Files:** plugin/scripts/lib/agy-checks.mjs

## Task 2 (feature): wire into doctor.mjs

Import and call `checkAgyAdapter`/`checkAgyOffload` from `runDoctor`, gated
on `cfg.ok`, placed alongside the runner block (both are silent-unless-
applicable sections). No change to doctor's existing checks.

**Files:** plugin/scripts/doctor.mjs

## Task 3 (fix): emit.mjs prints verification guidance unconditionally

Move the `agy plugin validate forge` reminder out of the `if (viaOut)`
guard so it prints on every emit; keep the `--out`-specific NOTE lines
(discovery-flow-is-primary, re-validate-after-install) gated on `viaOut`
only. No change to what is written to disk (non-goal).

**Files:** plugin/scripts/agy/emit.mjs

## Task 4 (test): agy-checks unit tests

New `tests/lib/agy-checks.test.mjs` — gating/negative case, integrity
against a REAL emitted package (`emitAgyPlugin` into a tmp dir) plus
break-it cases (remove a generated file, remove a shim, corrupt JSON, stale
version, newer-than-own version), the #294 rewrite regression (clean emit
vs. hand-edited placeholder), journal sanity (absent/valid/malformed),
`resolveOwnManifest`/`checkAgyStaleness` layout + self-comparison edge
cases, and `checkAgyOffload`'s independence from the adapter block.

**Files:** tests/lib/agy-checks.test.mjs

## Task 5 (test): doctor integration + AC.5 negative case

New describe block in `tests/doctor.test.mjs`: the AC.5 negative case (no
package, `features.agy` off -> zero `agy-*` rows), a real-emit-present
pass, agy-not-on-PATH warn, the two-gating-signals-decoupled cases, and a
stale-package warn that never fails doctor outright.

**Files:** tests/doctor.test.mjs

## Task 6 (docs): consume #433's seam, don't re-document it

Replace both guides' "tracked in #431, not built by this guide" lines with
a short description of the now-built `agy-staleness` doctor check, keeping
the one honest residual limitation (running doctor from inside the emitted
copy itself has nothing to compare against). Add a short agy-adapter
paragraph to `commands/doctor.md`.

**Files:** docs/guides/cross-gai.md, docs/guides/install.md, plugin/commands/doctor.md

## Task 7 (docs): route index

Add this plan to `docs/README.md`.

**Files:** docs/README.md
