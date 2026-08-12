# Installing forge into a project

The full path from any repo — fresh or existing (cms included) — to a working forge setup. Every step is idempotent; re-running is always safe.

## 0. Prerequisites

| need | check | fix |
| --- | --- | --- |
| Claude Code | `claude --version` | claude.com/claude-code |
| Node ≥ 22.13 on PATH | `node --version` | nodejs.org (portable zip works — no admin needed) |
| gh CLI, authed, `project` scope | `gh auth status` | `gh auth login -s project` (existing auth: `gh auth refresh -s project`) |
| a git repo on GitHub | `git remote -v` | push it first — the board, tickets, and trail all live there |

> Running Antigravity instead of Claude Code? Same Node/git/gh prerequisites, plus the `agy` CLI on PATH (`agy --version`) — skip to [Antigravity (agy)](#antigravity-agy) below.

## 1. Install the plugin

Pick your host. From step 2 on this guide is host-agnostic — `/forge:init`, doctor, the gates, and everything after work the same way regardless of which one installed the plugin.

### Claude Code

In a Claude Code session inside the target repo:

```
/plugin marketplace add dngioidev/forge
/plugin install forge@forge
```

(or from the terminal: `claude plugin marketplace add dngioidev/forge` then `claude plugin install forge@forge`.)

This brings the 20 skills, the `/forge:*` commands, the safety + learning hooks, and the graph MCP server. Nothing runs against your repo yet.

### Antigravity (agy)

forge's engine is host-agnostic ([ADR-0007](../decisions/0007-cross-gai-mcp-first.md)); Antigravity, via its `agy` CLI, is the one adapter **proven end-to-end today** (Codex is deferred, see [#292](https://github.com/dngioidev/forge/issues/292)). Unlike Claude Code there is no marketplace — an agy-only adopter (no Claude subscription) needs a forge checkout to emit from. Three steps, start to finish:

**1. Get a forge checkout** — once; you reuse it for every project you adopt forge into, and for every future update:

```
git clone https://github.com/dngioidev/forge C:\tools\forge
```

(macOS/Linux: forward slashes, e.g. `~/tools/forge`.) Anywhere on disk works — the checkout is a source you emit *from*, never itself the target of the next step.

**2. Emit the plugin package into your project.** Run this from your **project's own directory** — not from inside the forge checkout — with an **absolute path** to the checkout's emitter:

```
cd C:\my\project
node C:\tools\forge\plugin\scripts\init.mjs --host agy
```

`init.mjs` resolves the output directory relative to the **current working directory**, not the forge checkout — running it while `cd`'d into the checkout emits the package into forge's own tree instead of your project. No `--out` is the recommended path: the package emits in place to `.agents/plugins/forge/` under your project and agy discovers it there — nothing to copy or relocate. agy ingests the Claude plugin format natively (skills, agents, and commands copied byte-for-byte, slash commands auto-converted to skills), so you get the same 20 skills and `/forge:*` commands as Claude Code.

**3. Commit the emitted package.** `.agents/plugins/forge/` is meant to be committed to your project's repo — that's what gives every teammate the same, version-pinned forge without each of them needing their own checkout. Nothing gitignores it for you: the bootstrap you run next ([§2 Bootstrap: `/forge:init`](#2-bootstrap-forgeinit), a separate command from the emit above) only ever adds `.forge/` to `.gitignore`, never `.agents/`. Expect roughly 126 files on the first commit — that's the package, not a mistake.

**Updating later:** re-run the exact command from step 2 — the emitter is a clean, idempotent re-emit of its own output directory, so there is no separate update command to learn. Commit the result; on an already-adopted repo that's a reviewable, all-at-once diff across the package's files, which is expected (the whole point of committing a version-pinned snapshot), not a sign something broke. For a copy install (you passed `--out` and ran `agy plugin install`), also re-run `agy plugin install "<out-dir>"` and `agy plugin validate forge` afterward so the installed copy picks up the refreshed files. To check what you're on: the emitted `.agents/plugins/forge/plugin.json`'s `version` field is the pinned forge version; compare it against your checkout's own `plugin/.claude-plugin/plugin.json` after `git -C C:\tools\forge pull` to see if an update is available. (Automating that comparison as a `forge:doctor` staleness check is tracked in [#431](https://github.com/dngioidev/forge/issues/431) — not built yet; this is a manual read for now.)

For a custom `--out` staging path, the MCP/hook wiring detail, Windows gotchas (MAX_PATH), and the full capability/parity matrix, see the [Cross-GAI guide](cross-gai.md).

## 2. Bootstrap: `/forge:init`

One command, two modes:

- **Adopt** an existing GitHub Project: have its number ready. Fields/options are **mapped as-is** — nothing on a live board is modified (ADR-0001); missing statuses are listed for you to add via the UI whenever you want them.
- **Create** a fresh project: full bootstrap — the 6-status Status field, Priority/Size/Type fields, all created for you.

Either mode also creates (only if missing): the pinned **delivery-log issue**, `.claude/forge.json` (committed — the repo's board ids + conventions), a `.gitignore` entry for `.forge/`, the **verify CI workflow** template, and (if you say yes) the status line in `.claude/settings.local.json`.

`forge.json` is where you set the verify command (`pnpm verify`, `npm test`, …), docs dirs, team members/roles, and feature flags — all optional beyond the board block.

### Docs structure — the route-index convention

A **fresh** `/forge:init` (no `forge.json` yet, and no `docs/` already on disk) also seeds a `docs/` structure so docs don't land with zero convention from day one:

```
docs/
  specs/       plans/      spikes/     design/     decisions/  guides/
  README.md    (the route index)
```

**Adopting** an existing repo — or a repo that already has a `docs/` directory in any shape, even one predating `forge.json` — leaves it completely untouched. Nothing is ever seeded over an existing layout.

One line each, what goes where:

- **specs/** — approved feature specs (the "what and why"; `forge:brainstorm` output).
- **plans/** — task-by-task implementation plans (`forge:plan` output).
- **spikes/** — time-boxed research findings / ADR drafts (`forge:spike` output; never merged as code).
- **design/** — visual specs for UI work (`forge:design` output).
- **decisions/** — ADRs: durable architectural decisions and their rationale.
- **guides/** — how-to documentation for humans (install, handbook, troubleshooting, runbooks).

`docs/README.md` is the **route index**: one line per doc, updated whenever a doc lands, moves, or renames (the `forge:ship` checklist enforces this). The `docsync` gate checks the index against `docs/` whenever the file exists, and still skips gracefully when it doesn't — seeding the structure doesn't change that gate.

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

### Local self-hosted runner (`runner` block — PRIVATE repos only)

Private repos have a metered monthly Actions-minute cap (Windows bills at 2×). A local self-hosted runner drops that GitHub bill to $0 and lets you afford heavier pipelines (ADR-0005). `/forge:init --runner` scaffolds the runner assets (see [handbook](handbook.md#local-self-hosted-runner-adr-0005) and `runner/README.md`); this section covers the **`runner` block in `.claude/forge.json`** that records the config those assets read. For end-to-end adoption steps (new + existing projects), per-OS host setup, and a troubleshooting runbook of the common issues, see the **[runner adoption guide](runner-adoption.md)**. To manage the fleet from a desktop app instead of by hand, see the **[cockpit](../../tools/runner-ui/README.md)** (`tools/runner-ui/`, ADR-0006).

> **Security rule — private repos only.** A self-hosted runner must **never** process fork/public-repo PRs: a fork can run untrusted code on your machine (GitHub's documented fork-PR RCE). `/forge:init --runner` **refuses on a public repo**, and if this repo ever goes public the runner wiring must be removed. Do not enable a runner on anything a stranger can open a PR against.

Add the block only if you run a local runner — it is entirely optional and off by default:

```jsonc
// .claude/forge.json
"runner": {
  "enabled": true,                                  // default false — runner off until you opt in
  "labels": ["self-hosted", "linux", "forge-local"], // routing labels the workflow targets
  "sharing": "repo",                                // "repo" (default, solo) | "org" (team, opt-in)
  "windows": "native",                              // "native" (default when a Windows box is present) | "hosted" (fallback)
  "advancedCi": {                                   // decision 5 — all off by default, owner-gated (may spend money)
    "linuxMatrix": false,
    "deploySmoke": false,
    "nightly": false
  }
}
```

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. Absent or `false` = no local runner. |
| `labels` | `["self-hosted","linux","forge-local"]` | Labels the runner registers with and `verify.yml` targets, so jobs route to your box and only your box. |
| `sharing` | `"repo"` | `"repo"` registers the one physical box **per private repo** (solo/personal accounts — N registrations, zero org setup). `"org"` points at an org runner group so **one** registration serves all repos — the only path GitHub calls true sharing, and it needs a (free) org. |
| `windows` | `"native"` | `"native"` runs the Windows leg on a native Windows host runner at $0 (default when you develop on Windows). `"hosted"` is the fallback when no Windows box exists — the Windows leg runs as a normal per-PR check on hosted `windows-latest` (billed per PR); Linux stays free on the local runner. |
| `advancedCi.*` | all `false` | Optional upside (decision 5): `linuxMatrix` (full Linux matrix per PR), `deploySmoke` (build + `terraform plan`, never `apply`), `nightly` (maintain + graph reindex + security sweep). Off by default because anything that provisions infra or hits a paid API is **owner-gated**. |

**Solo vs. team boundary (honest):** on a personal account, `sharing: "repo"` is the real default — "many repos on one box" is achieved operationally (one machine, one registration per repo), because GitHub runner *groups* are an org/enterprise construct. True one-registration-serves-many sharing (`sharing: "org"`) requires moving the private repos into a (free) org. Pick `repo` unless you already run an org.

Malformed values are rejected by `/forge:doctor` and any config load (e.g. `sharing: "enterprise"`, a non-boolean `enabled`); omitted fields take the defaults above.

## 5. Working in it

Everything is ticket-first: `/forge:ticket` for quick triage, then the lane skills (ideate → brainstorm → design → plan → execute → ship → release; hotfix/respond/maintain for care). `forge board status` (or the status line) is the one-glance catch-up. The owner merges every PR — agents never do.

## 6. Migrating from superpowers

forge replaces ship / plan+execute / brainstorm one-for-one. Once installed and init'd: `claude plugin uninstall superpowers` from the consumer repo's checkout. Keep both during a transition if you like — the skills don't collide, but two ship rituals is one too many.

## Troubleshooting

- **`gh: command not found` inside scripts** — gh must be on the *user* PATH, not just the shell profile. On Windows, a portable install to `%LOCALAPPDATA%` works: add the gh `bin` directory (e.g. `%LOCALAPPDATA%\GitHub CLI`) to your user `Path` via System Settings → Environment Variables, then restart the shell so spawned scripts inherit it.
- **`token lacks the 'project' scope`** — `gh auth refresh -s project`.
- **Board writes fail with dangling ids** — someone edited field options in the UI; re-run `/forge:init` to re-map, then `/forge:doctor`.
- **Anything else** — `/forge:doctor` first; its hints are the supported fixes.
