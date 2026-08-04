# Plan: #307 - agy emitter `--out` couples the install to the staging dir

**Ticket:** #307 (parent epic #174, ADR-0007) - **Kind:** bug
**Base:** main - **Branch:** feat/307-agy-emit-relocatable

`forge init --host agy --out <dir>` writes **absolute** paths (rooted at `<dir>`)
into the emitted `mcp_config.json` (server `args`) and `hooks.json` (hook
`command`). `agy plugin install <dir>` then **copies** the package into
`~/.gemini/config/plugins/forge/`, but the copied configs still point back at the
original `<dir>` - delete it and the MCP servers + hooks break. The default
discovery flow (no `--out` -> emit into `.agents/plugins/forge/`, discovered in
place) survives only because the absolute paths happen to point at the stable
discovered location.

The absolute path is fundamentally wrong for the copy flow: the emitter cannot
know the final install path at emit time, so no absolute literal survives
`agy plugin install`. The fix is relocatable emission - plugin-root-**relative**
paths that agy resolves via the plugin root, the exact model the emitter already
relies on for the `${CLAUDE_PLUGIN_ROOT}` -> root-relative rewrite of skills and
commands (agy runs a plugin's shell-outs, incl. hook commands, with the working
directory set to the plugin root; `hooks.json`'s command CWD is the directory
containing `hooks.json` = the plugin root).

## AC map

- **AC-307.1** a package emitted with `--out` and copied elsewhere keeps working
  after the `--out` dir is deleted: `mcp_config.json` `args` and `hooks.json`
  `command` carry plugin-root-relative paths (no absolute staging/install path),
  and every path resolves against the package root wherever the package lands.
- **AC-307.2** `docs/guides/cross-gai.md` reflects the relocatable flow (the
  configs are relocatable; the copied package is self-contained).

## Task 1 (bug): emit plugin-root-relative paths in mcp_config.json + hooks.json (AC-307.1)

`buildMcpConfig` / `buildHooksConfig` drop the `destRoot` join and emit
plugin-root-relative, forward-slashed paths (`mcp/graph/server.mjs`,
`node "hooks/agy-deny.mjs"`). The emitter's `emitAgyPlugin` caller stops passing
`dest` into the builders. No absolute staging/install path is written into either
generated config.

**Files:** plugin/scripts/agy/emit.mjs

## Task 2 (test): relocatability + updated builder assertions (AC-307.1)

New AC-307.1 tests: emit with `--out`, then simulate `agy plugin install` (copy
the package to a second dir) AND delete the original `--out` dir; assert both
configs reference no absolute path and every relative target resolves under the
new root. Update the existing AC-289.4 computed-path assertions to the new
relative contract (they encoded the old absolute behavior).

**Files:** tests/agy/emit.test.mjs

## Task 3 (docs): document the relocatable flow (AC-307.2)

Update `docs/guides/cross-gai.md` Step 2 / Step 3 example configs and prose to
show plugin-root-relative paths and explain the package is relocatable (survives
`agy plugin install` copy + `--out` deletion).

**Files:** docs/guides/cross-gai.md

## Verification

`pnpm verify` full green. Gates: acgate (AC-307.1-2 covered by passing tests),
testintent clean, depguard no new deps, plandrift clean, docsync (cross-gai.md
route-indexed). `agy` is not runnable in CI, so relocatability is asserted
structurally: copy-then-delete the `--out` dir and resolve every emitted path
against the new package root. `emit.test.mjs` is subprocess-heavy (known flake
#339 under load) - re-run in isolation if it times out.
