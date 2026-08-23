---
description: Adoption-readiness preflight for the local self-hosted runner — resolves the runner config and reports a single READY / NOT READY verdict
---

Run the local self-hosted-runner readiness preflight from the repo root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/runner/check.mjs"
```

It resolves the `runner` block in `.claude/forge.json` (defaults applied) and runs one end-to-end go/no-go pass — broader than the single runner-health line `/forge:doctor` prints — so someone adopting the runner on another project can confirm the whole setup in one shot. Each check prints one ✓/⚠/✗ line with a fix hint; it ends with a single **READY** / **NOT READY** verdict and exits nonzero when NOT READY.

What it checks (ADR-0005):
- private-repo guard (a self-hosted runner on a public repo is a fork-PR RCE — hard ✗);
- the `runner` block is present + enabled, with the effective labels / sharing / windows echoed;
- host prerequisites on PATH: `git`, `gh`, `node` (>=22.13), and `docker` reachable for the Linux container leg;
- PAT store safety: `~/.forge/runner.env` gitignored + untracked, no committed PAT (never prints the token);
- the runner is registered + online for the configured labels (plus the windows label set when `windows: native`);
- the `runner/` scaffold is present and a `verify` workflow targets the runner label;
- the pinned `actions-runner` version is not behind the latest release (deprecation staleness);
- live registration reconciliation against the resolved config (#490): flags registered-but-config-disabled, config-enabled-but-none-registered, and stale/offline registrations as warnings, degrades to a "could not verify" warning if the live lookup fails, and stays silent when config is disabled and nothing is registered.

Relay the results to the user:
- **NOT READY** (any ✗): list each blocker with its hint. The fixes are usually `/forge:init --runner` (scaffold/guards), the per-OS `~/.forge/runner.env` setup, or starting the runner/Docker service — see `docs/guides/runner-adoption.md`.
- **READY** (✓/⚠ only): say the setup is adoption-ready and list any ⚠ warnings with their hints — warnings are advisory (offline runner, stale pin, unrouted workflow), not blockers.

This command is read-only — it never mutates the repo, the board, settings, or the PAT store.
