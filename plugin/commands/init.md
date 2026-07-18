---
description: Bootstrap or adopt this repo's forge setup — GitHub Project, fields, delivery log, forge.json, gitignore, status line
---

Bootstrap forge for this repository (adopt-or-create, idempotent — safe to re-run).

1. Ask the user which mode applies, unless the arguments already say:
   - Adopt an existing GitHub Project: needs the project number.
   - Create a fresh project: needs a title (default: the repo name).
2. Ask whether to wire the forge status line into `.claude/settings.local.json` (recommended; it only merges the `statusLine` key, never touches other settings — local because the command embeds a machine-specific path).
3. Ask about **CLI backends**: the search/investigate roles (investigator, librarian) can run on a cheaper non-Claude CLI instead of Claude. Offer the shipped one — **agy (Gemini)**: "route the search roles to agy/Gemini? (needs the `agy` CLI installed; falls back to Claude if absent)". If yes, append `--roster agy:gemini-flash` (or `agy:gemini-pro`). Other runtimes (e.g. `codex:gpt-5`) can be set the same way but have no shipped adapter yet, so they fall back to Claude until one exists. Skip → Claude for everything (the safe default). Gate/write roles are never offered — they're pinned to Claude by law (spec §5).
4. Run the script from the repo root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --project <number>
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --create-project "<title>"
```

Append `--statusline` when the user said yes in step 2, and `--roster <backendId>` when they chose a backend in step 3. After a backend is scaffolded, run `/forge:backends-sync` to generate its context + ignore files.

4. The script prints each action taken and finishes with a doctor report. Relay the summary: what was created vs adopted, the forge.json path, and any doctor warnings with their fix hints. If the script exits nonzero, report the error verbatim — do not improvise fixes to the board by hand; hand-built GraphQL is exactly what forge exists to remove.

Notes:
- Status options: on an empty project the standard 6-status set is created automatically; on a board with existing items, options are mapped as-is and missing ones must be added via the UI (ADR-0001).
- The command needs gh authenticated with the `project` scope (`gh auth refresh -s project` if doctor flags it).
