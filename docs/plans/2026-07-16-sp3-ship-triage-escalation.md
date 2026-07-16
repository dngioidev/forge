# SP3 — Ship + triage + investigate + escalation + situation — Implementation Plan

**Epic:** #3 · **Spec:** [platform design v3.7](../specs/2026-07-15-forge-platform-design.md) §4 (items 2/6/13) §6 §7 §8 §13
**Branch:** `feat/3-ship-triage-escalation` · **Verify:** `pnpm verify` · **Date:** 2026-07-16

## Acceptance criteria

- **AC-3.1** — Journal: `lib/journal.mjs` appends kind-tagged JSONL to `.forge/journal.jsonl` and reads it back; secret-looking values (env-style tokens, key material) are redacted at append time; unknown kinds rejected.
- **AC-3.2** — Escalate: one command moves the ticket to `blocked`, posts a decision comment (context + options + recommendation, decision marker), journals an `escalation` event, and writes `.forge/decisions/<id>.json` pending; a resolution helper detects the human's reply comment and marks the decision resolved (journal `escalation-resolved`).
- **AC-3.3** — Situation: `status.mjs` derives the situation with spec §7 priority (`security-response` > `incident` > `awaiting-decision` > `building` > `idle`) from journal events + board state; the status line gains the situation glyph + pending-decision count without exceeding its silent-failure guarantee.
- **AC-3.4** — Denylist hook: a PreToolUse hook blocks destructive git/fs commands (force push, hard reset, recursive delete, history rewrite) with an escalate-instead message; allow-listed safe forms pass; hook never crashes the session (fail-open with a logged warning on internal errors).
- **AC-3.5** — Consumer CI template: `plugin/templates/verify.yml` (configured verify command + gitleaks + license check, SHA-pinned); `init` installs it when `.github/workflows/` lacks a verify workflow; doctor reports its absence.
- **AC-3.6** — Skills: `forge:ship`, `forge:triage`, `forge:investigate` SKILL.md files with checklists wired to the board scripts + journal + escalation (ship runs the degraded gates: conventions lint, commits→issues map, honest checklist, CI-green check, trail + receipt/log/digest/move ritual). Markdown — validated by dogfooding this very epic's ship.
- **AC-3.7** — Suite green on windows + ubuntu CI.

## Tasks

- **T1 — journal lib** (`plugin/scripts/lib/journal.mjs` + tests): `append(cwd, kind, data)` / `read(cwd, {since})`; kind enum from spec §8 (`gate-fail`, `blocked-edit`, `cmd-fail`, `backend-fallback`, `review-finding`, `escalation`, `escalation-resolved`, `incident`, `auto-approve`, `respond-open`, `respond-close`); redaction of secret-shaped values; `.forge/` auto-created.
- **T2 — escalate + resolve** (`scripts/board/escalate.mjs` + tests): `--issue N --reason … --options "a|b" --recommend a` → move blocked + decision comment (marker `decision:<id>`) + journal + pending file; `--check N` scans comments after the decision comment for a non-bot reply → resolves, journals, prints the decision text (session resume input, spec §7).
- **T3 — situation derivation** (`lib/situation.mjs`, wire into `status.mjs` + `statusline.mjs` + tests): journal scan (open respond/incident/escalations) + board blocked/in-progress counts → situation per §7 priority; statusline prefix glyph (🔒 security-response, 🔥 incident, 🚩 awaiting-decision n, ▶ building, · idle); statusline stays silent-on-error.
- **T4 — denylist hook** (`plugin/hooks/hooks.json`, `plugin/hooks/denylist.mjs` + tests): PreToolUse on Bash; patterns: `push --force`/`push -f` (allow `--force-with-lease` on work branches), `reset --hard` (allow bare/`HEAD`-relative on work branches? no — block, escalate), `clean -fd?x`, `rm -rf` outside temp, `filter-branch`/`filter-repo`, branch delete of main/env branches; exit-2 block with escalate message; fail-open on internal error (AC-3.4).
- **T5 — CI template + init/doctor step** (`plugin/templates/verify.yml`, edits to `init.mjs`/`doctor.mjs` + tests): template uses `conventions.verify`; gitleaks + license check jobs, SHA-pinned; init copies when missing; doctor warns when absent.
- **T6 — `forge:ship` skill** (`plugin/skills/ship/SKILL.md`): branch → PR ritual per spec §4 item 6 (degraded gates staged note), trail moments, post-merge ritual via board scripts.
- **T7 — `forge:triage` skill** (`plugin/skills/triage/SKILL.md`): dedup search → typed ticket with AC via `create.mjs`; severity→priority map.
- **T8 — `forge:investigate` skill** (`plugin/skills/investigate/SKILL.md`): repro → bisect → grep-narrow (graph at SP8) → root cause + fix proposal on the ticket; regression-test-with-fix law.
- **T9 — ship**: PR, trail comments at each moment, ship ritual via scripts (dogfoods T6's checklist manually one last time).

## Out of scope

Capture hooks + /distill (SP7) · role-card gates (SP4) · plan-based AC mapping + plan-drift (SP5) · console transport (9a) · `degraded`/`paused`/`migrating`/`maintenance` situations (need runner/queue/migrate machinery from later SPs — derivation covers them when their signals exist).
