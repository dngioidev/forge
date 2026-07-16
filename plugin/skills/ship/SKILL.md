---
name: ship
description: Branch → PR → merged ritual with gates, trail comments, and the post-merge board ritual. Use whenever work on a branch is ready to become a PR, and after the owner merges it.
---

# forge:ship

Branch → PR with gates, then the post-merge ritual. Gates run degraded until later sub-projects upgrade them in place (spec §12 staged gates): role-card reviewer/security passes arrive with SP4, plan-based AC mapping + plan-drift with SP5, deploy-readiness with SP4b.

## Pre-PR checklist (in order — a failed gate stops the ritual)

1. **Conventions lint** (spec §2): branch matches `<type>/<issue#>-<slug>`; every commit `type(scope): subject (#issue)` ≤72 chars; intended PR title is conventional-format with the issue ref. Fix violations before anything else.
2. **Rebase on main**; run the configured verify command (`conventions.verify`) — must pass locally.
3. **Commits→issues map**: list each commit and its ticket. Any commit with no ticket → stop; apply the unplanned-work rule (trail `note` or a new ticket via triage).
4. **Security pass (degraded)**: review the full branch diff yourself, adversarially — injection, secrets, shell interpolation of untrusted strings, new dependencies (existence + age), CI/hook attack surface. Journal any finding: `review-finding`.
5. **AC check (degraded)**: every AC on the ticket maps to a passing test or a documented manual verification in the PR body. No honest map → not ready.
6. **Honest verification statement** for the PR body: what was run, what passed, what was NOT verified. Never overstate.
7. Open the PR: title conventional, body = `Closes #<n>` + commits→issues map + AC checklist + honest verification.
8. Trail: `comment.mjs --phase pr`; when checks finish: `--phase ci-green` (or `--phase gate-fail` with the cause + fix, then repeat).
9. **CI-green check**: never ask for merge with failing checks.

## Escalation triggers during ship (spec §7 — halt, don't improvise)

Critical security finding · the same gate failing twice · scope beyond the plan · any denylist-blocked action genuinely needed → `escalate.mjs --issue <n> --reason … --options …`, then stop. Resume via `escalate.mjs --check` after the human replies.

## Post-merge ritual (owner merged)

```
node .../scripts/board/receipt.mjs --issue <n> --pr <pr> --sha <merge-sha> --title "…"
node .../scripts/board/log.mjs --pr <pr> --sha <merge-sha> --issues "<n,…>" --title "…"
node .../scripts/board/move.mjs --issue <n> --status done
node .../scripts/board/digest.mjs --epic <parent>        # when the ticket has a parent epic
```

Then: delete the local branch, update the docs route index if the branch touched `docs/`, and verify the issue closed.
