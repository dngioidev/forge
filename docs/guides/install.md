# Installing forge into a project

The full path from any repo — fresh or existing (cms included) — to a working forge setup. Every step is idempotent; re-running is always safe.

## 0. Prerequisites

| need | check | fix |
| --- | --- | --- |
| Claude Code | `claude --version` | claude.com/claude-code |
| Node ≥ 22.13 on PATH | `node --version` | nodejs.org (portable zip works — no admin needed) |
| gh CLI, authed, `project` scope | `gh auth status` | `gh auth login -s project` (existing auth: `gh auth refresh -s project`) |
| a git repo on GitHub | `git remote -v` | push it first — the board, tickets, and trail all live there |

## 1. Install the plugin

In a Claude Code session inside the target repo:

```
/plugin marketplace add dngioidev/forge
/plugin install forge@forge
```

(or from the terminal: `claude plugin marketplace add dngioidev/forge` then `claude plugin install forge@forge`.)

This brings the 20 skills, the `/forge:*` commands, the safety + learning hooks, and the graph MCP server. Nothing runs against your repo yet.

## 2. Bootstrap: `/forge:init`

One command, two modes:

- **Adopt** an existing GitHub Project: have its number ready. Fields/options are **mapped as-is** — nothing on a live board is modified (ADR-0001); missing statuses are listed for you to add via the UI whenever you want them.
- **Create** a fresh project: full bootstrap — the 6-status Status field, Priority/Size/Type fields, all created for you.

Either mode also creates (only if missing): the pinned **delivery-log issue**, `.claude/forge.json` (committed — the repo's board ids + conventions), a `.gitignore` entry for `.forge/`, the **verify CI workflow** template, and (if you say yes) the status line in `.claude/settings.local.json`.

`forge.json` is where you set the verify command (`pnpm verify`, `npm test`, …), docs dirs, team members/roles, and feature flags — all optional beyond the board block.

## 3. Health check: `/forge:doctor`

Run it after init and any time something feels off. ✗ items block work and say how to fix; ⚠ items are **owner settings** worth doing early: branch protection on main, secret scanning + push protection, Dependabot alerts (feeds `forge:maintain`), and repo Settings → *Automatically delete head branches*.

## 4. Optional wiring (per feature, all off by default)

| feature | turn on | what you get |
| --- | --- | --- |
| deploy | `/forge:deploy-init` (sets `features.deploy`) | Dockerfile/compose/terraform scaffold, staging/production env-branch workflows, deploy-readiness gate, smoke script |
| graph | `features.graph: true` + `npm i -D ts-morph` + `node <plugin>/scripts/graph/graphctl.mjs rebuild` | structural index: find_component / who_uses / blast_radius / reuse_candidates MCP tools (TypeScript repos only — grep-first is the permanent fallback otherwise) |
| design review | `features.designReview: true` | design-reviewer validates UI work against visual specs |
| Gemini (agy) offload | `features.agy: true` + `agy` (Antigravity) on PATH | opt-in cross-model help via `agy --print` (Gemini), zero Claude cost — a **second opinion** (`scripts/review/agy-opinion.mjs`) and read-only **codebase Q&A** (`scripts/agy/ask.mjs`). Advisory, non-gating, read-only; optional `agy: { command, model }` config. (`features.geminiSecondOpinion` still accepted.) |

**Code intelligence (LSP, optional):** forge's graph MCP gives structural reuse/blast-radius answers; for real-time diagnostics and go-to-definition, install Anthropic's official LSP plugin for your language rather than one from forge — search `lsp` in the `/plugin` Discover tab (e.g. `typescript-lsp`, `pyright-lsp`, `rust-analyzer-lsp`). Install the language server binary first, then the plugin. forge deliberately doesn't bundle an LSP — the binary is yours to install.

**Theme (optional):** `/theme` → **Forge (smithy)** for forge's ember-on-steel identity.

## 5. Working in it

Everything is ticket-first: `/forge:ticket` for quick triage, then the lane skills (ideate → brainstorm → design → plan → execute → ship → release; hotfix/respond/maintain for care). `forge board status` (or the status line) is the one-glance catch-up. The owner merges every PR — agents never do.

## 6. Migrating from superpowers

forge replaces ship / plan+execute / brainstorm one-for-one. Once installed and init'd: `claude plugin uninstall superpowers` from the consumer repo's checkout. Keep both during a transition if you like — the skills don't collide, but two ship rituals is one too many.

## Troubleshooting

- **`gh: command not found` inside scripts** — gh must be on the *user* PATH, not just the shell profile. On Windows, a portable install to `%LOCALAPPDATA%` works: add the gh `bin` directory to your user `Path` (System Settings → Environment Variables, or `setx PATH "%PATH%;%LOCALAPPDATA%\GitHub CLI"`), then restart the shell so spawned scripts inherit it.
- **`token lacks the 'project' scope`** — `gh auth refresh -s project`.
- **Board writes fail with dangling ids** — someone edited field options in the UI; re-run `/forge:init` to re-map, then `/forge:doctor`.
- **Anything else** — `/forge:doctor` first; its hints are the supported fixes.
