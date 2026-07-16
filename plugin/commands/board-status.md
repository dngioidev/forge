---
description: Print the forge catch-up card — situation, counts, blocked/in-progress items, open PRs, next action
---

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board/status.mjs"
```

Relay the card verbatim (it is already terse). If anything is 🚩 blocked, surface those first — they are waiting on a human decision.
