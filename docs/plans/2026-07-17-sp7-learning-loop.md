# SP7 — Learning loop: capture hooks + /distill + digest flow metrics

**Ticket:** #9 · **Branch:** `feat/9-learning-loop` · **Spec:** §8 (learning loop), §5 (digest flow metrics), rollout row 7.

The journal format + append/read/redaction landed in SP3 (`plugin/scripts/lib/journal.mjs`). SP7 adds the three missing pieces: automatic **capture** (hooks that feed the journal), **distill** (cluster → human-approved lessons → archive), and the digest **flow metrics** computed from data the board + journal already hold.

## Tasks

- [ ] T1 — Capture hook: `plugin/hooks/capture.mjs` (PostToolUse/Bash). Failing commands → `cmd-fail`; failing gate scripts (`scripts/gates/`) → `gate-fail`. Read-only commands (grep/ls/cat/rg/find/git log|status|diff|show/gh …view|list/…) excluded **at capture time**; compound commands capture if any segment is non-read-only. Branch/ticket from `.git/HEAD` + `parseBranch`; `err_line` = last stderr line, redacted by `journal.append`. Fail-open + silent: no exit code in the payload, or any internal error ⇒ capture nothing, never block. Wire into `hooks.json`.
- [ ] T2 — Denylist journals: `plugin/hooks/denylist.mjs` appends `blocked-edit` (cmd + rule) when it blocks. Journaling failure never changes the block/allow decision.
- [ ] T3 — Distill mechanics: `plugin/scripts/learn/distill.mjs`. `clusterEvents(events)` groups by kind + normalized signature (gate name / first command token / escalation reason); `renderReport(clusters)` proposes per cluster one of CLAUDE.md rule / role-card edit / lint-or-hook guard / memory entry, with counts + example refs. CLI: default report mode; `--archive` moves the live journal to `.forge/journal-archive/<date>.jsonl` and starts it empty. Empty journal ⇒ "nothing to distill", exit 0.
- [ ] T4 — /distill front door: `plugin/commands/distill.md` + `plugin/skills/distill/SKILL.md`. Law (spec §8 + automation ceiling): a **maintainer approves each proposal** before anything is written; applied lessons land as a **PR**; archive only after apply; rejected clusters keep their evidence in the archive.
- [ ] T5 — Digest flow metrics: `plugin/scripts/board/digest.mjs` gains a Flow section in the managed block — per done child cycle time (createdAt→closedAt via extended `getSubIssues`), size estimate next to actual, median cycle, gate-fail / backend-fallback / escalation counts from the journal since last archive. Metrics we can't compute honestly yet (backend cost) are omitted, not faked.
- [ ] T6 — Docs route index + live dogfood: run `distill.mjs` report against this repo's real `.forge/journal.jsonl`; trigger a real capture; refresh digest with metrics live.

**Files:** plugin/hooks/capture.mjs, plugin/hooks/denylist.mjs, plugin/hooks/hooks.json, plugin/scripts/learn/distill.mjs, plugin/scripts/board/digest.mjs, plugin/scripts/lib/issues.mjs, plugin/scripts/lib/journal.mjs, plugin/commands/distill.md, plugin/skills/distill/SKILL.md, docs/README.md

## Acceptance criteria

- AC-7.1 — a failing non-read-only Bash command is captured as `cmd-fail` with branch/ticket and a redacted `err_line`; a read-only command (single or fully read-only compound) is excluded at capture time; a payload without a determinable exit code captures nothing.
- AC-7.2 — a failing gate script is captured as `gate-fail` with the gate name.
- AC-7.3 — a denylist block appends a `blocked-edit` event; a journal write failure still blocks with exit 2.
- AC-7.4 — distill clusters repeated events by kind+signature, renders one proposal per cluster with counts, and reports "nothing to distill" on an empty journal.
- AC-7.5 — `--archive` moves the journal to `.forge/journal-archive/<date>.jsonl` and leaves the live journal empty; re-running archive with no journal is a no-op.
- AC-7.6 — the digest managed block carries flow metrics: cycle time per done child with size alongside, median cycle time, and journal event counts.
- AC-7.7 — the /distill skill + command state the human-approval law: maintainer approves every proposal, lessons land as a PR, distill is never auto-run.

## Out of scope

- Digest **stalled-items** section (green PRs unmerged, unpromoted deploys, unanswered decisions with age) — lands with SP11 `forge:maintain`, which owns the cadence that consumes it; `doctor` flags the same list there.
- Backend **cost** per shipped ticket — the journal records role/backend/prompt-hash but no spend; wiring cost needs console telemetry (SP9a).
- `review-finding` capture from reviewer report JSON — the execute/ship skills already own that append (spec §8); no hook can see it.
