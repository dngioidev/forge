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
RUN START: probeEnv(ctx) (§ Environment preflight)  ← ALSO required, before the first spawn
  └─ verdict=no-go ─────────────▶ print the numbered blocker list + fixes, do NOT spawn the first subagent
  ▼
RUN START: startRun(cwd, {..., boardSize}) (§ Loop backstop)  ← anchors the runaway cap ONCE (#488)
  ▼
RE-READ run.json (§ Re-read, don't remember)  ← top of EVERY iteration, fresh session or after compaction
  ▼
ITERATION GUARD: nextIteration(run, boardSize) (§ Loop backstop)  ← call FIRST, every iteration
  └─ stop=true (runaway) ──────────────────▶ HALT + escalate (do NOT deliver another ticket)
  ▼
select next actionable ticket (§ selection) → { ticket, action }
  ├─ none left ────────────────────────────▶ STOP + run report
  ▼
every budgetCheckDue(run.iterations) iterations: evaluateRateBudget(gh, {recentDeltas, kind: ticket.kind}) again (§ Rate-budget preflight)
  └─ pause=true ────────────────────────────▶ same pause as run start
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
  │  WATCHDOG: matchHeldVerdicts(report, heldVerdicts) FIRST (#474) ── run on every deliver/resume report (internally defers for a resolved/awaiting-merge outcome)
  │    └─ action=relay ──▶ SendMessage the held verdict(s), resume the SAME subagent, await its next report
  │    └─ action=defer ──▶ resolveReturnedTicket(report) (§ Return-then-resume watchdog)  ← run on EVERY delivery report
  ├─ action=merge ───────────────────────▶ funnel the PR through the merge bar (autopilot_merge/runMerge)
  ├─ action=escalate ────────────────────▶ surface visibly (record awaiting-human / escalate) — never a silent park;
  │                                          includes a malformed report with NO PR (#522, unrecoverable — inspect the tree first)
  ├─ action=respawn (stalled-before-PR, #464; PR must already exist, #522) ▶ resume/re-spawn — never funnel to the merge bar
  ├─ action=continue: outcome=escalated / awaiting-human ─▶ record + park, continue with next ticket
  ├─ action=continue: outcome=merged ────▶ record to run.json · trail --phase merged
  ├─ shape outcome=ready ─────────────────▶ record {outcome:'ready', stage:'shape'} · re-enters the queue as `deliver`
  ├─ triage verdict=fail ─────────────────▶ escalate + skip (§ Auto-triage front door)
  ├─ triage outcome=skipped (#487) ───────▶ recordDependency (§ Selection) · not re-selected until dependsOn closes
  └─ subagent filed new work ────────────▶ already on the board — re-enters the queue
  ▼
loop  (main context unchanged — ~O(1) per ticket — RE-READ run.json again at the top)
```

## Orchestration — the main loop never runs a skill inline (#466)

**The main loop never runs a skill inline. Every action `select.mjs` returns is executed in a spawned subagent.** The loop's own tools are only: `select.mjs`, the ledger, `watchdog.mjs`, the merge bar, trail/escalation surfacing, and the Task tool. This generalizes the earlier delivery-only rule (#156): `select.mjs` `actionFor()` returns **four spawnable** actions — `resume`/`deliver`/`triage`/`shape` — and every one of them gets a spawn, not just delivery. (`actionFor()` can also return `'escalate'` — an unshaped `backlog` ticket with no `--shape` — but that names a decision already parked for the human, not delegable work; it is handled directly by the loop's existing escalation surfacing, § Selection / § The human gates.) Why this generalization was needed (`shape` used to run inline and drove a long run to 100% context): `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/driver-scripts.md`.

| action | subagent | brief runs | terminal report |
| --- | --- | --- | --- |
| `shape` | **shape subagent** | `forge:shape` | `{verdict, outcome, issue, followUp, sources}` |
| `triage` | **triage subagent** | `forge:triage` | `{issue, verdict, outcome}` |
| `deliver` / `resume` | **delivery subagent** (unchanged) | `forge:deliver` | `{issue, outcome, pr, notes}` |

Per ticket, the main loop does exactly three things: **spawn**, **record**, **continue**.

1. **Spawn a subagent for whatever action was selected** with the Task tool — `subagent_type: general-purpose, model: sonnet` (or a dedicated agent if the roster has one), for **every** action, not delivery alone. Pin the model explicitly — an unpinned `general-purpose` spawn silently inherits the orchestrating session's model, burning work at the wrong rate (#379) — every other forge role agent already carries an explicit model tier for the same reason (#101).

   - **`deliver`/`resume` → delivery subagent.** The brief is self-contained so the subagent needs no main-loop context: the ticket ref + body, the merge bar (§ auto-merge), the escalation triggers (§ human gates), and this instruction — *do the whole ticket in your own context (branch, plan, implement, test, gates, ship, open the PR, **watch CI to green in this same run with `gh pr checks <pr> --watch`**, auto-merge on green, post-merge ritual); file follow-ups directly with `board/create.mjs`; escalate with `escalate.mjs`; then return a compact terminal report and nothing else.* It also carries the **liveness-heartbeat instruction (#505, § Agent-liveness monitor)**: best-effort call `node "${CLAUDE_PLUGIN_ROOT}/scripts/monitors/agents-watch.mjs" --write --id <issue> --issue <issue> --branch <branch> --phase <phase>` at spawn and at each phase change (scoping/planning/testing/implementing/reviewing/shipping/watching-ci) — never block on its failure, it is a liveness signal, not part of the ticket's actual work.
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

   **Literal-string caveat — applies to every spawned brief.** The denylist matches these command strings even inside quoted/heredoc bodies, so a PR body, an issue/trail comment, an escalation reason, or a sources-manifest entry that merely *mentions* a blocked command trips it when passed inline — this applies equally to a delivery subagent's PR body, a triage subagent's `board/*.mjs --body`/`--body-file`, and a shape subagent's `escalate.mjs --reason`/`--context` (or their file-taking equivalents `--reason-file`/`--context-file`). Write such content to a file and pass the `-file` variant (or `git commit -F <file>`), never inline on a shell command line.
2. **Read only the terminal report.** For `deliver`/`resume`, run the report through the **return-then-resume watchdog** before recording anything (§ Return-then-resume watchdog for the full relay/merge/escalate/respawn logic) — `{issue, outcome: merged|escalated|awaiting-human|skipped, pr, notes}` is the conforming shape; a non-conforming or `awaiting-merge` report is never recorded as resolved on its own, only what the watchdog resolves it to. For `shape`: `{verdict, outcome: ready|escalated, issue, followUp, sources}` — `outcome: ready` records via `ledger.mjs` `applyOutcome(run, {issue, outcome:'ready', stage:'shape'})` (the ticket re-enters the queue as `deliver` on a later iteration; § Run ledger & report), `outcome: escalated` records + parks like any other escalation. For `triage`: `{issue, verdict, outcome, sequencedBehind?, reason?}` (`triage/SKILL.md` § Report contract) — `fail` escalates-and-skips (§ Auto-triage front door); `ready` records via `recordOutcome(...,{ctx})` — `ctx` (#556) also promotes `backlog`→`ready`, so `selectNext` returns `deliver`; `skipped` (#487) records the dependency (`recordDependency`) first, so it isn't re-selected next pass. Every recorded outcome carries the producing `stage` (`shape`/`triage`/`deliver`) so the run report can distinguish them. The main loop writes the resolved outcome to `run.json`, trails the ticket, and never re-reads the subagent's work. It also best-effort clears that issue's liveness record (`node "${CLAUDE_PLUGIN_ROOT}/scripts/monitors/agents-watch.mjs" --clear <issue>`, #505) — a resolved ticket's heartbeat must not linger to false-positive as "stale" on a later run.
3. **Continue** to the next ticket. Because every spawned context is discarded on return, the main window is unchanged between tickets — a 5-ticket and a 50-ticket run cost the same orchestration overhead, and the run never compacts mid-loop.

A subagent that can't finish (deadlock, a gate failing twice, an ungrounded shape) returns `outcome: escalated` with the reason; the loop parks that one ticket and moves on. Never fall back to running any stage inline — a missing/broken subagent is itself an escalation.

## Return-then-resume watchdog — four shapes, none ever silently parked (#319, #464, #474, #522)

The forbidden pattern above (§ Orchestration) is a *briefing* rule; this is its **mechanical backstop** — briefing alone doesn't reliably close the stall on its own. The pattern is consistent — the agent reaches for the only "wait" shape it knows (returning, or narrating a backgrounded step) instead of finishing in-run. Its own return discards the context that would have received the answer. Field evidence for why a mechanical backstop was needed (repeated stalls despite an increasingly explicit brief): `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/watchdog-history.md`.

**#474 — relay a held verdict automatically, before any of the below.** `matchHeldVerdicts(report, heldVerdicts)` runs FIRST on every non-conforming report — `heldVerdicts` are `reviewer`/`security` task notifications the orchestrator already received this run for this issue. When the report's free text names one or more roles it's awaiting ("security" / "review(er)" / "both") and the loop already holds a verdict for every one of those named roles, it returns `action: 'relay'` with the matched verdict(s) — `SendMessage` them to the SAME already-running subagent (resumed from its own transcript, context intact — never a fresh subagent placed onto a shared tree) and await its next report. This relay carries none of #522's blind-respawn risk (it never touches the working tree or spawns anything new), so it is safe to attempt independent of whether a PR exists — six real instances confirm the recovery works (field evidence, including the two stalls that motivated #474 itself: `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/watchdog-history.md`). **AC.2 — never guesses:** any ambiguity (no held verdicts, a named role with nothing held, a partial match when multiple roles are named, no recognisable role named at all, held verdicts for a different issue) returns `action: 'defer'` instead — the loop falls straight through to `resolveReturnedTicket`, unmodified, exactly as it did before #474. `resolveReturnedTicket` itself never changes for this — `matchHeldVerdicts` is a separate, pure function composed ahead of it, not a branch inside it.

Once `matchHeldVerdicts` defers (or the report was never even a candidate — e.g. it already conforms to a resolved outcome), the loop runs the report through `watchdog.mjs` `resolveReturnedTicket({ outcome, pr, ciGreen, mergeMode })` — a pure decision that maps the report to one action, catching the remaining **three** shapes:

- **`merge`** — `awaiting-merge` on a **green** PR with **auto-merge** authority (the run's recorded `mergeMode`), OR a non-conforming report whose PR the loop's own observed `ciGreen`/`mergeMode` already show is green + authorized (#522): funnel the PR through the tested bar (`autopilot_merge` / `runMerge`), which re-checks CI itself. The stall becomes a merge.
- **`escalate`** — `awaiting-merge` that can't merge: a green PR under **pr-only** (no in-session grant) is recorded **awaiting-human visibly**; a return with **no PR** or a **not-yet-green** PR (the subagent skipped its in-run `--watch`) is **escalated**. ALSO (#522): a non-conforming report with **no PR at all** — the unrecoverable shape (below) — is **escalated**, not respawned. Either way it is *surfaced*, never silently parked.
- **`respawn`** — **stalled-before-PR, recoverable (#464):** the report doesn't parse as the contract at all — `outcome` is missing, or free text that isn't one of `merged`/`escalated`/`awaiting-human`/`skipped`/`ready`/`awaiting-merge` (verbatim examples: `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/watchdog-history.md`) — **and a PR is already open** (`pr` carried through, e.g. #437). The recovery is to resume or re-spawn the subagent to finish that PR, because there is nothing here for `runMerge` to funnel (unless it's already observably green + authorized — see `merge` above). `outcome` records as `'stalled-before-pr'` — `ledger.mjs`'s `OUTCOMES` carries it, so the run report shows the stall rather than the ledger throwing on an unknown outcome — a real, recordable, actionable state, never a silent `outcome: null`. (Named `respawn`, not `resume`, so this action never gets confused with `select.mjs`'s unrelated `resume` selection action below.)
- **`escalate` (again) — malformed/absent report, unrecoverable, NO PR (#522):** the same non-conforming shape as `respawn` above, but with **no PR at all** (verbatim examples: same reference doc). Unlike the recoverable shape there is nothing here to resume INTO, and the shared working tree's state (uncommitted? mid-edit? nothing at all?) is not observable from `resolveReturnedTicket`'s inputs — a bare respawn risks a fresh subagent silently discarding or clobbering whatever is sitting there. So this escalates — `outcome: 'escalated'` — forcing a human/orchestrator to inspect `git status`/`git log` before anything touches the tree again.
- **`continue`** — every already-resolved outcome (`merged`/`escalated`/`awaiting-human`/`skipped`/`ready`): record the reported outcome and move on.

**The invariants:** an `awaiting-merge` report is NEVER left as a silent terminal state — it either merges or is surfaced (#319). A non-conforming report is likewise NEVER recorded as a resolved outcome (AC.1) — it either relays (a matching held verdict — #474), respawns (a PR already exists, no match — #464), or escalates (no PR, no match — #522), per the shapes above. Selection is resume-safe for the recoverable shapes: a ticket returned at an open PR (green or still under review) is still at a resume-tier board status (`inReview`/`inProgress`), so `selectNext` re-picks it as `resume` on the next iteration (and even a ticket left at `ready`/`backlog` is re-delivered, never dropped) — the watchdog and the resume path are belt-and-suspenders against the same class of stall. (Design rationale for the relay/respawn split's keying, purity, and how this relates to #505's agent-liveness monitor: `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/watchdog-history.md`.)

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

**The preflight is enforced in code, not prose alone (#316).** `scripts/autopilot/preflight.mjs` `mergeAuthPreflight({ authorized, config })` is the pure decision: it returns the effective merge **mode** — `auto-merge` **only** when an explicit in-session grant is held **and** config doesn't disable it; otherwise `pr-only` with the exact human-readable notice to surface. `startRun` records the chosen `mergeMode` + `mergeReason` into `run.json` at run start, and `runMerge` gates on it — **`pr-only` carries `autoMergeEnabled:false` semantics**, parking the ticket *awaiting-human* rather than attempting a merge that would stall. The orchestrator passes the recorded mode to the `autopilot_merge` tool; `authorized` is `true` **only** for a genuine live user grant. (On resume, the preflight re-runs — the in-session grant is not file-backed — § Resume protocol.)

## Rate-budget preflight (#407) — pause before the shared GraphQL bucket hits zero

`rateBudget()` (`lib/exec.mjs`, #360 AC.4) was shipped fully implemented but never called — the loop only reacted to a 403 *after* it happened. `scripts/autopilot/ratebudget.mjs` wires it in at two points, both **required**, mirroring the merge-auth preflight's shape:

- **Run start, before spawning the first delivery** (alongside § Merge-authorization preflight): call `evaluateRateBudget(gh)`. `pause:true` → surface the reset window (`decision.reason`) and pause the run at this safe boundary — schedule/wait for continuation exactly like § Session-window self-pause, **not** an escalation (nothing is broken; the shared account-wide 5,000 pt/hr bucket is just low). `pause:false` → proceed.
- **Every `budgetCheckDue(run.iterations)` iterations thereafter, now AFTER selection** (§ The loop diagram — moved from the old same-boundary-as-`nextIteration` spot so the next ticket is already known): re-run `evaluateRateBudget(gh, {recentDeltas, kind: ticket.kind})`, threading the **just-selected** ticket's `kind` — sourced from the board `type` field first (#530), falling back to the title-prefix classifier only when unavailable. Cadence is **every iteration** (`DEFAULT_CHECK_EVERY_N = 1`, #517) — a slower cadence was structurally too late to fire before the bucket drained; this check costs nothing extra against any bucket. Full derivation of why `type`-first and why every-iteration: `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/rate-budget-history.md`.
- **Degrade, never hard-block, on a FAILED check.** `evaluateRateBudget` returns `{pause:false, ok:false}` when the check itself couldn't complete (network down, gh broken) — that is explicitly NOT "low," and the run continues, falling back to today's reactive per-call retry (`makeGh`'s own backoff already covers an individual 403). Only a **completed** check reporting `low:true` pauses.
- **The low-water threshold is gated on the next selected ticket's kind, not just the run's historical worst case (#526).** A **known kind** (`kind` is a `KIND_COST_ESTIMATES` key — currently `{ docs: 975, spike: 3457 }`, each the actually-measured GraphQL spend for that kind) short-circuits `estimateTicketCost` straight to `Math.max(KIND_COST_ESTIMATES[kind], UNATTRIBUTED_DRAIN_FLOOR)` (1500), ignoring `recentDeltas`/`fallback` entirely. An **unknown kind** (no ticket selected yet, or a kind outside `KIND_COST_ESTIMATES` — every real board-`type`-derived kind as of #530) falls through to the MAX of this run's own recent, plausible readings (`recentBudgetDeltas(run)`, filtered by `MIN_PLAUSIBLE_DELTA`), falling back to `DEFAULT_LOW_WATER` (4993 — the measured worst-case single-ticket cost) with no history yet — the RUN START check always takes this path, since it has no selected ticket yet. Constant derivation + measured evidence for both branches: reference doc above.
- **Pure decision function:** `ratebudget.mjs` `shouldPauseForBudget(budget)` — the boundary math only (no IO), mirroring `mergeAuthPreflight`/`shouldPause`; hermetically tested against a mocked `rateBudget` result — no real API, no real sleep. `evaluateRateBudget(gh, {lowWater, recentDeltas, kind})` is the IO wrapper the orchestrator actually calls; `budgetCheckDue(iterations, everyN)` is the periodic-cadence gate; `estimateTicketCost(recentDeltas, kind, fallback)` is the pure derivation of the effective low-water threshold, per-kind short-circuit first, then the unchanged recent-history path.
- **Disk-sourced history can never disable the guard (#517 security fix-wave, mirrors #488's `run.json` hardening), and `kind` is untrusted the same way.** `run.rateBudgetReadings` is written by the loop but is still a trust boundary — `estimateTicketCost` treats any delta below `MIN_PLAUSIBLE_DELTA` (500) as no evidence at all, falling back to `DEFAULT_LOW_WATER` rather than letting the threshold collapse toward zero; a malformed/non-string `kind` simply isn't a `KIND_COST_ESTIMATES` key, so it falls through to the unknown-kind path rather than throwing. Full hardening rationale: reference doc above.

## Environment preflight (#504) — verify the machine before burning a delivery on it

The third RUN START gate, alongside § Merge-authorization preflight and § Rate-budget preflight. Neither of those two looks at the machine — nothing verified `gh`/`node`/`pnpm` resolve, that `node_modules` exists, that the board's Status option keys still match the ones `select.mjs` reads, or that the statusline plugin path on disk still exists. `forge:doctor` covers part of this ground but is a separate, manually-invoked, read-only skill never wired into the loop, returning no GO/NO-GO verdict a loop can gate on — so a run could deliver a whole ticket's setup work and only wedge mid-flight on an environment problem that was already true at run start.

- **`scripts/autopilot/envpreflight.mjs`** mirrors the other two preflights' shape exactly: `evaluateEnvPreflight(probes)` is the **pure** boundary decision (probe results → `{verdict, blockers, warnings}`; every blocker carries a stable `id`, a `detail`, and a concrete `fix` string) — no IO, hermetically tested with injected probe results, no real shell/network. `probeEnv(ctx)` is the IO wrapper the orchestrator actually calls at run start, running six probes through an injectable `exec`/`gh`/`stat`/`readJson` and feeding their results through `evaluateEnvPreflight`.
- **The six probes:** `gh`/`node`/`pnpm` resolvable on PATH; `node_modules` present in the checkout; the board's Status option keys (normalized via `lib/board.mjs`'s `optionKey()`) cover every key `select.mjs`'s `TIER`/`SKIP` consume (a board admin renaming "In Progress" would otherwise silently break `actionFor()` routing with zero signal); the statusline plugin path parsed out of `statusLine.command` resolves on disk.
- **`verdict:'no-go'`** → print the **numbered** blocker list with each blocker's fix (`formatBlockers`) and **do not spawn the first delivery subagent** — the run stops at this safe boundary, exactly like a missing merge authorization or a low rate budget. **`verdict:'go'`** → proceed with no behaviour change.
- **Fail closed but narrow**, matching § Rate-budget preflight's degrade-don't-hard-block rule: a probe that *cannot complete* (an unexpected thrown error, not a completed negative finding) degrades to a **warning**, never a blocker — a broken probe must never be able to block a healthy run, and a warning from one probe never masks a real blocker found by another.
- **Out of scope:** no auto-repair. This gate reports and refuses — installing deps or rewriting settings stays a human step, or a later ticket.

## Selection — "next actionable"

Priority-ordered, FIFO within a priority. Read the board fresh each iteration (tickets you filed, or the owner added mid-run, get picked up):

1. **Resume first** — an `inProgress`/`inReview` ticket left mid-flight by an earlier run (deliver's resume protocol continues it).
2. `ready` (triaged), `p0` → `p1` → `p2`.
3. `backlog` — **auto-triaged** first (the front door), then delivered.
4. **Never selected:** `blocked`, `done`, `wontDo`, an unresolved escalation, or a sequenced-behind dependency.

Flags: `--limit N` stop after N merges · `--area <a>` restrict to one area · `--dry-run` print the selection + per-ticket classification and change nothing · `--shape` **crazy mode** (below).

A `backlog` ticket routes on its **readiness** (`readiness.mjs` → does it carry acceptance criteria): shaped → the triage front door; **not shaped** → `shape` under `--shape`, else escalate-and-skip (the default).

### Resting state for a "sequenced behind #N" verdict (#487)

Triage can return `outcome:"skipped"` (`triage/SKILL.md` § Report contract): well-specified but genuinely not actionable yet — sequenced behind another open ticket (`sequencedBehind: <N>`). Before #487 that verdict had nowhere to live: the board stayed `backlog`, so the next pass re-picked the same ticket as `triage` and re-derived the same conclusion, one full triage subagent per iteration.

**A file, not a board status:** `lib/dependencies.mjs` records `{issue, dependsOn, reason}` under `.forge/autopilot/dependencies/<issue>.json`, mirroring #499's `pendingIssues` shape. `selectNext` takes a `dependencyIssues` set excluding any ticket in it regardless of status. Self-clearing: every non-`--dry-run` invocation calls `resolveDependencies(cwd,{gh})` first, dropping a record once `dependsOn` closes — no human, no re-triage.

**Distinct from a pending decision (AC.4):** a decision needs a human answer; a dependency clears by polling. Separate stores, threaded into `selectNext` independently.

**Honest gap:** an environment dependency with no issue to poll (#480) isn't covered; Blocked stays its resting place. Rationale + follow-up: `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/driver-scripts.md`.

## Crazy mode — shaping the backlog (`--shape`, spec: forge-autopilot-crazy-mode)

Off by default. With `--shape`, a `backlog` ticket that isn't shaped (no acceptance criteria) is sent to a **spawned shape subagent** instead of being escalated (§ Orchestration — same spawn discipline as every other action): it gathers the product context, classifies why it isn't ready, runs the right front-of-pipeline skill (`ideate`/`brainstorm`/`spike`/`design`), and — **grounded-only** — either promotes it Backlog→Ready (recorded `outcome: ready, stage: shape` — re-enters the queue, delivered by a **later** `deliver` spawn, never the same invocation) or **escalates** the exact open question (writing it via `escalate.mjs` **before** it returns — its context is discarded on return, so an unwritten reason is lost) and skips. The **ground gate** (`gates/groundgate.mjs`) enforces that every shaped product decision cites a real source, so the engine never invents product direction. Without `--shape`, this whole stage is off and an unshaped ticket escalates as before.

## Auto-triage front door

A `backlog` ticket that is already shaped is sent to a **spawned triage subagent** (§ Orchestration) that runs `forge:triage` in its own context to become deliverable *before* `deliver` sees it. If it still can't be specified (`verdict: fail` — the ask or acceptance is unclear), **escalate it and skip** — the loop moves to the next ticket. Autopilot never guesses a product decision to keep moving.

## Auto-merge — the bar that replaces human review

A ticket merges **only when every one of these is green**. Any red routes to a fix wave (a fresh `implementer` spawn inside deliver's flow); the *same* gate failing twice is an escalation. **Nothing merges on red — ever.**

0. **In-session merge authorization is present** (§ Merge-authorization preflight; **Claude-only** — an agy-hosted run never calls `autopilot_merge` and always stops at the open green PR, so this item is moot there regardless of any allowlist). On Claude, an explicit in-session user grant is what actually clears Claude's harness auto-mode classifier — `features.autopilotAutoMerge: true` + the `gh pr merge` allowlist are necessary but **not sufficient**, and a grant in `run.json`/narration does not count. Absent it, the ticket is parked *awaiting-human* at its open green PR, never merged.
1. `forge:ship` completed clean: situation gate · conventions lint · rebase + full `verify` green.
2. All mechanical gates pass: `plandrift` · `testintent` · `depguard` · `acgate` (every AC id in a passing test).
3. Full-branch `reviewer` **and** `security` subagents return `verdict: pass` with **zero critical/high** findings. A critical is always an escalation, never a merge.
4. **CI on the PR is green.** Open the PR as deliver does (`Closes #n`, AC checklist, honest verification), then **watch CI to conclusion in the same run** with `gh pr checks <pr> --watch` — never merge before CI, and never return awaiting an external notification (the delivery subagent isn't re-invoked on green — § Orchestration). At the **loop** level the `forge-ci` monitor also pushes each CI transition (`CI pass` / `CI fail`) to the running orchestrator (§ Monitor notifications), so the loop tracks CI status without inline polling — but that push is *not* what merges the ticket in flight; the subagent's own in-run `--watch` is the authoritative green.

   **A CI red is not automatically a real gate failure (#408).** GitHub Actions itself can go down mid-run — a signature distinct from a real regression and from #360's rate limiting (`isRateLimited`). Before treating a red/pending result as "the same gate failing twice," `merge.mjs`'s `runMerge` runs it through `classifyCiFailure` (`isPlatformOutage` in `exec.mjs`): a genuine outage gets the empirically-proven recovery — `forceNewSha` forces a fresh commit SHA via rebase + `--force-with-lease` repush (re-running the *same* SHA did not reliably help) — bounded to `maxOutageAttempts` (2) via `--outage-attempt N` threaded across separate `runMerge` invocations (a fresh SHA needs a fresh CI run to `--watch`, so the bound spans calls, not a busy-loop inside one). Only once recovery is exhausted does it fall through to the ordinary "blocked on ci" path, and even then the `reason` says **"GitHub Actions platform outage, not your change"** — post that verbatim distinction in the `--phase gate-fail` trail comment, not a claim the change is broken. A real failure is never masked — it routes straight to the ordinary fix-wave/escalation path unchanged.
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

Full mechanics (poll cadence, exact state enums, throttled-error behavior, field evidence, threshold derivation) for every monitor below: `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/monitor-notifications.md`.

- **`forge-ci`** (`plugin/scripts/monitors/ci-watch.mjs`) polls the current branch's PR checks and, only on a transition, emits one line: `CI <state> on PR #<n> (<branch>)` (`pass`/`fail`/`pending`) — this is how the **merge bar's CI-green requirement surfaces to the loop as the `CI pass` line** without inline-polling `gh`. *Reacting* to it still belongs to the delivery layer: the merge bar (`merge.mjs`) and any fix wave execute **inside the delivery subagent** (§ Orchestration, and the disclaimer in § Auto-merge item 4), whose own in-run `--watch` is the authoritative green for the ticket in flight. A `CI outage-suspected on PR #<n> …` line is also possible (#408) — a stuck-`QUEUED` platform-outage signature, not a code failure (recovery: § Auto-merge item 4).
- **`forge-decisions`** (`plugin/scripts/monitors/decisions-watch.mjs`) polls `.forge/decisions/` and, the moment an escalation the human answered flips to `status: resolved`, emits one line: `Decision <id> (#<issue>) resolved: <first line of the answer>`. A **resolved-decision line unblocks the escalated ticket** — the parked (blocked) ticket named by `#<issue>` re-enters the selection queue on the next iteration, so the loop surfaces the reply without polling `.forge/decisions/` itself.
- **`forge-outbox`** (`plugin/scripts/monitors/outbox-watch.mjs`, #414) watches `.forge/autopilot/outbox.json` — a local queue for board writes when GitHub is unreachable, drained opportunistically and by this monitor once reachable again. Only a `drain failed` line (a real bug, not GitHub being down) is ever escalation-worthy; an ordinary "still queued" is never a `blocked` ticket.
- **`forge-agents`** (`plugin/scripts/monitors/agents-watch.mjs`, #505, epic #503) — the detection layer for a stall `watchdog.mjs` cannot see, because `resolveReturnedTicket` is **return-time only** and a subagent that never returns produces no report at all. The delivery brief (§ Orchestration item 1) best-effort writes/refreshes `.forge/agents/<id>.json` (`{id, issue, branch, phase, spawnedAt, lastArtifactAt}`) at spawn and each phase change; this monitor polls every record, classifies each with the pure `classifyLiveness({record, now, thresholdMs})`, and emits `Agent stall suspected: issue #<n> (branch <b>, phase <p>) — no heartbeat update past the threshold` only on a transition into `stale` (paired with `Agent recovered: issue #<n> …` on recovery) — never a line per poll. **Threshold: `DEFAULT_STALE_MS` = 60 minutes**, comfortably above every observed legitimate quiet phase (a full `pnpm verify`, a `gh pr checks --watch` wait) so a healthy delivery never false-positives. **AC.5 — detection only, never wired to resolution.** `agents-watch.mjs` never calls `resolveReturnedTicket` and never classifies a *returned* report — there is no report for a subagent that never returned, so there is nothing here for the watchdog to consume. The `forge-agents` line is exactly what it says: a notice surfaced to the (blocked) main loop while the spawn is still in flight — there is no *returned report* yet for `matchHeldVerdicts`/`resolveReturnedTicket` to classify or relay against (§ Return-then-resume watchdog, #474), so this monitor's stall notice and the watchdog's post-return relay remain two distinct layers, never merged into one. **Honest limit:** a subagent wedged badly enough to never execute its own heartbeat-write call is invisible to this mechanism exactly as it was invisible before — the heartbeat is briefing-dependent, not cooperation-free (detail + field evidence: the reference doc above).

A persistent poll failure on any of the four monitors surfaces a throttled `<monitor> error: <reason> (<n> consecutive polls)` line rather than going silent forever (#318); a single transient failure stays quiet.

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
- **Loop backstop (a code call, not a discipline):** the orchestrator MUST call `ledger.mjs` `nextIteration(run, boardSize)` at the **top of every iteration, before selecting or delivering** the next ticket — this is the mechanical caller for the `guardTripped` bound (#317). It returns `{ stop, escalate, iterations, cap, reason }`: `stop=false` → continue the iteration; `stop=true` → the run is a **runaway** (iterations reached the cap), so **halt the loop and escalate** (surface the `reason` via `escalate.mjs`) rather than deliver another ticket. It reads the persisted iteration counter (`run.iterations`, maintained by `applyOutcome`), so the bound is resume-safe; it never mutates the run, so the natural stop (board clear) and `--limit N` are untouched.
  - **#488 — the cap anchors to the board size at run start, not the live count.** Call `startRun(cwd, {..., boardSize})` **once at run start** (§ The loop diagram) with the board size at that point — it is persisted as `run.boardSizeAtStart` and never recomputed on resume, so a shrinking board never shrinks the cap (AC.4). `nextIteration`/`guardTripped` prefer that anchor over the live `boardSize` argument when present. Disk-sourced state (`boardSizeAtStart`/`iterations`) can never disable the guard — a non-finite/non-positive value is rejected and falls back to a conservative default, failing CLOSED rather than silently disabling the backstop. Why the anchor was needed + the fail-closed hardening detail: `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/driver-scripts.md`.
  - **The escalated `reason` distinguishes "no progress" from "simply long" (AC.5).** At trip time `nextIteration` compares `run.iterations` against the count of distinct issues with a recorded outcome in `run.outcomes` (already-available state — `stalled-before-pr` excluded, since that's a stall awaiting resume, not resolved progress). A low ratio phrases as *"no progress is being made"* (catches #487's shape, where the same issue is reselected with no new resolved outcome); a high ratio with the cap still reached phrases as *"this run has simply been long, not stalled"* — so a run report never mislabels a healthy run as a runaway.
  - The periodic rate-budget recheck is still gated by this same `budgetCheckDue(run.iterations)` cadence, but it no longer fires at this iteration-top boundary — it now runs just after selection, once the next ticket's `kind` is known (§ Rate-budget preflight, #407, #526).
- **Convergence guard (#506).** Call `ledger.mjs` `convergenceGuard(run,{startingOpen,currentOpen})` per wave; trips (halt+escalate, names filed tickets) on TWO CONSECUTIVE `diverging` waves, not one. Persist via `recordConvergence`; detail: `driver-scripts.md`

## Session-window self-pause (#378) — pause before the cutoff, not after

A long run can be cut off mid-ticket by Claude Code's **5-hour session usage window** — a hard stop rather than a clean pause. This is **additive and opt-in**: it changes nothing about the merge bar, the escalation triggers (§ The human gates), selection order (§ Selection), or the runaway backstop (§ Stop conditions) — it only adds a check **between tickets** that, when it fires, routes into the **existing, unmodified Resume protocol** below. Nothing here changes that protocol's own logic.

- **Mechanism (ADR-0003):** no pull API for session-window-remaining exists. `statusline.mjs` already receives the harness's `rate_limits` payload (Pro/Max only, push-based, after the first response) and now writes it — best-effort, narrow — to `.forge/autopilot/usage.json` on every invocation. That turns the harness's own UI-refresh cadence into a de-facto poll autopilot can read.
- **When to check — between tickets, at the same safe boundary the loop already uses (never mid-ticket, mid-gate, or mid-merge):** after a delivery subagent returns and its outcome is recorded (§ Orchestration step 2), **before** spawning the next one. Read `.forge/autopilot/usage.json` (`sessionpause.mjs` `evaluateSessionPause(cwd)` — or `node "${CLAUDE_PLUGIN_ROOT}/scripts/autopilot/sessionpause.mjs"` as a thin CLI, exit code 3 = pause).
- **The decision is data- and config-gated, never a guess:** `evaluateSessionPause` returns `pause:false` — i.e. the loop simply continues as it always has — whenever the usage file is **absent** (no Pro/Max statusline data, or no session yet), **stale** (older than a plausible refresh gap — the write is push-only, so a stale file could be from an idle or earlier session), or the threshold is **unconfigured** (`autopilot.sessionPauseThresholdPct` unset in `.claude/forge.json` — the safe, opt-in default; see `lib/config.mjs`). This must never block or degrade autopilot for a consumer without that data or who hasn't opted in.
- **On `pause:true`** (5h usage at/above the configured threshold, default suggested value **90**): stop spawning new deliveries at this safe boundary, checkpoint as usual (`run.json` already has everything — no extra state to save), and surface a pause notice with the reason `evaluateSessionPause` returned. Schedule or wait for continuation (e.g. `ScheduleWakeup`/an autonomous-loop pattern, per the ticket) rather than requiring a human to notice.
- **On resume (scheduled or human-triggered):** re-enter through the **existing, unmodified § Resume protocol** below — same steps, same order, no new resume path. In particular the in-session merge authorization is **not** file-backed (§ Merge-authorization preflight), so resume still re-obtains or degrades to PR-only exactly as it does today; this feature does not change that semantics.
- **Pure decision function:** `sessionpause.mjs` `shouldPause({ usedPercentage, thresholdPct = 90 })` — the boundary math only (no IO), mirroring `preflight.mjs`/`ledger.mjs`. `evaluateSessionPause` is the IO wrapper that combines the on-disk snapshot + config into the verdict above.

## Run ledger & report

The loop owns `.forge/autopilot/run.json`: the queue, and per ticket `merged | escalated | skipped | filed` with the PR/decision ref. A fresh session reads it to resume. At stop, print the report: how many merged, which parked (with why), which skipped, what new tickets were filed — and summarise the run on the delivery-log issue. A live board count adds a `convergence:` line (#506). When the local outbox (§ Monitor notifications, `forge-outbox`) still has items queued at report time, the report gains one trailing line naming the pending count — read-only, never a reason to treat the run as incomplete.

## Driver scripts (the executable spine)

The loop is prose the orchestrator runs, but its mechanical decisions are real, tested scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/autopilot/` — `select.mjs`, `merge.mjs`, `preflight.mjs`, `ratebudget.mjs`, `envpreflight.mjs`, `ledger.mjs`, `watchdog.mjs`, `newwork.mjs`, `perms.mjs` (Claude-only, § Permissions), `sessionpause.mjs` — plus two supporting pieces load-bearing for #407: `monitors/ci-watch.mjs`, `monitors/agents-watch.mjs`, `lib/board.mjs`, `lib/outbox.mjs`, `lib/lock.mjs`. The orchestrator invokes these via CLI/MCP — it never needs their exported-function signatures or design rationale inline to run the loop. Full per-script reference (signatures, pure-vs-IO split, the reasoning behind each): `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/reference/driver-scripts.md` (e.g. `envpreflight.mjs` → `evaluateEnvPreflight`/`probeEnv`, the § Environment preflight implementation).

The orchestrator holds the ship/gate/reviewer/security verdicts and passes them to the merge bar; the scripts never spawn subagents or drive the loop themselves.

## Cost & context on long runs (spec §11)

A long run stays bounded by construction — not by luck:

- **Delegate, don't inline (mandatory — see § Orchestration).** Each ticket is delivered in a discardable context — its **own spawned agent** — whose tokens die when the ticket ends. The outer loop never ingests code; it keeps only `run.json` + git + a **one-line outcome** per ticket, so overhead stays **~O(1) per ticket** no matter how long the run.
- **Checkpoint + reset is free.** Every ticket is written to `run.json`; the resume protocol reconstructs from disk, so the orchestrator can be compacted or restarted between tickets at near-zero reload cost.
- **Cheap where it can be.** `select.mjs` + the ledger are plain scripts (zero model cost); model tiering already applies inside delivery (haiku lookup / sonnet default / opus only for second-opinion).
- **Intrinsic vs. overhead.** Per-ticket delivery cost is the real work and can't be optimised away; what autopilot keeps ~constant is the *loop overhead*. The host OS is irrelevant to cost/context.

## Resume protocol

Fresh session: read `.forge/autopilot/run.json` for run state → `escalate.mjs --check` to pick up any decisions the human answered → **re-run the Merge-authorization preflight** (the in-session grant is *not* file-backed — a restarted session is a new session and must re-obtain a live grant, or degrade to PR-only) → re-select per the selection order (which naturally resumes a mid-flight ticket first) → continue the loop. (A full restart always needs a fresh grant. But a restart is not the only trigger: the harness classifier evaluates merge authorization per attempt, not once per session, so a later merge later in the *same*, uncompacted session can still be denied even after an earlier merge in that session succeeded — observed directly, repeatedly, in production runs (#397). There is no code-level way to predict this in advance (#398). When it happens, the loop's only recourse is the same pattern as the run-start preflight: stop, surface the denial to the user, and ask for a fresh explicit in-session grant before retrying the merge — not a new mechanism, just the existing one applied mid-run.)
