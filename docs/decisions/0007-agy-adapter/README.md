# ADR-0007 reference: proven Antigravity (`agy`) adapter files

These four files are the **verified-working** output of the #174 spike — they were
generated and tested against a live `agy` v1.1.5 on 2026-07-26, installing forge as a
native agy plugin. They are the reference implementation the AC3 build productizes into
`forge init --host agy`; they are **not** wired into the plugin build yet.

## What was proven

Installed into `~/.gemini/config/plugins/forge/`, `agy plugin validate` reported all five
component types green:

```
✔ skills      : 20 processed
✔ agents      : 12 processed
✔ commands    :  8 processed (converted to skills)
✔ mcpServers  :  1 processed   (forge-graph, via mcp_config.json)
✔ hooks       :  2 processed   (deny + capture, via hooks.json)
```

The denylist shim was exercised directly with agy-shaped payloads:
`git push --force …` → `{"decision":"deny"}`, `rm -rf <repo>` → `{"decision":"deny"}`,
`npm test` → `{"decision":"allow"}`. Capture returned `{}`.

## The files

- **`mcp_config.json`** — agy reads MCP servers from a plugin-root `mcp_config.json`
  (NOT from the `mcpServers` key in `plugin.json`, which agy ignores). Same server defs as
  Claude's manifest, different file.
- **`hooks.json`** — agy's named-hook schema (top-level hook *names*, not Claude's `"hooks"`
  wrapper), matcher on the tool name `run_command` (not Claude's `"Bash"`).
- **`hooks/agy-deny.mjs`** — PreToolUse shim. Reads agy's stdin (`toolCall.args.CommandLine`),
  calls forge's host-agnostic `check()` from `denylist.mjs`, emits agy's decision shape
  (`{"decision":"deny"|"allow","reason"?}`). **Must not be named `*denylist.mjs`** —
  `denylist.mjs`'s self-exec guard `/denylist\.mjs$/` is unanchored and would re-fire on import.
- **`hooks/agy-capture.mjs`** — PostToolUse shim. Self-contained (agy does not copy the
  plugin `scripts/` tree), appends metadata-only journal lines, emits `{}`.

## Productization notes for AC3

- The absolute paths in `mcp_config.json` / `hooks.json` are install-specific;
  `forge init --host agy` must compute them from the resolved plugin dir.
- Stage/emit at a **short path** — `agy plugin install` hit Windows MAX_PATH on long
  source paths during the spike.
- Layout: agy needs `plugin.json` **co-located** with the component dirs (Claude splits
  `plugin.json` into `.claude-plugin/`); the emitter reshuffles or writes agy's layout.
