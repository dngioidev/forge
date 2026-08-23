# Plan: #556 - autopilot: a triage verdict of outcome:"ready" never promotes the board status, so the ticket is re-selected as triage forever

**Ticket:** #556 (board #8) - **Kind:** bug - **Parent:** epic #183
**Base:** main - **Branch:** fix/556-triage-ready-board-promotion - **Verify:** `pnpm verify`

## Task T1 — regression test reproducing the loop

**Kind:** test. **AC-IDs:** AC-1

`forge:triage` places tickets `--status backlog` by design; nothing else
promotes a `verdict:"pass", outcome:"ready"` triage report to `ready`, so
`select.mjs` re-selects the same ticket as `triage` on the very next pass
(reproduced live for #490 and #550). A regression test built on a real
`makeBoardCtx` (not an in-memory flag) demonstrates: recording the triage
report the OLD way (`recordOutcome(cwd, entry)`, no board `ctx`) leaves the
live board status at `backlog`, and a subsequent `selectNext` call returns
`action: 'triage'` for the same issue a second time.

**Files:** tests/autopilot/engine.test.mjs

**Test plan:** `AC-1` — `tests/autopilot/engine.test.mjs`, describe block
`#556`, the "reproduces the loop" test.

## Task T2 — promote board status on a triage ready verdict

**Kind:** fix. **AC-IDs:** AC-2, AC-3, AC-4

`ledger.mjs`'s `recordOutcome(cwd, entry)` — the one choke point every
triage report already passes through on its way to `run.json` — gains an
optional third argument, `{ ctx, log }`. When `ctx` (a `makeBoardCtx` board
context) is supplied AND the entry is exactly `{stage:'triage',
outcome:'ready'}`, `recordOutcome` additionally calls `board/move.mjs`'s
`runMove(ctx, {issue, status:'ready'}, log)`, promoting the board status
`backlog`→`ready`. Every existing 2-arg call site (deliver's
merged/escalated/awaiting-human, shape's own ready/escalated) is untouched
— `ctx` defaults to `null`, which skips the new branch entirely
(back-compat). `forge:triage`'s own `--status backlog` placement contract
(triage/SKILL.md § Steps) is never touched — the promotion happens from
the outside, in the record step, per AC-2's explicit either/or. The
promotion is idempotent for free: `runMove` already no-ops
(`changed:false`, no mutation, no error) when the ticket is already at the
target status (AC-3). Narrowly scoped (AC-4): a `skipped` or `escalated`
triage outcome never matches `{stage:'triage', outcome:'ready'}`, so
neither ever reaches `runMove`; a shape `outcome:'ready'`
(`stage:'shape'`) also never matches (shape's own subagent already
performs its own board promotion).

**Files:** plugin/scripts/autopilot/ledger.mjs, tests/autopilot/engine.test.mjs

**Test plan:** `AC-2` — the "recording... WITH the board ctx promotes
backlog→ready" test (`selectNext` then returns `deliver`). `AC-3` — the
"idempotent" test (recording the same ready outcome twice never throws,
board stays `ready`). `AC-4` — the "skipped is unaffected" and "escalated
is unaffected" tests (board stays `backlog` even with `ctx` passed), plus
the "shape outcome:'ready' is unaffected" test.

## Task T3 — correct the SKILL.md claim that was never true of the code

**Kind:** code (docs). **AC-IDs:** AC-5

`autopilot/SKILL.md`'s § Orchestration text and `triage/SKILL.md`'s Report
contract both stated that a triage `outcome:"ready"` "re-enters the
autopilot queue as `deliver` on the next iteration" with no mechanism that
actually made that true (`applyOutcome` only ever wrote `run.json`).
Both docs, plus the `driver-scripts.md` reference (`ledger.mjs` entry),
now describe the real `recordOutcome(...,{ctx})` promotion this ticket
adds. `autopilot/SKILL.md` carries a hard <70000-byte size budget (#467)
with almost no headroom on `main`, so the correction is deliberately
terse in-file, with full rationale relocated to `driver-scripts.md`
(same "relocate, don't inline" pattern #467 already established).

**Files:** plugin/skills/autopilot/SKILL.md, plugin/skills/autopilot/reference/driver-scripts.md, plugin/skills/triage/SKILL.md, tests/autopilot/engine.test.mjs, tests/skills/triage.test.mjs

**Test plan:** `AC-5` — the "autopilot/SKILL.md and triage/SKILL.md now
describe the real recordOutcome+ctx promotion mechanism" test.
`tests/skills/triage.test.mjs`'s pre-existing AC-2 assertion (which
locked in the old, incorrect `applyOutcome`/`stage:"triage"` wording) is
updated to assert the corrected `recordOutcome`/`stage:'triage'` wording —
flagged by the `testintent` gate as a "weakened" pre-existing assertion
(a line was replaced, not purely added); explicit sign-off: this is a
literal-text correction of an assertion that pinned down the OLD, buggy
mechanism this ticket replaces, not a loosening of coverage — the
re-entry-into-the-queue claim itself is still asserted unchanged.
