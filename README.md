# forge

A portable AI-dev-platform plugin for Claude Code: 20 pipeline skills in 5 lanes, a 12-role Claude-native agent roster, GitHub Projects board automation with a ticket-trail law, mechanical ship gates, a learning loop, and a graph-RAG index. The platform ships itself — every feature here was planned, gated, trailed, and merged through its own pipeline.

## Install

```
/plugin marketplace add dngioidev/forge
/plugin install forge@forge
/forge:init
```

**[→ Full install guide](docs/guides/install.md)** — prerequisites, adopt-vs-create, per-feature wiring, troubleshooting.

**[→ Handbook](docs/guides/handbook.md)** — daily use: every flow, every gate, and exactly where the human is needed.

## Find anything

- [docs/README.md](docs/README.md) — the route index: every spec, plan, ADR, and guide, one line each.
- [Platform design spec](docs/specs/2026-07-15-forge-platform-design.md) — the whole design in one document.

## Laws worth knowing before you disagree with a gate

Ticket-first, always — silent side-work is forbidden. Owner merges every PR. Situations (incident, security-response) change what's *allowed*, not what's suggested. Gates are mechanical scripts — run them, don't argue with them. `"Unknown" is a valid answer.`

## Contributing

Contributions follow forge's own pipeline. Start with the **[Contributing guide](CONTRIBUTING.md)** — setup, `pnpm verify`, branching/commit conventions, and how PRs are reviewed. All participation is governed by the **[Code of Conduct](CODE_OF_CONDUCT.md)**. To report a vulnerability, see **[SECURITY.md](SECURITY.md)** (private reporting — never a public issue). forge is [MIT](LICENSE)-licensed.
