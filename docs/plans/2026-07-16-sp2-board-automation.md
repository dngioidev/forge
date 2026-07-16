# SP2 — Board automation — Implementation Plan

**Epic:** #2 · **Spec:** [platform design v3.7](../specs/2026-07-15-forge-platform-design.md) §6 §7
**Branch:** `feat/2-board-automation` · **Verify:** `pnpm verify` · **Date:** 2026-07-16

## Acceptance criteria

- **AC-2.1** — `create`: one command produces issue + parent sub-issue link + board item + all four fields + assignee; a re-run with the same title+parent duplicates nothing and resumes any missing step.
- **AC-2.2** — `move`: transitions status by config key (`backlog`…`done`); an unknown key errors listing the valid keys for this repo.
- **AC-2.3** — `comment`: posts a ticket-trail comment tagged by phase; a second call for the same phase updates that comment in place (never stacks).
- **AC-2.4** — `receipt` + `log`: merge receipt per issue and delivery-log row per PR, both idempotent by marker (re-run updates, never duplicates).
- **AC-2.5** — `digest`: the epic body carries a managed block (`<!-- forge:digest -->`) with a live child table (status/assignee, blocked-first ordering); refresh rewrites only inside the markers.
- **AC-2.6** — `status`: prints the minimal catch-up card from board data — counts per status, in-progress and blocked lists (situation-awareness upgrades at SP3).
- **AC-2.7** — every script resolves IDs from `forge.json` only; suite green on windows + ubuntu CI.

## Tasks

- **T1 — board context lib** (`plugin/scripts/lib/boardctx.mjs` + tests): loads forge.json + repo info once; item ops (find item by issue number via `gh project item-list`, add by URL, set single-select field); status/priority/size/type key→optionId resolution with valid-keys error text; managed-block replace helper (begin/end markers) shared by digest/receipt/comment.
- **T2 — `create`** (`scripts/board/create.mjs` + tests): find-by-exact-title first → `gh issue create` (+assignee) → sub-issue link via GraphQL `addSubIssue` (skip when parent already set) → board add → field set ×4. Each step detect-before-create (AC-2.1 resume test: item added but fields unset → only fields fire).
- **T3 — `move`** (`scripts/board/move.mjs` + tests): `--issue N --status <key>`; AC-2.2.
- **T4 — `comment`** (`scripts/board/comment.mjs` + tests): `--issue N --phase <p> --body …`; marker `<!-- forge:trail:<p> -->`; list comments → PATCH in place or POST new; AC-2.3.
- **T5 — `receipt`** (`scripts/board/receipt.mjs` + tests): `--issue N --pr N --sha … --title …`; marker `<!-- forge:receipt:pr-<n> -->`; AC-2.4a.
- **T6 — `log`** (`scripts/board/log.mjs` + tests): row comment on `board.deliveryLogIssue`, marker per PR; AC-2.4b.
- **T7 — `digest`** (`scripts/board/digest.mjs` + tests): children via GraphQL `subIssues`; join board status/assignee; blocked/escalated first; managed block in the epic body via `gh issue edit`; AC-2.5.
- **T8 — `status`** (`scripts/board/status.mjs` + tests): board-derived catch-up card; AC-2.6.
- **T9 — skill + commands**: `plugin/skills/board/SKILL.md` (forge:board — when/how to call each script, trail-moment map from spec §6) + `plugin/commands/ticket.md` (quick create wrapper).
- **T10 — ship**: PR with AC checklist; trail comments on #2 at each moment; receipt/log/digest dogfooded on this very epic after merge.

## Out of scope

Flow metrics in digest (SP7) · situation derivation + journal-driven card (SP3) · `forge:triage` skill logic (SP3 — `/ticket` here is create-wrapper only, not triage judgment).
