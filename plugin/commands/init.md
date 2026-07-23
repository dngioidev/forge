---
description: Bootstrap or adopt this repo's forge setup — GitHub Project, fields, delivery log, forge.json, gitignore, status line
disable-model-invocation: true
---

Bootstrap forge for this repository (adopt-or-create, idempotent — safe to re-run).

1. Ask the user which mode applies, unless the arguments already say:
   - Adopt an existing GitHub Project: needs the project number.
   - Create a fresh project: needs a title (default: the repo name).
2. Ask whether to wire the forge status line into `.claude/settings.local.json` (recommended; it only merges the `statusLine` key, never touches other settings — local because the command embeds a machine-specific path).
3. Run the script from the repo root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --project <number>
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --create-project "<title>"
```

Append `--statusline` when the user said yes in step 2.

4. The script prints each action taken and finishes with a doctor report. Relay the summary: what was created vs adopted, the forge.json path, and any doctor warnings with their fix hints. If the script exits nonzero, report the error verbatim — do not improvise fixes to the board by hand; hand-built GraphQL is exactly what forge exists to remove.

## `--runner` — scaffold a local self-hosted runner (ADR-0005, private repos only)

`--runner` is a distinct mode: instead of the board bootstrap it scaffolds the local self-hosted-runner assets so a **private** repo gets free CI (ephemeral Linux container runner + JIT supervisor, native-Windows host-runner setup, and a trimmed `verify.yml` — PRs Linux-only on the `forge-local` label, Windows main-only + nightly). It **refuses on a public repo** (`gh repo view --json isPrivate`) — a self-hosted runner must never process fork PRs.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --runner
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --runner --label my-box
```

It places assets under `runner/` (+ `.github/workflows/verify.yml`, or `verify.runner.yml` if one already exists), adds `**/.forge/`, `runner.env`, `*.runner.env` to `.gitignore` and the gitleaks allowlist, and prints the per-OS `~/.forge/runner.env` setup. It **never writes the PAT** — that fine-grained "Administration"-only token is set up out-of-band by the owner (see `runner/README.md`). Relay the printed owner steps.

Notes:
- Status options: on an empty project the standard 6-status set is created automatically; on a board with existing items, options are mapped as-is and missing ones must be added via the UI (ADR-0001).
- The command needs gh authenticated with the `project` scope (`gh auth refresh -s project` if doctor flags it).
