---
name: ship
description: Branch → PR → merged ritual with gates, trail comments, and the post-merge board ritual. Use whenever work on a branch is ready to become a PR, and after the owner merges it.
---

# forge:ship

Branch → PR with gates, then the post-merge ritual. Since SP5 the core gates are **mechanical scripts** — run them, don't re-argue them. (Still staged: deploy-readiness runs via the consumer workflow, SP4b.)

## Pre-PR checklist (in order — a failed gate stops the ritual)

1. **Situation gate** (spec §7): `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/situationgate.mjs" --action ship --branch <branch>` — during an incident only `hotfix/*` ships; during security-response nothing ships. A refusal names the unlocking command; don't argue with it.
2. **Conventions lint** (spec §2): branch matches `<type>/<issue#>-<slug>`; every commit `type(scope): subject (#issue)` ≤72 chars; intended PR title is conventional-format with the issue ref. The commit-subject rule is enforced mechanically — `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/conventions.mjs" --base main` rejects any empty, punctuation-only, or non-conventional subject (e.g. a squash that landed as `@ (#297)`). **Spike branches never ship** — a `spike/…` branch asking for a PR is refused outright (spec §4 item 12: findings merge as ADRs, code is re-implemented via plan/execute).
3. **Rebase on main**; run the configured verify command — must pass locally.
4. **Commits→issues map**: every commit has a ticket; otherwise apply the unplanned-work rule (trail `note` or triage).
5. **Mechanical gates** (spec §13):
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/plandrift.mjs" --plan <plan>` — off-plan files ⇒ escalate or a reviewer-visible `.forge/scope.json` extension
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/testintent.mjs"` — weakened existing assertions ⇒ explicit reviewer sign-off in the PR body, or revert
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/depguard.mjs"` — new-dependency violations ⇒ remove or escalate
   - **AC gate**: `vitest run --reporter=json --outputFile=.forge/results.json` then `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/acgate.mjs" --plan <plan> --ticket <n> --results .forge/results.json` — every AC id in a passing test, machine evidence only
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/docsync.mjs"` — a doc that isn't in the `docs/README.md` route index, or a newly-added skill not mentioned in `docs/guides/handbook.md` ⇒ update the index/handbook before shipping (keeps docs in step with what ships)
6. **Security pass** (`security` role card on the full branch diff): findings journaled; criticals escalate.
7. **Review pass** (`reviewer` role card; `design-reviewer` for UI when `features.designReview`).
8. **Honest verification statement** for the PR body: what ran, what passed, what was NOT verified. Never overstate.
9. Open the PR: `Closes #<n>` + commits→issues map + AC checklist + honest verification.
10. Trail: `--phase pr`; on checks: `--phase ci-green` or `--phase gate-fail` (cause + fix, repeat).
11. **CI-green check**: never ask for merge with failing checks.

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
