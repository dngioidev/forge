# forge:autopilot — continuous autonomous board-clearing engine

**Status: draft — awaiting owner approval.** Board: project #8. Target: next release. Code home: `plugin/skills/autopilot/SKILL.md` + a thin driver in `plugin/scripts/autopilot/`.

## 1. What it is

One command that **clears the whole board unattended**. It picks the next actionable ticket, makes it deliverable, delivers it, merges it, and moves to the next — continuously, until nothing actionable remains. It is `forge:deliver` in a loop with two additions: an **auto-triage front door** (so an untriaged ticket doesn't stall the run) and **auto-merge on green** (so the human is no longer the per-ticket gate). The human is consulted **only** when the product breaks or a decision the engine may not make comes up.

Autopilot is not a new pipeline — it is an **orchestrator over the pipeline forge already has**. Every ticket still runs the real thing: planner classifies it, `execute-agents` fans the roles out, the mechanical gates and the adversarial `reviewer`/`security` subagents run. Autopilot only removes the *human* PR gate and adds the loop around it.

## 2. The trust reversal (the one thing that changes)

`deliver`'s contract is "exactly one human gate — the PR." Autopilot **removes that gate** and replaces it with an *automated* merge bar. This is deliberate and owner-chosen (this spec). The quality guarantee shifts entirely onto the mechanical gates + adversarial subagents + CI. Therefore the merge bar is strict and non-negotiable (§4).

**One thing the trust reversal does *not* buy you: it does not clear the harness's auto-mode classifier.** Removing the *product* PR gate is a forge decision; permitting a subagent to **unattended-merge its own PR** is a *harness* decision, and the auto-mode classifier requires an **explicit in-session user authorization** for it — a genuine live user message that names the merge authorization (e.g. the answer to a run-start "Merge policy" prompt). `features.autopilotAutoMerge: true` **plus** the `gh pr merge` allowlist (§ Permissions) are **necessary but not sufficient**: config + allowlist alone do **not** clear the classifier, and a grant recorded only in `run.json` or in agent narration is **not** an authorization. Without the in-session grant, the loop **stalls at the very first merge** — contradicting the hands-off contract — so the authorization must be obtained **up front at run start** (§4 preflight), not discovered mid-run.

## 3. Orchestration — how it works, mechanically

```
[you] /forge:autopilot                         (optionally: --limit N, --area <a>, --dry-run)
        ▼
run start: confirm in-session merge authorization (§4 preflight)
        │   absent ⇒ prompt (Merge policy) or degrade to PR-only — never a mid-run merge stall
        ▼
loop:  select next actionable ticket  ──────────────┐   selection order §5
        ▼                                           │
   triaged?  ── no ──▶  forge:triage the ticket      │   auto-triage front door
        │                 (still under-specified? ⇒ ESCALATE, skip, continue)
        ▼ yes                                        │
   forge:deliver  (planner → execute-agents → ship)  │   the real pipeline, unchanged
        ▼                                            │
   merge bar §4  ── any red ──▶ fix wave / ESCALATE   │   never merge red
        ▼ all green                                  │
   auto-merge to main (squash, Closes #n)            │
        ▼                                            │
   post-merge ritual (move→done, delivery log, trail)│
        ▼                                            │
   surfaced a new need? board/create.mjs it ─────────┘   feeds back into the queue
        ▼
until: no actionable ticket left  ⇒  STOP + run report
```

- **One ticket at a time (v1).** Finish and merge one before starting the next — no worktree machinery, no cross-ticket conflicts. The loop is written so a **bounded worktree pool** can drop in later (§8) without touching the per-ticket flow.
- **Continuous.** After each merge it re-reads the board (new tickets it filed, or ones you added mid-run, are picked up) and keeps going.
- **Owns state at the top level.** The autopilot loop owns the run ledger (`.forge/autopilot/run.json`: queue, done, escalated, skipped) and the stop condition; each ticket's `deliver` owns its own branch/ledger/gates as today.

## 4. The auto-merge bar (replaces the human PR review)

**Run-start preflight — in-session merge authorization (required before the first delivery).** Before autopilot spawns its *first* delivery subagent, the orchestrator must confirm it holds an **in-session user authorization to auto-merge** — a live user message naming the merge authorization, e.g. the answer to a run-start "Merge policy" prompt. This is a distinct requirement from `features.autopilotAutoMerge: true` and the `gh pr merge` allowlist: **config + allowlist alone do not clear the harness auto-mode classifier**, and a grant written only to `run.json` or spoken in agent narration does **not** count. If that authorization is absent, autopilot must **surface it and degrade at run start** — either prompt for it (obtaining the live grant) or run in a PR-only / *awaiting-human* mode where each ticket stops at its open green PR — **rather than burning a delivery that then stalls at the first merge**. The preflight exists precisely because that stall is the observed failure mode: without an up-front grant the loop delivers a whole ticket and then wedges at merge.

A ticket merges **only when every one of these is green** — any red routes to a fix wave, and a second failure of the same gate escalates (never a merge on red):

0. **In-session merge authorization is present** (the run-start preflight above). `features.autopilotAutoMerge: true` + the `gh pr merge` allowlist are necessary but not sufficient — the live in-session grant is what actually clears the harness classifier; without it, the merge cannot proceed and the ticket is parked *awaiting-human*, not merged.
1. `ship` completed: situation gate · conventions lint · rebase + full `verify` green.
2. All mechanical gates pass: `plandrift`, `testintent`, `depguard`, `acgate` (every AC checked).
3. Full-branch `reviewer` **and** `security` subagents return `verdict: pass` with **zero critical/high** findings. A critical finding is always an escalation, never an auto-merge.
4. CI on the PR is green (the PR is opened with `Closes #n` and the honest verification statement, exactly as `deliver` does; autopilot then waits for checks and merges — it does not merge before CI).
5. Merge is **squash to main**; the branch is deleted; `Closes #n` closes the issue.

If the repo's `features` disables auto-merge (an opt-out flag `features.autopilotAutoMerge: false`), autopilot stops at the open PR for that ticket and records it as *awaiting-human* instead of merging — the loop continues with other tickets. This keeps the safe-by-default door for consumers who adopt autopilot but not its merge policy.

## 5. Selection — what "next actionable" means

Priority-ordered, then FIFO within a priority:

1. `inReview` / `inProgress` left mid-flight by a previous run → **resume first** (deliver's resume protocol).
2. `ready` (triaged) tickets, `p0` → `p1` → `p2`.
3. `backlog` tickets → **auto-triaged** first (front door), then delivered.
4. Never: `blocked` (has a pending decision), `done`, `wontDo`, or anything with an unresolved escalation.

`--area <a>` restricts selection to one area; `--limit N` stops after N merges; `--dry-run` prints the plan (selection + classification per ticket) and makes no changes.

## 6. The human gates — the only pauses

Autopilot halts **only** for these, via `escalate.mjs` (blocked + decision comment + pending file), then continues with the *next* ticket (one escalation does not stop the whole run — it parks that ticket and moves on):

- **Product broken, no safe fix** — verify/CI red after a fix wave, or a change that breaks unrelated behaviour and the fix is beyond the plan's blast radius.
- **Design deviation needs a decision** — the work can't be done as designed; the choice isn't the engine's to make (spec/ADR ambiguity, a product-behaviour fork).
- **Under-specified ticket** — planner/triage returns `verdict: fail`; the ask or acceptance is unclear. Escalate, don't guess.
- **Critical security finding.**
- **Denylist-blocked action genuinely needed · reviewer↔implementer deadlock across re-spawns · the same gate failing twice.** (deliver's existing §7 triggers.)

Everything else — routine role choices, UI variant selection, which regression test, a new follow-up ticket — autopilot decides and proceeds.

## 7. It can open new work (tracking as it goes)

When delivery surfaces a need, autopilot files it rather than dropping it — `board/create.mjs`, linked to the driving ticket, trail-noted:

- a **bug** it found but that's out of the current ticket's scope,
- a **spike** when a ticket turns out to need investigation before it can be built (deliver already does this for spike-kind; autopilot also does it *reactively*),
- a **follow-up item** for deferred work.

Filed tickets enter the queue and are picked up in a later iteration by §5 — so the board can *grow* during a run and still converge, as long as new work trends down.

## 8. Stop conditions & safety rails

- **Natural stop:** no actionable ticket remains (all `done`/`wontDo`/`blocked`) → print the run report (merged / escalated / skipped / newly-filed) and exit.
- **`--limit N`:** stop after N merges.
- **Kill switch:** honours the per-repo **situation gate** (`gates/situationgate.mjs`) — while the repo is in an **open incident** or **security-response** (security hold) situation the gate pauses shipping, so autopilot spawns no new delivery until it clears. Clearing the situation is always a human action (close the incident / lift the security hold), never automated.
- **Interrupt:** Ctrl-C between tickets is clean (the run ledger is the resume point); mid-ticket, deliver's own resume protocol recovers.
- **Loop backstop:** a max-iterations guard (default = board size, anchored at run start, × 4 — #488) prevents a pathological file-a-ticket-per-iteration runaway; hitting it escalates rather than looping forever. The escalation reason distinguishes "no progress is being made" from "this run has simply been long" (#488 AC.5) so a healthy long clear is never misreported as a runaway.

## 9. Future: parallel (deferred, designed-for)

v1 is sequential by owner choice. The loop is factored so a **bounded worktree pool** (N tickets in flight, each in its own `git worktree`, chosen for non-overlapping blast radius via the scoper) can replace the single-ticket step without changing the merge bar, the escalation model, or the run ledger. Not built in v1.

## 10. Acceptance criteria

- **AC-1 (loop):** `/forge:autopilot` selects the next actionable ticket per §5, delivers it, and moves to the next — continuously until none remain, then prints a run report. Resumes a mid-flight ticket first.
- **AC-2 (auto-triage front door):** a `backlog` ticket is triaged before delivery; one that stays under-specified is escalated and skipped, not guessed.
- **AC-3 (auto-merge bar):** a ticket merges to main only when §4 items 0–5 are all green; any red routes to a fix wave; a repeated failure escalates; **nothing merges on red**. `features.autopilotAutoMerge: false` stops at the open PR instead.
- **AC-3a (in-session merge authorization):** unattended auto-merge additionally requires an **explicit in-session user authorization** obtained at the **run-start preflight** (§4). `features.autopilotAutoMerge: true` + the `gh pr merge` allowlist alone do **not** clear the harness auto-mode classifier, and a grant recorded only in `run.json` or agent narration is insufficient; without the live grant the loop stalls at the first merge, so the preflight surfaces it up front and degrades to PR-only/awaiting-human rather than burning a delivery.
- **AC-4 (human gates only):** the run halts (`escalate.mjs`) only for the §6 conditions; each escalation parks one ticket and the loop continues with the next.
- **AC-5 (files new work):** a need surfaced mid-delivery becomes a linked, trail-noted ticket via `board/create.mjs` and re-enters the queue.
- **AC-6 (safety):** honours the global pause / situation gate; the loop backstop prevents runaway; the run ledger makes an interrupted run resumable.
- **AC-7 (trail):** every lifecycle moment is trail-commented on the driving ticket (started · delivered · merged · escalated · filed), and the run is summarised on the delivery-log issue.

## 11. Cost & context on long runs (#137)

A long run must not blow the orchestrator's context window or let cost grow with run length. The design bounds both:

- **Delegate, don't inline — mandatory, not aspirational (#156).** The main loop's per-ticket step **is** to spawn a delivery subagent (Task tool) that owns the whole ticket in its own context and returns a compact terminal report. The main loop never runs `forge:deliver` inline, edits files, or merges in its own context — doing so fills the main window (forcing mid-run compaction) and surfaces every permission prompt in the orchestrator. The heavy tokens live and die inside the per-ticket subagent; the outer loop keeps only `run.json` + git + a one-line outcome.
- **Continuous requires pre-authorized permissions (#156).** Auto-merge/push/close are outward commands; unless they're in the `.claude/settings.local.json` allowlist, each raises a permission prompt and the run stalls. `scripts/autopilot/perms.mjs` prints the exact block; it's opt-in (forge never writes merge authority for you).
- **The outer loop holds only file-backed state.** Between tickets the autopilot loop retains just `.forge/autopilot/run.json` + git state + a one-line outcome per ticket. Its growth is **~O(1) per ticket**, not O(work), so a 5-ticket run and a 50-ticket run have about the same loop overhead.
- **Checkpoint + reset is free.** Every ticket is checkpointed to `run.json`; the resume protocol (§ resume) reconstructs from disk, so the orchestrator can be compacted or fully restarted between tickets at near-zero reload cost. (This session is the proof: it compacted at 67% and continued because state lived on the board + files, not the transcript.) **One thing is *not* file-backed and cannot be:** the in-session merge authorization (§4). A **fully restarted session is a new session and must re-run the run-start preflight** to obtain a fresh live grant; the authorization is deliberately *not* persisted to `run.json` (a stored value would not clear the harness classifier anyway). But a restart is not the only trigger: the harness auto-mode classifier evaluates the grant **per merge attempt**, not once per session — a later merge attempt in the *same*, uncompacted session can still be denied even after an earlier merge in that session succeeded (observed directly, repeatedly, in production runs; #397). There is today no code-level way to predict this in advance (tracked separately, #398). So re-obtaining the grant is **not guaranteed to be a single up-front cost** — it can recur mid-run — and when it does, the loop's only recourse is the same pattern as the run-start preflight: stop, surface the denial to the user, and ask for a fresh explicit grant before retrying.
- **Cheap where it can be.** Selection (`select.mjs`) and the ledger are plain scripts — **zero model cost**. Model tiering already applies inside delivery (haiku for lookup, sonnet default, opus only for second-opinion).
- **What's intrinsic vs. overhead.** Per-ticket *delivery* cost is intrinsic — it's the actual engineering and can't be optimised away. What autopilot keeps ~constant is the *loop overhead*. (The host OS — Windows included — has no bearing on tokens, context, or cost; only PATH/shell handling is platform-specific.)
