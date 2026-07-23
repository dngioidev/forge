# forge

> A portable AI development platform that runs inside Claude Code — turning a backlog into merged, reviewed, gated pull requests.

[![verify](https://github.com/dngioidev/forge/actions/workflows/verify.yml/badge.svg)](https://github.com/dngioidev/forge/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.16.0-blue.svg)](CHANGELOG.md)

## What is forge?

forge is a plugin for [Claude Code](https://docs.claude.com/en/docs/claude-code) that installs a complete software-delivery pipeline: 20 pipeline skills across 5 lanes, a 12-role Claude-native agent roster, GitHub Projects board automation with a ticket-trail law, mechanical ship gates, a learning loop, and a graph-RAG code index. You describe the work as tickets; forge plans it, writes it, reviews it, gates it, and opens a pull request for you to merge.

**Who it's for:** developers and small teams who work in Claude Code and want an opinionated, auditable pipeline — every change ticketed, planned, reviewed, and gated — instead of ad-hoc prompting. It works on a fresh project or adopts an existing one.

## Quickstart

**Prerequisites**

| need | check | fix |
| --- | --- | --- |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | — | required host for the plugin |
| Node ≥ 22.13 | `node --version` | [nodejs.org](https://nodejs.org) |
| pnpm 10.14+ | `pnpm --version` | `corepack enable` then `corepack prepare pnpm@10.14.0 --activate` |
| git + a GitHub account | `git --version` | [git-scm.com](https://git-scm.com) |

**Install** (run these inside Claude Code):

```
/plugin marketplace add dngioidev/forge
/plugin install forge@forge
/forge:init
```

`/forge:init` wires forge into the current project (adopt-vs-create, board setup, status line, hooks). See the **[full install guide](docs/guides/install.md)** for prerequisites, per-feature wiring, and troubleshooting.

## What you get

- **Pipeline skills (5 lanes)** — front-of-pipeline (`ideate`, `brainstorm`, `spike`, `design`, `shape`), build (`plan`, `execute`, `execute-agents`, `deliver`, `ship`, `release`), care (`hotfix`, `respond`, `maintain`), knowledge (`distill`, `review`, `investigate`), and scale (`autopilot`, `triage`, `board`) — 20 in all. Each is a `/forge:<skill>` command.
- **Agent roster** — 12 Claude-native role subagents (planner, scoper, implementer, reviewer, security, test-architect, and more) spawned with fresh context for the job at hand.
- **Board automation** — GitHub Projects as the source of truth, with a ticket-trail law: every lifecycle moment is recorded on the driving issue. No silent side-work.
- **Mechanical ship gates** — AC mapping, plan-drift, doc-sync, test-intent, and a reviewer + security pass — enforced as scripts, not opinions.
- **Learning loop + graph RAG** — a distill flow that turns journal evidence into approved lessons, and a SQLite/ts-morph structural index (`graph-rag`) that answers reuse and blast-radius questions before new code is written.

## The pipeline builds itself

forge is built *by its own pipeline*. Every feature here was ticketed, planned, gated, trailed, and merged through the same skills it ships — so the README, the gates, and the roster you're reading about are also the ones that produced this repo.

## Documentation

- **[Install guide](docs/guides/install.md)** — prerequisites, adopt-vs-create, per-feature wiring, troubleshooting.
- **[Handbook](docs/guides/handbook.md)** — daily use: every flow, every gate, and exactly where the human is needed.
- **[Docs route index](docs/README.md)** — every spec, plan, ADR, and guide, one line each.
- **[Platform design spec](docs/specs/2026-07-15-forge-platform-design.md)** — the whole design in one document.

## Laws worth knowing before you disagree with a gate

Ticket-first, always — silent side-work is forbidden. The owner merges every PR. Situations (incident, security-response) change what's *allowed*, not what's suggested. Gates are mechanical scripts — run them, don't argue with them. `"Unknown" is a valid answer.`

## Contributing & community

Contributions follow forge's own pipeline. Start with the **[Contributing guide](CONTRIBUTING.md)** — setup, `pnpm verify`, branching/commit conventions, and how PRs are reviewed. All participation is governed by the **[Code of Conduct](CODE_OF_CONDUCT.md)**. To report a vulnerability, see **[SECURITY.md](SECURITY.md)** — private reporting, never a public issue.

## License

forge is released under the [MIT License](LICENSE).
