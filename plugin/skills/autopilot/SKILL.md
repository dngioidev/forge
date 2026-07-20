---
name: autopilot
description: Continuously clears the whole board unattended — picks the next actionable ticket, auto-triages it if needed, delivers it via forge:deliver, and auto-merges to main on green, one ticket at a time, until nothing actionable remains. The per-ticket human PR gate is replaced by a strict automated merge bar; the only pauses are genuine escalations (product broken, a decision that is the human's to make, critical security). Use to burn a triaged-or-triageable backlog down to empty hands-off.
---

# forge:autopilot

Clear the board, unattended. Autopilot is **`forge:deliver` in a continuous loop** with two additions: an **auto-triage front door** (an untriaged ticket doesn't stall the run) and **auto-merge on green** (the human is no longer the per-ticket gate). It is an orchestrator *over* the pipeline forge already has — every ticket still runs the real thing (planner → `execute-agents` → mechanical gates → adversarial `reviewer`/`security`). Autopilot only removes the *human* PR gate and adds the loop.

Spec: `docs/specs/2026-07-21-forge-autopilot.md`.

## The contract (what changes, what doesn't)

- **The human PR gate is gone.** In its place, a strict **automated merge bar** (below). This is the deliberate trust reversal — the quality guarantee rests entirely on the mechanical gates + adversarial subagents + CI.
- **The only pauses are real escalations.** Product broken with no safe fix · a design/behaviour decision that isn't the engine's to make · an under-specified ticket · critical security · plus deliver's existing §7 triggers. Everything routine — role choice, UI variant, which regression test, filing a follow-up — autopilot decides and proceeds.
- **One ticket at a time (v1).** Finish and merge one before starting the next — no worktree machinery, no cross-ticket conflicts. (Parallel via a bounded worktree pool is designed-for but deferred; see spec §9.)
- **The loop owns the run; deliver owns each ticket.** Autopilot owns the run ledger and the stop condition; each ticket's branch/ledger/gates/trail stay inside `forge:deliver`.
- **Each ticket is delivered in a discardable context.** `forge:deliver` for a ticket runs as its **own spawned agent**; its heavy tokens (reading/writing/reviewing code) die with that context. The outer loop keeps only `run.json` + git + a one-line outcome per ticket — so loop overhead stays ~O(1) per ticket no matter how long the run (spec §11).

## The loop

```
select next actionable ticket (§ selection)
  ├─ none left ────────────────────────────▶ STOP + run report
  ▼
triaged?  ── no ──▶ forge:triage
                      └─ still under-specified (verdict: fail) ─▶ ESCALATE + skip, continue
  ▼ yes
forge:deliver  (planner → execute-agents → ship, up to the open PR)
  ▼
merge bar (§ auto-merge)  ── any red ──▶ fix wave; repeat failure ─▶ ESCALATE + park, continue
  ▼ all green
squash-merge to main · post-merge ritual · trail --phase merged
  ▼
surfaced new work? ─▶ board/create.mjs it (linked, trail-noted) — re-enters the queue
  ▼
loop
```

## Selection — "next actionable"

Priority-ordered, FIFO within a priority. Read the board fresh each iteration (tickets you filed, or the owner added mid-run, get picked up):

1. **Resume first** — an `inProgress`/`inReview` ticket left mid-flight by an earlier run (deliver's resume protocol continues it).
2. `ready` (triaged), `p0` → `p1` → `p2`.
3. `backlog` — **auto-triaged** first (the front door), then delivered.
4. **Never selected:** `blocked` (has a pending decision), `done`, `wontDo`, or any ticket with an unresolved escalation.

Flags: `--limit N` stop after N merges · `--area <a>` restrict to one area · `--dry-run` print the selection + per-ticket classification and change nothing.

## Auto-triage front door

A `backlog` ticket is run through `forge:triage` to become deliverable *before* `deliver` sees it. If it still can't be specified (planner or triage returns `verdict: fail` — the ask or acceptance is unclear), **escalate it and skip** — the loop moves to the next ticket. Autopilot never guesses a product decision to keep moving.

## Auto-merge — the bar that replaces human review

A ticket merges **only when every one of these is green**. Any red routes to a fix wave (a fresh `implementer` spawn inside deliver's flow); the *same* gate failing twice is an escalation. **Nothing merges on red — ever.**

1. `forge:ship` completed clean: situation gate · conventions lint · rebase + full `verify` green.
2. All mechanical gates pass: `plandrift` · `testintent` · `depguard` · `acgate` (every AC id in a passing test).
3. Full-branch `reviewer` **and** `security` subagents return `verdict: pass` with **zero critical/high** findings. A critical is always an escalation, never a merge.
4. **CI on the PR is green.** Open the PR as deliver does (`Closes #n`, AC checklist, honest verification), then wait for checks — never merge before CI.
5. **Squash-merge to main**, delete the branch, `Closes #n` closes the issue.

**Opt-out:** if `features.autopilotAutoMerge` is `false`, autopilot stops at the open PR for that ticket, records it as *awaiting-human*, and continues the loop with other tickets — the safe-by-default door for consumers who adopt autopilot but not its merge policy.

## The human gates — the only pauses (spec §6)

Halt via `escalate.mjs` (ticket → blocked + decision comment + pending file). An escalation **parks one ticket** and the loop continues with the next — a single blocked ticket does not stop the whole run.

- **Product broken, no safe fix** — verify/CI red after a fix wave, or a change breaking unrelated behaviour with a fix beyond the plan's blast radius.
- **Design deviation needs a decision** — the work can't be done as designed and the choice isn't the engine's (spec/ADR ambiguity, a product-behaviour fork).
- **Under-specified ticket** — planner/triage `verdict: fail`.
- **Critical security finding.**
- **deliver's §7 triggers** — denylist-blocked action genuinely needed · reviewer↔implementer deadlock across re-spawns · the same gate failing twice.

## Filing new work as it goes (spec §7)

When delivery surfaces a need out of the current ticket's scope, file it rather than drop it — `board/create.mjs`, linked to the driving ticket, trail-noted: a **bug** found in passing, a **spike** when a ticket turns out to need investigation first, a **follow-up item** for deferred work. Filed tickets re-enter the queue and are picked up by a later iteration — the board may *grow* mid-run and still converge, as long as new work trends down.

## Stop conditions & safety rails (spec §8)

- **Natural stop:** no actionable ticket remains → print the run report (merged / escalated / skipped / newly-filed) and exit.
- **`--limit N`:** stop after N merges.
- **Kill switch:** honour the forge-control global pause (`.forge-control/paused`) and the per-repo situation gate (open incident / security hold) — spawn nothing while paused. Clearing a pause is always a human, never automated.
- **Interrupt:** Ctrl-C between tickets is clean (the run ledger is the resume point); mid-ticket, deliver's own resume protocol recovers.
- **Loop backstop:** a max-iterations guard (default = board size × 2) prevents a file-a-ticket-per-iteration runaway — hitting it escalates rather than looping forever.

## Run ledger & report

The loop owns `.forge/autopilot/run.json`: the queue, and per ticket `merged | escalated | skipped | filed` with the PR/decision ref. A fresh session reads it to resume. At stop, print the report: how many merged, which parked (with why), which skipped, what new tickets were filed — and summarise the run on the delivery-log issue.

## Driver scripts (the executable spine)

The loop is prose the orchestrator runs, but its mechanical decisions are real, tested scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/autopilot/`:

- `select.mjs` — `selectNext(tickets)` / `--dry-run`: the selection order + the triage/deliver/resume decision (§ selection). Pure, so the order is testable.
- `merge.mjs` — `evaluateMergeBar(signals)` + `runMerge(ctx,{issue,pr,signals})`: the auto-merge bar. Fail-closed — a missing signal is red; `features.autopilotAutoMerge:false` parks at the PR. This is where "nothing merges on red" lives.
- `ledger.mjs` — the run ledger (`.forge/autopilot/run.json`): `applyOutcome`/`applyFiled`/`guardTripped`/`renderReport`, plus `ledger.mjs report`. The loop backstop and the resume point.
- `newwork.mjs` — `fileWork(ctx,{title,kind,from})`: files a linked follow-up (bug/spike/item) mid-run.

The orchestrator holds the ship/gate/reviewer/security verdicts and passes them to the merge bar; the scripts never spawn subagents or drive the loop themselves.

## Cost & context on long runs (spec §11)

A long run stays bounded by construction — not by luck:

- **Delegate, don't inline.** Deliver each ticket as a spawned agent; its context (and its own subagents' contexts) is discarded when the ticket ends. The outer loop never ingests code — only the terminal outcome.
- **Checkpoint + reset is free.** Every ticket is written to `run.json`; the resume protocol reconstructs from disk, so the orchestrator can be compacted or restarted between tickets at near-zero reload cost.
- **Cheap where it can be.** `select.mjs` + the ledger are plain scripts (zero model cost); model tiering already applies inside delivery (haiku lookup / sonnet default / opus only for second-opinion).
- **Intrinsic vs. overhead.** Per-ticket delivery cost is the real work and can't be optimised away; what autopilot keeps ~constant is the *loop overhead*. The host OS is irrelevant to cost/context — only PATH/shell handling is platform-specific.

## Resume protocol

Fresh session: read `.forge/autopilot/run.json` for run state → `escalate.mjs --check` to pick up any decisions the human answered → re-select per the selection order (which naturally resumes a mid-flight ticket first) → continue the loop.
