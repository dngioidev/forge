---
name: deliver
description: End-to-end delivery of one triaged ticket, driven by subagents, with a single human gate — the PR review. Classifies the ticket (spike/bug/ui/feature/test/chore) and routes to the flow that fits, auto-plans with typed tasks, runs the execute-agents subagent loop, ships to a PR, and stops. Halts only on spec §7 safety escalations. Use when a ticket is ready to become a merge-ready PR without step-by-step approval.
---

# forge:deliver

One triaged ticket → a merge-ready PR (or, for a spike, an ADR), unattended, with **exactly one human gate: reviewing the PR**. `deliver` is **kind-aware** — it doesn't assume plain implementation. It classifies the ticket and routes to the right flow, running every phase on subagents while the main loop orchestrates and owns all state.

## Output discipline (quiet run)

The trail, ledger, and journal are the record — don't re-narrate them in chat. Emit **at most one terse status line per phase** (`plan committed`, `PR #145 opened`, `merged`), never a paragraph, preamble, or recap. Don't announce a subagent spawn — spawn it, consume its JSON report, surface only its **verdict + one-line note**, not its working. Reserve prose for **escalations** (the decision + options) and the **final result** (the PR/ADR link + honest verification).

## The one-gate contract

- **The human is consulted once — at the PR.** Nothing between kickoff and PR asks for approval.
- **Still HALTS on genuine blockers (spec §7), never on routine choices:** critical security finding · denylist-blocked action · reviewer/implementer deadlock across re-spawns · same gate failing twice · planner `verdict: fail`. → `escalate.mjs`, stop.
- **Preconditions:** the ticket is triaged (clear ask + acceptance). Otherwise the planner returns `verdict: fail` — escalate, don't guess. `deliver` doesn't do discovery/spec work.
- **Orchestrator owns state, subagents own work:** branch, ledger, `scope.json`, gates, trail, escalations stay with the main loop; subagents return their terminal JSON report only.

## Phase 0 — Classify

Spawn `planner` (`subagent_type: planner`) with the ticket ref + body + any linked spec/design/ADR. It returns the **ticket kind** (`spike | bug | ui | feature | test | chore`) and a **typed task plan** (each task tagged `code | test | ui | infra`, with Files + AC-IDs + test plan). `verdict: fail` → escalate, stop. The orchestrator picks the route from the kind:

## Route table (kind → pipeline)

- **feature / chore** — write + commit the plan → **Execute** → **Ship**. (The baseline flow.)
- **bug** — spawn `investigator` to reproduce + root-cause first (attached to the ticket); the plan's **first task is a regression test**; then Execute → Ship. If an incident is open, ship under hotfix rules (situation gate).
- **ui** — plan → **Design**: spawn `designer` for token-grounded, a11y-first variants; the orchestrator **auto-selects the best against the visual spec + design tokens + a11y contract** (no human variant-pick — the choice is shown at the PR). Execute includes a `design-reviewer` pass per UI task. Then Ship.
- **test** — plan is `test-architect`-led (coverage/intent); Execute → Ship.
- **spike** — **does not ship code** (spec §4 item 12). Run the spike flow (investigate/prototype on subagents) → write findings as an **ADR** (`docs/decisions/`) → **auto-file a follow-up implementation ticket** (`board/create.mjs`, linking the ADR) → **stop**. Report the ADR + the new ticket; the human decides whether to `deliver` that. No code PR.

## Execute (all shippable kinds)

Run the **`forge:execute-agents`** loop against the plan. Per task, the executor spawns the role matching the task's `kind` — `code`→implementer, `test`→test-architect, `ui`→designer + design-reviewer, `infra`→devops — around the scoper/reviewer bookends, with the per-task gates. Orchestrator marks the ledger and consumes each report.

## Ship (all shippable kinds)

Run `forge:ship`: situation gate · conventions lint · rebase + verify · mechanical gates (`plandrift`, `testintent`, `depguard`, `acgate`) · full-branch `security` + `reviewer` subagents (criticals escalate) · open the PR with `Closes #<n>`, the AC checklist, and an **honest verification statement**. Trail `--phase pr` → `ci-green`.

## Stop — the human gate

Report the PR link (or, for a spike, the ADR + follow-up ticket) and the honest verification, then **stop**. The human reviews and merges; the post-merge ritual runs after they merge.

## Escalation triggers (the only pauses)

Critical security finding · denylist-blocked action genuinely needed · reviewer/implementer deadlock · same gate failing twice · planner `verdict: fail` · blast radius beyond the plan with no safe `scope.json` extension. `escalate.mjs`, then stop; resume via `escalate.mjs --check`.
