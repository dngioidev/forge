# Plan: #499 - selection ignores pending decisions, so an escalated ticket returns to the queue if its board status drifts

**Ticket:** #499 (board #8, child of epic #183) - **Kind:** bug
**Base:** main - **Branch:** fix/499-selection-pending-decisions - **Verify:** `pnpm verify`

`escalate.mjs` parks a ticket by writing a pending decision file to
`.forge/decisions/` **and** moving the board to `blocked`. `select.mjs`
`selectNext` keeps a ticket out of the queue **purely on board status** — it
never reads `.forge/decisions/`. The board move is a single point of failure:
observed directly on #438, whose board status drifted back to `backlog` while
its decision (`esc-438-msrn1h5s`) was still `pending`; `selectNext` returned it
as the next actionable item. Triage additionally found a second, related
defect (folded into AC-499.5): `escalate.mjs` `runCheck` marks a decision
`resolved` but never moves the board off `blocked`, so — since `blocked` is a
hard `TIER` exclusion — a resolved ticket is then permanently unselectable
without a manual board move.

## Design (per triage's grounded recommendation on the issue — not re-litigated)

- **Purity is preserved by threading state in, not reading disk inside the
  predicate.** `selectNext(tickets, {area, shape, pendingIssues})` takes a
  `pendingIssues` Set<number>, built by IO wrappers at both real call sites:
  `select.mjs`'s own CLI, and `server.mjs`'s `autopilot_select` MCP tool. This
  mirrors the `sessionpause.mjs`/`ratebudget.mjs` pure-decision + IO-wrapper
  split.
- **Reuse `pendingDecisions()`** (`lib/situation.mjs`) — already enumerates
  pending decisions and already degrades a missing/unreadable
  `.forge/decisions/` to `[]` (AC-499.3), so no new IO is written for this.
- **The blanket `blocked`-status exclusion in `selectNext` stays** — this
  fix adds pending-decision state as an *additional* exclusion (independent of
  status), it does not replace the status-based one. Dropping the blanket
  exclusion would regress #487's current de-facto protection (a
  deliberately/manually `blocked` ticket with no decision file, e.g. #449).
- **AC-499.5's round trip is fixed at the one place that owns board
  mutation:** `escalate.mjs` `runCheck`'s resolve path now also calls
  `runMove(ctx, {issue, status: 'backlog'}, log)` after marking the decision
  file `resolved`. A move failure (no `backlog` option mapped, transient
  GitHub error, `findItemByIssue` miss) degrades to a logged warning — the
  decision is still marked resolved and `runMove`'s own outbox/retry handles
  transient GitHub errors — matching `runEscalate`'s existing degrade for a
  board with no `blocked` option mapped (#27).
- **#487 is out of scope** — it needs a new representation for "sequenced
  behind ticket N" with no existing on-disk state; this ticket only wires up
  state (`.forge/decisions/`) that already exists.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC-499.1** `selectNext`/`actionFor` refuses a ticket with a pending entry
  in `.forge/decisions/`, regardless of board status.
- **AC-499.2** Pinned by test on the observed case: `backlog` + pending
  decision → not selected; same ticket with decision `resolved` → selected
  again.
- **AC-499.3** Degrades safely — absent/unreadable `.forge/decisions/` must
  not crash selection or block every ticket.
- **AC-499.4** The decision function stays pure and hermetically testable —
  pending state passed in, never read from disk inside the predicate.
- **AC-499.5** The resolved path works end to end: `escalate.mjs --check`
  marking a decision resolved also moves the board so the ticket re-enters the
  queue without a manual move. Verified as a full round trip (decision file +
  board mutation), not just the predicate.

## Task 1 (test): regression tests first, on the pre-fix code

Add a `#499`-titled describe block to `tests/autopilot/engine.test.mjs`
covering AC-499.1 (exclusion holds across every status, not just backlog),
AC-499.2 (the #438-shaped backlog+pending → excluded, then resolved →
selected again), AC-499.3 (empty/omitted `pendingIssues` is a no-op — existing
selection behaviour unchanged), and AC-499.4 (the same `Set` reference reused
across calls with no mutation/hidden state — pins purity). Also extend
`tests/escalate.test.mjs`'s two existing `runCheck` tests (which will need new
`project item-list`/`item-edit` fakeGh routes once Task 3 lands) and add two
new AC-499.5 cases: the already-drifted-to-backlog round trip, and the
board-move-failure degrade path. Also extend
`tests/mcp-forge/forge-core.test.mjs` with an `autopilot_select` case proving
the MCP call site (not just the CLI) excludes a pending-decision ticket.
Written first against the pre-fix code so the new assertions fail, confirming
the regression they pin.

**Files:** tests/autopilot/engine.test.mjs, tests/escalate.test.mjs, tests/mcp-forge/forge-core.test.mjs
**AC map:** AC-499.1, AC-499.2, AC-499.3, AC-499.4, AC-499.5
**Test plan:** see above; run `npx vitest run tests/autopilot/engine.test.mjs tests/escalate.test.mjs tests/mcp-forge/forge-core.test.mjs`.

## Task 2 (code): thread `pendingIssues` through `selectNext` at both call sites

- `select.mjs`: `selectNext(tickets, {area, shape, pendingIssues = new Set()})`
  adds a filter excluding any ticket whose number is in `pendingIssues`,
  applied alongside (not instead of) the existing `SKIP`/`TIER` status filter.
  The CLI (`isMain` block) builds `pendingIssues` from
  `pendingDecisions(ctx.cwd)` and passes it to both `selectNext` and
  `actionableQueue`.
- `server.mjs`: import `pendingDecisions`, add it to `DEFAULT_DEPS`, and in
  the `autopilot_select` case build `pendingIssues` from
  `deps.pendingDecisions(ctx.cwd)` the same way, so the MCP surface gets the
  same protection as the CLI.

**Files:** plugin/scripts/autopilot/select.mjs, plugin/mcp/forge/server.mjs
**AC map:** AC-499.1, AC-499.2, AC-499.3, AC-499.4
**Done:** Task 1's `engine.test.mjs`/`forge-core.test.mjs` cases pass.

## Task 3 (code): `escalate.mjs` `runCheck` moves the board on resolve

After marking a decision `resolved` (unchanged), call
`runMove(ctx, {issue: d.issue, status: 'backlog'}, log)`. Log a warning (not a
hard failure) if the move doesn't succeed; record `moved` on each resolved
entry so callers/tests can see the outcome without it affecting `ok`.

**Files:** plugin/scripts/board/escalate.mjs
**AC map:** AC-499.5
**Done:** Task 1's `escalate.test.mjs` cases pass.

## Fix wave: adversarial `forge:reviewer` + `forge:security`, round 1

Both ran in parallel against the full branch diff and both returned
`verdict: fail`:

- **security (major):** `runCheck`'s new automatic board move fired on ANY
  comment recognized as "the human's reply" — no author check — so any
  commenter, not just the owner/a collaborator, could silently re-queue a
  ticket for autonomous work, recreating the exact autonomy-pre-empt risk
  #499 exists to close. **Fix:** gate the move on the reply comment's
  GitHub `author_association` (`OWNER`/`MEMBER`/`COLLABORATOR` only); an
  untrusted reply still resolves the decision file (unchanged pre-#499
  behaviour) but does not move the board. security also flagged (minor,
  defense-in-depth) that `pendingIssues` was built from `d.issue` with no
  type normalization — not reachable via any current writer (both write
  integers), but fixed anyway with `Number(d.issue)` at both call sites.
- **reviewer (major):** the move unconditionally forced status to
  `backlog`, which would demote a ticket that was genuinely in-flight
  (`inProgress`/`inReview`, e.g. an escalation fired mid-delivery on a
  reviewer deadlock or a gate failing twice) or was never actually parked
  at `blocked` in the first place (a board with no `blocked` option mapped,
  #27) — discarding real progress state for no reason. **Fix:** the move
  now only fires when the ticket is confirmed to be at `blocked` right now
  (`ctx.findItemByIssue` + `itemFieldKey` read before the move); otherwise
  it's left alone. `moved: true` in the returned/resolved entry now means
  "confirmed not blocked" (a queue-ready ticket), not "a mutation
  happened" — an unreadable board status degrades to a warning rather than
  a blind guess-and-move.

Both fixes landed in the same commit; `pnpm verify` re-run green (1268/1268:
1256 baseline + 12 new — 6 pure `selectNext` predicate tests, 6 `runCheck`
round-trip/trust-gate tests) and `ac-gate` re-confirmed all 5 ACs mapped.

## Task 4 (docs): route index

Add this plan to `docs/README.md`'s plan index.

**Files:** docs/README.md
**AC map:** (docsync only, no AC)
**Done:** `forge:docsync-check` clean.
