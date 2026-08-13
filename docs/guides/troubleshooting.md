# Troubleshooting — known issues and how to handle them

`/forge:doctor` first, always — every ✗ carries its fix. This guide covers what doctor can't see: staleness, wiring, and environment breaks. Each entry: symptom → cause → fix, ordered least to most forceful.

## 1. Updated the plugin but changes aren't visible

The escalation ladder — stop at the first step that works:

1. **Refresh the marketplace cache** (installs pin to it, not to GitHub): `/plugin marketplace update forge`
2. **Update the plugin**: `/plugin update forge@forge`
3. **Reload in-session**: `/reload-plugins` (skills/commands/agents reload; **hooks and MCP servers may not** — see 4)
4. **Restart the session** — the only guaranteed full reload for hooks, hook JSON, and MCP server definitions.
5. **Nuclear overwrite** — when the cache itself is corrupt or half-updated: `/plugin uninstall forge` → `/plugin marketplace remove forge` → re-add + reinstall per the [install guide](install.md). Your repo loses nothing: `forge.json`, the board, tickets, and `.forge/` are your data, not the plugin's.

Still stale? Check you're not shadowed: a repo-local override (a same-named skill/command in the repo's own `.claude/`) wins over the plugin version.

## 2. Status line problems

- **Empty status line** — it's silent-by-design, so breakage looks like absence. Causes in order: the wired command's absolute `node` path moved (portable installs!), the script path moved (checkout relocated), not a git repo. Fix: re-run `/forge:init` with `--statusline` — it **overwrites** the `statusLine` key in `.claude/settings.local.json` with the current correct paths (it never touches other keys). Manual check: open `settings.local.json` and run its command string by hand — you'll see the real error.
- **Old format after an update** — repos wired to the **plugin cache** path get updates via §1; a repo wired to a **checkout** path (like the forge repo itself) updates via `git pull` in that checkout. Know which one your settings point at.
- **Wired but wrong file** — `settings.json` vs `settings.local.json`: both are consulted; local wins. If a stale entry lives in the shared `settings.json`, delete it there (it also embeds machine paths that break teammates — local is the right home).
- **Context bar missing, rest fine** — your Claude Code build predates `context_window` in the payload (added ~v2.1.13x): update Claude Code. Early-session absence is normal (`current_usage` is null before the first API call).
- **Rate limits missing** — only sent for Pro/Max subscriptions, and only after the first response. Not a bug.

## 3. Board and config drift

- **"unknown status/option" or dangling-id failures** — someone edited fields in the project UI; ids in `forge.json` no longer match. Fix: re-run `/forge:init` (adopt mode re-maps and rewrites forge.json), then `/forge:doctor`.
- **Missing statuses on an adopted board** — add options in the project UI (Settings → Status → add option), then re-run init to map them. The API replacement path re-mints ALL option ids and orphans item statuses (ADR-0001) — only do it deliberately, with a snapshot, like the #32 migration.
- **Escalation says "board unchanged (no 'blocked' option)"** — working as designed on a 3-status board; the decision comment is the escalation. Add the option (above) to get the visible column move.

## 4. Hooks not firing (denylist / capture)

`/reload-plugins` often isn't enough for hooks — restart the session. Verify wiring: the hook runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/…"` — if `node` isn't on the **user** PATH (not just your shell profile), hooks fail open silently. Symptom for capture: `.forge/journal.jsonl` never grows despite failing commands.

### Denylist staleness (working tree vs. the live enforced copy)

`${CLAUDE_PLUGIN_ROOT}` resolves to the **installed plugin cache**, not a forge checkout's working tree (#447). If you're developing inside a forge checkout, that means editing `plugin/hooks/denylist.mjs` does **not** change the rules enforced against your own tool calls this session — the machine is still running whatever `denylist.mjs` shipped in the last plugin install/update. The same lag applies to `scripts/**` invoked by the `${CLAUDE_PLUGIN_ROOT}` path.

`/forge:doctor` now reports this directly: when it detects a working-tree `plugin/hooks/denylist.mjs`, it compares that file's **content** (not just its `plugin.json` version — two copies can share a version and still differ, e.g. mid-development) against the live resolved copy and emits a `denylist-staleness` row:

- `ok` — the live copy matches the working tree; nothing to do.
- `warn` — they differ. The message names both paths and each side's `plugin.json` version.
- **silent (no row at all)** — there's no working-tree copy to compare against. A plain consumer install (cache only, no checkout) never sees this check.

If you get the `warn`, the fix is the same reinstall ladder as **[§1 above](#1-updated-the-plugin-but-changes-arent-visible)** — walk it from the top until the live copy matches. This check is diagnostic only: it reports the mismatch, it does not change which copy actually gets enforced (that's a separate, open question tracked in #484).

## 5. Environment breaks (Windows portable installs)

- **`gh: command not found` inside scripts** — gh must be on the *user* PATH, not just the current shell. In Git Bash, export it for the session (`export PATH="$PATH:/c/Users/$USER/AppData/Local/GitHub CLI"`) or add gh's `bin` dir to the user `Path` permanently so spawned scripts inherit it.
- **`spawn pnpm ENOENT`** — bare `.cmd` shims need the cmd.exe retry that `exec.mjs run()` provides; if you hit this in a consumer repo's verify command, invoke via `pnpm.cmd` or ensure the shim dir is on PATH.
- **gh auth/scope lost** — `gh auth refresh -s project`.

## 6. Local self-hosted runner

Runner setup + delivery hit a distinct family of issues (Docker/WSL, PowerShell parsing, execution policy, `docker://` on containerized runners, JIT-remnant locks, deprecated runner versions). They have their own symptom → cause → fix table in the **[runner adoption guide](runner-adoption.md#known-issues--solutions-runbook)**.

## 7. When it's really stuck

Re-run `/forge:init` (idempotent — resumes/repairs, never duplicates), then `/forge:doctor`. If a script errors with GraphQL in the message, don't hand-patch the board — that's what forge exists to remove; file a bug ticket with the exact output instead.
