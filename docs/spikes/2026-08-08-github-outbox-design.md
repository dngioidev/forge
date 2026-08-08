# Spike — local outbox for GitHub-bound writes during outages/rate-limit exhaustion (#409)

**Date:** 2026-08-08 · **Ticket:** #409 (parent #183) · **Route:** spike (deliverable = this findings doc; no code changed).

## Question

Owner proposal (2026-08-08, spec `2026-08-08-github-resilience.md` §3.3): when GitHub is unavailable (rate-limited or an Actions outage), don't let autopilot's loop sit blocked — buffer safe GitHub-bound writes locally (an "async box") and keep going, draining them once GitHub recovers. Two directions were already rejected at the spec stage and are **not re-litigated here**: a full local/open-source GitHub replacement (disproportionate, doesn't fix the observed failure class), and a general-purpose async broker for every `gh` call (most calls are cheap idempotent reads already covered by #360's retry; only a handful of writes matter). What's genuinely open, per the ticket: (1) which write call sites are actually safe to queue, (2) how the outbox's own state avoids compounding #387's confirmed ledger race, (3) what drains it, (4) how a human sees "the board isn't fully caught up because GitHub was down."

## 1 — Which writes are safe to defer? Every current GitHub-write call site, read directly

`grep`-level guessing was explicitly ruled out by the ticket; all ten files in `plugin/scripts/board/*.mjs` plus `autopilot/merge.mjs` were read in full. Every call that mutates GitHub state (not just reads it) is listed below, classified.

**Safe to defer (queue-eligible) — all five are informational or already-tolerated-eventual-consistency writes that don't gate any other decision:**

| Call site | Write | Why safe |
| --- | --- | --- |
| `board/comment.mjs` `runComment` | `upsertMarkedComment` (trail:`<phase>`) | Pure narration of something already true; nothing waits on it landing immediately. |
| `board/move.mjs` `runMove` | `setSelect(status)` + `verifyStatusMoved` re-read | The ticket's own text names this: "board-status drift is already a routine, tolerated eventual-consistency gap." |
| `board/receipt.mjs` `runReceipt` | `upsertMarkedComment` (receipt:pr-`<n>`) | Posted *after* the merge already truly happened (merge itself is never deferred, see below) — a late receipt changes nothing about what's real. |
| `board/log.mjs` `runLog` | `upsertMarkedComment` (log:pr-`<n>`) | Same shape as receipt — a delivery-log row describing a fact that already happened. |
| `board/digest.mjs` `runDigest` | `setIssueBody` (epic digest block) | Fully idempotent recompute-and-overwrite from a fresh read each call; not latency-sensitive, nothing downstream keys off it landing at a specific time. |

The board-status-move *portion* of `board/close.mjs` (`ctx.setSelect(status)`) and `board/escalate.mjs` (`runMove(status:'blocked')`) are the same operation as `move.mjs` and should defer through the identical path rather than a second implementation — see §3.

**Never defer — kept synchronous on the existing `makeGh` retry/backoff, no exceptions:**

| Call site | Write | Why never |
| --- | --- | --- |
| `autopilot/merge.mjs` `runMerge` | `gh pr merge --squash --delete-branch` | Explicit in ticket + spec §3.3: deferring a merge silently violates "nothing merges on red" and the merge bar's own re-check invariant. This is the one hard line the spec already drew; this spike doesn't touch it. |
| PR creation (forge:ship/deliver flow) | `gh pr create` | Same principle as merge — not itself in `board/*.mjs`, but named explicitly out-of-scope by the ticket. |
| `board/escalate.mjs` `runEscalate` | `upsertMarkedComment` (decision:`<id>`) | **This is the one non-obvious call.** It shares `upsertMarkedComment` plumbing with the "safe" trail comments, but it is the literal artifact a human must see to unblock a halted pipeline (spec §7). Deferring it would compound the outage: a run already halted waiting on a human decision becomes a run where the human can't even see *why* until GitHub recovers. Recommend an explicit non-deferral marker at this one call site (see §3), not a blanket "comments defer" rule. |
| `board/create.mjs` `runCreate` | `gh issue create`, `gh issue edit` (labels/milestone), `addSubIssue`, `addItemByUrl`, field `setSelect`s | Its own idempotency is **read-dependent**: it title-searches GitHub *at call time* to decide create-vs-resume (`ctx.gh(['issue','list',...])`). A queued create replayed later without re-running that search risks a duplicate if something else (a human, a different run) created a similarly-titled issue in the interim. This doesn't compose with "write now, replay later" without re-deriving the dedup decision at replay time too — a materially bigger design than the minimal scope the spec asked for. |
| `board/reparent.mjs` `runReparent` | `addSubIssue` (`replaceParent:true`) | Infrequent structural mutation. `create.mjs`'s own parentless-orphan warning (§AC3 board hierarchy law) reads the *live* parent link — a deferred reparent would let a concurrent `create.mjs` call observe stale structure and false-warn (or worse, mis-link). Rare enough that synchronous-with-retry is cheap. |
| `board/close.mjs` `runClose` | `gh issue close --reason ...` | The terminal state transition itself (as opposed to the board-status-move and trail-comment sub-steps in the *same* function, which ARE deferrable per the table above). Recommend for v1: **exclude `close.mjs` from outbox integration entirely** rather than decompose one call into sync+async halves — simpler, and still satisfies the spec's "minimal scope" instruction. Flagged as an owner call in §5 if the extra complexity is wanted later. |

`board/status.mjs` is read-only (N/A). This table is exhaustive over every `.mjs` file in `plugin/scripts/board/` plus the one write in `autopilot/merge.mjs` — nothing was skipped.

## 2 — Interaction with #387's ledger-race finding

#387 (`docs/spikes/2026-08-06-autopilot-concurrency-safety.md`, read in full) found `.forge/autopilot/run.json`'s read-modify-write has a real lost-update race (no lock anywhere in `ledger.mjs`'s path), and recommended a `.forge/autopilot/run.lock` — exclusive-create (`fs.open(path, 'wx')`, not `writeJson`'s clobbering temp+rename), `{pid, startedAt, hostname}` contents, PID-liveness + age-staleness reclaim, release in try/finally. **That recommendation has not been implemented anywhere in the codebase yet** (`grep -rn "acquireLock\|exclusive.create\|flag.*'wx'"` across `plugin/scripts` returns zero hits) — there is no lock module to import today, only a documented design to build.

Two concrete answers:

- **The outbox needs its own lock, not a shared one with `run.lock`.** `run.json` and a new `outbox.json` are different resources with different writers/readers (the loop's own bookkeeping vs. a queue of not-yet-delivered GitHub calls) — sharing one mutex would make an outbox flush block on unrelated `run.json` activity and vice versa, and a single loop process draining its own outbox mid-iteration while also calling `recordOutcome` would risk self-deadlock if both went through one lock. Recommend a **second, identically-shaped** `.forge/autopilot/outbox.lock` guarding `.forge/autopilot/outbox.json`, using the *exact same* exclusive-create + PID/age-staleness idiom #387 designed — parameterized so both locks are one small shared helper (e.g. `plugin/scripts/lib/lock.mjs`, `acquireLock(path)`/`isStale(lock)`), not two copies of the same logic. Since neither lock exists in code yet, building the outbox is the natural place this shared helper gets written for the first time — see the follow-up ticket filed in §6.
- **`ledger.mjs`'s `recordOutcome`/`nextIteration` do not need to become outbox-aware.** Every write in the "safe to defer" scope (§1) is *downstream* of a decision the ledger already records synchronously — a `merged` outcome is true the instant `runMerge`'s synchronous `gh pr merge` succeeds (merges are never deferred, per §1), independent of whether the courtesy receipt/trail comment describing it is still sitting in the outbox. The ledger's `run.outcomes` array is the loop's own authoritative record of what it decided/did; a queued board-status-move or trail comment is only a late mirror of that decision onto GitHub's UI. So `applyOutcome`/`applyFiled` stay exactly as #387 read them — no `pending` field, no new mutator. `outbox.json` itself gets the same atomic-write hygiene as `run.json` for free by reusing `jsonfile.mjs`'s existing `writeJson` (temp-then-rename) — no new IO primitive needed there either, only the *lock* is new.

## 3 — Drain trigger

Two mechanisms, composed rather than picking one, mirroring the monitor idiom `plugin/skills/autopilot/SKILL.md` (§ Monitor notifications, read in full) already documents and forge already runs:

- **Opportunistic**: attempt a drain pass at the top of every loop iteration (alongside the existing `nextIteration` guard call) and immediately after any outbox-owned write finally succeeds live (piggybacking `makeGh`'s own success path costs nothing extra).
- **Background monitor**: add `forge-outbox` (`plugin/scripts/monitors/outbox-watch.mjs`), the same shape as the existing `forge-ci` (`monitors/ci-watch.mjs`) and `forge-decisions` (`monitors/decisions-watch.mjs`) — poll, emit exactly one line to the running loop **only on a state transition**, throttled error surfacing after a few consecutive failures (#318's existing pattern). Its reachability check should **reuse #407/#408's existing detectors** (`isRateLimited`, `isPlatformOutage`, `rateBudget`) rather than invent a fourth "is GitHub up" signal — GitHub going from unreachable→reachable is exactly the transition `forge-ci`'s own poll loop already has to reason about.
- **Ceiling**: the ticket's own text is right that a fixed number is hard to defend — the GraphQL reset window tops out around ~1hr (`retryDelayFrom`'s `resetCapMs` is 15 min for the exponential-fallback case, but a real `x-ratelimit-reset` wait can be longer) and an Actions outage has no documented upper bound. Recommend **no fixed auto-escalation ceiling** on "items still queued because GitHub is down" — that's an ordinary, self-resolving wait, not a decision a human can act on faster by being paged. Recommend escalating instead only when a **drain attempt itself fails for a reason that isn't "GitHub still unreachable"** (e.g. a 422 replaying a stale mutation, a malformed queued entry) — that's a real bug, not patience. This is the one place in this spike where the ticket's own request for "a defensible ceiling" is better answered with "no ceiling, different escalation trigger" than with a number — flagged as an owner call in §5 if a belt-and-suspenders numeric ceiling is wanted anyway.

## 4 — Visibility

Recommend two additions, both read-only against `outbox.json`'s pending count (no new mutator, no change to what triggers a `blocked` ticket):

- **`ledger.mjs` `renderReport`** gains an optional trailing line — `outbox: N item(s) still queued (GitHub unreachable for part of this run)` — sourced by reading `outbox.json` at report time, the same way it already reads `run.json`.
- **`board/status.mjs` `computeStatus`** gains an analogous optional field so `forge:board-status` / the `board_status` MCP tool surfaces it in the catch-up card too, consistent with how `blocked`/pending-decision counts already surface there.
- **Explicitly NOT a `blocked` ticket and NOT `escalate.mjs`** by default — `blocked` is reserved for a ticket-level decision only a human can make (spec §7); an outbox backlog isn't a decision, it resolves itself the moment GitHub answers. Overloading the escalation machinery for "please wait" would spam exactly the channel spec §7 keeps deliberately scarce. Reserve escalation for the non-outage drain-failure case in §3.
- The queue itself (`outbox.json`) should be plain, human-readable JSON (`{issue, op, payload preview, queuedAt}` per entry) so a manual `cat .forge/autopilot/outbox.json` is sufficient fallback visibility for v1 — no new inspection command needed.

## Recommendation

1. **Scope**: queue `board/comment.mjs`, `board/move.mjs` (+ the status-move sub-step reused by `close.mjs`/`escalate.mjs`), `board/receipt.mjs`, `board/log.mjs`, `board/digest.mjs`. Never queue merges, PR creation, `escalate.mjs`'s decision comment, `create.mjs`, `reparent.mjs`, or `close.mjs`'s issue-close call (§1).
2. **State + lock**: `.forge/autopilot/outbox.json` (via `jsonfile.mjs`'s existing atomic `writeJson`, no new primitive) guarded by its own `.forge/autopilot/outbox.lock`, built from the *same* exclusive-create + PID/age-staleness idiom #387 designed but never implemented — extract a small shared `lib/lock.mjs` rather than let #409 and #387's eventual `run.lock` diverge on two copies of the same logic (§2). No change needed to `ledger.mjs`'s outcome-recording shape.
3. **Drain**: opportunistic (top-of-iteration + post-success) plus a new `forge-outbox` monitor mirroring `ci-watch.mjs`/`decisions-watch.mjs`, reusing #407/#408's existing reachability detectors. No fixed numeric ceiling; escalate only on a non-outage drain failure (§3).
4. **Visibility**: a `renderReport` line + a `board/status.mjs` field, both read-only against the outbox's pending count. Never a `blocked` ticket for "GitHub is just down" (§4).

## Still an owner decision vs. grounded enough to plan directly

**Grounded enough to plan directly** (this spike's own evidence, no further input needed): the write-scope table (§1), the two-lock-not-one-shared-lock design and the "ledger stays unchanged" finding (§2), the opportunistic+monitor drain composition reusing #407/#408's detectors (§3), and the report-line + status-field visibility approach that explicitly avoids `blocked`/escalation (§4).

**Still open, owner's call**:
- Whether `close.mjs`'s issue-close call is worth decomposing (defer its board-move/trail sub-steps, keep only the `gh issue close` synchronous) instead of this spike's simpler recommendation to exclude `close.mjs` from outbox integration entirely for v1.
- Whether a belt-and-suspenders *numeric* ceiling is wanted anyway on top of this spike's "no ceiling, escalate on non-outage drain failure" recommendation, given the ticket explicitly asked for a defensible number and this spike's honest answer is that an outage's duration is unbounded so any fixed number is somewhat arbitrary.
- The exact mechanism for `escalate.mjs`'s never-defer carve-out — a hardcoded exemption at that one call site, or a general `urgent:true` flag threaded through `upsertMarkedComment` callers — an API-shape choice for whoever plans the build, not resolved here.

## Sources

- `plugin/scripts/autopilot/ledger.mjs` (full read) — `recordOutcome`/`recordFiled`/`applyOutcome`/`applyFiled`/`startRun`/`renderReport`/`nextIteration`/`guardTripped`.
- `plugin/scripts/lib/jsonfile.mjs` (full read) — `readJson`/`writeJson`'s atomic temp-then-rename, `mergeJson`.
- `docs/spikes/2026-08-06-autopilot-concurrency-safety.md` (full read) — the lockfile design this reuses; confirmed not yet implemented anywhere in the codebase (no `lock.mjs`, no `flag: 'wx'` usage in `plugin/scripts`).
- `plugin/scripts/board/*.mjs` — all ten files read in full (`close.mjs`, `comment.mjs`, `create.mjs`, `digest.mjs`, `escalate.mjs`, `log.mjs`, `move.mjs`, `receipt.mjs`, `reparent.mjs`, `status.mjs`) to enumerate every GitHub write call site (§1) rather than guess.
- `plugin/scripts/lib/exec.mjs` and `plugin/scripts/autopilot/merge.mjs` (both full read, **fresh, on the `feat/408-outage-detection` branch** — post-#408) — `isRateLimited`/`retryDelayFrom`/`makeGh`/`rateBudget` (#360/#407), `isPlatformOutage`/`classifyCiFailure`/`failedDuringSetup`/`forceNewSha` (#408), `runMerge`'s single `gh pr merge` write.
- `plugin/scripts/lib/issues.mjs` (partial read) — `upsertMarkedComment`'s list-then-PATCH-or-POST idempotency core, shared by every "trail-shaped" write in §1's table.
- PR #410 (#407, open, not yet merged) diff — confirmed `ciGreen()`'s shape changed (now takes `{freshState}` and can skip a redundant GraphQL re-fetch on a fresh known-green transition) and that `rateBudget()` is still not wired into any preflight on this branch (`grep -n rateBudget plugin/scripts/autopilot/*.mjs` = zero hits pre-#410-merge) — read so this doc's write-call-site table reflects the current delivered shape, not the pre-#407/#408 one the original spec was written against.
- PR #412 (#408, open, not yet merged, this branch) — confirms the outage-detection code this doc's drain-trigger recommendation reuses is real, delivered code, not aspirational.
- `plugin/skills/autopilot/SKILL.md` (§ Monitor notifications, § Stop conditions, full sections read) — the existing `forge-ci`/`forge-decisions` background-monitor idiom this doc's `forge-outbox` recommendation mirrors, and the escalation/`blocked` semantics §4 deliberately avoids overloading.
- `docs/specs/2026-08-08-github-resilience.md` §3.3 (full read) — the ticket's own scope statement and the two directions already rejected, not re-litigated here.
