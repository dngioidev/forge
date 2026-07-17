---
description: Turn journal evidence into approved lessons — cluster repeats, propose fixes, maintainer approves each, archive.
---

Run the forge distill ritual (skill `distill`). Human-invoked only — `/distill` is at the permanently-human rung of the automation ladder and is never auto-run.

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn/distill.mjs"` — cluster the journal, render proposals.
2. Present every proposal to the maintainer; **each one needs an explicit yes** before anything is written.
3. Apply approved lessons on a branch → PR (ticket-first: a `chore` ticket for the distill round).
4. After apply: `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn/distill.mjs" --archive` — rejected clusters keep their evidence in the archive.
