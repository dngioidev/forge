# Cross-GAI guide: running forge on Antigravity (agy)

forge was built as a Claude Code plugin, but its engine is host-agnostic: the
board automation, the seven mechanical gates, the graph-RAG index, the safety
denylist, and the journal-capture learning loop are all plain Node CLIs and
hook scripts that depend only on `node`, `gh`, `git`, and `.claude/forge.json`.
[ADR-0007](../decisions/0007-cross-gai-mcp-first.md) inverts the architecture
into an MCP-first core plus per-host adapter emission so the same plugin runs on
other GAI (generative-AI dev) hosts.

This guide documents the one host that is **proven today**: Antigravity, driven
by its `agy` CLI. It was verified end-to-end against live `agy` v1.1.5 on
2026-07-26 (see ADR-0007, "Spike verification on real agy"), and the hook
contract was re-verified against **v1.1.7** on 2026-08-12 with no drift
([#428 spike](../spikes/2026-08-12-agy-approval-semantics.md)). Codex is a
separate, **deferred** adapter tracked in [#292](https://github.com/dngioidev/forge/issues/292)
and is **not built** — do not expect it to work yet.

For the honest capability differences between hosts, see the
[capability / parity matrix](#capability--parity-matrix) at the end of this
guide.

---

## Prerequisites

| need | check | notes |
| --- | --- | --- |
| Antigravity `agy` CLI | `agy --version` | proven on v1.1.5, hook contract re-verified on v1.1.7 (#428); the plugin system ingests the Claude plugin format directly |
| Node >= 22.13 | `node --version` | the whole engine runs on Node; the hook shims are ESM |
| git + `gh` (authenticated) | `git --version`, `gh auth status` | needed by the board/gate/release CLIs, not by the emit step itself |
| a forge checkout | — | you run `forge init --host agy` from the forge plugin source |

The emit step (`forge init --host agy`) needs only `node` — it writes files and
does not touch `gh` or the board. `gh`/`git` are needed once you actually drive
forge inside an agy session (board moves, gates, release readiness).

---

## Step 1 — emit the agy plugin package

From a forge checkout, run the host-emit mode of `init`:

```
node plugin/scripts/init.mjs --host agy --out C:\agy\forge
```

- `--host agy` is the only supported host today. Any other value is refused with
  a message pointing at #292 (Codex deferred).
- `--out <dir>` sets where the package is staged. If omitted, it defaults to
  `.agents/plugins/forge/` under the current directory.
- **The in-place discovery flow (no `--out`) is the recommended primary path.**
  With no `--out` the package is emitted into `.agents/plugins/forge/` and
  discovered where it sits — nothing is copied, so there is no staging-dir to
  delete and nothing to relocate. This is the flow verified end-to-end against
  live agy. Use `--out` only when you intend to `agy plugin install` the package;
  the emitted configs are relocatable (relative paths, see Steps 2-3), but after a
  copy install you should run `agy plugin validate forge` to confirm they resolve
  on your agy build (the emitter prints this reminder when `--out` is used). See
  [#307](https://github.com/dngioidev/forge/issues/307).
- **Use a short `--out` path.** `agy plugin install` hit Windows `MAX_PATH`
  (260-char) failures when the source sat under a long temp path during the
  spike. The emitter itself is long-path aware (it prefixes `\\?\` on win32), but
  staging at a short path such as `C:\agy\forge` avoids the class of problem
  entirely. This is the single biggest Windows gotcha.

The emitter is safe to re-run: it fully manages its own output directory and does
a clean re-emit each run, but it **refuses** to write into a filesystem root, the
current working directory or any ancestor of it, a directory that contains the
forge source, or any non-empty directory that does not already carry a forge
`plugin.json` marker (`{"name":"forge"}`). This blast-radius guard means a
mistyped `--out .` cannot delete your working tree.

### What gets emitted (the plugin layout)

agy needs `plugin.json` **co-located** with the component directories — unlike
the Claude layout, which splits `plugin.json` into `.claude-plugin/`. The
emitted package looks like this:

```
C:\agy\forge\
  plugin.json          <- co-located marker: { "name": "forge", ... } ($schema + mcpServers stripped)
  mcp_config.json      <- GENERATED: agy reads MCP servers from HERE, not plugin.json
  hooks.json           <- GENERATED: agy named-hook schema (see below)
  skills/              <- copied verbatim; agy ingests natively (20 skills)
  agents/              <- copied verbatim; agy ingests natively (12 role cards)
  commands/            <- copied verbatim; agy auto-converts these to skills
  mcp/                 <- forge-graph server (+ forge-core when built)
  hooks/               <- denylist.mjs, capture.mjs, and the agy-deny / agy-capture shims
  scripts/             <- the `forge <area> <cmd>` shell tier the skills call
  bin/                 <- the forge dispatcher
```

Three things are agy-specific and **generated** (not copied). Their internal
references are **plugin-root-relative**, so the package is **relocatable** — it
keeps working after `agy plugin install` copies it to
`~/.gemini/config/plugins/forge/` and after you delete the original `--out` dir
([#307](https://github.com/dngioidev/forge/issues/307)):

1. **`plugin.json`** — the co-located marker. The emitter strips the Claude-only
   `$schema` and `mcpServers` keys agy ignores.
2. **`mcp_config.json`** — the MCP registration, relative paths (see Step 2).
3. **`hooks.json`** — the hook registration, relative commands (see Step 3).

Note the copied `hooks/` tree also carries the original Claude-format
`hooks/hooks.json` (Claude's `"hooks"` wrapper, `"Bash"` matcher). agy ignores it
and reads the **plugin-root** `hooks.json` generated above; if you hand-edit
hooks for agy, edit the root file, not `hooks/hooks.json`.

The `skills/`, `agents/`, and `commands/` trees are copied byte-for-byte. agy
imports them with **zero conversion code** and auto-converts slash commands to
skills. `mcp/`, `hooks/`, `scripts/`, and `bin/` are copied so the paths the
configs and skills reference physically exist inside the package.

---

## Step 2 — MCP registration (`mcp_config.json`)

**agy does NOT read the `mcpServers` key from `plugin.json`.** During the spike,
`agy plugin validate` reported `mcpServers: skipped (not found)` when the servers
were declared only in `plugin.json`. agy reads a sibling plugin-root
**`mcp_config.json`** — same content as Claude's inline block, different file:

```json
{
  "mcpServers": {
    "forge-graph": {
      "command": "node",
      "args": ["mcp/graph/server.mjs"]
    },
    "forge-core": {
      "command": "node",
      "args": ["mcp/forge/server.mjs"]
    }
  }
}
```

- Paths are **plugin-root-relative** and written with forward slashes (safe on
  Windows). They are deliberately **not** absolute: `agy plugin install` copies
  the package to `~/.gemini/config/plugins/forge/`, so an absolute literal
  computed at emit time would be stale after the copy — delete the `--out` dir and
  the servers would break ([#307](https://github.com/dngioidev/forge/issues/307)).
  A relative path resolves against the plugin root wherever the package lands, so
  the same file works in the staging dir, after `agy plugin install`, and under
  `.agents/plugins/forge/`. agy's env-expansion is buggy, which is why a
  `${...}`-style token is avoided in favour of a plain relative path.
- **Verification note.** agy's hook-command working directory is documented as the
  plugin root (so the relative `hooks.json` command in Step 3 is well-grounded),
  but agy's MCP-server subprocess working directory is **not** independently
  confirmed in the agy docs, and the #174 spike validated `mcp_config.json` only
  with absolute paths. Relative is the strictly-better emit-time choice (an
  absolute path cannot survive the `agy plugin install` copy at all), but confirm
  it on your build with `agy plugin validate forge` after install; the in-place
  discovery flow avoids the question entirely. Live confirmation lands with the
  #290 dogfood.
- `forge-graph` is always registered. `forge-core` (the 15-tool board/gate/
  autopilot server from [#288](https://github.com/dngioidev/forge/issues/288),
  [#400](https://github.com/dngioidev/forge/issues/400)) is registered **only
  when its server file exists** in the source — the emitter guards on
  `mcp/forge/server.mjs` being present. Since #288 merged, a fresh emit
  registers both.
- Note that agy's plugin MCP config has **no `httpUrl` / `timeout`** support and
  buggy env-expansion; both forge servers are plain stdio (`command`/`args`),
  which sidesteps this.

MCP is a **structured-return enhancement**, not a hard requirement on agy. agy's
agent has a `run_command` tool, so the entire `forge <area> <cmd>` shell tier
runs on agy without MCP at all. `forge-core` exists so board/gate/autopilot
branching gets typed returns (pass/fail, the merge-bar vector) instead of
stdout-scraping.

### Tool usage reference (21 tools: forge-core 15 + forge-graph 6)

One line each — what it does, and when a host calls it. Full schemas live in
each server's `TOOLS` export ([`plugin/mcp/forge/server.mjs`](../../plugin/mcp/forge/server.mjs),
[`plugin/mcp/graph/server.mjs`](../../plugin/mcp/graph/server.mjs)).

**forge-core** (board/gate/release/autopilot — typed returns over `scripts/*.mjs`):

| Tool | Does | Call it when |
| --- | --- | --- |
| `board_move` | Moves a ticket to a board status; reports whether it changed and re-verified. | The ticket needs to change lifecycle column (e.g. ready -> inProgress). |
| `board_comment` | Posts an idempotent ticket-trail comment for a lifecycle phase. | Every trail milestone (started/plan/pr/ci-green/...) — never re-narrate, just call it. |
| `board_create` | Creates (or resumes) a ticket with board item + fields. | New work is identified and needs a ticket before it can be picked up. |
| `board_escalate` | Blocks a ticket, posts a decision comment with >=2 options, writes a pending decision. | Genuinely blocked on a human call — the halt-and-ask spine. |
| `board_status` | Returns the same catch-up card as `forge board status`, plus normalized items[]. | Resuming work, or a host needs the current board picture / next action. |
| `board_receipt` | Posts/updates the idempotent merge receipt on an issue for a PR (#400). | A PR that closes an issue has merged — record the receipt on that issue. |
| `board_log` | Posts/updates one delivery-log row on the pinned delivery-log issue (#400). | A PR merged and the delivery log needs its one-line row. |
| `board_digest` | Refreshes an epic's managed digest block (child table + flow metrics) (#400). | An epic's children changed state and its summary needs to reflect that. |
| `board_reparent` | Moves a sub-issue to a different parent epic (#400). | A ticket was filed under the wrong epic and needs restructuring. |
| `board_close` | Closes an issue for a special reason (completed/not-planned/etc.) and reflects it on the board (#400). | Closing something that isn't a normal "done" move — duplicate, superseded, won't do. |
| `gate_run` | Runs one mechanical gate (ac/conventions/dep/docsync/ground/license/plandrift/situation/testintent) and returns its pass/fail verdict. | Before shipping, or whenever a specific gate's verdict is needed programmatically. |
| `release_readiness` | Evaluates the release-readiness checklist item-by-item. | Deciding whether the repo is safe to cut a release. |
| `autopilot_select` | Picks the next actionable ticket and the ordered queue (read-only). | Autopilot (or a host driving it) needs to know what to work on next. |
| `autopilot_merge_bar` | Computes the {merge, blockedOn} vector from a signal set — pure, no side effect. | A host wants to know if a PR *would* pass the merge bar without merging it. |
| `autopilot_merge` | Executes the gated live merge — the single sanctioned auto-merge path (Claude-only by policy). | All signals are believed green and the PR should actually be squash-merged now. |

**forge-graph** (read-only code-graph RAG over `plugin/mcp/graph/queries.mjs`; requires `features.graph`):

| Tool | Does | Call it when |
| --- | --- | --- |
| `find_component` | Finds components/exports by name substring. | Before writing anything new — check whether it already exists. |
| `who_uses` | Finds who renders/imports a symbol or uses a token. | Assessing the impact of touching a symbol/token before changing it. |
| `similar_props` | Ranks props interfaces by member overlap. | Looking for a near-duplicate interface to reuse instead of adding a new one. |
| `blast_radius` | Finds transitive dependents (files, tests, stories) of a set of files. | Deciding the test set for a change. |
| `code_for_ticket` | Finds files linked to a ticket via commit-message issue refs. | Picking up a ticket and needing to know what code it previously touched. |
| `reuse_candidates` | Ranks existing exports/components against a feature description. | Before creating new files — check for reuse candidates first. |

---

## Step 3 — hooks (`hooks.json` + the deny/capture shims)

agy reads a plugin-root **`hooks.json`** and auto-wires it when the plugin is
enabled. Its schema differs from Claude's in three ways that matter:

- Top-level keys are **hook names** (`forge-safety`, `forge-capture`), not
  Claude's `"hooks"` wrapper.
- The matcher is on the tool name **`run_command`** — not Claude's `"Bash"`.
- The command line is read from `toolCall.args.CommandLine` (camelCase JSON on
  stdin).

The generated file:

```json
{
  "forge-safety": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          { "type": "command", "command": "node \"hooks/agy-deny.mjs\"", "timeout": 10 }
        ]
      }
    ]
  },
  "forge-capture": {
    "PostToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          { "type": "command", "command": "node \"hooks/agy-capture.mjs\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

The hook `command` is **plugin-root-relative**: agy runs a hook command with its
working directory set to the directory containing `hooks.json` (= the plugin
root), so `hooks/agy-deny.mjs` resolves wherever the package is installed. Like
`mcp_config.json`, this keeps the safety + capture hooks working after
`agy plugin install` copies the package and the original `--out` dir is deleted
([#307](https://github.com/dngioidev/forge/issues/307)).

### The host-mode I/O shims

forge's denylist and capture **rules** live in one place
(`hooks/denylist.mjs`, `hooks/capture.mjs`); only the host I/O contract differs.
agy reads a **different decision shape** than Claude — Claude uses
`permissionDecision` / exit-2, agy expects a JSON decision object on stdout — so
the emitted package includes two thin shims:

- **`hooks/agy-deny.mjs`** (PreToolUse) — reads agy's stdin
  (`toolCall.args.CommandLine`), calls forge's host-agnostic `check()` from
  `denylist.mjs`, and emits agy's decision shape:
  `{ "decision": "deny", "reason": "..." }` on a block, `{ "decision": "allow" }`
  otherwise. It **fails open** (allow) on any internal error — a safety hook must
  never wedge the loop.
- **`hooks/agy-capture.mjs`** (PostToolUse) — appends a **metadata-only** journal
  line (timestamp, host, step index, a bounded error string — never raw command
  output) to `<workspace>/.forge/agy-journal.jsonl`, then emits `{}`. It is
  self-contained because agy does not copy the plugin's `scripts/` tree into the
  hook's reach.

**The denylist self-exec-guard naming constraint.** The deny shim must **not** be
named `*denylist.mjs`. `denylist.mjs` self-executes when it is the entry point;
the original guard `/denylist\.mjs$/` was **unanchored**, so importing `check()`
from a file whose name ended in `denylist.mjs` would re-fire `main()` and consume
its stdin. AC-289.3 anchored the guard to the basename
(`/(^|[\\/])denylist\.mjs$/`), but the shim is deliberately kept named
`agy-deny.mjs` as belt-and-braces so `check()` can be imported with zero side
effects.

---

## Step 4 — install and validate with agy

Install the emitted package as an agy plugin (or discover it under
`.agents/plugins/forge/` / `~/.gemini/config/plugins/forge/`):

```
agy plugin install "C:\agy\forge"
agy plugin validate forge
agy plugin list
```

When enabled, agy **auto-wires** the MCP servers (from `mcp_config.json`) and the
hooks (from `hooks.json`) — there is no manual registration step.

### The green `agy plugin validate` output shape

The spike proved this exact shape on live agy v1.1.5 (installed into
`~/.gemini/config/plugins/forge/`), all five component types green:

```
skills      : 20 processed
agents      : 12 processed
commands    :  8 processed (converted to skills)
mcpServers  :  1 processed   (forge-graph, via mcp_config.json)
hooks       :  2 processed   (deny + capture, via hooks.json)
```

`agy plugin list` then showed forge installed, source `antigravity`, 40
components.

The spike ran **before** `forge-core` existed ([#288](https://github.com/dngioidev/forge/issues/288)),
so it registered one MCP server. A fresh emit today registers **both**
`forge-graph` and `forge-core` (confirmed in the generated `mcp_config.json`), so
`mcpServers` would validate as **2 processed**. Everything else is unchanged.

The deny shim was exercised directly with agy-shaped payloads and behaved as
designed:

```
git push --force ...   ->  {"decision":"deny"}
rm -rf <repo>          ->  {"decision":"deny"}
npm test               ->  {"decision":"allow"}
```

Capture returned `{}`. (During the spike, forge's own Claude denylist even
blocked one of the operator's `rm -rf` commands mid-run — the rules are real, not
theoretical.)

---

## Gotchas summary (Windows-first)

| gotcha | what to do |
| --- | --- |
| **MAX_PATH (260)** on `agy plugin install` from a long source path | stage/emit at a **short** `--out` path (e.g. `C:\agy\forge`); the emitter is also `\\?\`-prefix aware |
| agy reads MCP from **`mcp_config.json`**, not `plugin.json`'s `mcpServers` | rely on the generated `mcp_config.json`; do not expect `plugin.json` MCP to load |
| agy hooks use matcher **`run_command`**, not Claude's `"Bash"` | the generated `hooks.json` already targets `run_command`; the command line is at `toolCall.args.CommandLine` |
| agy decision shape differs from Claude (`decision` object vs `permissionDecision`/exit-2) | the `agy-deny` / `agy-capture` shims translate the I/O; the rules stay in `denylist.mjs`/`capture.mjs` |
| deny shim naming | never name it `*denylist.mjs`; keep `agy-deny.mjs` so `check()` imports without re-firing the self-exec guard |
| `plugin.json` placement | agy needs it **co-located** with the component dirs, not under `.claude-plugin/` |
| no unattended auto-merge on agy | by owner policy (below) forge stops at an open, green PR / awaiting-human on non-Claude hosts |

---

## Capability / parity matrix

This is the honest matrix from [ADR-0007 §(d)](../decisions/0007-cross-gai-mcp-first.md).
Full = works as on Claude; Near = model-driven equivalent; Partial = reduced /
manual; Lost = unavailable. Codex is included as the ADR's researched target but
is **deferred and unbuilt** ([#292](https://github.com/dngioidev/forge/issues/292)) —
only the Claude and Antigravity columns are proven.

| Capability | Claude Code | Codex (deferred, #292) | Antigravity / agy (proven) |
| --- | --- | --- | --- |
| Board law (create/move/comment/escalate) | Full | Full (MCP+shell) | **Full** (MCP+shell) |
| Mechanical gates (7) | Full | Full (MCP) | **Full** (MCP) |
| Graph RAG | Full | Full (register server) | **Full** (register server) |
| Release readiness + cut | Full | Full | **Full** |
| Safety denylist (block force-push/hard-reset) | Full | Full (PreToolUse deny hook) | **Full** (PreToolUse deny) |
| Journal capture (learning loop) | Full | Full (PostToolUse hook) | **Full** (PostToolUse) |
| Parallel subagent fan-out | Full | Full (native subagents, <=6) | **Full** (subagents / Agent Manager) |
| Slash-command UX | Full | Full (prompts/Skills) | **Full** (auto-converted to skills) |
| Pipeline / deliver (spec->plan->execute->ship) | Full (auto) | Near (model orchestrates) | **Near** (model orchestrates) |
| Skill auto-invocation | Full (runtime trigger) | Near (model-driven) | **Near** (model-driven) |
| Autopilot unattended auto-merge on green | Full | Stops at green PR (policy) | **Stops at green PR** (policy) |
| Background monitors (ci-watch/decisions-watch) | Full | Partial (session events / cron) | **Partial** |
| Statusline | Full | Lost (no API) | **Lost** (no API) |

### What actually differs, honestly

Everything **load-bearing** reaches Full parity on agy: board law, all seven
gates, graph RAG, release readiness, the safety denylist, journal capture,
parallel subagent fan-out, and slash-command UX. The only differences are:

1. **Auto-merge is deliberately Claude-only** — a policy line, not an engine
   limit. `autopilot_merge_bar` computes the merge decision on every host (a host
   can see whether the bar is green), but forge does **not** wire an unattended
   `gh pr merge` action on non-Claude hosts. On agy, forge stops at an open,
   green PR / awaiting-human. The live merge stays where the full auto-safety
   stack (denylist hook + merge-authority grant) is proven.
2. **The pipeline / skill auto-flow is model-driven, not runtime-triggered.** On
   Claude a runtime trigger fires the skill; on agy the model invokes it because
   the instructions tell it to. Same capability, near-identical in practice for
   an agent following its instructions file.
3. **Background monitors degrade** to session events / cron where a persistent
   watcher API is not available.
4. **The statusline is cosmetic and Claude-only** — no host exposes a statusline
   API. Nothing load-bearing depends on it.

---

## References

- [ADR-0007 — Cross-GAI forge](../decisions/0007-cross-gai-mcp-first.md) — the
  design, the full parity matrix (§d), and the live agy verification.
- [0007-agy-adapter reference](../decisions/0007-agy-adapter/README.md) — the
  verified-working spike output the emitter productizes.
- `plugin/scripts/agy/emit.mjs` — the `forge init --host agy` emitter (#289).
- `plugin/mcp/forge/server.mjs` — the `forge-core` MCP server, 15 tools (#288, #400).
