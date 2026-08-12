---
description: Read-only forge health check — gh auth, Node version, forge.json validity, board IDs, gitignore, branch protection, secret scanning
---

Run the forge health check from the repo root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

It prints one ✓/⚠/✗ line per check with a fix hint, and exits nonzero when any ✗ is present.

When an emitted agy (Antigravity) adapter package is found at `.agents/plugins/forge/`, it also checks `agy` on PATH, the integrity of the three generated files (`plugin.json`, `mcp_config.json`, `hooks.json`) plus the deny/capture shims, unrewritten `${CLAUDE_PLUGIN_ROOT}` placeholders, and package staleness against this forge install's own version — see [the cross-GAI guide](../../docs/guides/cross-gai.md). Fully silent when no adapter package exists. Separately, if `features.agy` (the Gemini-offload flag) is on, it checks `agy` is reachable regardless of whether an adapter package was ever emitted.

Relay the results to the user:
- All ✓/⚠: say the setup is healthy and list the warnings (⚠) with their hints — warnings are advisory (branch protection, secret scanning, status line, agy staleness), not blockers.
- Any ✗: list each failure with its hint. Offer to run `/forge:init` when the hint says so; do not hand-patch `forge.json` IDs or the board via ad-hoc GraphQL.

This command is read-only — it never mutates the repo, the board, or settings.
