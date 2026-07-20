---
name: deliver
description: End-to-end plan → execute → ship for one triaged ticket, driven by subagents, with a single human gate — the PR review. Auto-plans, runs the execute-agents subagent loop, ships to a PR, and stops. Halts only on spec §7 safety escalations. Use when a ticket is ready to become a merge-ready PR without step-by-step human approval.
---

# forge:deliver

One triaged ticket → a merge-ready PR, unattended, with **exactly one human gate: reviewing the PR**. The plan-approval and inline checkpoints of the normal pipeline are collapsed into that final review. This is the autonomous wrapper around `forge:plan` + `forge:execute-agents` + `forge:ship` — every phase runs on subagents; the main loop orchestrates and owns all state.

## The one-gate contract

- **The human is consulted once — at the PR.** Nothing between kickoff and PR asks for approval.
- **The pipeline still HALTS on genuine blockers (spec §7), never on routine choices:** a critical security finding, a denylist-blocked action, a reviewer/implementer deadlock across re-spawns, or the same gate failing twice → `escalate.mjs`, then stop. These are safety valves, not approvals.
- **Preconditions:** the ticket is already triaged (clear ask + acceptance). If it isn't, the planner returns `verdict: fail` — escalate rather than guess. `deliver` does not do discovery/spec work; run `forge:triage`/`forge:brainstorm` first.
- **Orchestrator owns state, subagents own work:** branch, ledger, `scope.json`, gates, trail, and every escalation decision stay with the main loop; subagents return their terminal JSON report and nothing more.

## Phase 1 — Plan (subagent)

1. Spawn `planner` (Task tool, `subagent_type: planner`) with a brief: the ticket ref + body, any linked spec/design/ADR. It returns an ordered task plan — each task with a **Files:** list, **AC-IDs** (`AC-<ticket>.<n>`), and a test plan — plus findings (risks/open questions).
2. `verdict: fail` (unplannable without a human decision) → escalate, stop.
3. Otherwise the **orchestrator** writes the plan to `docs/plans/<date>-<slug>.md` and commits it to main (no plan-approval gate — this is the collapsed step). Trail `--phase plan`.

## Phase 2 — Execute (subagent loop)

Run the **`forge:execute-agents`** loop against that plan: branch, ledger, and per task `scoper → test-architect → implementer → reviewer` spawned as subagents, with the per-task gates. The orchestrator marks the ledger and consumes each report. All of that skill's rules apply here unchanged.

## Phase 3 — Ship (gates + subagents → PR)

Run `forge:ship`:
1. Situation gate, conventions lint, rebase + verify green.
2. Mechanical gates: `plandrift.mjs --plan <plan>`, `testintent.mjs`, `depguard.mjs`, and the AC gate (`vitest --reporter=json` → `acgate.mjs --plan <plan> --ticket <n>`).
3. Full-branch `security` + `reviewer` subagents; criticals escalate (that's a §7 halt).
4. Open the PR: `Closes #<n>`, commits→issues map, AC checklist, and an **honest verification statement** (what ran, what passed, what was NOT verified). Trail `--phase pr` → `ci-green`.

## Stop — the human gate

Report the PR link and the honest verification, then **stop**. The human reviews and merges the MR. The post-merge ritual (`forge:ship`'s receipt → log → move) runs after they merge, as usual.

## Escalation triggers (the only pauses)

Critical security finding · denylist-blocked action genuinely needed · reviewer/implementer deadlock across re-spawns · same gate failing twice · planner `verdict: fail` · blast radius beyond the plan with no safe `scope.json` extension. `escalate.mjs --issue <n> --reason … --options …`, then stop. Resume via `escalate.mjs --check` after the human replies — the ledger + plan make it seamless.
