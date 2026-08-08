# Spec — GitHub resilience for autopilot (rate limits, platform outages) (#407, #408, #409)

**Date:** 2026-08-08 · **Driving report:** owner, 2026-08-08 — *"the github api rate limit and the api health got break too many time during the work I doing... autopilot --shape will do many in the same time."* Proposed two directions: a local/open-source GitHub-equivalent, or an "asynchronous box" so the pilot doesn't wait when GitHub is broken.

## 1. Problem

Two distinct failure modes were reported as one, and conflating them would misdirect the fix:

- **GitHub API rate limiting** — the GraphQL bucket (5,000 pts/hr, shared account-wide) gets exhausted mid-run, hard-stalling board ops.
- **GitHub platform outages** — GitHub Actions infra itself returns `Service Unavailable` resolving action-download-info, unrelated to any budget; jobs stick in `queued` or fail for reasons that have nothing to do with the code under test.

Both were experienced this session and both produced the same symptom (the run stalls or looks broken), but they need different fixes — the code confirms this once read directly (§2).

**The owner's stated cause — parallel mode — is not actually the mechanism.** Autopilot v1 has no parallel ticket delivery (`docs/specs/2026-07-21-forge-autopilot.md` §9: "not built in v1"; spike #387 confirmed zero worktree/concurrency code exists). The real amplifier, found by re-reading the code for this spec, is **redundant polling within a single ticket's CI wait** (§2.2) — three independent GraphQL pollers watch the same PR's check status per ticket, and that compounds across a long unattended run to look exactly like "too many at once."

## 2. What the code actually shows (constraints)

### 2.1 — #360 closed 4 ACs; only 2 were delivered

#360 ("Board tooling exhausts the shared GitHub GraphQL rate limit," closed 2026-08-03) specified AC.1–AC.4. Re-reading `plugin/scripts/lib/exec.mjs` directly:

- **AC.1 (backoff/retry) — delivered, adopted.** `isRateLimited`, `retryDelayFrom`, `makeGh` exist and `makeGh` is used across 24 files.
- **AC.2 (actionable notice) — delivered.** `rateLimitNotice` produces the "remaining N, reset in ~Ns, retrying" line.
- **AC.3 (reduce call volume) — not delivered.** No caching exists in `plugin/scripts/lib/board.mjs` (`grep -n "cache|memoiz"` = zero hits). Three independent pollers hit the same PR's `statusCheckRollup` per ticket: the `forge-ci` monitor (`monitors/ci-watch.mjs`, 20s interval), the delivery subagent's own mandated `gh pr checks <pr> --watch` (SKILL.md §Orchestration), and `autopilot/merge.mjs`'s `ciGreen()` pre-merge re-check.
- **AC.4 (budget preflight) — dead code.** `rateBudget(gh, {lowWater})` is fully implemented and exported but `grep -rn "rateBudget("` finds only its own definition — nothing calls it. Autopilot's run-start preflight (`preflight.mjs`) checks merge authorization only; the iteration guard (`ledger.mjs` `nextIteration`) checks iteration count only. Neither checks the GraphQL budget.

The retry primitive works; the *demand-reduction* half of #360 was never built, so a long run still burns the shared budget fast and each individual 403 gets a working but expensive retry instead of the run pausing proactively.

### 2.2 — Actions outages are a different signature, currently invisible to the code

`isRateLimited()` matches rate-limit-specific text only (`x-ratelimit-remaining: 0`, `API rate limit exceeded`, `RATE_LIMITED`, secondary-limit hints). A `Service Unavailable` resolving action-download-info matches **none** of these — it is treated as an ordinary CI failure. This session's empirical recovery (force a fresh commit SHA via rebase + repush; re-running the same SHA did not reliably help) is entirely manual today, and autopilot's merge bar has no way to tell "GitHub was down" from "your change is actually broken" — both currently look like the same red, and the same-gate-failing-twice rule would escalate an outage as if it were a real regression.

### 2.3 — autopilot v1 is strictly sequential; the ledger has no concurrency safety

Spike #387 (2026-08-06, read in full for this spec) found `plugin/scripts/autopilot/ledger.mjs`'s `run.json` read-modify-write has a real, demonstrated **lost-update race** with no lock anywhere in the path — writes are individually atomic (`jsonfile.mjs` temp+rename) but the read...compute...write sequence is not. This matters directly here: any new local state this spec proposes (an outbox) must not add a second uncoordinated writer to the same hazard class, and the spike's own recommendation (an exclusive-create lockfile, PID+age staleness check) is the idiom to reuse, not reinvent.

## 3. Chosen design — three sub-designs, three tickets

Split because they have different owners, different urgency, and different confidence levels (two are ready to plan directly; the third has open questions and is spiked first, per this skill's own rule).

### 3.1 — #407: close the real gap in #360 (concrete, ready to plan)

- Wire `rateBudget()` into the run-start preflight and a periodic iteration check; pause + surface the reset window when low, instead of only reacting after a 403. If the budget check itself fails (network down, not just low budget), degrade to today's reactive per-call retry rather than hard-blocking the run on a check that couldn't complete.
- Reduce the 3-poller redundancy for CI status — thread the `forge-ci` monitor's known transition into `merge.mjs`'s `ciGreen()` so a *very recent* (e.g. within one monitor interval) known-green transition can satisfy the check without firing a new GraphQL call, or back the monitor's own interval off when budget is low. **The re-check itself — confirming CI is actually green before merging — stays mandatory** ("nothing merges on red"); only the case where fresh, already-known-good data exists is short-circuited from re-fetching, never the guarantee that a merge is preceded by a green confirmation.
- Cache board field/option IDs per run instead of re-fetching on every op.

### 3.2 — #408: detect + auto-recover from Actions platform outages (concrete, ready to plan)

- Add `isPlatformOutage(res)` to `exec.mjs`, mirroring `isRateLimited`'s shape but matching the outage signature (§2.2) instead of the rate-limit one.
- On detection, apply the empirically-proven recovery (force a fresh commit SHA, bounded retries) before treating it as a real gate failure.
- Escalations distinguish "GitHub was down" from "your change is broken" in the trail/run report.

### 3.3 — #409: the "async box" (spiked first — open questions, not guessed)

The owner's own proposed direction. Scoped to a **minimal local outbox for the small set of writes that are safe to defer** (trail comments, board-status moves — both already tolerate the eventual-consistency gap this session hit repeatedly as routine "board status drift"), reusing #387's lockfile idiom rather than inventing new machinery. **Not spiked further; explicitly not chosen (§4):** a full local/open-source GitHub replacement, and a general-purpose async broker for every GitHub call. What's genuinely open and routed to the spike: which write call sites are actually safe to queue, how the outbox's own state avoids compounding #387's ledger race, what drains it, and how a human sees "the board isn't fully caught up because GitHub was down" without polling. PR creation and merges are **not** deferred candidates — that would violate the merge bar's own invariant.

## 4. Alternatives considered (and rejected)

- **A full local/open-source GitHub-equivalent backend** (self-host Gitea/Forgejo, or a hand-built board+PR+review system). Rejected: disproportionate to the actual failure modes — it would touch board, PR, review, and CI orchestration simultaneously (forge's entire spine), for outages that recovered in minutes each this session against 99%+ uptime otherwise. It also doesn't fix §2.2's specific mechanism: CI compute is *already* local (self-hosted runners, per standing project convention), and the outage is in GitHub's *action-catalog metadata resolution* — a self-hosted runner still depends on that regardless of which system hosts the repo or the board, unless every Action is also fully vendored, which is its own separate, much larger undertaking. This would be a rewrite of forge's spine to fix a rare, already-recoverable failure — not an enhancement.
- **A general-purpose async job queue/broker for every GitHub-bound call.** Rejected for v1: most `gh` calls are cheap, idempotent reads already covered by #360's retry (§2.1). Only a handful of *write* operations are stateful enough to matter, and #387 already found the existing file-backed ledger has an unresolved concurrency hazard — layering a generic broker on top before that's addressed would compound the hazard, not solve it. The scoped outbox (§3.3) gets the same practical benefit (don't block the loop on a GitHub write) without introducing a new subsystem.

## 5. Risks

- **#407's CI-poll dedup could weaken the merge bar's own safety property if done carelessly** — the spec explicitly requires `merge.mjs`'s pre-merge re-check to remain; only *idle* redundant polling is a target.
- **#408's outage detector could false-positive on a real, slow-but-legitimate CI failure** and mask a genuine break as "just an outage." Bounded retry count (2) and honest trail logging (§3.2 AC.3/4) keep this recoverable and visible rather than silent.
- **#409's outbox could become a second uncoordinated writer to local state** if it doesn't reuse #387's lock design — the spike is scoped explicitly to prevent this by reading #387 first (see ticket's own Sources list).

## 6. Out of scope

- Any change to which system is the board/PR/CI system of record — GitHub stays authoritative throughout (§4).
- Concurrent/parallel ticket delivery — orthogonal to this spec; tracked by #387/spec §9, deliberately still deferred.
- Vendoring/self-hosting the GitHub Actions marketplace catalog to fully eliminate dependency on §2.2's metadata service — a much larger undertaking than the outage's actual observed frequency justifies; not proposed here.
