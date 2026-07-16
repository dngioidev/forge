---
description: Render forge.json conventions into CLI-native context files (GEMINI.md/AGENTS.md managed blocks) and write CLI ignore files
---

Run from the repo root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/backends/sync.mjs"
```

Re-run whenever `.claude/forge.json` conventions change. The managed block is fenced (`<!-- forge:context:begin/end -->`) — hand-written content outside it always survives. The ignore files (`.geminiignore`, `.codexignore`) keep env files, keys, terraform state, and `.forge/` away from third-party CLIs (spec §13).
