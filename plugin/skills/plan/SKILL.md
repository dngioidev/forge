---
name: plan
description: Spec → task-by-task implementation plan with machine-parseable sections (Files lists, AC map, test plans). Use after a spec is approved and before execute.
---

# forge:plan

Spec → plan in the consumer's plans dir (`conventions.plansDir`). The plan is a **contract**: plan-drift and the AC gate parse it mechanically at ship — its sections are grammar, not decoration.

## Plan template (machine-parseable parts are load-bearing)

```markdown
# <name> — Implementation Plan
**Epic:** #<n> · **Spec:** <link> · **Branch:** <type>/<n>-<slug> · **Verify:** <cmd>

## Acceptance criteria
- **AC-<n>.1** — <verifiable statement>            ← ids used in test titles
…

## Tasks
### T1 — <title>
**Files:** path/one.mjs, path/two/ , tests/one.test.mjs   ← plan-drift parses these lines
**AC map:** AC-<n>.1, AC-<n>.3                            ← acgate parses these
<approach, key code sketch>
**Test plan:** cases, edge matrix (incl. Windows paths/CRLF where relevant), layers per spec §13
**Done:** <criteria>
```

## Rules

1. Every task carries a `**Files:**` line (dirs end with `/`) and an `**AC map:**` line; every AC id appears in ≥1 task.
2. `test-architect` drafts the test-plan sections — AC-ID-titled tests (`test('AC-7.2: …')`) so the runner output satisfies the gate.
3. `features.e2e` repos: critical-path E2E cases go in the test plan of the task that completes the path.
4. Bug tickets: the regression test is T1, before any fix task.
5. **Plan gate is auto by default** — commit the plan to main (`docs(plan): … (#n)`), update the route index, trail-comment the ticket (`--phase plan`), and proceed to execute. Only pause for sign-off when `team.policy.approvals.plan` exists.
6. Scoper narrows before planning when the blast radius is unclear — its file list feeds the Files lines; write `.forge/scope.json` (`{"files":[…]}`) when execute discovers legitimate extra surface.
