---
name: execute
description: Plan → branch, task by task — scoper → failing tests → implement → review, with the ledger, per-task gates, and the resume protocol. Use after forge:plan.
---

# forge:execute

Plan → working branch. Order is law (spec §4 item 5); the ledger makes any session resumable.

## Setup

1. Branch per git conventions: `<type>/<issue#>-<slug>` cut from up-to-date main.
2. Init the ledger: `.forge/progress.md` with one line per plan task (lib/ledger.mjs grammar: `- [ ] T1 — title`). Trail-comment `--phase started`.

## Per-task loop (mark `[~]` at start, `[x]` + note at end)

1. **Scope** (`scoper` role when the radius is unclear): confirm the task's Files list; legitimate extra surface goes into `.forge/scope.json` — never silently.
2. **Failing tests first** (`test-architect` role or its card discipline): AC-ID-titled tests from the task's test plan; confirm each fails for the expected reason. Bug fixes: regression test first, no exceptions.
3. **Implement** (`implementer` role or its card discipline): make them pass; scoped test run + full verify green.
4. **Per-task review** (`reviewer`; + `design-reviewer` on UI tasks when `features.designReview`): findings fixed or ticketed before the next task.
5. New dependency? Run the dep guard *now*, not at ship: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/depguard.mjs"`.

## Whole-branch finish

1. Fix waves until the full-branch review (reviewer + security cards) is clean.
2. Pre-ship gates (also run by forge:ship):
   - `gates/plandrift.mjs --plan <plan>` — off-plan files ⇒ escalate or extend scope.json with a reviewer-visible note
   - `gates/testintent.mjs` — weakened existing assertions ⇒ reviewer sign-off in the PR or revert
   - `vitest run --reporter=json --outputFile=.forge/results.json` then `gates/acgate.mjs --plan <plan> --ticket <n> --results .forge/results.json`
3. Hand to `forge:ship`.

## Resume protocol (spec §4 — no human re-briefing)

A fresh session: read `.forge/progress.md` (ledger `next()` = first non-done task) → read `.forge/decisions/` for resolved answers (`escalate.mjs --check`) → `git status`/log to verify branch state matches the ledger → continue the loop from that task.

## Escalation triggers here (spec §7)

Same gate failing twice · blast radius beyond the plan · reviewer/implementer deadlock · any denylist-blocked need. `escalate.mjs`, then stop.
