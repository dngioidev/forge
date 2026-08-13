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
RUN START: evaluateRateBudget(gh) (§ Rate-budget preflight)  ← ALSO required, before the first spawn
  └─ pause=true (low budget) ───────────────▶ surface the reset window, pause the run (not an escalation)
  ▼
RE-READ run.json (§ Re-read, don't remember)  ← top of EVERY iteration, fresh session or after compaction
  ▼
ITERATION GUARD: nextIteration(run, boardSize) (§ Loop backstop)  ← call FIRST, every iteration
  └─ stop=true (runaway) ──────────────────▶ HALT + escalate (do NOT deliver another ticket)
  ▼
every budgetCheckDue(run.iterations) iterations: evaluateRateBudget(gh) again (§ Rate-budget preflight)
  └─ pause=true ────────────────────────────▶ same pause as run start
  ▼
select next actionable ticket (§ selection) → { ticket, action }
  ├─ none left ────────────────────────────▶ STOP + run report
  ▼
SPAWN a subagent keyed on `action` (Task tool) ─────────────────┐   § Orchestration
  action=deliver/resume → SPAWN a delivery subagent: deliver #N  │   runs in its OWN,
    end-to-end (plan → execute → ship → open PR → WATCH CI to    │   DISCARDABLE context —
    green in-run (`gh pr checks <pr> --watch`) → auto-merge on   │   never the main window
    green), return {issue, outcome, pr, notes}                   │
  action=triage → SPAWN a triage subagent: forge:triage in its   │
    own context, return {issue, verdict, outcome}                │
  action=shape → SPAWN a shape subagent: forge:shape in its own  │
    context (gather product context → route to ideate/           │
    brainstorm/spike/design → ground gate → promote or escalate),│
    return {verdict, outcome, issue, followUp, sources}          │
  ▼                                                              │
main loop reads ONLY that terminal report ◀─────────────────────┘
  │  WATCHDOG: resolveReturnedTicket(report) (§ Return-then-resume watchdog)  ← run on EVERY delivery report
  ├─ action=merge ───────────────────────▶ funnel the PR through the merge bar (autopilot_merge/runMerge)
  ├─ action=escalate ────────────────────▶ surface visibly (record awaiting-human / escalate) — never a silent park
  ├─ action=continue: outcome=escalated / awaiting-human ─▶ record + park, continue with next ticket
  ├─ action=continue: outcome=merged ────▶ record to run.json · trail --phase merged
  ├─ shape outcome=ready ─────────────────▶ record {outcome:'ready', stage:'shape'} · re-enters the queue as `deliver`
  ├─ triage verdict=fail ─────────────────▶ escalate + skip (§ Auto-triage front door)
  └─ subagent filed new work ────────────▶ already on the board — re-enters the queue
  ▼
loop  (main context unchanged — ~O(1) per ticket — RE-READ run.json again at the top)
```

## Orchestration — the main loop never runs a skill inline (#466)

**The main loop never runs a skill inline. Every action `select.mjs` returns is executed in a spawned subagent.** The loop's own tools are only: `select.mjs`, the ledger, `watchdog.mjs`, the merge bar, trail/escalation surfacing, and the Task tool. This generalizes the earlier delivery-only rule (#156): `select.mjs` `actionFor()` returns **four spawnable** actions — `resume`/`deliver`/`triage`/`shape` — and every one of them gets a spawn, not just delivery. (`actionFor()` can also return `'escalate'` — an unshaped `backlog` ticket with no `--shape` — but that names a decision already parked for the human, not delegable work; it is handled directly by the loop's existing escalation surfacing, § Selection / § The human gates, exactly as before this ticket.) Before this, `shape` had no spawn rule at all and ran inline in the main window — the most context-hungry stage forge has (`docs/product/**`, linked spec/ADR, code-graph payloads, then a nested `ideate`/`brainstorm`/`spike`/`design` run) — which is exactly what drove a long `--shape` run to 100% context.

| action | subagent | brief runs | terminal report |
| --- | --- | --- | --- |
| `shape` | **shape subagent** | `forge:shape` | `{verdict, outcome, issue, followUp, sources}` |
| `triage` | **triage subagent** | `forge:triage` | `{issue, verdict, outcome}` |
| `deliver` / `resume` | **delivery subagent** (unchanged) | `forge:deliver` | `{issue, outcome, pr, notes}` |

Per ticket, the main loop does exactly three things: **spawn**, **record**, **continue**.

1. **Spawn a subagent for whatever action was selected** with the Task tool — `subagent_type: general-purpose, model: sonnet` (or a dedicated agent if the roster has one), for **every** action, not delivery alone. Pin the model explicitly; an unpinned `general-purpose` spawn silently inherits whatever model the orchestrating session happens to be on, so a run started on a heavier model burns work at that model's rates for no reason (#379) — every other forge role agent (planner/implementer/reviewer/security/test-architect/etc.) already carries an explicit model tier for the same reason (#101); every spawned action gets the same discipline.

   - **`deliver`/`resume` → delivery subagent.** The brief is self-contained so the subagent needs no main-loop context: the ticket ref + body, the merge bar (§ auto-merge), the escalation triggers (§ human gates), and this instruction — *do the whole ticket in your own context (branch, plan, implement, test, gates, ship, open the PR, **watch CI to green in this same run with `gh pr checks <pr> --watch`**, auto-merge on green, post-merge ritual); file follow-ups directly with `board/create.mjs`; escalate with `escalate.mjs`; then return a compact terminal report and nothing else.*
   - **`triage` → triage subagent.** Self-contained brief: the ticket ref + body, run `forge:triage` in its own context (classify, confirm the ask, set fields), escalate (`verdict: fail`) rather than guessing, then return `{issue, verdict, outcome}` and nothing else.
   - **`shape` → shape subagent** — spawned the same way as every other action (`subagent_type: general-purpose, model: sonnet`, pinned per #379/#101). Self-contained brief: the ticket ref + body, run `forge:shape` in its own context (gather `docs/product/**` + linked spec/ADR + ticket body + code graph, classify why it isn't ready, route to `ideate`/`brainstorm`/`spike`/`design`, ground gate, promote Backlog→Ready or escalate), then return only the terminal JSON `{verdict, outcome, issue, followUp, sources}` (§ forge:shape's own report contract) — never the gathered context itself. **No fused shape-then-deliver route:** the delivery brief above does NOT carry a `shape-first` clause — one action, one spawn, one discardable context. A shaped ticket becomes `ready`, re-enters the queue, and is picked up by a **later** iteration as its own `deliver` spawn — never chained into the same subagent invocation that shaped it, so the shape context (product docs, code graph, a drafted spec) never rides along as dead weight through implementation.

   **Forbidden — the return-then-resume stall:** the brief must NOT tell the subagent to open the PR and then return awaiting an external/background completion notification (e.g. "await the CI watcher's notification"). The subagent's context is discarded on return and **nothing re-invokes it when CI goes green** — that stalls the ticket until a manual resume. The background CI monitor notifies the **main loop**, not a returned subagent. The subagent must therefore watch CI to conclusion **in-run itself** (`gh pr checks <pr> --watch`) and merge within the **same invocation** — never return on the assumption it will be re-spawned on green.

   **Denylist safe-alternatives — carried in every spawned brief, not delivery alone (#466).** Every subagent brief — delivery, triage, **and shape** — teaches the safe alternative up front so it doesn't reflexively reach for a denylisted destructive command, hit the block, and burn a turn retrying. Triage and shape don't do destructive git ops themselves, but they do write ticket-derived text (comments, escalation reasons, sources manifests) that can trip the **literal-string caveat** below just as easily as a delivery subagent's PR body can, so both get the same caveat, not only delivery's:

   | Blocked class | Safe alternative |
   | --- | --- |
   | recursive `rm` outside build/temp (`recursive-delete`) | targeted `rm <paths>` — name the paths, don't recurse over the tree |
   | `git reset --hard` (`hard-reset`) | `git revert` / `git restore <paths>` |
   | force-push (`force-push`) | `--force-with-lease`, and only when explicitly requested |
   | `git clean -f` (`git-clean-force`) | targeted `rm <paths>` |

   **On a denylist block, escalate — do not retry the blocked command** (`escalate.mjs`); a genuinely-required destructive action is a human decision, not a retry.

   **Literal-string caveat — applies to every spawned brief.** The denylist matches these command strings even inside quoted/heredoc bodies, so a PR body, an issue/trail comment, an escalation reason, or a sources-manifest entry that merely *mentions* a blocked command trips it when passed inline — this applies equally to a delivery subagent's PR body, a triage subagent's `board/*.mjs --body`, and a shape subagent's `escalate.mjs --reason`/`--context`. Write such content to a file and pass `--body-file` (or `git commit -F <file>`), never inline on a shell command line.
2. **Read only the terminal report** and **run every returned report through the watchdog** (`watchdog.mjs` `resolveReturnedTicket`, § Return-then-resume watchdog) before recording — it is a harmless no-op pass-through (`action: continue`) for any outcome other than the `awaiting-merge` sentinel, and only `deliver`/`resume` reports can ever carry that outcome, so running it on every report (not delivery alone) costs nothing and keeps one code path for "record what a subagent returned." For `deliver`/`resume`: `{issue, outcome: merged|escalated|awaiting-human|skipped, pr, notes}`. A subagent that returns `awaiting-merge` (opened a green PR, then returned awaiting a re-invocation) must NOT be recorded as a silent terminal state — the watchdog turns that into a `merge` (funnel to the bar) or an `escalate` (surface awaiting-human / escalate); every already-resolved outcome passes through as `continue`. For `shape`: `{verdict, outcome: ready|escalated, issue, followUp, sources}` — `outcome: ready` records via `ledger.mjs` `applyOutcome(run, {issue, outcome:'ready', stage:'shape'})` (the ticket re-enters the queue as `deliver` on a later iteration; § Run ledger & report), `outcome: escalated` records + parks like any other escalation. For `triage`: `{issue, verdict, outcome}` — `verdict: fail` escalates-and-skips (§ Auto-triage front door), a pass proceeds to `deliver` on the next iteration. Every recorded outcome carries the producing `stage` (`shape`/`triage`/`deliver`) so the run report can distinguish them. The main loop writes the resolved outcome to `run.json`, trails the ticket, and never re-reads the subagent's work.
3. **Continue** to the next ticket. Because every spawned context is discarded on return, the main window is unchanged between tickets — a 5-ticket and a 50-ticket run cost the same orchestration overhead, and the run never compacts mid-loop.

A subagent that can't finish (deadlock, a gate failing twice, an ungrounded shape) returns `outcome: escalated` with the reason; the loop parks that one ticket and moves on. Never fall back to running any stage inline — a missing/broken subagent is itself an escalation.

## Return-then-resume watchdog — awaiting-merge is never silently parked (#319)

The forbidden pattern above (§ Orchestration) is a *briefing* rule; this is its **mechanical backstop**. Even a correctly-briefed subagent can return `awaiting-merge` — it opened a PR, watched CI green, then returned at the open green PR awaiting a re-invocation that never comes. Its context is discarded on return and nothing re-drives it, so without detection the ticket parks at a green PR **forever** (and a subagent that never moved the board status may never be re-selected). So the loop runs **every** returned report through `watchdog.mjs` `resolveReturnedTicket({ outcome, pr, ciGreen, mergeMode })` — a pure decision that maps the report to one action:

- **`merge`** — `awaiting-merge` on a **green** PR with **auto-merge** authority (the run's recorded `mergeMode`): funnel the PR through the tested bar (`autopilot_merge` / `runMerge`), which re-checks CI itself. The stall becomes a merge.
- **`escalate`** — `awaiting-merge` that can't merge: a green PR under **pr-only** (no in-session grant) is recorded **awaiting-human visibly**; a return with **no PR** or a **not-yet-green** PR (the subagent skipped its in-run `--watch`) is **escalated**. Either way it is *surfaced*, never silently parked.
- **`continue`** — every already-resolved outcome (`merged`/`escalated`/`awaiting-human`/`skipped`): record the reported outcome and move on.

**The invariant:** an `awaiting-merge` report is NEVER left as a silent terminal state — it either merges or is surfaced. Selection is resume-safe by the same token: a ticket returned at an open green PR is still at a resume-tier board status (`inReview`/`inProgress`), so `selectNext` re-picks it as `resume` on the next iteration (and even a ticket left at `ready`/`backlog` is re-delivered, never dropped) — the watchdog and the resume path are belt-and-suspenders against the same stall.

## Permissions — required for a continuous run

Autopilot is autonomous, so its **outward commands must be pre-authorized** — otherwise `gh pr merge`, `git push`, `gh issue close`, etc. each raise a permission prompt and the loop stalls (it is *not* continuous). Pre-authorization works differently per host — follow the one you're running under, not the other:

- **Claude Code:** run this once. It prints the exact allowlist block plus which local settings file to merge it into and why — read its own output, it's the source of truth (opt-in; forge never writes the file for you; review the block before adding it, since it grants unattended auto-merge/push authority):

  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/autopilot/perms.mjs"
  ```

  Approving the first prompt as *"always allow"* achieves the same thing incrementally. Without it, autopilot still works but pauses at each outward command for your approval.
- **Antigravity (agy):** nothing to run or merge — pre-authorization is hook-mediated, not a settings file. The bundled PreToolUse hook checks every outward command against the same allowlist source Claude's script reads and auto-answers `allow` for a known-good command, `ask` for anything else, `deny` on a denylist hit. See `docs/guides/cross-gai.md` ("Permissions: the allow / ask / deny default") for the exact mechanics and honest limits (the hook's own timeout fails open; the classifier caveat just below has no agy analogue — see why there).

**On Claude Code, the allowlist alone does NOT authorize unattended merge — this whole caveat, and the preflight after it, is Claude-only.** Unattended auto-merge itself is Claude-only by policy (ADR-0007): an agy-hosted run never calls `autopilot_merge` and always stops at the open green PR (§ Auto-merge item 0) regardless of any allowlist, so there is nothing here for an agy host to clear. On Claude, the local allowlist (and `features.autopilotAutoMerge: true`) are **necessary but not sufficient**: they do **not** clear Claude's harness **auto-mode classifier**, which blocks a subagent from unattended-merging its own PR unless the **user names the merge authorization in a genuine in-session message** (a live user turn — e.g. answering the run-start "Merge policy" prompt below). A grant recorded only in `run.json` or in agent narration does **not** count. With the allowlist but no in-session authorization, the loop still **stalls at the first merge** — so confirm the in-session grant at run start (§ Merge-authorization preflight), not just the allowlist.

## Merge-authorization preflight — REQUIRED before the first delivery (Claude Code only)

**Claude-only:** unattended auto-merge is Claude-only by policy (ADR-0007), so an agy-hosted run never reaches this gate — it always stops at the open green PR (§ Auto-merge item 0). The rest of this section describes the Claude harness's own gate.

Autopilot's loop is orchestrator prose, so this preflight is a **required run-start step**, not a script: **before spawning the first delivery subagent**, the orchestrator must confirm it holds an **in-session user authorization to auto-merge**.

- **Why up front, not mid-run.** Config + allowlist do not clear Claude's harness auto-mode classifier (§ Permissions). If the grant is missing, every ticket delivers fully and then **wedges at its first merge** — you burn a whole delivery only to stall. This is the observed failure mode this preflight prevents.
- **What counts as authorization.** A **live user message naming the merge authorization** — e.g. the user answering a run-start **"Merge policy"** question with an explicit grant. *Not* counted: `features.autopilotAutoMerge: true`, the `gh pr merge` allowlist, a value in `run.json`, or anything the agent narrates to itself.
- **If it is present** → proceed into the loop; delivery subagents may unattended-merge on a green bar.
- **If it is absent** → do **not** spawn a delivery that will stall. **Surface it and degrade at run start:** either ask the "Merge policy" question now and obtain the live grant, or run **PR-only / awaiting-human** — each ticket stops at its open green PR and is recorded *awaiting-human* (as with `features.autopilotAutoMerge: false`), and the loop continues. Escalate rather than guess a merge authorization.

**The preflight is enforced in code, not prose alone (#316).** `scripts/autopilot/preflight.mjs` `mergeAuthPreflight({ authorized, config })` is the pure decision: it returns the effective merge **mode** — `auto-merge` **only** when an explicit in-session grant is held **and** config doesn't disable it; otherwise `pr-only` with the exact human-readable notice to surface. `startRun` records the chosen `mergeMode` + `mergeReason` into `run.json` at run start (auditable, resume-safe), and `runMerge` gates on it — **`pr-only` carries `autoMergeEnabled:false` semantics**, so the merge path parks the ticket *awaiting-human* rather than attempting a merge that would stall. The orchestrator passes the recorded mode to the `autopilot_merge` tool. The `authorized` flag is `true` **only** for a genuine live user grant — a value in `run.json`, config, the allowlist, or agent narration passes `false`. (On resume, the preflight re-runs: the in-session grant is not file-backed, so a restarted session must re-obtain it — § Resume protocol.)

## Rate-budget preflight (#407) — pause before the shared GraphQL bucket hits zero

`rateBudget()` (`lib/exec.mjs`, #360 AC.4) was shipped fully implemented but never called — the loop only reacted to a 403 *after* it happened. `scripts/autopilot/ratebudget.mjs` wires it in at two points, both **required**, mirroring the merge-auth preflight's shape:

- **Run start, before spawning the first delivery** (alongside § Merge-authorization preflight): call `evaluateRateBudget(gh)`. `pause:true` → surface the reset window (`decision.reason`) and pause the run at this safe boundary — schedule/wait for continuation exactly like § Session-window self-pause, **not** an escalation (nothing is broken; the shared account-wide 5,000 pt/hr bucket is just low). `pause:false` → proceed.
- **Every `budgetCheckDue(run.iterations)` iterations thereafter** (alongside § Loop backstop's `nextIteration` call, same iteration-top boundary): re-run `evaluateRateBudget(gh)`. Default cadence is every 10 iterations (`DEFAULT_CHECK_EVERY_N`) — frequent enough to catch a long run burning the bucket, cheap enough (one REST call that itself does not count against any bucket) not to matter.
- **Degrade, never hard-block, on a FAILED check.** `evaluateRateBudget` returns `{pause:false, ok:false}` when the check itself couldn't complete (network down, gh broken) — that is explicitly NOT "low," and the run continues, falling back to today's reactive per-call retry (`makeGh`'s own backoff already covers an individual 403). Only a **completed** check reporting `low:true` pauses.
- **Pure decision function:** `ratebudget.mjs` `shouldPauseForBudget(budget)` — the boundary math only (no IO), mirroring `mergeAuthPreflight`/`shouldPause`; hermetically tested against a mocked `rateBudget` result — no real API, no real sleep. `evaluateRateBudget(gh, {lowWater})` is the IO wrapper the orchestrator actually calls; `budgetCheckDue(iterations, everyN)` is the periodic-cadence gate.

## Selection — "next actionable"

Priority-ordered, FIFO within a priority. Read the board fresh each iteration (tickets you filed, or the owner added mid-run, get picked up):

1. **Resume first** — an `inProgress`/`inReview` ticket left mid-flight by an earlier run (deliver's resume protocol continues it).
2. `ready` (triaged), `p0` → `p1` → `p2`.
3. `backlog` — **auto-triaged** first (the front door), then delivered.
4. **Never selected:** `blocked` (has a pending decision), `done`, `wontDo`, or any ticket with an unresolved escalation.

Flags: `--limit N` stop after N merges · `--area <a>` restrict to one area · `--dry-run` print the selection + per-ticket classification and change nothing · `--shape` **crazy mode** (below).

A `backlog` ticket routes on its **readiness** (`readiness.mjs` → does it carry acceptance criteria): shaped → the triage front door; **not shaped** → `shape` under `--shape`, else escalate-and-skip (the default).

## Crazy mode — shaping the backlog (`--shape`, spec: forge-autopilot-crazy-mode)

Off by default. With `--shape`, a `backlog` ticket that isn't shaped (no acceptance criteria) is sent to a **spawned shape subagent** instead of being escalated (§ Orchestration — `action=shape` gets the same spawn discipline as every other action, never an inline call): it gathers the product context, classifies why it isn't ready, runs the right front-of-pipeline skill (`ideate`/`brainstorm`/`spike`/`design`), and — **grounded-only** — either promotes it Backlog→Ready (recorded `outcome: ready, stage: shape` — the ticket re-enters the queue and is delivered by a **later** `deliver` spawn, never the same subagent invocation) or **escalates** the exact open question (writing the escalation via `escalate.mjs` **before** it returns — its context is discarded on return, so an unwritten reason is lost) and skips. The **ground gate** (`gates/groundgate.mjs`) enforces that every shaped product decision cites a real source, so the engine never invents product direction. Without `--shape`, this whole stage is off and an unshaped ticket escalates as before.

## Auto-triage front door

A `backlog` ticket that is already shaped is sent to a **spawned triage subagent** (§ Orchestration) that runs `forge:triage` in its own context to become deliverable *before* `deliver` sees it. If it still can't be specified (planner or triage returns `verdict: fail` — the ask or acceptance is unclear), **escalate it and skip** — the loop moves to the next ticket. Autopilot never guesses a product decision to keep moving.

## Auto-merge — the bar that replaces human review

A ticket merges **only when every one of these is green**. Any red routes to a fix wave (a fresh `implementer` spawn inside deliver's flow); the *same* gate failing twice is an escalation. **Nothing merges on red — ever.**

0. **In-session merge authorization is present** (§ Merge-authorization preflight; **Claude-only** — an agy-hosted run never calls `autopilot_merge` and always stops at the open green PR, so this item is moot there regardless of any allowlist). On Claude, an explicit in-session user grant is what actually clears Claude's harness auto-mode classifier — `features.autopilotAutoMerge: true` + the `gh pr merge` allowlist are necessary but **not sufficient**, and a grant in `run.json`/narration does not count. Absent it, the ticket is parked *awaiting-human* at its open green PR, never merged.
1. `forge:ship` completed clean: situation gate · conventions lint · rebase + full `verify` green.
2. All mechanical gates pass: `plandrift` · `testintent` · `depguard` · `acgate` (every AC id in a passing test).
3. Full-branch `reviewer` **and** `security` subagents return `verdict: pass` with **zero critical/high** findings. A critical is always an escalation, never a merge.
4. **CI on the PR is green.** Open the PR as deliver does (`Closes #n`, AC checklist, honest verification), then **watch CI to conclusion in the same run** with `gh pr checks <pr> --watch` — never merge before CI, and never return awaiting an external notification (the delivery subagent isn't re-invoked on green — § Orchestration). At the **loop** level the `forge-ci` monitor also pushes each CI transition (`CI pass` / `CI fail`) to the running orchestrator (§ Monitor notifications), so the loop tracks CI status without inline polling — but that push is *not* what merges the ticket in flight; the subagent's own in-run `--watch` is the authoritative green.

   **A CI red is not automatically a real gate failure (#408).** GitHub Actions itself can go down mid-run — `Service Unavailable` resolving an action's download-catalog metadata, or a job stuck `queued` indefinitely — a signature distinct from a real regression and from #360's rate limiting (`isRateLimited`). Before treating a red/pending result as "the same gate failing twice," `merge.mjs`'s `runMerge` runs it through `classifyCiFailure` (`isPlatformOutage` in `exec.mjs`): a genuine outage gets the empirically-proven recovery — `forceNewSha` forces a fresh commit SHA via rebase + `--force-with-lease` repush (re-running the *same* SHA did not reliably help) — bounded to `maxOutageAttempts` (2) via `--outage-attempt N` threaded across separate `runMerge` invocations (a fresh SHA needs a fresh CI run to `--watch`, so the bound spans calls, not a busy-loop inside one). Only once recovery is exhausted does it fall through to the ordinary "blocked on ci" path, and even then the `reason` says **"GitHub Actions platform outage, not your change"** — post that verbatim distinction in the `--phase gate-fail` trail comment (§ below), not a claim the change is broken. A real failure (no outage signature in the log) is never masked — it routes straight to the ordinary fix-wave/escalation path unchanged.
5. **Squash-merge to main**, delete the branch, `Closes #n` closes the issue.

**The sanctioned merge path is the bar, not a raw `gh pr merge`.** The live merge is executed **only** through the tested bar — the `autopilot_merge` MCP tool (forge-core), which calls `merge.mjs` `runMerge(ctx, {issue, pr, signals, critical})`: it re-checks CI, evaluates `evaluateMergeBar` over `{ship,gates,reviewer,security,ci}`, and squash-merges **only** when every signal is green (a missing/red signal or a critical never merges — fail-closed). A **raw `gh pr merge` on an autopilot ticket is NOT the sanctioned path** — it bypasses the tested bar and the "nothing merges on red" invariant. The delivery subagent holds the ship/gates/reviewer/security verdicts and passes them as `signals`; the tool computes the bar and performs the merge, so the merge goes through the bar **by construction**. (`autopilot_merge` is Claude-only by policy per ADR-0007; hosts that must not auto-merge never call it, and `features.autopilotAutoMerge:false` still parks at the PR.)

**Opt-out:** if `features.autopilotAutoMerge` is `false`, autopilot stops at the open PR for that ticket, records it as *awaiting-human*, and continues the loop with other tickets — the safe-by-default door for consumers who adopt autopilot but not its merge policy.

## The human gates — the only pauses (spec §6)

Halt via `escalate.mjs` (ticket → blocked + decision comment + pending file). An escalation **parks one ticket** and the loop continues with the next — a single blocked ticket does not stop the whole run. When the human answers, the `forge-decisions` monitor pushes a `Decision <id> (#<issue>) resolved: …` line to the running loop (§ Monitor notifications): the parked ticket unblocks and re-enters the selection queue on the next iteration, with no polling of `.forge/decisions/`.

- **Product broken, no safe fix** — verify/CI red after a fix wave, or a change breaking unrelated behaviour with a fix beyond the plan's blast radius.
- **Design deviation needs a decision** — the work can't be done as designed and the choice isn't the engine's (spec/ADR ambiguity, a product-behaviour fork).
- **Under-specified ticket** — planner/triage `verdict: fail`.
- **Critical security finding.**
- **deliver's §7 triggers** — denylist-blocked action genuinely needed · reviewer↔implementer deadlock across re-spawns · the same gate failing twice.

## Monitor notifications — CI and decisions arrive as pushes, not inline polls

Two background **monitors** (`plugin/monitors/monitors.json`, both registered `when: on-skill-invoke:autopilot`) run for the life of an autopilot session and push a stdout line to the **running main loop** as a notification the moment something changes — so the *loop* reacts to events instead of polling for them on a timer. They sit at the **orchestrator layer** and are orthogonal to (never a replacement for) the delivery subagent's own in-run `gh pr checks <pr> --watch` (§ Orchestration).

- **`forge-ci`** (`plugin/scripts/monitors/ci-watch.mjs`) polls the current branch's PR checks and, **only when the rollup transitions**, emits exactly one line. The real shape is `CI <state> on PR #<n> (<branch>)` where `<state>` is one of:
  - `pass` — every check is `SUCCESS` / `NEUTRAL` / `SKIPPED`
  - `fail` — any check is `FAILURE` / `ERROR` / `CANCELLED` / `TIMED_OUT` / `ACTION_REQUIRED` / `STARTUP_FAILURE`
  - `pending` — otherwise (fail-closed on unknowns)

  The **merge bar's CI-green requirement surfaces to the loop as the `CI pass` line** — the loop learns of a CI transition from the push instead of inline-polling `gh`, and a `CI fail` line tells it the watched PR went red. *Reacting* to that transition still belongs to the delivery layer, not the loop: the merge bar (`merge.mjs`) and any fix wave execute **inside the delivery subagent** (§ Orchestration, and the disclaimer in § Auto-merge item 4), whose own in-run `--watch` is the authoritative green for the ticket in flight. The `forge-ci` push is strictly the poll-free way for the **loop** to observe the same transitions (including on a parked or other PR). It stays silent until a PR exists for the branch and on any unchanged rollup. A *persistent* poll failure (auth/network) no longer silences it forever (#318): after a few consecutive failed polls it surfaces one `forge-ci error: <reason> (<n> consecutive polls)` line (throttled, not per-poll), then a good poll resets it — a single transient failure stays quiet.

  A fourth line is possible (#408): `CI outage-suspected on PR #<n> (<branch>) — stuck queued Xm with no progress (not a real failure; recovery: rebase + repush)`. This fires when every reported check has sat in `QUEUED` status past a generous threshold with zero progress — GitHub's own signature of an Actions platform outage, not a code failure — and is reported **at most once per stuck episode** (it resets the moment the rollup stops being all-queued), never a line per 20s poll. Same rule as the CI-green disclaimer above: this is the poll-free way the **loop** observes the signature; the recovery itself (§ Auto-merge item 4) still runs inside the delivery subagent's own merge-bar check.

- **`forge-decisions`** (`plugin/scripts/monitors/decisions-watch.mjs`) polls `.forge/decisions/` and, the moment an escalation the human answered flips to `status: resolved`, emits one line: `Decision <id> (#<issue>) resolved: <first line of the answer>`. A **resolved-decision line unblocks the escalated ticket** — the parked (blocked) ticket named by `#<issue>` re-enters the selection queue on the next iteration (where it runs the full gate pipeline again), so the loop surfaces the reply without polling `.forge/decisions/` itself. A *persistent* fs error (not a missing dir, which is benign) likewise surfaces one throttled `forge-decisions error: <reason> (<n> consecutive polls)` line after a few consecutive failed polls (#318), so a silent fs stall that would keep parked tickets blocked forever becomes visible; a single transient error stays quiet.

- **`forge-outbox`** (`plugin/scripts/monitors/outbox-watch.mjs`, #414, per the spike `docs/spikes/2026-08-08-github-outbox-design.md`) watches `.forge/autopilot/outbox.json` — the local outbox that lets the loop keep going instead of sitting blocked when GitHub is rate-limited or an Actions outage is underway. Five writes are queue-eligible (`lib/outbox.mjs` `QUEUEABLE_OPS`): `board/comment.mjs` trail comments, `board/move.mjs` board-status moves (the same sub-step `escalate.mjs` reuses for its own `blocked` move), `board/receipt.mjs` merge receipts, `board/log.mjs` delivery-log rows, and `board/digest.mjs` epic digests — each of these `run*` functions tries the live write first (no behavior change while GitHub is reachable) and only queues it, via `lib/outbox.mjs` `attemptOrDefer`, when the failure looks like GitHub being unreachable (`isRateLimited`/`isPlatformOutage`, reused rather than a new signal). Everything else — merges, PR creation, `escalate.mjs`'s own decision comment, `create.mjs`, `reparent.mjs`, and `close.mjs`'s `gh issue close` — stays synchronous with no exceptions; the decision comment in particular calls `upsertMarkedComment` directly rather than through `comment.mjs`, so it is never outbox-aware by construction, not by a special-cased flag. The queue is guarded by its own `.forge/autopilot/outbox.lock` (deliberately separate from any future `run.lock`, #387 — different resource, would cross-block), built on the shared `lib/lock.mjs` exclusive-lockfile helper (`fs.open(path,'wx')`, `{pid,startedAt,hostname}`, PID-liveness + age-staleness reclaim) — the first real implementation of that #387-designed idiom; a future `run.lock` should reuse the same helper. Draining is two composed mechanisms, never a fixed ceiling: **opportunistic** — `attemptOrDefer` tries a drain right after any live outbox-owned write succeeds — and this **background monitor**, which polls, probes reachability with a cheap `gh api rate_limit` call, drains when reachable, and emits a line only on a pending-count transition (`forge-outbox: N item(s) queued (GitHub unreachable)` / `forge-outbox: N item(s) still queued` / `forge-outbox: drained — 0 item(s) queued`). A drain failing for a reason that ISN'T GitHub being down (a real bug — a stale mutation, a malformed queued entry) surfaces immediately as `forge-outbox: drain failed — … (escalation warranted)` — that is the only outbox-driven escalation trigger; an ordinary "still queued, GitHub is down" is never a `blocked` ticket and never routes through `escalate.mjs` (spec §7 reserves that for genuine human decisions). Visibility is read-only against the pending count: `ledger.mjs` `renderReport` gains an optional trailing `outbox: N item(s) still queued …` line, and `board/status.mjs` `computeStatus`/`board_status` gain an analogous `outboxPending` field for the catch-up card — both silent at `0`.

**The delivery subagent never waits on these.** The monitors notify the **main loop**, whose context lives across the whole run; a subagent's context is discarded on return and nothing re-delivers a notification to it (§ Orchestration, "the return-then-resume stall"). So the subagent still watches its **own** PR's CI in-run and merges in the **same invocation** (#177) — the authoritative green for the ticket in flight is the subagent's `--watch`, while the `forge-ci` push is only how the *loop* stays aware of CI transitions (including on a parked or other PR) without a polling timer. Never brief a subagent to open its PR and return awaiting a monitor push.

## Filing new work as it goes (spec §7)

When delivery surfaces a need out of the current ticket's scope, file it rather than drop it — `board/create.mjs`, linked to the driving ticket, trail-noted: a **bug** found in passing, a **spike** when a ticket turns out to need investigation first, a **follow-up item** for deferred work. Filed tickets re-enter the queue and are picked up by a later iteration — the board may *grow* mid-run and still converge, as long as new work trends down.

## Re-read, don't remember — compaction is harmless by construction (#466)

The loop holds no un-checkpointed state — everything needed to continue lives in `run.json`, the board, and `.forge/decisions`. So rather than *detecting* a mid-run auto-compaction, the loop makes one harmless: it **re-reads `run.json` at the top of every iteration**, before selecting the next ticket (§ The loop diagram). It is a ~5KB file read at zero model cost, and the window is never the source of truth for run state — a compaction mid-run loses only prose the loop never needed to remember. The resume protocol (below) accordingly applies on a **fresh session or after any compaction** — not a fresh session only.

**Explicit failure mode this guards against:** `mergeMode` in `run.json` is a **record of a past grant, not a recoverable grant**. Re-anchoring from disk must never create the belief that merge authority was restored merely because `run.json` still shows `auto-merge` from an earlier point in the run — the harness classifier re-evaluates per attempt regardless of what's on disk (#397/#398), so every merge attempt still needs the live in-session grant (§ Merge-authorization preflight), compaction or not.

## Stop conditions & safety rails (spec §8)

- **Natural stop:** no actionable ticket remains → print the run report (merged / escalated / skipped / newly-filed) and exit.
- **`--limit N`:** stop after N merges.
- **Kill switch:** honour the per-repo **situation gate** (`gates/situationgate.mjs`) — while the repo is in an **open incident** or **security-response** (security hold) situation the gate pauses shipping (during an incident, ship proceeds only on a `hotfix/*` branch and release is refused outright; during a security hold only `respond`/`investigate` run), so autopilot spawns no new delivery until it clears. Clearing the situation is always a human action (close the incident / lift the security hold), never automated.
- **Interrupt:** Ctrl-C between tickets is clean (the run ledger is the resume point); mid-ticket, deliver's own resume protocol recovers.
- **Loop backstop (a code call, not a discipline):** the orchestrator MUST call `ledger.mjs` `nextIteration(run, boardSize)` at the **top of every iteration, before selecting or delivering** the next ticket — this is the mechanical caller for the `guardTripped` bound (#317). It returns `{ stop, escalate, iterations, cap, reason }`: `stop=false` → continue the iteration; `stop=true` → the run is a file-a-ticket-per-iteration **runaway** (iterations reached board size × 2), so **halt the loop and escalate** (surface the `reason` via `escalate.mjs`) rather than deliver another ticket. It reads the persisted iteration counter (`run.iterations`, maintained by `applyOutcome`), so the bound is resume-safe; it never mutates the run, so the natural stop (board clear) and `--limit N` are untouched. At the SAME iteration-top boundary, also call `ratebudget.mjs` `budgetCheckDue(run.iterations)` (§ Rate-budget preflight, #407) — when due, re-run `evaluateRateBudget(gh)` and pause on `pause:true`.

## Session-window self-pause (#378) — pause before the cutoff, not after

A long run can be cut off mid-ticket by Claude Code's **5-hour session usage window** — a hard stop rather than a clean pause. This is **additive and opt-in**: it changes nothing about the merge bar, the escalation triggers (§ The human gates), selection order (§ Selection), or the runaway backstop (§ Stop conditions) — it only adds a check **between tickets** that, when it fires, routes into the **existing, unmodified Resume protocol** below. Nothing here changes that protocol's own logic.

- **Mechanism (owner-approved 2026-08-05, `esc-378-msfttmev` option a — see `docs/spikes/2026-08-05-session-window-detection.md` [PR #381] and ADR-0003 § Consequences):** no pull API for session-window-remaining exists. `statusline.mjs` already receives the harness's `rate_limits` payload (Pro/Max only, push-based, after the first response) and now writes it — best-effort, narrow — to `.forge/autopilot/usage.json` on every invocation. That turns the harness's own UI-refresh cadence into a de-facto poll autopilot can read.
- **When to check — between tickets, at the same safe boundary the loop already uses (never mid-ticket, mid-gate, or mid-merge):** after a delivery subagent returns and its outcome is recorded (§ Orchestration step 2), **before** spawning the next one. Read `.forge/autopilot/usage.json` (`sessionpause.mjs` `evaluateSessionPause(cwd)` — or `node "${CLAUDE_PLUGIN_ROOT}/scripts/autopilot/sessionpause.mjs"` as a thin CLI, exit code 3 = pause).
- **The decision is data- and config-gated, never a guess:** `evaluateSessionPause` returns `pause:false` — i.e. the loop simply continues as it always has — whenever the usage file is **absent** (no Pro/Max statusline data, or no session yet), **stale** (older than a plausible refresh gap — the write is push-only, so a stale file could be from an idle or earlier session), or the threshold is **unconfigured** (`autopilot.sessionPauseThresholdPct` unset in `.claude/forge.json` — the safe, opt-in default; see `lib/config.mjs`). This must never block or degrade autopilot for a consumer without that data or who hasn't opted in.
- **On `pause:true`** (5h usage at/above the configured threshold, default suggested value **90**): stop spawning new deliveries at this safe boundary, checkpoint as usual (`run.json` already has everything — no extra state to save), and surface a pause notice with the reason `evaluateSessionPause` returned. Schedule or wait for continuation (e.g. `ScheduleWakeup`/an autonomous-loop pattern, per the ticket) rather than requiring a human to notice.
- **On resume (scheduled or human-triggered):** re-enter through the **existing, unmodified § Resume protocol** below — same steps, same order, no new resume path. In particular the in-session merge authorization is **not** file-backed (§ Merge-authorization preflight), so resume still re-obtains or degrades to PR-only exactly as it does today; this feature does not change that semantics.
- **Pure decision function:** `sessionpause.mjs` `shouldPause({ usedPercentage, thresholdPct = 90 })` — the boundary math only (no IO), mirroring `preflight.mjs`/`ledger.mjs`. `evaluateSessionPause` is the IO wrapper that combines the on-disk snapshot + config into the verdict above.

## Run ledger & report

The loop owns `.forge/autopilot/run.json`: the queue, and per ticket `merged | escalated | skipped | filed` with the PR/decision ref. A fresh session reads it to resume. At stop, print the report: how many merged, which parked (with why), which skipped, what new tickets were filed — and summarise the run on the delivery-log issue. When the local outbox (§ Monitor notifications, `forge-outbox`) still has items queued at report time, the report gains one trailing line naming the pending count — read-only, never a reason to treat the run as incomplete.

## Driver scripts (the executable spine)

The loop is prose the orchestrator runs, but its mechanical decisions are real, tested scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/autopilot/`:

- `select.mjs` — `selectNext(tickets)` / `--dry-run`: the selection order + the triage/deliver/resume decision (§ selection). Pure, so the order is testable.
- `merge.mjs` — `evaluateMergeBar(signals)` + `runMerge(ctx,{issue,pr,signals,mode,outageAttempt,maxOutageAttempts})`: the auto-merge bar. Fail-closed — a missing signal is red; `features.autopilotAutoMerge:false` **or** the preflight's `mode:'pr-only'` parks at the PR. This is where "nothing merges on red" lives. `runMerge` is the **canonical, enforced merge entry point**, exposed to hosts as the `autopilot_merge` MCP tool (forge-core) so the live merge is executed through the bar by construction — never via a raw `gh pr merge`. `ciGreen(gh, pr, {freshState})` (#407 AC.2) accepts the `forge-ci` monitor's last observed transition (read from `ctx.cwd` via `monitors/ci-watch.mjs` `loadCiWatchState` when `runMerge` has a `cwd`); a very recent (`isFreshGreenTransition`, default 20s) known-green reading for the SAME pr satisfies the check without a redundant GraphQL re-fetch — reducing the 3 idle CI-status pollers per ticket lifecycle (forge-ci monitor / the delivery subagent's own `--watch` / this pre-merge re-check) to effectively 2. Anything less than an exact fresh match (wrong pr, stale, non-pass, or no `cwd`/file at all) falls straight through to the unchanged real re-fetch — the mandatory pre-merge green confirmation itself is never skipped, only its network cost sometimes is. `classifyCiFailure(gh,{branch})` + `forceNewSha(execRun,{base})` (#408, § Auto-merge item 4) are the outage classification + the bounded fresh-SHA recovery `runMerge` runs before treating a real CI red as a gate failure — journaled (`gate-fail`, `outage:true`) so the run report can tell a real fix wave from GitHub being down twice.
- `preflight.mjs` — `mergeAuthPreflight({authorized,config})`: the run-start merge-authorization decision (§ Merge-authorization preflight). Pure — returns the effective merge `mode` (`auto-merge` only on an explicit in-session grant + config-enabled; else `pr-only` with the notice to surface). `startRun` records it into `run.json`; `runMerge` gates on it. This is what stops an unattended run from delivering a whole ticket and then silently wedging at the first merge (#316).
- `ratebudget.mjs` — `shouldPauseForBudget(budget)` (§ Rate-budget preflight, #407): the pure threshold decision over a `rateBudget()` reading, mirroring `sessionpause.mjs`. `evaluateRateBudget(gh, {lowWater})` is the IO wrapper the orchestrator calls at run start and every `budgetCheckDue(iterations)`-th iteration; a FAILED check degrades to "don't pause" (today's reactive per-call retry), never a hard block.
- `ledger.mjs` — the run ledger (`.forge/autopilot/run.json`): `applyOutcome`/`applyFiled`/`guardTripped`/`nextIteration`/`renderReport`, plus `ledger.mjs report`. `nextIteration(run, boardSize)` is the per-iteration **runaway backstop** the loop calls first each iteration — the real caller for `guardTripped` (halt + escalate on trip; #317). The resume point too.
- `watchdog.mjs` — `resolveReturnedTicket({outcome,pr,ciGreen,mergeMode})`: the return-then-resume watchdog (§ Return-then-resume watchdog). Pure — the loop runs it on **every** subagent report so an `awaiting-merge` on a green PR is re-driven to the merge bar or surfaced, never silently parked (#319).
- `newwork.mjs` — `fileWork(ctx,{title,kind,from})`: files a linked follow-up (bug/spike/item) mid-run.
- `perms.mjs` — **Claude-only**: prints the local Claude settings allowlist autopilot needs to run continuously (non-destructive; opt-in). agy pre-authorizes via a hook instead — see § Permissions.
- `sessionpause.mjs` — `shouldPause({usedPercentage,thresholdPct})` (§ Session-window self-pause): the pure threshold decision (default 90), plus `evaluateSessionPause(cwd)`, the IO wrapper that reads `.forge/autopilot/usage.json` (written by `statusline.mjs`) + `autopilot.sessionPauseThresholdPct` config and degrades to "don't pause" on any missing/stale/unconfigured input.

Two more supporting pieces, not autopilot-only but load-bearing for #407:

- `monitors/ci-watch.mjs` — besides its usual background-poll job (§ below), it now writes its every-poll observation to `.forge/autopilot/ci-watch.json` (`writeCiWatchState`/`loadCiWatchState`) so `merge.mjs`'s `ciGreen()` in a DIFFERENT process (the delivery subagent) can read a fresh transition back (#407 AC.2). Best-effort — a write failure never crashes the monitor.
- `lib/board.mjs` — `getRepoInfo(gh)` / `getProjectFields(gh, projectId)` are now memoized per `gh` instance (#407 AC.3): repeat calls against the same injected `gh` (a long-lived process — notably the forge-core MCP server, which resolves one `gh`/ctx for its whole session) are served from cache instead of re-fetching. Pass `{refresh: true}` after a mutation that changes what a fresh read must reflect (e.g. `init.mjs`'s post-field-creation re-discovery).
- `lib/outbox.mjs` (#414) — the local GitHub outbox: `enqueue`/`pendingCount`/`drain`/`attemptOrDefer`, `node lib/outbox.mjs drain` as a thin CLI. The five queue-eligible `board/*.mjs` `run*` functions call `attemptOrDefer` themselves (§ Monitor notifications, `forge-outbox`) — this module is never called directly by the orchestrator except to read `pendingCount` for the report line / `board_status` field, or to trigger an opportunistic drain.
- `lib/lock.mjs` (#414, per #387's design) — `acquireLock(path)`/`isStale(lock)`: the shared exclusive-lockfile helper (`fs.open(path,'wx')`, `{pid,startedAt,hostname}`, PID-liveness + age-staleness reclaim, `release()` in try/finally). `lib/outbox.mjs` is its first real consumer (`.forge/autopilot/outbox.lock`); #387's eventual `run.lock` should reuse it rather than duplicate the idiom.

The orchestrator holds the ship/gate/reviewer/security verdicts and passes them to the merge bar; the scripts never spawn subagents or drive the loop themselves.

## Cost & context on long runs (spec §11)

A long run stays bounded by construction — not by luck:

- **Delegate, don't inline (mandatory — see § Orchestration).** Each ticket is delivered in a discardable context — its **own spawned agent** — whose tokens die when the ticket ends. The outer loop never ingests code; it keeps only `run.json` + git + a **one-line outcome** per ticket, so overhead stays **~O(1) per ticket** no matter how long the run.
- **Checkpoint + reset is free.** Every ticket is written to `run.json`; the resume protocol reconstructs from disk, so the orchestrator can be compacted or restarted between tickets at near-zero reload cost.
- **Cheap where it can be.** `select.mjs` + the ledger are plain scripts (zero model cost); model tiering already applies inside delivery (haiku lookup / sonnet default / opus only for second-opinion).
- **Intrinsic vs. overhead.** Per-ticket delivery cost is the real work and can't be optimised away; what autopilot keeps ~constant is the *loop overhead*. The host OS is irrelevant to cost/context — only PATH/shell handling is platform-specific.

## Resume protocol

Fresh session: read `.forge/autopilot/run.json` for run state → `escalate.mjs --check` to pick up any decisions the human answered → **re-run the Merge-authorization preflight** (the in-session grant is *not* file-backed — a restarted session is a new session and must re-obtain a live grant, or degrade to PR-only) → re-select per the selection order (which naturally resumes a mid-flight ticket first) → continue the loop. (A full restart always needs a fresh grant. But a restart is not the only trigger: the harness classifier evaluates merge authorization per attempt, not once per session, so a later merge later in the *same*, uncompacted session can still be denied even after an earlier merge in that session succeeded — observed directly, repeatedly, in production runs (#397). There is no code-level way to predict this in advance (#398). When it happens, the loop's only recourse is the same pattern as the run-start preflight: stop, surface the denial to the user, and ask for a fresh explicit in-session grant before retrying the merge — not a new mechanism, just the existing one applied mid-run.)
