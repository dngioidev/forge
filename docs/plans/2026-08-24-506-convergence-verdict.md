# Plan: #506 - autopilot: the run has no convergence verdict — filed-vs-closed can diverge for waves unnoticed

**Ticket:** #506 (board #8) - **Kind:** feature - **Parent:** epic #503
**Base:** main - **Branch:** feat/506-convergence-verdict - **Verify:** `pnpm verify`

## Task T1 — pure convergence verdict

**Kind:** code. **AC-IDs:** AC-506.1

`ledger.mjs` gains `convergence(run, {startingOpen, currentOpen})` — pure, no
IO. `closed` counts THIS RUN's own `merged` outcomes (the only outcome that
actually closes a GitHub issue); `filed` is `run.filed.length`; `netDelta =
closed - filed`; `verdict` is `converging` (net > 0), `flat` (net === 0), or
`diverging` (net < 0). Scoped to the run's own actions (immune to unrelated
board churn), matching the ticket's own worked example: 11 merged, 13 filed
→ `diverging`, not "a good run". `startingOpen`/`currentOpen` are threaded
through on the return object (not folded into the verdict) so `renderReport`
(T3) can source "open-now vs open-at-start" from the same call.

**Files:** plugin/scripts/autopilot/ledger.mjs, tests/autopilot/engine.test.mjs

**Test plan:** `AC-506.1` — `tests/autopilot/engine.test.mjs`, describe
block `autopilot convergence verdict (#506, epic #503)`, the three
`convergence` tests (converging, the 11-merged/13-filed false-positive
reproduction, and the flat/zero-delta case).

## Task T2 — startingOpen persisted once, resume-safe

**Kind:** code. **AC-IDs:** AC-506.2

`startRun(cwd, opts)` accepts a new `opts.startingOpen`, sanitized via the
existing `sanitizePositiveInt` and persisted into `run.json` under the exact
same contract as `boardSizeAtStart` (#488): set once on a fresh run,
backfilled on a resume of a pre-#506 ledger that lacks the field, and never
recomputed once present — so a shrinking/growing live board never rewrites
the anchor `convergence` measures against. A corrupted opt (`Infinity`,
`NaN`, `0`, negative) is rejected at write time, same as `boardSizeAtStart`.

**Files:** plugin/scripts/autopilot/ledger.mjs, tests/autopilot/engine.test.mjs

**Test plan:** `AC-506.2` — the "startRun persists startingOpen once,
resume-safe", "a pre-#506 ledger... backfills... then never re-anchors",
and "a corrupted startingOpen opt... is never persisted" tests.

## Task T3 — renderReport gains the convergence line

**Kind:** code. **AC-IDs:** AC-506.3

`renderReport(run, {outboxPending, currentOpen})` gains an optional
`currentOpen` parameter (additive-only, mirrors `outboxPending`'s existing
opt-in shape). When both it and the persisted `run.startingOpen` are
present, a `convergence:` line is appended: closed, filed, net delta (with
verdict), and open-now vs open-at-start. Omitted — report byte-identical to
pre-#506 — when either input is unavailable, so every existing caller
(including the bare `ledger.mjs report` CLI, which has no live board count
to hand) is unaffected.

**Files:** plugin/scripts/autopilot/ledger.mjs, tests/autopilot/engine.test.mjs

**Test plan:** `AC-506.3` — the "renderReport includes a convergence line"
test (exact line format) and the "additive-only — omitted when
currentOpen... unavailable" back-compat test.

## Task T4 — two-consecutive-diverging-waves guard

**Kind:** code. **AC-IDs:** AC-506.4, AC-506.5

`convergenceGuard(run, {startingOpen, currentOpen})` wraps `convergence()`
with `run.divergingStreak` (new persisted field, defaults 0): a diverging
wave increments the streak, any other verdict resets it to 0. Returns the
same `{stop, escalate, reason}` shape `nextIteration` already uses so the
orchestrator treats every loop backstop identically; `stop`/`escalate` only
flip true once the streak reaches 2 (two CONSECUTIVE diverging waves) — one
diverging wave alone never trips it. `reason` names the filed tickets.
Escalation itself stays the existing `board/escalate.mjs` path — this
function only decides, per the ticket's explicit "not a new mechanism".
Pure (AC.5): every test constructs a `run` object directly and calls
`convergence`/`convergenceGuard` synchronously — no `ctx`/`gh`, no board
read. `recordConvergence(cwd, {...})` is the thin IO wrapper that persists
`divergingStreak` (mirrors `applyBudgetReading`/`recordBudgetReading`).

**Files:** plugin/scripts/autopilot/ledger.mjs, tests/autopilot/engine.test.mjs

**Test plan:** `AC-506.4` — "ONE diverging wave does not stop the loop",
"TWO CONSECUTIVE diverging waves stop... naming the filed tickets", "a
converging (or flat) wave resets the streak", and "recordConvergence
persists divergingStreak to disk" tests. `AC-506.5` — the dedicated
"convergence and convergenceGuard are synchronous pure functions... no
board/gh access" test (plus every AC-506.1/AC-506.4 test already
demonstrating it structurally, per the ticket's own framing).

## Task T5 — wire recordFiled into the real filing path (AC.6, appended after triage)

**Kind:** fix. **AC-IDs:** AC-506.6

`recordFiled`/`applyFiled` had ZERO callers before this ticket — verified
live: a run that filed #556/#557/#561/#562/#566 still showed `run.filed:
[]`. `newwork.mjs`'s `fileWork(ctx, spec, create, log)` — the documented,
single real choke point every follow-up filing (CLI or MCP) passes through
— now calls `recordFiled(ctx.cwd, {issue, kind, from})` after a successful
`create`, best-effort (logs, never throws, since the board ticket already
exists by that point and a thrown failure would invite a duplicate-creating
retry). Separately, `applyFiled` now validates `issue` as a positive
integer and THROWS on a malformed entry — closing the live trap where
`recordFiled(cwd, 556)` (a bare number instead of `{issue,kind,from}`)
destructured to `issue: undefined`, silently wrote a phantom entry, and
then permanently swallowed every later legitimate filing via the dedup
(`f.issue === issue` matching `undefined === undefined`).

**Files:** plugin/scripts/autopilot/newwork.mjs, plugin/scripts/autopilot/ledger.mjs, tests/autopilot/engine.test.mjs

**Test plan:** `AC-506.6` — describe block "recordFiled/applyFiled wiring
— fileWork actually reaches run.filed": the malformed-entry-throws test
(the live trap, pinned directly), "fileWork records the filed ticket into
run.json THROUGH THE REAL PATH" (goes through `fileWork` → `recordFiled` →
`loadRun` from disk, not a direct `applyFiled` call), the best-effort
never-throws-on-ledger-failure test, and the no-`ctx.cwd` back-compat test.

## Task T6 — docs (autopilot/SKILL.md + driver-scripts.md reference)

**Kind:** code (docs). **No new AC** — documents T1-T5's real wiring so the
orchestrator loop actually calls the new guard (the ACs are covered by T1-T5's
tests; this task has no test of its own beyond `docsync-check`/byte-budget).

`autopilot/SKILL.md` § Stop conditions gains one terse bullet for the
convergence guard (mirrors the existing runaway-backstop bullet), and §
Run ledger & report gains one sentence for the additive `convergence:`
report line — both within the file's existing <70000-byte budget (#467).
Full rationale relocated to `driver-scripts.md`'s `ledger.mjs`/`newwork.mjs`
entries, same "relocate, don't inline" pattern #467 established.

**Files:** plugin/skills/autopilot/SKILL.md, plugin/skills/autopilot/reference/driver-scripts.md
