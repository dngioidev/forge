---
name: execute-agents
description: Like forge:execute, but each plan task is driven by real subagents — scoper → test-architect → implementer → reviewer spawned via the Task tool, while the main loop keeps the ledger, gates, and resume protocol. Use when you want the per-task work fanned out to fresh-context role subagents instead of run inline.
---

# forge:execute-agents

The subagent-fan-out variant of `forge:execute`. Same order-is-law loop and the same ledger — the difference is **who does the work**: every role step is a **Task-tool subagent spawn**, not inline main-loop work. Use this when you want each task's scope/test/implement/review done by a fresh-context specialist; use plain `forge:execute` when inline is enough.

## Division of labour (the rule that makes this worth it)

- **The orchestrator (this main loop) owns state and never writes task code itself:** branch, `.forge/progress.md` ledger, `.forge/scope.json`, the gates, trail comments, the resume protocol, and every escalation decision.
- **Subagents own one unit of work each and return a report, not a conversation.** Spawn them from the compiled definitions in `plugin/agents/<role>.md` (Task tool, `subagent_type: <role>`). Each returns its terminal JSON report (`verdict` + `findings`); the orchestrator consumes the JSON, updates the ledger, and decides the next step. Never let a subagent drive the loop or spawn its own subagents.

## Setup

1. Branch per git conventions: `<type>/<issue#>-<slug>` cut from up-to-date main.
2. Init the ledger: `.forge/progress.md`, one line per plan task (`- [ ] T1 — title`). Trail-comment `--phase started`.

## Per-task loop (orchestrator marks `[~]` at start, `[x]` + note at end)

For each task, spawn in order and act on each report before the next:

1. **Scope** — spawn `scoper` (read-only) with a brief: ticket ref, the task's declared Files list, the plan section. It returns the touched surface + blast radius. Legitimate extra surface → the orchestrator writes `.forge/scope.json` (never the subagent, never silently).
2. **Failing tests first** — spawn `test-architect` with a brief: the task's AC ids + test plan. It writes AC-ID-titled tests and confirms each fails for the expected reason. Bug fixes: regression test first, no exceptions. The orchestrator verifies red before proceeding.
3. **Implement** — spawn `implementer` with a brief: the failing tests, the task's Files list, repo conventions. It makes the tests pass with the smallest correct change and nothing beyond the task. Orchestrator runs the scoped tests + full verify green.
4. **Per-task review** — spawn `reviewer` (and `design-reviewer` on UI tasks when `features.designReview`) on the task diff. Findings come back severity-tagged; the orchestrator fixes them (a fresh `implementer` spawn) or tickets them **before** marking the task done.
5. New dependency introduced? Run the dep guard now, not at ship: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/depguard.mjs"`.

Independent read-only briefs (e.g. scoping several tasks up front) may be spawned concurrently; the write steps (2→3→4) are strictly sequential within a task.

## Whole-branch finish

1. Spawn `reviewer` + `security` on the full branch diff; fix waves (fresh `implementer` spawns) until both come back clean.
2. Mechanical gates (same as `forge:ship`, run by the orchestrator — subagent reports are never a substitute for these):
   - `gates/plandrift.mjs --plan <plan>` — off-plan files ⇒ escalate or extend `scope.json` with a reviewer-visible note.
   - `gates/testintent.mjs` — weakened existing assertions ⇒ reviewer sign-off in the PR or revert.
   - `vitest run --reporter=json --outputFile=.forge/results.json` then `gates/acgate.mjs --plan <plan> --ticket <n> --results .forge/results.json`.
3. Hand to `forge:ship`.

## Report contract (what the orchestrator relies on)

Every role subagent ends with the terminal JSON block its card specifies (`{"verdict":"pass|fail","findings":[…]}`). The orchestrator consumes **that**, never the prose. A subagent that returns no parseable report is re-spawned once with the violation named; a second miss is an escalation, not a guess.

## Resume protocol (spec §4 — no human re-briefing)

A fresh session: read `.forge/progress.md` (`next()` = first non-done task) → read `.forge/decisions/` for resolved answers (`escalate.mjs --check`) → `git status`/log to confirm branch state matches the ledger → resume the loop from that task, spawning subagents as above.

## Escalation triggers here (spec §7)

Same gate failing twice · blast radius beyond the plan · reviewer/implementer deadlock across re-spawns · a subagent that can't produce a valid report · any denylist-blocked need. `escalate.mjs`, then stop.
