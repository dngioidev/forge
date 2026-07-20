# The forge handbook — install to daily use

Everything you do on the platform, flow by flow: what to run, what the agent does, where results appear, and exactly where **you** are needed. The [install guide](install.md) gets a repo set up; this is how you live in it.

## 0. The laws (everything below follows from these)

1. **Ticket-first.** Every change starts as an issue on the board; silent side-work is forbidden. Unplanned discoveries mid-work become a trail note (in-scope) or a new ticket (out-of-scope).
2. **The owner merges every PR.** Agents open PRs and wait; merge is always your click.
3. **Situations change what's allowed.** An incident or security-response mechanically blocks ship/release — not as advice, as an exit code.
4. **Gates are scripts, not opinions.** A refusal names its reason and the unlocking command. Don't argue with a gate; fix the cause or escalate.
5. **Honest verification.** Every PR states what was verified and what was NOT. "Unknown" is a valid answer.
6. **The trail is the record.** Every lifecycle moment lands as an idempotent comment on the driving issue — you can follow everything from GitHub Mobile.

## 1. Setup (once per repo)

Follow the [install guide](install.md): plugin install → `/forge:init` (adopt or create the board) → `/forge:doctor` → optional wiring (deploy, graph, design review).

## 2. The cockpit — where to look

| surface | what it shows | when to look |
| --- | --- | --- |
| **Status line** (bottom of every session) | situation glyph · active ticket · branch · pending-decision count | always on; a 🚩/🔥/🔒 glyph means you're needed |
| **`forge board status`** | the catch-up card: situation, column counts, pending decisions with age, next expected human action | back from time away |
| **Issue trail comments** | started / plan / spec / pr / gate-fail / escalation / ci-green / merged / note per ticket | reviewing any piece of work |
| **Epic digests** (managed block in the epic body) | live child table, blocked-first + flow metrics (cycle times, gate-fails) | tracking an epic |
| **Delivery log** (pinned issue) | one row per merged PR | the release history at a glance |

## 3. The Build loop — idea to shipped

The normal path, with your touch-points marked **[you]**:

1. **Capture** — `forge:ideate` for raw ideas → product notes; anything actionable goes straight to
2. **Ticket** — `/forge:ticket` (quick triage): issue created, board fields set (type/priority/size), status Backlog. **[you]** set priority when you care about order.
3. **Shape** (bigger features) — `forge:brainstorm` explores approaches and ends in a spec; **[you] approve the spec via a decision comment** — reply with your choice on the issue or in-session.
4. **Design** (UI-flagged tickets) — `forge:design` generates 2–3 real-token variants; **[you] pick one via decision comment**; the winner becomes a visual spec (speclint-enforced) that later review validates against.
5. **Plan** — `forge:plan` writes `docs/plans/…` with tasks and **AC-IDs** (acceptance criteria that must map to passing tests). Committed to main before work starts.
6. **Execute** — `forge:execute` works the plan task-by-task against a `.forge/progress.md` ledger (resumable mid-task). Tests come with the code. Variant: **`forge:execute-agents`** runs the same loop but fans each task out to role **subagents** (scoper → test-architect → implementer → reviewer) while the main loop keeps the ledger + gates.
7. **Ship** — `forge:ship` runs the gate ladder (section 6), opens the PR with the AC checklist + honest verification, waits for CI, posts trail comments throughout.
8. **Merge** — **[you] review and merge.** The agent then runs the post-merge ritual: receipt comment, delivery-log row, board → Done, branch cleanup, digest refresh.
9. **Release** — `forge:release` when you want a named version: computed readiness checklist → semver from conventional commits → changelog → tag → GitHub Release. In deploy repos it names the staging-verified image digest — release never builds.

**Autonomous variant:** **`forge:deliver`** runs steps 5→7 (plan → execute → ship) end-to-end on subagents for one triaged ticket — a `planner` drafts the plan, `execute-agents` does the per-task loop, ship opens the PR — with a **single human gate: the PR review** (step 8). It still halts on spec §7 safety escalations (security-critical, denylist, deadlock, gate-fail ×2).

**Board-clearing variant:** **`forge:autopilot`** (v0.9.0) runs `deliver` in a **continuous loop over the whole board**, one ticket at a time, until nothing actionable remains — and it **removes even the PR gate**. Two additions over deliver: an **auto-triage front door** (a `backlog` ticket is triaged before delivery; one that stays under-specified is escalated and skipped, never guessed) and **auto-merge on green**. The trust reversal is deliberate — in place of your review, a strict **automated merge bar**: `ship` green + all mechanical gates + `reviewer`/`security` subagents pass with zero critical/high + **CI green** → squash-merge to main. It is **fail-closed: nothing merges on red** — any red is a fix wave, a repeated failure escalates. The **only** pauses are real escalations (product broken with no safe fix · a design/behaviour decision that isn't the engine's to make · under-specified ticket · critical security · deliver's §7 triggers), and each **parks one ticket while the loop continues**. It can **file new bugs/spikes/follow-ups** mid-run (linked + trail-noted) so surfaced work is tracked, not dropped. Safe-by-default opt-out: `features.autopilotAutoMerge: false` stops at the open PR instead of merging. One ticket at a time in v1; parallel via a worktree pool is designed-for but deferred. Spec: `docs/specs/2026-07-21-forge-autopilot.md`.

## 4. Your interaction points (the complete list)

- **Decision comments** (`🚩 Decision needed` on an issue): reply with the option number or free text — on the GitHub issue or in-session. Both resume the pipeline identically.
- **PR merges** — every one (**except under `forge:autopilot`**, which auto-merges on a green bar; there your only touch-points are the escalations it parks).
- **Spec/design/brainstorm approvals** — decision comments like any other.
- **Environment-branch merges** — merging main into `staging` *is* the deploy authorization; nothing deploys without it. Production promote is a decision-gated human act.
- **`terraform apply`** — never automatic, ever.
- **`/distill` lessons** — you approve each proposed lesson individually; approved ones arrive as a PR.
- **Repo settings** doctor can only warn about: branch protection, secret scanning, Dependabot alerts, auto-delete merged branches.
- **The permission layer**: if a session asks you to confirm a destructive action by name, that's by design — name it or decline.

## 5. Care flows — when things break

- **Unknown-cause bug** → `forge:investigate`: reproduce → bisect → root cause attached to the ticket; feeds a planned fix (execute) or an urgent one (hotfix).
- **Production incident** → `forge:hotfix`: opens an `incident` journal event (statusline shows 🔥; ship/release freeze for non-hotfix branches), rollback-first decision ([runbook](rollback-runbook.md) — redeploy the previous digest; data corruption → [data-recovery runbook](data-recovery-runbook.md)), one-paragraph scope note instead of a plan, `hotfix/<n>-<slug>` branch, full deploy chain kept (staging smoke included). **Closing requires a postmortem ticket** — the command refuses without one.
- **Security signal** → `forge:respond`: containment before code — `respond-open` freezes deploys machine-wide (🔒), rotate/revoke credentials, forensics from the journal, disclosure if users affected; the fix ships via hotfix afterwards; `respond-close` needs the postmortem.
- **Dependencies** → `forge:maintain`: `maintain.mjs plan` batches patch/minor into one PR; majors get ONE coordinated ticket, never merged individually; `maintain.mjs advisories` SLA-stamps CVE alerts (critical 24h → low next-run).

## 6. The gate ladder (what ship runs, in order)

| gate | checks | on refusal |
| --- | --- | --- |
| situation | incident/security-response rules | close the emergency or use a hotfix branch |
| conventions | branch/commit/PR naming; spike branches never ship | rename/rebase |
| verify | the repo's test command, locally | fix the code |
| plandrift | touched files ⊆ plan's **Files** + defaults | escalate or extend scope visibly |
| testintent | weakened pre-existing assertions | reviewer sign-off in the PR body, or revert |
| depguard | new deps exist, are ≥90d old, ≥500 downloads | remove or escalate |
| acgate | every AC-ID in a passing test (runner JSON only) | write the missing test |
| docsync | every doc is in the route index; a new skill is in the handbook | update `docs/README.md` / `docs/guides/handbook.md` |
| security/review passes | role-card review of the diff | fix findings; criticals escalate |
| CI green | never ask for merge on red | fix, trail `gate-fail` with cause |

## 7. Knowledge flows

- **`forge:spike`** — time-boxed research on a `spike/` branch that never merges; the deliverable is an ADR in `docs/decisions/`. Ship refuses spike branches outright.
- **`/distill`** — after an epic or weekly: clusters the journal (gate-fails, blocked commands, incidents…) into proposed lessons; **you approve each**; lessons land as a PR; the journal archives. Never auto-run.
- **Docs** — every doc lands in `docs/` with a one-line entry in the route index (`docs/README.md`); ship maintains it.

## 8. Scale flows

- **`forge:review`** — standalone review of any PR (yours, a teammate's, an outside contribution) with severity-tagged findings.
- **`forge:audit` / `forge:docs` / `forge:migrate`** — spec'd (§4 items 15–17) but **not yet shipped**; they arrive when a real need schedules them. Don't look for them in the skill list yet.

## 9. Deploy + release (deploy-enabled repos)

```
merge PR → main (CI only, never deploys)
   [you] merge main → staging  ⇒ image built + staging deployed + smoke
forge:release              ⇒ names that digest vX.Y.Z (readiness checklist first)
   [you] approve promote   ⇒ production runs the SAME digest + smoke
```

Rollback = redeploy the previous digest (one command, runbook). Migrations are forward-only with a tested rollback story; staging runs them before production.

## 10. Config quick-reference (`.claude/forge.json`)

| block | what it controls |
| --- | --- |
| `board` | project/field/option ids — written by init, never by hand |
| `conventions` | verify command, docs dirs |
| `team` | members, roles, approval policy (solo default: you are maintainer of everything) |
| `features` | deploy · graph · designReview · e2e — all off by default |
| `deploy` | environments chain, healthcheck, registry |

## 11. When something's wrong

`/forge:doctor` first — every ✗ has a fix hint. Known issues + recovery ladders: [troubleshooting guide](troubleshooting.md). Gate refused: read its message, it names the unlock. Pipeline halted: check 🚩 decisions (`board status`). Board ids dangling: re-run `/forge:init`. Anything the platform can't decide arrives as a decision comment — answer it and work resumes.
