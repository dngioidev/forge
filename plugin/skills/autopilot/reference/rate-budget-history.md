# Rate-budget preflight — constant derivation & history (#407, #517, #526, #530)

Reference for `plugin/skills/autopilot/SKILL.md` § Rate-budget preflight (#561 —
relocated, not deleted). SKILL.md keeps the operative algorithm — the two required call
points, the degrade-never-hard-block rule, and the threshold formula; this file holds the
deeper "why" behind each tuned constant and the measured evidence that justified it, which
a run doesn't need loaded to execute the preflight correctly, only to recalibrate it.

## Why `kind` is sourced from the board `type` field first (#530)

`select.mjs`'s `normalize()` sources the ticket `kind` threaded into the post-selection
`evaluateRateBudget` call from the board `type` field first (`epic`/`item`/`bug`/`test`
on this board, ~100% populated, set via `create.mjs --type` — Projects-v2 board-write
access), falling back to the title-prefix `ticketKind(title)` classifier (`docs`/`spike`/
`null`) only when `type` is unavailable. Measured against 8 real board titles, the
title-only classifier hit 2/8; the board-type-first classifier hits 8/8 (#530's evidence
table) — closing the #526 trust-boundary finding that title text is freely
issue-write-editable while the board field isn't.

## Why the cadence is every iteration, not every 10 (#517)

The shared account-wide 5,000 pt/hr bucket has been observed draining within ~1.3
iterations of real per-ticket cost, so an earlier every-10-iterations cadence was
structurally too late to ever fire before the damage was done. The recheck is one REST
call that does not itself count against any bucket, so checking every iteration costs
nothing extra.

## `KIND_COST_ESTIMATES` and `UNATTRIBUTED_DRAIN_FLOOR` — where the numbers come from (#526)

`KIND_COST_ESTIMATES` (`{ docs: 975, spike: 3457 }`) is each kind's actually-measured
GraphQL spend, not an estimate — a known kind short-circuits `estimateTicketCost`
straight to `Math.max(KIND_COST_ESTIMATES[kind], UNATTRIBUTED_DRAIN_FLOOR)`, ignoring
`recentDeltas`/`fallback` entirely, because the ticket's own measured cost is strictly
better evidence than a past, possibly-unrelated ticket's delta.

`UNATTRIBUTED_DRAIN_FLOOR` (1500) still floors that result: #526 observed ~1,400pt of
unattributed background drain between checks (bot polling, workflow status, board reads)
with no delivery running at all, so a known-cheap kind must never be dragged *below* what
idle drain alone already costs — even though it must no longer be dragged *up* by a past
expensive ticket's delta. That was the #526 pathology being fixed: #438's ~4993pt delta
was dragging #462's docs+regression-test low-water up to a cost #462 never actually paid.

**#530: `KIND_COST_ESTIMATES` still keys only `docs`/`spike` (the title-prefix
vocabulary), deliberately NOT the board `type` vocabulary** — the live board has no
`docs`/`spike` type option at all, and #462 (~975pt) / #438 (~4993pt) are BOTH board type
`item`, proving a single board type spans a >5x measured range. Assigning any board type
an optimistic estimate today would violate AC.2/AC.4's conservative-by-default rule, so
no `type`-keyed entries exist yet — a fast-follow ticket can add them once real per-type
evidence accumulates.

## Unknown-kind fallback (pre-#526 / #517 path, unchanged)

Real per-ticket GraphQL cost varies ~5x by ticket kind (~975–5,000 observed) with no
per-kind number to lean on for kinds outside `KIND_COST_ESTIMATES` (as of #530, every
real board-`type`-derived kind: `item`/`bug`/`test`/`epic`), so the MAX of this run's own
recent, plausible readings (`recentBudgetDeltas(run)`, filtered by `MIN_PLAUSIBLE_DELTA`)
is used, falling back to `DEFAULT_LOW_WATER` (4993 — the measured worst-case single-ticket
cost, #438/PR #514) with no history yet. This is exactly the RUN START check's path too —
it has no selected ticket yet, so it always has no `kind` to thread and stays on this
cold-start/MAX behavior.

## Disk-sourced history hardening (#517 security fix-wave, mirrors #488)

`run.rateBudgetReadings` is written by the loop but is still the same trust boundary #488
already hardened `boardSizeAtStart`/`iterations` against — a corrupted or hand-edited
history of near-flat consecutive readings looks identical to a genuinely idle
check-to-check window where nothing was delivered. `estimateTicketCost` treats any delta
below `MIN_PLAUSIBLE_DELTA` (500 — below the lowest ever-measured real per-ticket cost,
~975) as no evidence at all, falling back to the safe `DEFAULT_LOW_WATER` rather than
letting the threshold collapse toward zero; a malformed/non-string `kind` simply isn't a
`KIND_COST_ESTIMATES` key, so it falls through to the unchanged unknown-kind path rather
than throwing.
