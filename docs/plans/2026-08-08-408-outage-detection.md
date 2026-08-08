# Plan: #408 - detect + auto-recover from GitHub Actions platform outages (distinct from rate-limit)

**Ticket:** #408 (parent #183, autopilot epic) - **Kind:** feature/chore
**Base:** main - **Branch:** feat/408-outage-detection

Spec: `docs/specs/2026-08-08-github-resilience.md` §2.2 + §3.2. Distinct from #407
(GraphQL rate limiting): GitHub Actions infra itself can return `Service
Unavailable` resolving action-download-info, or leave a job stuck `queued`
indefinitely — neither matches `isRateLimited()`'s signatures, so today it is
treated as an ordinary CI failure and can falsely trip the "same gate failing
twice" escalation even though nothing about the change is broken. The
empirically-proven recovery this session (§2.2): force a fresh commit SHA via
rebase + `--force-with-lease` repush — re-running the same SHA did not
reliably help.

## AC map

- **AC-408.1** `exec.mjs` gains a pure `isPlatformOutage(res, opts)` detector
  mirroring `isRateLimited`'s shape: textual ("Service Unavailable" +
  action-download-info resolution failure, both required) and stuck-queued
  (a job in QUEUED status past a generous threshold, `stuckQueuedMs`, default
  15m). No live API — fixture-tested. The CI-watch path (`ci-watch.mjs`)
  wires the stuck-queued trigger into its existing poll loop using its own
  clock (`allQueued`/`queuedSince`/`outageReported`, threaded across polls
  like `prev`), reported at most once per stuck episode.
- **AC-408.2** the merge-bar path (`merge.mjs` `runMerge`) classifies a real
  (non-empty) bad-checks CI result via `classifyCiFailure` before routing it
  to the ordinary fix-wave/escalation path. An outage attempts the
  empirically-proven recovery (`forceNewSha`: fetch, rebase onto
  `origin/main`, `git push --force-with-lease`), bounded to
  `maxOutageAttempts` (default 2) and threaded across separate invocations
  via `--outage-attempt` (a fresh SHA needs a fresh CI run to watch — the
  bound can't be a busy-loop inside one call).
- **AC-408.3** exhausted recovery falls through to a real "blocked on ci"
  result, but `reason` honestly distinguishes "GitHub Actions platform
  outage, not your change" from a real gate failure — `platformOutageNotice`
  surfaces the same distinction at the point of each recovery attempt. A real
  gate failure (log text with no outage signature) is never classified as an
  outage — the classifier degrades to "not an outage" on any
  malformed/ambiguous signal so a genuine regression is never masked.
- **AC-408.4** every outage event (recovered / recovery-failed / exhausted)
  is journaled (`gate-fail`, `outage:true`, `phase`) via `ctx.cwd` when
  present — visible in the run report / `board digest` (`METRIC_KINDS`
  already includes `gate-fail`) — so a run's history can tell a real fix wave
  from GitHub being down twice. `autopilot/SKILL.md` documents the
  distinction so the delivering agent posts the honest `--phase gate-fail`
  trail comment instead of treating an outage as a code problem.

## Task 1 (item): `isPlatformOutage` + `platformOutageNotice` in exec.mjs (AC-408.1)

Pure detector mirroring `isRateLimited`'s shape and position in the file (next to
the #360 rate-limit block). Two independent triggers: textual signature
(`Service Unavailable` + `action[- ]?download[- ]?info`, both required) or
`{status:'QUEUED', queuedForMs}` past `stuckQueuedMs`. `platformOutageNotice`
is the honest, actionable line (mirrors `rateLimitNotice`).

**Files:** plugin/scripts/lib/exec.mjs

## Task 2 (item): stuck-queued wiring in the CI-watch monitor (AC-408.1, AC-408.4)

`allQueued(checks)` classifies a rollup as fully-queued. `poll()` gains
`queuedSince`/`outageReported` state (threaded across polls exactly like
`prev`, additive/backward-compatible — existing 2-arg calls and the `prev`
contract are unchanged) and emits one `CI outage-suspected on PR #n (...)  —
stuck queued Xm...` line per stuck episode instead of spamming every 20s
interval. A real fail transition still emits the ordinary `CI fail` line.

**Files:** plugin/scripts/monitors/ci-watch.mjs

## Task 3 (item): outage classification + bounded recovery in the merge bar (AC-408.2, AC-408.3, AC-408.4)

`ciGreen` now also returns the PR's branch (`headRefName`, riding along on
the existing `pr view` call — no extra round-trip). `classifyCiFailure(gh,
{branch})` fetches the branch's latest run (`gh run list`) and, only when it
has genuinely completed or is stuck, the failed-job log
(`gh run view --log-failed`) to decide outage vs real failure via
`isPlatformOutage` — bounded to at most one extra round-trip, and only when
`ciGreen` already found real bad checks (not on an empty "no checks reported
yet" rollup, which stays a zero-extra-call path). `forceNewSha(execRun,
{base})` performs the fetch/rebase/push recovery with an injected exec
function (mirrors `exec.mjs`'s own DI convention — no real git in tests).
`runMerge` wires it in: outage + attempts remaining → recover, journal, return
`outcome:'retry'`; outage + exhausted → real "blocked on ci" with the honest
distinguishing `reason` + journal; not an outage → unchanged behavior
(`evaluateMergeBar` as before). All additive — every existing `ciGreen`/
`runMerge` test path (green CI, empty rollup, missing signals, critical) is
untouched because none of their fixtures hit "real bad checks."

**Files:** plugin/scripts/autopilot/merge.mjs

## Task 4 (docs): teach the distinction in the autopilot skill (AC-408.3, AC-408.4)

`plugin/skills/autopilot/SKILL.md` § Auto-merge documents that a CI red first
routes through the outage classifier before either a fix-wave or an
escalation, and that an outage's trail comment must say "GitHub platform
outage, not your change," not read as a real gate failure — closing the loop
the ticket's evidence names ("today this recovery is 100% manual; an agent
has to recognize the signature by eye").

**Files:** plugin/skills/autopilot/SKILL.md

## Task 5 (test): AC-mapped tests

`tests/lib/exec.test.mjs` — `isPlatformOutage`/`platformOutageNotice` fixture
tests (textual signature, case-insensitivity, false positives ruled out,
stuck-queued threshold math, custom threshold). `tests/monitors/monitors.test.mjs`
— `allQueued`, stuck-episode-once-only reporting, reset-on-recovery, a real
fail transition unaffected. `tests/autopilot/engine.test.mjs` —
`classifyCiFailure` (queued/completed/log-text branches, malformed-response
degrade), `forceNewSha` (order, first-failing-step surfaced), `runMerge`
(recovery attempted, bounded exhaustion with the honest reason, a real
failure never masked, empty-rollup path untouched, works without `ctx.cwd`).

**Files:** tests/lib/exec.test.mjs, tests/monitors/monitors.test.mjs, tests/autopilot/engine.test.mjs

## Verification

`npx vitest run` (full suite, 794+ tests). Gates: plandrift clean (this
plan's **Files:** lists cover every touched non-doc/non-test path), testintent
clean (only new assertions added, nothing weakened), depguard clean (no new
dependencies), ac-gate clean (AC-408.1..4 each covered by ≥1 passing test),
docsync clean (spec already indexed; this plan added to the route index).
