# Spike — forge whole-plugin self-audit (v0.15.0)

**Kind:** spike (review) · **Date:** 2026-07-21 · **Method:** ran the plugin's own tooling, then three parallel read-only audit passes (reference integrity · docs-vs-reality · test coverage + robustness).

Goal: sweep the whole forge plugin for gaps, mismatches, failures, and enhancement openings — and file a ticket for each real finding.

## Baseline — healthy

- **333/333 tests green** (`vitest run`).
- **Board clean** — only #15 (delivery log, open by design) was open before this audit.
- **`doctor` healthy** — one known `⚠ branch-protection` (spec §6), secret-scanning `n/a` on a private plan.
- **CI already runs `claude plugin validate ./plugin --strict`** (#149) and matrix tests on windows + ubuntu.

So this was a gap-hunt, not a firefight. Most of the #148 plugin-capabilities spike has since shipped (`bin/forge`, `themes/forge.json`, `monitors/`, manifest metadata, `plugin validate` in CI).

## Reference integrity — CLEAN at runtime

No broken references anywhere: every skill/command `${CLAUDE_PLUGIN_ROOT}/scripts/…` path resolves, every `forge:<skill>` cross-ref has a skill dir, every spawned agent name has an `agents/<name>.md`, `agents/` ↔ `cards/` are 1:1 (12 each), and every path in `hooks.json`/`monitors.json`/`plugin.json` exists. The only finding is dispatcher-coverage consistency → **#171**.

## Findings → tickets

| # | Kind | Pri | Finding |
|---|---|---|---|
| **#164** | bug | P1 | Autopilot run-ledger not crash-safe: `writeJson` non-atomic + `readJson` throws → a crash mid-write of `.forge/autopilot/run.json` wedges resume. `decisions-watch.mjs:24` shows the guarded pattern. |
| **#165** | test | P1 | `runRelease` mutating path untested — only the dry-run branch is exercised; all irreversible git/gh mutations (commit/tag/push/release) and the commit-failed-before-tag abort guard have zero assertions. |
| **#166** | bug | P2 | Autopilot kill-switch cites removed forge-control (`.forge-control/paused`, ADR-0003); no runtime produces that file. `SKILL.md:114`. |
| **#167** | item | P2 | Stale "Console daemon" section in `troubleshooting.md:35-41` tells users to run removed `serve`/`register` tooling (ADR-0003). |
| **#168** | item | P2 | Doc counts drift: README/install say "18 skills / 11 roles"; reality is 20 skills / 12 cards. Plus a dead link to `plugin/templates/shell-windows.md` (missing). |
| **#169** | item | P2 | `monitors.json` wires `forge-ci`/`forge-decisions` `on-skill-invoke:autopilot` to "react instead of poll", but `autopilot/SKILL.md` never consumes them — #148 Tier-2 value unrealized. |
| **#170** | item | P2 | No `LICENSE` file and no `license` field in `plugin.json`/`package.json` for a marketplace-distributed plugin (#148 T1.1 leftover). |
| **#172** | item | P2 | `bin/forge` dispatcher can't reach `statusline`/`agy`/`review`/`monitors` CLI entrypoints — consistency gap only (all are invoked by direct node path today). |
| **#173** | bug | P2 | `board/create.mjs` idempotency breaks for titles containing a double-quote — the interpolated `"<title>" in:title` search is malformed, the exact match misses, and a duplicate issue is created (spec §6 violation). Found *while filing these very tickets*: quoted title #4 created #167 then duplicate #171 on the resume run (#171 since closed as duplicate). |

## Checked and deliberately NOT ticketed

- **Graph DB in `${CLAUDE_PLUGIN_DATA}`** (#148 T2.4): the DB lives at `.forge/graph.db` in the *consumer project*, so it already survives plugin updates — N/A by design.
- **Injection surface:** `lib/exec.mjs` spawns `shell:false` with argv arrays only; no string-concatenated git/gh commands with ticket input. Clean.
- **`distill` as both command and skill:** intentional (slash-command entry vs model-invokable skill).
- **Version strings** across package.json / plugin.json / CHANGELOG all agree at 0.15.0.
