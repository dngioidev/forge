# Plan: #505 - a delivery subagent that never returns is undetectable

**Ticket:** #505 (board #8, child of epic #503) - **Kind:** feature (Item, size L)
**Base:** main - **Branch:** fix/505-agent-liveness-detection - **Verify:** `pnpm verify`

`watchdog.mjs`'s `resolveReturnedTicket()` only classifies a subagent's
**terminal report** — it runs after a spawn returns. A subagent that never
returns at all produces no report to classify and is invisible to the engine
today: `plugin/monitors/monitors.json` has three watchers (`forge-ci`,
`forge-decisions`, `forge-outbox`), none touching subagent liveness, and no
`.forge/agents/*`, heartbeat, or `classifyLiveness` exists anywhere on `main`.

Field evidence from the triage trail (2026-08-11/13 run, five stalls): four
were notified (harness stall-kill or a rate-limit kill) and cost minutes each.
The fifth — #457 deliver — died silently, no notification at all, and cost
5.3 hours of a 6.6-hour ticket. The mechanism that diagnosed it after the fact
was manual: output-file mtime vs. elapsed wall clock. This ticket builds the
automated, in-run equivalent of that diagnosis.

## Design

Extends the exact pattern `ci-watch.mjs` already uses (`writeCiWatchState` /
`loadCiWatchState` + a monitors.json entry that pushes a line to the running
loop): a new `plugin/scripts/monitors/agents-watch.mjs`.

- **Heartbeat record** — `.forge/agents/<id>.json`:
  `{ id, issue, branch, phase, spawnedAt, lastArtifactAt }`. `writeAgentHeartbeat`
  is a best-effort write (never throws — mirrors `writeCiWatchState`'s
  never-fail-the-caller contract), called by the delivery subagent itself at
  spawn and at each phase change (§ Orchestration brief, SKILL.md). `id` is the
  issue number — one live record per in-flight delivery.
- **Pure `classifyLiveness({ record, now, thresholdMs })`** — no IO, mirrors
  `sessionpause.mjs`'s `shouldPause`/`ratebudget.mjs`'s `shouldPauseForBudget`.
  Missing/unparsable `lastArtifactAt` → `status:'unknown'` (fail-quiet, never
  alarms on a malformed record). `now - lastArtifactAt >= thresholdMs` →
  `status:'stale'`, else `status:'healthy'`. Threading through `lastArtifactAt`
  (not raw elapsed-since-spawn) mirrors `ci-watch.mjs`'s `queuedSince` —
  resets the moment the observed shape changes (a phase update), so a single
  long phase doesn't itself read as a stall the instant it starts.
- **`poll(cwd, prevStatuses, { now, thresholdMs })`** reads every record under
  `.forge/agents/` (`readAgentRecords`, tolerant of a missing dir and of a
  corrupt individual file — mirrors `decisions-watch.mjs`'s `readDecisions`),
  classifies each, and emits a line only on a per-id transition into or out of
  `stale` (mirrors `ci-watch.mjs`'s `transition`) — never one line per poll.
  A genuine fs error (not a missing dir) reports `ok:false` so the shared
  `poll-guard.mjs` can surface a persistent read failure (#318 pattern).
- **`clearAgentHeartbeat(cwd, id)`** — best-effort delete, called once a
  ticket's outcome is recorded (§ Orchestration step 2) so a resolved ticket's
  record doesn't linger and false-positive on a later run.
- **`monitors.json`** gains a fourth entry, `forge-agents`, `when:
  on-skill-invoke:autopilot`, alongside the other three.
- **CLI (`agents-watch.mjs` `isMain`)** supports three modes: default (the
  poll loop, mirrors the other watchers), `--write --id --issue --branch
  --phase` (the delivery subagent's own heartbeat call), `--clear --id` (the
  orchestrator's cleanup call).

### AC-505.5 — detection only, never wired to resolution

`classifyLiveness`/`poll` never call `resolveReturnedTicket` and never
classify a report — there is no report for a subagent that never returned.
The `forge-agents` line is exactly that: a line surfaced to the (blocked)
main loop. Acting on it — resuming the stalled subagent, relaying context —
is #474's scope, explicitly not built here (§ below).

### Threshold — `DEFAULT_STALE_MS = 60 * 60 * 1000` (60 minutes)

Two anchors, per the triage trail: the harness's own silent-stall kill fires
at 600s — a monitor threshold at or below that is redundant (the harness
already notifies in that case; 4 of the 5 field-evidence stalls were exactly
this). A legitimate quiet phase (full `pnpm verify`, a `gh pr checks --watch`
wait, a rebase) must not false-positive. 60 minutes is 6× the harness floor —
comfortably above every observed legitimate quiet phase in this repo (`pnpm
verify`'s ~1300-test suite completes in low single-digit minutes; even a slow
CI wait is realistically tens of minutes, not sixty) — while still catching a
genuine stall in about an hour instead of the 5.3 hours #457 actually cost.
AC-505.6 proves the number against an injected clock (a healthy long-running
agent whose heartbeat keeps refreshing every phase change never reads as
stale), not just prose.

### The cooperation-dependency concern — weighed, not ignored

A heartbeat written by the subagent itself is briefing-dependent, and this
run is direct evidence that briefing-dependent safeguards fail (three
subagents returned free text despite a bold, escalating warning). The
detection that actually worked for #457 needed no subagent cooperation:
harness output-file mtime vs. elapsed wall clock.

Investigated whether that path is buildable here: there is no documented,
stable, discoverable harness output/transcript file path available to a
monitor process in this repo or its docs (checked `plugin/`, `docs/specs/`,
`docs/plans/` for any `CLAUDE_*` output-path env var or transcript
convention — none exists; the only related precedent, `docs/plans/2026-07-19-c2-control-runner.md`'s
control-plane daemon, supervises its own explicitly-spawned `claude -p`
child process by PID, a different situation from a Task-tool subagent
inside the same harness session). So the mtime approach is not knowable from
inside forge today — it is not a viable alternative to build in this ticket,
only a residual weakness to name honestly: **`forge-agents` detection
inherits the same cooperation dependency as the mechanism it exists to catch
one failure mode of.** A subagent wedged badly enough to never execute its
own heartbeat-write call (as opposed to one that is merely quiet during a
long legitimate phase) is invisible to this monitor exactly as it was
invisible before. This is disclosed in the PR body, not shipped quietly. If
a stable harness-side output path becomes discoverable later, it strengthens
this mechanism as a second, cooperation-free signal — tracked as a possible
follow-up, not invented here.

### Out of scope (kept out deliberately)

- **#474** (automatic `SendMessage`-relay recovery) — #505 is detection
  only; it surfaces a monitor line while the loop is blocked awaiting the
  spawn, nothing more. Noted in the PR body that #474 becomes actionable
  once this lands, and that field evidence shows its scope should generalise
  past "relay held review verdicts" — every recovery this session used the
  same disk-state re-anchor (branch, commits, uncommitted files, diff stat)
  regardless of what the agent was waiting on.
- **#506** (convergence verdict), **#490** (doctor/runner reconciliation) —
  separate tickets.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC-505.1** `classifyLiveness` is pure (no IO), takes an injected clock.
- **AC-505.2** Staleness keys on elapsed-time-without-a-new-heartbeat
  (`lastArtifactAt`), not raw elapsed-since-spawn — a phase change resets it.
- **AC-505.3** `.forge/agents/<id>.json` best-effort heartbeat write, mirroring
  `writeCiWatchState`'s never-fail-the-caller contract.
- **AC-505.4** `forge-agents` monitor entry in `monitors.json`,
  `when: on-skill-invoke:autopilot`, pushing a line to the running loop on a
  liveness transition.
- **AC-505.5** Detection is never wired to `resolveReturnedTicket` — surfaces a
  line only; recovery stays #474's scope (documented explicitly).
- **AC-505.6** The default threshold is justified in prose (this doc + SKILL.md)
  and proven by a healthy-long-running-agent test using an injected
  clock/records — not merely asserted.

## Task 1 (test): regression tests first

Add an `AC-505.*`-titled block to `tests/monitors/monitors.test.mjs`
(mirroring the file's existing per-watcher describes), covering, all written
first against the not-yet-existing module so they fail:

- `classifyLiveness` (AC-505.1/AC-505.2): a fresh record (`lastArtifactAt` = now) is
  `healthy`; a record older than `thresholdMs` is `stale`; a record refreshed
  partway through the window (simulated phase change) resets the age instead
  of accumulating from `spawnedAt`; a missing/unparsable `lastArtifactAt` is
  `unknown`, never `stale` (fail-quiet on bad data); the boundary is
  inclusive (`age === thresholdMs` → stale, mirrors `shouldPause`'s `>=`).
- `writeAgentHeartbeat`/`readAgentRecords` round-trip (AC-505.3): a write is
  readable back with the same fields; a write failure (unwritable dir) never
  throws, returns `false`; a missing `.forge/agents/` dir reads as `[]`, not
  an error; one corrupt record among several valid ones is skipped, not
  fatal to the read.
- `clearAgentHeartbeat`: removes a record; clearing a non-existent id is a
  quiet no-op (never throws).
- `poll` (AC-505.4): emits a line only on a healthy→stale (and stale→healthy)
  transition for a given id, never on an unchanged status or on repeated
  polls with the same classification; a genuine fs read error surfaces
  `ok:false` (mirrors the existing `decisions poll marks a real fs error`
  test in this file); an `unknown`-status record never emits a line.
- **AC-505.6** — a healthy long-running-agent fixture: a record whose
  `lastArtifactAt` is refreshed every simulated phase change well inside
  `DEFAULT_STALE_MS`, driven across many polls with an injected clock —
  never classifies `stale`, proving the default threshold doesn't
  false-positive a legitimate long run.
- Manifest test update: bump the existing `monitors manifest` describe's
  expected length from 3 to 4 and the expected name list to include
  `forge-agents`.

Also add an `AC-505.5` doc test to `tests/skills/autopilot.test.mjs`
(mirroring `AC-464.5`'s exact pattern) pinning the new SKILL.md subsection:
names `#505`, `classifyLiveness`, `.forge/agents`, states detection is never
wired to `resolveReturnedTicket`/never calls it, and names `#474` as the
separate recovery scope.

**Files:** tests/monitors/monitors.test.mjs, tests/skills/autopilot.test.mjs
**AC map:** AC-505.1, AC-505.2, AC-505.3, AC-505.4, AC-505.5, AC-505.6
**Test plan:** `npx vitest run tests/monitors/monitors.test.mjs tests/skills/autopilot.test.mjs`

## Task 2 (code): `plugin/scripts/monitors/agents-watch.mjs`

- `AGENTS_DIR_RELPATH = join('.forge', 'agents')`, `DEFAULT_STALE_MS = 60 *
  60 * 1000`.
- `writeAgentHeartbeat(cwd, { id, issue, branch, phase, spawnedAt,
  lastArtifactAt })` — best-effort `writeJson`, try/catch → `false`.
- `readAgentRecords(cwd)` — `readdir` the dir (ENOENT → `[]`, other fs errors
  propagate for `poll` to catch, mirrors `readDecisions`), `readJson` each
  file tolerating one corrupt entry.
- `clearAgentHeartbeat(cwd, id)` — best-effort `rm` of the one file, try/catch
  → `false`, missing file is not an error.
- `classifyLiveness({ record, now = Date.now(), thresholdMs =
  DEFAULT_STALE_MS })` — pure, per § Design.
- `poll(cwd, prevStatuses, { now = Date.now, thresholdMs } = {})` — reads,
  classifies, diffs against `prevStatuses` (a `Map<id,status>` threaded by
  the caller like `ci-watch.mjs`'s `prev`), returns `{ lines, statuses, ok,
  reason }`.
- `isMain` CLI: `--write` mode (parses `--id/--issue/--branch/--phase`,
  calls `writeAgentHeartbeat`, exits 0); `--clear <id>` mode (calls
  `clearAgentHeartbeat`, exits 0); default mode runs the poll loop
  (`FORGE_AGENTS_INTERVAL_MS`, default 20000), using `poll-guard.mjs` for
  persistent read-failure surfacing, printing each transition line.

**Files:** plugin/scripts/monitors/agents-watch.mjs
**AC map:** AC-505.1, AC-505.2, AC-505.3, AC-505.4, AC-505.6
**Done:** Task 1's tests pass; `npx vitest run tests/monitors/monitors.test.mjs` green.

## Task 3 (wiring): monitors.json + SKILL.md

- `plugin/monitors/monitors.json`: add the `forge-agents` entry (name,
  command, description, `when: on-skill-invoke:autopilot`), same shape as
  the existing three.
- `plugin/skills/autopilot/SKILL.md`:
  - § Monitor notifications gains a `forge-agents` subsection (mirroring the
    `forge-ci`/`forge-decisions`/`forge-outbox` write-ups): what it watches,
    the line shape, the threshold + justification (§ Design above,
    condensed), and the AC-505.5 boundary — explicitly states this monitor never
    calls `resolveReturnedTicket` and never resolves a stall, only surfaces
    it; recovery is #474.
  - § Orchestration step 1's delivery-subagent brief gains an instruction to
    call `node agents-watch.mjs --write ...` at spawn and each phase change
    (best-effort, never blocks on failure) — and § Orchestration step 2
    gains the paired cleanup: once an outcome is recorded for an issue,
    best-effort `--clear` its heartbeat record.
  - § Driver scripts gains the `agents-watch.mjs` line.
  - The cooperation-dependency honesty note (§ Design above) is captured
    here too, not only in the PR body, so it's visible to whoever reads the
    skill later.
- `docs/README.md`: add this plan to the route index (docsync).

**Files:** plugin/monitors/monitors.json, plugin/skills/autopilot/SKILL.md, docs/README.md
**AC map:** AC-505.4, AC-505.5, AC-505.6
**Done:** `tests/skills/autopilot.test.mjs` AC-505.5 passes; `pnpm verify` green; docsync clean.
