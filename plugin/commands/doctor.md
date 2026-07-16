---
description: Read-only forge health check — gh auth, Node version, forge.json validity, board IDs, gitignore, branch protection, secret scanning
---

Run the forge health check from the repo root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

It prints one ✓/⚠/✗ line per check with a fix hint, and exits nonzero when any ✗ is present.

Relay the results to the user:
- All ✓/⚠: say the setup is healthy and list the warnings (⚠) with their hints — warnings are advisory (branch protection, secret scanning, status line), not blockers.
- Any ✗: list each failure with its hint. Offer to run `/forge:init` when the hint says so; do not hand-patch `forge.json` IDs or the board via ad-hoc GraphQL.

This command is read-only — it never mutates the repo, the board, or settings.
