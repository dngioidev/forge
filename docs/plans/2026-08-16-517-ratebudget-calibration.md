# Plan: #517 - low-water 200 and check-every-10 cannot protect a ticket boundary

**Ticket:** #517 (board #8, child of epic #183) - **Kind:** bug (Item, size M)
**Base:** main - **Branch:** fix/517-ratebudget-calibration - **Verify:** `pnpm verify`

`ratebudget.mjs` (#407) exists to pause an autopilot run *before* the shared
5,000 pt/hr account-wide GitHub GraphQL bucket hits zero. Two constants
defeat that purpose today: `DEFAULT_LOW_WATER = 200` is ~20x too low to
protect a ticket boundary (a check returning "continue" at 1543 remaining
lets the loop start a ticket that then exhausts the bucket mid-delivery —
board writes fail inside a delivery subagent), and `DEFAULT_CHECK_EVERY_N =
10` never gets a chance to fire (the bucket can drain within ~1.3
iterations).

The ticket's own follow-up correction comment revises the framing: measured
per-ticket cost ranges **~975–5,000** (not a stable ~4,000), so a single
hardcoded replacement constant is wrong in both directions — too
conservative for a cheap docs ticket (idles a usable bucket for up to an
hour), too optimistic for a contested code ticket. It also flags an
**unattributed ~1,400pt drain** in one window with no delivery running, and
argues any calibration must stay robust to consumption it did not itself
generate.

## Design

- **`shouldPauseForBudget(budget)` is UNCHANGED** — still pure, no IO, same
  signature, same `ok:true && low:true` boundary. This ticket does not touch
  it; the fix lives entirely in what `low` is computed against.
- **`DEFAULT_CHECK_EVERY_N`: 10 → 1** (AC-517.2). The check is one REST call
  that does not itself count against any bucket (per #407's own docblock);
  at the observed drain rate (a bucket can empty within ~1.3 iterations),
  every-10 is not "infrequent," it's structurally too late to ever fire
  before the damage. Checking every iteration is the only cadence that
  reliably catches a single-iteration drain.
- **New pure `estimateTicketCost(recentDeltas, fallback = DEFAULT_LOW_WATER)`**
  (`ratebudget.mjs`) — the low-water threshold for THIS check, derived from
  the run's own recent GraphQL-remaining deltas rather than a flat number
  (AC-517.1). Takes the **max** of the valid (finite, positive) deltas
  supplied, not an average: the question this check answers is "does
  'continue' guarantee this ticket can complete," so the conservative read
  of recent evidence is required, not the typical one. Falls back to
  `DEFAULT_LOW_WATER` (raised from 200 to **4993** — the measured worst-case
  single-ticket cost, #438/PR #514) when there is no history yet (a fresh
  run's first check) — see § Why max-of-recent-deltas below for why this
  also directly answers the unattributed-drain concern.
- **`evaluateRateBudget(gh, { lowWater, recentDeltas } = {})`** — unchanged
  IO shape, gains the optional `recentDeltas` opt. An explicit `lowWater`
  (already-passing callers, existing tests) still wins outright — back
  compatible. Otherwise the effective threshold is
  `estimateTicketCost(recentDeltas, DEFAULT_LOW_WATER)`.
- **History storage — `ledger.mjs`** (the file that already owns
  `run.json`, mirroring `applyOutcome`/`recordOutcome`'s pure-transition +
  IO-wrapper split): a capped rolling log of `remaining` readings taken at
  every rate-budget check, `run.rateBudgetReadings` (max 6 entries,
  `MAX_BUDGET_READINGS`). `applyBudgetReading(run, remaining)` is the pure
  append+cap (ignores a non-finite/negative reading rather than corrupting
  the log — same trust posture as `sanitizePositiveInt`). `recentBudgetDeltas(run)`
  is the pure derivation: consecutive-reading drops only — a reading that
  went *up* means the hourly window reset, not "a ticket was cheap," and is
  excluded, never counted as a zero/negative cost. `recordBudgetReading(cwd,
  remaining)` is the IO wrapper (load → apply → write), same shape as
  `recordOutcome`/`recordFiled`.
- **Orchestrator wiring — `SKILL.md`** § Rate-budget preflight: at run start
  and every iteration (now `budgetCheckDue`'s cadence), the orchestrator
  reads `run.json`, computes `recentBudgetDeltas(run)`, passes it as
  `evaluateRateBudget`'s `recentDeltas`, and after the check records the
  fresh `decision.budget.remaining` via `recordBudgetReading`. This lives in
  the main loop (which already owns `run.json` per the loop's own
  contract), never inside a delivery subagent.

### Why max-of-recent-deltas answers the unattributed-drain concern

A delta is computed from two consecutive **actual `remaining` readings**,
whatever happened between them — a delivered ticket, a fix wave, a
background monitor, an idle window. It is not a model of "what a ticket
kind should cost"; it already includes any unaccounted consumption that
occurred in that window, because it's measured, not attributed. Using the
max of the last few such deltas as the next threshold means: if something
undocumented is quietly draining the bucket between checks (as the
correction comment observed), that drain shows up in the next delta and
raises the bar for the following check — the calibration self-corrects
without ever needing to know the cause. This is also why the check fires
every iteration now (AC-517.2): a threshold this reactive is only safe if
the readings feeding it are frequent.

### Why not a single fixed constant (rejected)

A flat replacement number cannot pass AC-517.3's required pairing: the same
`1543/5000` reading must pause ahead of a ~4000pt ticket and must NOT pause
ahead of a ~975pt ticket. No single number satisfies both. A per-ticket-kind
lookup table was considered and rejected for this ticket: the budget check
runs *before* ticket selection in the loop (§ The loop), so the kind of the
next ticket isn't known yet at check time — recent-actual-deltas needs no
such foreknowledge and directly reflects this run's real recent cost,
whatever kind of ticket produced it.

### Cold-start value — `DEFAULT_LOW_WATER = 4993`

The exact measured worst case (#438, PR #514: 4995 → 2 remaining). Used only
until this run has its own `rateBudgetReadings` history (first check of a
fresh run). Deliberately not rounded up to 5000: at 5000 nearly every
possible reading (remaining is capped at the 5000 limit) would read as
"low," permanently pausing a fresh run before it ever starts — the inverse
failure this ticket also guards against (§ ticket cautions). 4993 leaves a
narrow but real "comfortably fresh window" band while still being exactly
as conservative as the worst ticket actually observed.

## Acceptance criteria (authoritative text is on the issue + the triage
trail comment; summarised here — AC-517.3 is the triage-revised, paired
version per the correction comment)

- **AC-517.1** The low-water boundary is derived from a realistic per-ticket
  cost estimate (this run's own recent GraphQL-remaining deltas, max-of,
  falling back to a documented worst-case constant) rather than a flat
  `200`.
- **AC-517.2** The periodic re-check cadence (`DEFAULT_CHECK_EVERY_N`) fires
  every iteration, catching a bucket draining within a single iteration.
- **AC-517.3** Tests cover the observed real numbers in BOTH directions at
  the identical `1543/5000` reading: (a) recent history implying a
  ~4000-point ticket ahead → pause; (b) recent history implying a ~975-point
  ticket ahead → continue.
- **AC-517.4** Degrade-on-failed-check (#407) is unchanged: a check that
  cannot complete still returns `{pause:false, ok:false}`.

## Task 1 (test): regression tests first

Update/extend `tests/autopilot/engine.test.mjs`'s existing `describe('autopilot
rate-budget preflight ...')` block (do not delete existing cases — update the
two that assert the OLD defaults) and add a new ledger-side describe block,
all written first so they fail against today's code:

- Update the existing `'budgetCheckDue: ...'` test: `DEFAULT_CHECK_EVERY_N`
  is now `1`; every positive iteration is due
  (`budgetCheckDue(1)===true`, `budgetCheckDue(9)===true`,
  `budgetCheckDue(10)===true`), iteration `0` is still never due (owned by
  the mandatory run-start check), and the custom-cadence case
  (`budgetCheckDue(5,5)`) still works. Title it to include `AC-517.2`.
- Update the existing `'DEFAULT_LOW_WATER matches ...'` test to assert the
  new value (`4993`) with an `AC-517.1`-tagged title explaining it's the
  documented worst-case fallback, not `rateBudget`'s own unrelated default.
- New `'AC-517.1: estimateTicketCost'` cases: empty/absent `recentDeltas` →
  `DEFAULT_LOW_WATER`; a single valid delta → that delta; multiple deltas →
  the max, not the average or the most recent; non-finite/negative/zero
  entries filtered out (a mixed array of `[4000, -50, NaN, undefined, 0,
  2000]` → `4000`); a custom `fallback` argument is honoured when there's no
  history.
- New `'AC-517.3: ...'` pair, mirroring the existing
  `evaluateRateBudget`-mocked-`gh` pattern (`makeGh` around a fake
  `rate_limit` response with `remaining: 1543, limit: 5000`):
  - (a) `evaluateRateBudget(gh, { recentDeltas: [4993, 3457] })` → `pause:
    true` (max delta 4993 > 1543).
  - (b) the SAME mocked `remaining: 1543` response,
    `evaluateRateBudget(gh, { recentDeltas: [975] })` → `pause: false` (975
    < 1543).
  - Also assert an explicit `lowWater` still overrides `recentDeltas` when
    both are given (back-compat case).
- Confirm (no new assertion needed if unchanged, but re-verify it still
  passes as-is) the existing `'spec §3.1: a FAILED budget check degrades
  ...'` test — rename/annotate its title to include `AC-517.4` so the AC
  gate maps it.
- New `describe('ledger rate-budget history (AC-517.1, #517)')` block in the
  same file (or a new block near the existing ledger describes), importing
  `applyBudgetReading`, `recentBudgetDeltas`, `recordBudgetReading`,
  `MAX_BUDGET_READINGS` from `../../plugin/scripts/autopilot/ledger.mjs`:
  - `applyBudgetReading`: appends a reading; caps at `MAX_BUDGET_READINGS`
    (drops the oldest, not the newest, once over cap); ignores
    non-finite/negative input (returns `run` unchanged).
  - `recentBudgetDeltas`: two decreasing readings → one positive delta
    (the drop); an increasing reading (window reset) is excluded, not
    counted as a negative/zero delta; fewer than 2 readings → `[]`; a
    realistic sequence `[4995, 2, 5000, 4525]` → `[4993, 475]` (the `2→5000`
    reset step excluded).
  - `recordBudgetReading` (IO, tmp-dir fixture mirroring `recordOutcome`'s
    existing test setup in this file): round-trips through `run.json` —
    write then `loadRun` sees the same reading appended.

**Files:** tests/autopilot/engine.test.mjs
**AC map:** AC-517.1, AC-517.2, AC-517.3, AC-517.4
**Test plan:** `npx vitest run tests/autopilot/engine.test.mjs`

## Task 2 (code): `plugin/scripts/autopilot/ratebudget.mjs`

- `DEFAULT_LOW_WATER = 4993` (was `200`) — update the doc comment to cite
  #438/PR #514 as the empirical anchor and state it's the cold-start
  fallback, not a permanent floor.
- `DEFAULT_CHECK_EVERY_N = 1` (was `10`) — update the doc comment
  accordingly; `budgetCheckDue`'s own logic is unchanged (`iterations > 0 &&
  iterations % n === 0` already does the right thing at `n=1`).
- Add exported `estimateTicketCost(recentDeltas, fallback =
  DEFAULT_LOW_WATER)` per § Design above, placed just above
  `evaluateRateBudget` with the "why max, why this answers unattributed
  drain" reasoning from § Design captured in its docblock (condensed).
- `evaluateRateBudget(gh, { lowWater, recentDeltas } = {})`: compute
  `const effectiveLowWater = Number.isFinite(lowWater) ? lowWater :
  estimateTicketCost(recentDeltas, DEFAULT_LOW_WATER);` and pass
  `{ lowWater: effectiveLowWater }` to `rateBudget`. `shouldPauseForBudget`
  call and the rest of the function body are unchanged.
- `shouldPauseForBudget` and `budgetPauseNotice`: **no changes**.

**Files:** plugin/scripts/autopilot/ratebudget.mjs
**AC map:** AC-517.1, AC-517.2, AC-517.4
**Done:** Task 1's ratebudget-side tests pass.

## Task 3 (code): `plugin/scripts/autopilot/ledger.mjs`

- `export const MAX_BUDGET_READINGS = 6;` near the top, with a short comment
  (§ Design above, condensed) on why it's a small cap (recency, not a full
  history).
- `freshRun()` gains `rateBudgetReadings: []` alongside the existing fields
  (keeps the shape explicit/discoverable, matches the file's existing style
  for `outcomes`/`filed`).
- `applyBudgetReading(run, remaining)` — pure, per § Design.
- `recentBudgetDeltas(run)` — pure, per § Design.
- `recordBudgetReading(cwd, remaining)` — IO wrapper (load → apply → write),
  placed alongside `recordOutcome`/`recordFiled` under the "IO wrappers the
  loop calls" comment banner.

**Files:** plugin/scripts/autopilot/ledger.mjs
**AC map:** AC-517.1
**Done:** Task 1's ledger-side tests pass; `npx vitest run tests/autopilot/engine.test.mjs` green end to end.

## Task 4 (wiring + docs): `SKILL.md` + route index

- `plugin/skills/autopilot/SKILL.md` § Rate-budget preflight (~line 151-158):
  rewrite the cadence bullet (was: "Default cadence is every 10 iterations
  ... frequent enough") to state the cadence is now every iteration and why
  (§ Design's cadence reasoning, condensed — the bucket can drain within
  ~1.3 iterations, so every-10 was structurally too late). Add a bullet
  describing the `recentDeltas` wiring: the orchestrator reads
  `run.rateBudgetReadings` (via `loadRun`), derives `recentBudgetDeltas(run)`,
  passes it into `evaluateRateBudget`, and records the fresh reading via
  `recordBudgetReading` after each check — all in the main loop, never
  inside a delivery subagent (consistent with § The contract's "main loop
  never delivers inline" rule). Update the "pure decision function" bullet's
  list of driver-script exports to include `estimateTicketCost`.
- § Driver scripts bullet for `ratebudget.mjs` (~line 289): update to
  mention `estimateTicketCost(recentDeltas, fallback)` and the raised
  `DEFAULT_LOW_WATER`/lowered-cadence defaults; note `ledger.mjs` now also
  owns `applyBudgetReading`/`recentBudgetDeltas`/`recordBudgetReading` for
  the history this feeds from.
- `docs/README.md`: add this plan's route-index line (mirrors the existing
  #505/#488 entries' style — one line, ticket + parent epic + one-paragraph
  summary of the mechanism).

**Files:** plugin/skills/autopilot/SKILL.md, docs/README.md
**AC map:** AC-517.1, AC-517.2
**Done:** `pnpm verify` green; docsync clean (no orphaned doc, route index entry present).
