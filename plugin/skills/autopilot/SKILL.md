---
name: autopilot
description: Continuously clears the whole board unattended — picks the next actionable ticket, auto-triages it if needed, delivers it via forge:deliver, and auto-merges to main on green, one ticket at a time, until nothing actionable remains. The per-ticket human PR gate is replaced by a strict automated merge bar; the only pauses are genuine escalations (product broken, a decision that is the human's to make, critical security). Use to burn a triaged-or-triageable backlog down to empty hands-off.
---

# forge:autopilot

Clear the board, unattended. Autopilot is **`forge:deliver` in a continuous loop** with two additions: an **auto-triage front door** (an untriaged ticket doesn't stall the run) and **auto-merge on green** (the human is no longer the per-ticket gate). It is an orchestrator *over* the pipeline forge already has — every ticket still runs the real thing (planner → `execute-agents` → mechanical gates → adversarial `reviewer`/`security`). Autopilot only removes the *human* PR gate and adds the loop.

Spec: `docs/specs/2026-07-21-forge-autopilot.md`.

## Output discipline (quiet run)

The trail, ledger (`run.json`), and journal are the record — don't re-narrate them in chat. Emit **at most one terse status line per ticket** (`#123 → merged · PR #145`, `#130 → escalated (needs decision)`), never a paragraph, preamble, or recap. The delivery subagents work silently in their own contexts — surface only each returned **outcome**, not its working. Reserve prose for what the human must act on: **escalations** (the decision + options) and the **final run report**.

## The contract (what changes, what doesn't)

- **The human PR gate is gone.** In its place, a strict **automated merge bar** (below). This is the deliberate trust reversal — the quality guarantee rests entirely on the mechanical gates + adversarial subagents + CI.
- **The only pauses are real escalations.** Product broken with no safe fix · a design/behaviour decision that isn't the engine's to make · an under-specified ticket · critical security · plus deliver's existing §7 triggers. Everything routine — role choice, UI variant, which regression test, filing a follow-up — autopilot decides and proceeds.
- **One ticket at a time (v1).** Finish and merge one before starting the next — no worktree machinery, no cross-ticket conflicts. (Parallel via a bounded worktree pool is designed-for but deferred; see spec §9.)
- **The loop owns the run; the delivery subagent owns each ticket.** Autopilot owns the run ledger and the stop condition; each ticket's branch/ledger/gates/trail/merge happen **inside a spawned delivery subagent**, not in the main loop.
- **The main loop NEVER delivers inline.** It must not read code, run `forge:deliver`, edit files, or merge in its own context. Doing so fills the main window (forcing compaction mid-run) and surfaces every permission prompt in the orchestrator. The main loop's only tools are selection, the ledger, trail comments, and spawning the delivery subagent (§ Orchestration).

## The loop

```
RUN START: confirm in-session merge authorization (§ Merge-authorization preflight)
  └─ absent ─▶ ask "Merge policy" / degrade to PR-only (awaiting-human)  — NOT a mid-run stall
  ▼
select next actionable ticket (§ selection)
  ├─ none left ────────────────────────────▶ STOP + run report
  ▼
SPAWN a delivery subagent (Task tool) for this ticket ─────────┐   § Orchestration
  brief: deliver #N end-to-end (triage/shape → plan → execute   │   runs in its OWN context
  → ship → open PR → WATCH CI to green in-run                   │
  (`gh pr checks <pr> --watch`) → auto-merge on green),         │
  return {issue, outcome, pr, notes}                            │
  ▼                                                             │
main loop reads ONLY that terminal report ◀────────────────────┘
  ├─ outcome=escalated / awaiting-human ─▶ record + park, continue with next ticket
  ├─ outcome=merged ─────────────────────▶ record to run.json · trail --phase merged
  └─ subagent filed new work ────────────▶ already on the board — re-enters the queue
  ▼
loop  (main context unchanged — ~O(1) per ticket)
```

## Orchestration — the main loop only orchestrates

Per ticket, the main loop does exactly three things: **spawn**, **record**, **continue**.

1. **Spawn a delivery subagent** with the Task tool — `subagent_type: general-purpose` (or a dedicated delivery agent if the roster has one). The brief is self-contained so the subagent needs no main-loop context: the ticket ref + body, the route (deliver, or shape-first under `--shape`), the merge bar (§ auto-merge), the escalation triggers (§ human gates), and this instruction — *do the whole ticket in your own context (branch, plan, implement, test, gates, ship, open the PR, **watch CI to green in this same run with `gh pr checks <pr> --watch`**, auto-merge on green, post-merge ritual); file follow-ups directly with `board/create.mjs`; escalate with `escalate.mjs`; then return a compact terminal report and nothing else.*

   **Forbidden — the return-then-resume stall:** the brief must NOT tell the subagent to open the PR and then return awaiting an external/background completion notification (e.g. "await the CI watcher's notification"). The subagent's context is discarded on return and **nothing re-invokes it when CI goes green** — that stalls the ticket until a manual resume. The background CI monitor notifies the **main loop**, not a returned subagent. The subagent must therefore watch CI to conclusion **in-run itself** (`gh pr checks <pr> --watch`) and merge within the **same invocation** — never return on the assumption it will be re-spawned on green.
2. **Read only the terminal report** — `{issue, outcome: merged|escalated|awaiting-human|skipped, pr, notes}`. The main loop consumes that JSON, writes it to `run.json`, trails the ticket, and never re-reads the subagent's work.
3. **Continue** to the next ticket. Because the delivery context is discarded, the main window is unchanged between tickets — a 5-ticket and a 50-ticket run cost the same orchestration overhead, and the run never compacts mid-loop.

A subagent that can't finish (deadlock, a gate failing twice, an ungrounded shape) returns `outcome: escalated` with the reason; the loop parks that one ticket and moves on. Never fall back to delivering inline — a missing/broken delivery subagent is itself an escalation.

## Permissions — required for a continuous run

Autopilot is autonomous, so its **outward commands must be pre-authorized** — otherwise `gh pr merge`, `git push`, `gh issue close`, etc. each raise a permission prompt and the loop stalls (it is *not* continuous). Print the exact allowlist and merge it into `.claude/settings.local.json` once:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/autopilot/perms.mjs"
```

This grants unattended **auto-merge and push** authority — review it before adding; it's opt-in and forge never writes it for you. Approving the first prompt as *"always allow"* achieves the same thing incrementally. Without it, autopilot still works but pauses at each outward command for your approval.

**The allowlist alone does NOT authorize unattended merge.** The `.claude/settings.local.json` allowlist (and `features.autopilotAutoMerge: true`) are **necessary but not sufficient**: they do **not** clear the harness's **auto-mode classifier**, which blocks a subagent from unattended-merging its own PR unless the **user names the merge authorization in a genuine in-session message** (a live user turn — e.g. answering the run-start "Merge policy" prompt below). A grant recorded only in `run.json` or in agent narration does **not** count. With the allowlist but no in-session authorization, the loop still **stalls at the first merge** — so confirm the in-session grant at run start (§ Merge-authorization preflight), not just the allowlist.

## Merge-authorization preflight — REQUIRED before the first delivery

Autopilot's loop is orchestrator prose, so this preflight is a **required run-start step**, not a script: **before spawning the first delivery subagent**, the orchestrator must confirm it holds an **in-session user authorization to auto-merge**.

- **Why up front, not mid-run.** Config + allowlist do not clear the harness auto-mode classifier (§ Permissions). If the grant is missing, every ticket delivers fully and then **wedges at its first merge** — you burn a whole delivery only to stall. This is the observed failure mode this preflight prevents.
- **What counts as authorization.** A **live user message naming the merge authorization** — e.g. the user answering a run-start **"Merge policy"** question with an explicit grant. *Not* counted: `features.autopilotAutoMerge: true`, the `gh pr merge` allowlist, a value in `run.json`, or anything the agent narrates to itself.
- **If it is present** → proceed into the loop; delivery subagents may unattended-merge on a green bar.
- **If it is absent** → do **not** spawn a delivery that will stall. **Surface it and degrade at run start:** either ask the "Merge policy" question now and obtain the live grant, or run **PR-only / awaiting-human** — each ticket stops at its open green PR and is recorded *awaiting-human* (as with `features.autopilotAutoMerge: false`), and the loop continues. Escalate rather than guess a merge authorization.

(If a lightweight helper that prints the required-authorization notice is useful, keep it additive; the documented orchestrator step above is the requirement.)

## Selection — "next actionable"

Priority-ordered, FIFO within a priority. Read the board fresh each iteration (tickets you filed, or the owner added mid-run, get picked up):

1. **Resume first** — an `inProgress`/`inReview` ticket left mid-flight by an earlier run (deliver's resume protocol continues it).
2. `ready` (triaged), `p0` → `p1` → `p2`.
3. `backlog` — **auto-triaged** first (the front door), then delivered.
4. **Never selected:** `blocked` (has a pending decision), `done`, `wontDo`, or any ticket with an unresolved escalation.

Flags: `--limit N` stop after N merges · `--area <a>` restrict to one area · `--dry-run` print the selection + per-ticket classification and change nothing · `--shape` **crazy mode** (below).

A `backlog` ticket routes on its **readiness** (`readiness.mjs` → does it carry acceptance criteria): shaped → the triage front door; **not shaped** → `shape` under `--shape`, else escalate-and-skip (the default).

## Crazy mode — shaping the backlog (`--shape`, spec: forge-autopilot-crazy-mode)

Off by default. With `--shape`, a `backlog` ticket that isn't shaped (no acceptance criteria) is sent to **`forge:shape`** instead of being escalated: it gathers the product context, classifies why it isn't ready, runs the right front-of-pipeline skill (`ideate`/`brainstorm`/`spike`/`design`), and — **grounded-only** — either promotes it Backlog→Ready (then the loop delivers it) or **escalates** the exact open question and skips. The **ground gate** (`gates/groundgate.mjs`) enforces that every shaped product decision cites a real source, so the engine never invents product direction. Without `--shape`, this whole stage is off and an unshaped ticket escalates as before.

## Auto-triage front door

A `backlog` ticket that is already shaped is run through `forge:triage` to become deliverable *before* `deliver` sees it. If it still can't be specified (planner or triage returns `verdict: fail` — the ask or acceptance is unclear), **escalate it and skip** — the loop moves to the next ticket. Autopilot never guesses a product decision to keep moving.

## Auto-merge — the bar that replaces human review

A ticket merges **only when every one of these is green**. Any red routes to a fix wave (a fresh `implementer` spawn inside deliver's flow); the *same* gate failing twice is an escalation. **Nothing merges on red — ever.**

0. **In-session merge authorization is present** (§ Merge-authorization preflight). An explicit in-session user grant is what actually clears the harness auto-mode classifier — `features.autopilotAutoMerge: true` + the `gh pr merge` allowlist are necessary but **not sufficient**, and a grant in `run.json`/narration does not count. Absent it, the ticket is parked *awaiting-human* at its open green PR, never merged.
1. `forge:ship` completed clean: situation gate · conventions lint · rebase + full `verify` green.
2. All mechanical gates pass: `plandrift` · `testintent` · `depguard` · `acgate` (every AC id in a passing test).
3. Full-branch `reviewer` **and** `security` subagents return `verdict: pass` with **zero critical/high** findings. A critical is always an escalation, never a merge.
4. **CI on the PR is green.** Open the PR as deliver does (`Closes #n`, AC checklist, honest verification), then **watch CI to conclusion in the same run** with `gh pr checks <pr> --watch` — never merge before CI, and never return awaiting an external notification (the delivery subagent isn't re-invoked on green — § Orchestration).
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
- **Kill switch:** honour the per-repo **situation gate** (`gates/situationgate.mjs`) — while the repo is in an **open incident** or **security-response** (security hold) situation the gate pauses shipping (during an incident, ship proceeds only on a `hotfix/*` branch and release is refused outright; during a security hold only `respond`/`investigate` run), so autopilot spawns no new delivery until it clears. Clearing the situation is always a human action (close the incident / lift the security hold), never automated.
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
- `perms.mjs` — prints the `.claude/settings.local.json` allowlist autopilot needs to run continuously (non-destructive; opt-in).

The orchestrator holds the ship/gate/reviewer/security verdicts and passes them to the merge bar; the scripts never spawn subagents or drive the loop themselves.

## Cost & context on long runs (spec §11)

A long run stays bounded by construction — not by luck:

- **Delegate, don't inline (mandatory — see § Orchestration).** Each ticket is delivered in a discardable context — its **own spawned agent** — whose tokens die when the ticket ends. The outer loop never ingests code; it keeps only `run.json` + git + a **one-line outcome** per ticket, so overhead stays **~O(1) per ticket** no matter how long the run.
- **Checkpoint + reset is free.** Every ticket is written to `run.json`; the resume protocol reconstructs from disk, so the orchestrator can be compacted or restarted between tickets at near-zero reload cost.
- **Cheap where it can be.** `select.mjs` + the ledger are plain scripts (zero model cost); model tiering already applies inside delivery (haiku lookup / sonnet default / opus only for second-opinion).
- **Intrinsic vs. overhead.** Per-ticket delivery cost is the real work and can't be optimised away; what autopilot keeps ~constant is the *loop overhead*. The host OS is irrelevant to cost/context — only PATH/shell handling is platform-specific.

## Resume protocol

Fresh session: read `.forge/autopilot/run.json` for run state → `escalate.mjs --check` to pick up any decisions the human answered → **re-run the Merge-authorization preflight** (the in-session grant is *not* file-backed — a restarted session is a new session and must re-obtain a live grant, or degrade to PR-only) → re-select per the selection order (which naturally resumes a mid-flight ticket first) → continue the loop. (Compaction within the *same* session keeps the grant; only a full restart needs a fresh one.)
