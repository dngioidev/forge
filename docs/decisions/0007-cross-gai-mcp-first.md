# ADR-0007 - Cross-GAI forge: MCP-first portable core + per-host instruction adapters

**Date:** 2026-07-25 - **Status:** **Proposed** (AC1 gate; needs owner sign-off before any build) - **Ticket:** #174 - **Route:** spike (deliverable = this decision record; the throwaway spike branch `spike/174-cross-gai-mcp-first` never merges - it is graduated to main after owner sign-off)

## Context

Epic #174 proposes making forge natively runnable on GAI hosts other than Claude Code - concretely **Codex** (AGENTS.md) and **Antigravity/Gemini** (GEMINI.md) - by inverting the current architecture into an **MCP-first core**. Today only the graph is exposed over MCP (`plugin/mcp/graph/server.mjs`); the rest of the engine is reachable only as node CLIs invoked by Claude-Code skills, or as the `forge` bash dispatcher (`plugin/bin/forge`). Everything that orchestrates those CLIs - skills, agent cards, hooks, slash commands - is Claude-Code-native and does not port.

AC1 is the gate: a design spike must resolve four things and the owner must approve before any build. This ADR is that spike's deliverable. Every recommendation below is grounded in the actual repo, not invented (crazy-mode ground gate). Where a cut line is a product/architecture decision rather than an engine fact, it is flagged and routed to the owner sign-off section instead of being decided here.

### The repo as it actually is (grounded)

- **Existing MCP server** - `plugin/mcp/graph/server.mjs`: a hand-rolled, zero-dependency JSON-RPC 2.0 server over newline-delimited stdio. It implements exactly `initialize`, `ping`, `tools/list`, `tools/call`. It exposes 6 read-only graph tools (`find_component`, `who_uses`, `similar_props`, `blast_radius`, `code_for_ticket`, `reuse_candidates`), each with an `inputSchema`, a local `validateInput` validator, and repo-root path canonicalization. Tool results are returned as `{ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError }`. It re-reads `features.graph` from `.claude/forge.json` on every call (`makeGraphState`) so a config toggle needs no restart, and fails soft (teaching error) when the feature is off. Supporting layers: `db.mjs`, `indexer.mjs`, `queries.mjs`.
- **MCP registration** - `plugin/.claude-plugin/plugin.json` -> `mcpServers.forge-graph = { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/graph/server.mjs"] }`. This is the only registration surface today and it is Claude-Code-plugin-manifest-shaped.
- **The portable engine (node CLIs under `plugin/scripts/`)**, every one an ESM module exporting a pure-ish `runX(ctx, args)` that returns a structured `{ ok, ... }` object and only self-executes under an `isMain` guard:
  - `board/` - `create, move, comment, close, digest, escalate, log, receipt, reparent, status`. Stateful: they mutate a GitHub Projects v2 board via `gh`. `move` returns `{ ok, changed, verified }`; `comment` takes a fixed `PHASES` enum and upserts a marker-keyed trail comment; `escalate` opens a decision (board -> blocked + decision comment + journal + pending file). All build a `makeBoardCtx` first (board IDs from `forge.json`).
  - `gates/` - `acgate, depguard, docsync, groundgate, plandrift, situationgate, testintent`. Evaluators that read machine evidence (e.g. `acgate` parses vitest JSON) and return structured pass/fail. Mostly pure given inputs.
  - `release/` - `core, readiness, release`. `computeReadiness` returns an `items[]` checklist of `{ name, level: pass|skip|fail, msg }`.
  - `autopilot/` - `select, merge, ledger, newwork, perms, readiness`. `select.selectNext` is a pure ranking function; `merge` exposes `BAR_SIGNALS = ['ship','gates','reviewer','security','ci']` as a pure merge bar; `ledger` is the append-only run record.
- **Shell dispatcher already exists** - `plugin/bin/forge`: `forge <area> <command> [args]` over areas `board, gate, autopilot, care, deploy, design, graph, learn, backends, agy, review`, plus `init|doctor|statusline|release`. It is a thin bash wrapper over `node "$ROOT/scripts/<area>/<cmd>.mjs"`. It is bash - a portability caveat on non-bash hosts (see Decision c).
- **The Claude-Code-native layer that does NOT port** - `plugin/.claude-plugin/plugin.json` (manifest), `plugin/skills/**` (21 skills incl. autopilot/deliver/execute-agents - the orchestration prose + Skill auto-invocation), `plugin/agents/**` (12 role cards: scoper, planner, implementer, reviewer, security, test-architect, ...), `plugin/hooks/hooks.json` + `hooks/denylist.mjs` + `hooks/capture.mjs` (PreToolUse Bash denylist / PostToolUse Bash capture-to-journal), `plugin/commands/**` (slash commands), `plugin/monitors/**` (ci-watch, decisions-watch background watchers), statusline. None of these has an MCP or config equivalent - they are host-runtime features of Claude Code.
- **`init` today** - `plugin/scripts/init.mjs` bootstraps the board (project, fields, delivery-log issue), writes `.claude/forge.json`, `.gitignore`, `.gitattributes`, and a verify CI template. **It does NOT emit AGENTS.md or GEMINI.md today.** Those two files exist in the repo root carrying a `<!-- forge:context:begin -->...<!-- forge:context:end -->` managed block (forge conventions + Windows-first shell rules), but no code writes them - they are currently hand-maintained. The mechanism to generate them exists and is proven: `plugin/scripts/lib/markers.mjs` `upsertBlock(text, marker, content)` rewrites only the marked span and preserves everything outside byte-for-byte (already used for the board `digest` block). This is the exact hook per-host adapter emission extends.
- **Existing Antigravity integration is the INVERSE of this epic** - `plugin/scripts/agy/core.mjs`: forge *calls* headless Gemini (`agy --print <prompt> --add-dir <cwd> --model gemini-3.1-pro-high --mode plan --dangerously-skip-permissions`) as an opt-in, advisory, read-only second opinion (never gates, never edits). This epic is the reverse - forge running *on* Antigravity/Codex. The reusable knowledge is only the headless-CLI shape and the `features.agy` opt-in convention, not the call path.

**Grounding verdict:** the portable engine IS genuinely host-agnostic. Every `scripts/**` CLI depends only on `node`, `gh`, `git`, and `.claude/forge.json` - nothing in the CLIs imports a Claude-Code runtime API. The MCP-first direction is therefore NOT blocked. The two honest portability caveats, addressed below, are (1) the dispatcher is bash, and (2) the auto-orchestration + safety layer is Claude-native with no portable equivalent.

---

## (a) The split - portable core vs Claude-native orchestration

Every high-value engine capability, and what it becomes off-Claude:

| Capability | Where it lives today | Portable? | Off-Claude form |
| --- | --- | --- | --- |
| Board create/move/comment/close/reparent/status | `scripts/board/*.mjs` (stateful gh mutations) | Portable (node CLI) | MCP tool (structured return) OR `forge board <cmd>` shell |
| Board digest / receipt / log | `scripts/board/{digest,receipt,log}.mjs` | Portable | MCP tool or shell |
| Escalate (halt-and-ask) | `scripts/board/escalate.mjs` | Portable | MCP tool (structured return needed) |
| Mechanical gates (ac/dep/docsync/ground/plandrift/situation/testintent) | `scripts/gates/*.mjs` | Portable | MCP tools (structured pass/fail) |
| Release readiness + cut | `scripts/release/*.mjs` | Portable | MCP tool (readiness) + shell (cut) |
| Autopilot select / merge-bar / ledger | `scripts/autopilot/*.mjs` | Portable (pure fns) | MCP tools (structured return) |
| Graph RAG queries | `mcp/graph/server.mjs` | Already MCP | Same MCP server (host-registered) |
| Init / doctor / statusline wiring | `scripts/{init,doctor,statusline}.mjs` | Portable (node CLI) | `forge init` shell (emits per-host files) |
| Skill auto-invocation (skill fires itself on trigger) | `plugin/skills/**` + Claude Skill runtime | Claude-native | LOST -> explicit invocation (host tells model to call the tool/skill) |
| Subagent role fan-out (Task tool spawns scoper/planner/implementer/reviewer) | `plugin/agents/**` + Claude Task tool | Claude-native | DEGRADED -> single-context sequential, or host-native subagents where they exist |
| Safety denylist (PreToolUse Bash block) | `plugin/hooks/denylist.mjs` + `hooks.json` | Claude-native hook wiring | PARTIAL/LOST -> re-implement in each host's hook mechanism, else manual discipline |
| Journal capture (PostToolUse Bash capture) | `plugin/hooks/capture.mjs` + `hooks.json` | Claude-native hook wiring | PARTIAL/LOST -> host hook if present, else no auto-capture |
| Slash commands (/forge:init etc.) | `plugin/commands/**` | Claude-native | LOST as slash UX -> `forge <cmd>` shell / MCP tool |
| Background monitors (ci-watch, decisions-watch) | `plugin/monitors/**` | Claude-native trigger | LOST as auto-watch -> manual polling or external cron |
| Statusline | `scripts/statusline.mjs` + settings | Claude-native surface | LOST off-Claude (no statusline API) |

The dividing line is clean: **anything that is a node CLI returning structured JSON is portable; anything that is Claude-Code runtime wiring (auto-invocation, Task fan-out, PreToolUse/PostToolUse hooks, slash UX, monitors, statusline) is native and either re-homes into the host's own mechanism or is honestly lost.**

---

## (b) The MCP tool surface to expose

**Recommendation on server home:** add a **sibling** `mcp/forge` server (new `plugin/mcp/forge/server.mjs`), NOT an extension of `mcp/graph`. Rationale grounded in the code: `mcp/graph` is single-feature, gated entirely on `features.graph`, and its `makeHandler`/`makeGraphState` are graph-db-specific. The board/gate/autopilot tools have a different lifecycle (they need `makeBoardCtx` + `gh`, not the graph db) and a different feature gate. Keep `forge-graph` exactly as is; add `forge-core` as a second server that reuses the *protocol skeleton* (the ~50-line JSON-RPC loop, `validateInput`, `canonicalize`, the `toolText` result shape) - factor those into `mcp/lib/rpc.mjs` so both servers share one hardened transport and neither regresses.

**MUST-be-MCP vs can-stay-shell rule:** a capability MUST be an MCP tool when the *caller needs the structured return to make its next decision* - the model has to read a typed result (pass/fail, changed/verified, the merge-bar signal vector, the readiness checklist) and branch on it. A capability can stay a plain `forge <area> <cmd>` shell call when it is fire-and-forget or its exit code is enough. Structured-return tools cannot rely on the model scraping stdout prose across hosts; shell calls can.

Proposed `forge-core` MCP tools (beyond the 6 existing graph tools):

| Tool name | Input | Structured return | Why MCP (not shell) |
| --- | --- | --- | --- |
| `board_move` | `{ issue:int, status:string }` | `{ ok, changed, verified, status }` | Caller branches on `verified`; already returns this shape |
| `board_comment` | `{ issue:int, phase:enum, body:string, actor?, session? }` | `{ ok, action }` | Trail law is a decision point; `phase` enum needs validation |
| `board_create` | `{ title, body?, type?, priority?, size?, area?, parent? }` | `{ ok, number, url }` | Caller needs the new issue number to continue |
| `board_escalate` | `{ issue:int, reason:string, options:string[>=2], recommend?, context? }` | `{ ok, id, boardNote, pending }` | The halt-and-ask spine; caller must know it parked |
| `board_status` | `{ issue?:int }` | `{ ok, items[] }` | Read-model the model reasons over |
| `gate_run` | `{ gate:enum(ac|dep|docsync|ground|plandrift|situation|testintent), ...gateArgs }` | `{ ok, level:pass\|fail, findings[] }` | Gates ARE decision points - pass/fail drives flow |
| `release_readiness` | `{}` | `{ ok, items:[{name,level,msg}] }` | Checklist the model must evaluate item-by-item |
| `autopilot_select` | `{ area?, shape? }` | `{ ok, next:{number,status,action,title}\|null, queue[] }` | Picks the next ticket - pure fn, structured return is the point |
| `autopilot_merge_bar` | `{ signals:{ship,gates,reviewer,security,ci} }` | `{ ok, merge:bool, blockedOn[] }` | The trust-reversal bar; MUST be typed, never stdout-scraped |

Can stay `forge <area> <cmd>` shell (no structured branch needed): `board close`, `board digest`, `board receipt`, `board log`, `board reparent`, `release release` (the actual cut, after readiness passes), `graph rebuild/reindex` (graphctl), `init`, `doctor`, `learn`. These either mutate-and-done or their exit code suffices.

**Cut-line note (for owner):** exposing `board_create`/`board_escalate` as MCP tools gives an off-Claude host the ability to open tickets and to halt-and-ask. Whether autopilot's `merge_bar` should be an MCP tool a non-Claude host can call (i.e. letting Codex/Antigravity auto-merge) is a trust decision, not an engine decision - see sign-off.

**Registration reuse:** the `forge-core` server registers on Claude Code by adding one more entry to `mcpServers` in the plugin manifest (identical shape to `forge-graph`). Per-host registration is Decision (c).

---

## (c) Per-host adapters, concretely

`init` gains a per-host emission step (reusing `markers.upsertBlock` so re-runs refresh, never duplicate, and never touch user-authored prose outside the block). Windows-first shell rules from the current managed block are preserved verbatim in every emitted file.

### Codex (AGENTS.md)

- **What `init` emits:** the existing `<!-- forge:context:begin -->` managed block, PLUS a forge-tools section that (1) points the model at the `forge-core` + `forge-graph` MCP tools by name and says "prefer these over raw `gh`/`git` for board/gate/release/autopilot work," (2) points at the `forge <area> <cmd>` dispatcher for the shell-tier capabilities, (3) states the board law (only Epic/Program at top level; every item is a child of an epic; always trail-comment the driving issue at each lifecycle moment). Windows-first shell rules stay.
- **MCP registration on Codex:** Codex reads MCP servers from its own config (`~/.codex/config.toml`, `[mcp_servers.forge_core]` with `command`/`args`), NOT from the Claude plugin manifest. `init` emits (or prints for the user to paste) a `forge-core`/`forge-graph` stanza pointing at `node <plugin>/mcp/*/server.mjs`. Confirm the exact Codex MCP config path/schema at build time before generating it (flag for owner - see sign-off).
- **Hook mechanism:** Codex has no PreToolUse/PostToolUse hook equivalent to re-home the denylist/capture into. Off-Codex the safety denylist degrades to prose ("never force-push, never hard-reset protected branches" written into AGENTS.md) + reliance on Codex's own sandbox/approval mode. This is a real loss (see degradation matrix).

### Antigravity / Gemini (GEMINI.md)

- **What `init` emits:** same managed block + forge-tools section as AGENTS.md, keyed to Antigravity. The `agy` integration (`scripts/agy/core.mjs`) already proves the headless-Gemini CLI contract, so the Windows-first spawn rules are known-good here.
- **MCP registration on Antigravity:** Antigravity/Gemini registers MCP servers via its own settings (Gemini CLI uses a `.gemini/settings.json` `mcpServers` map with `command`/`args` - close in shape to the Claude manifest). `init` emits that stanza. Confirm exact path/schema at build time (flag for owner).
- **Hook mechanism:** Antigravity likewise has no guaranteed PreToolUse Bash-denylist equivalent; same degradation as Codex - safety rails become prose + host approval mode.

### The `forge <area> <cmd>` dispatcher shape

`plugin/bin/forge` already implements exactly this contract. The only cross-host gap: it is **bash** (`#!/usr/bin/env bash`), so a host on a bare Windows shell without Git-Bash cannot run it directly. Adapter work is a small sibling `forge.cmd`/`forge.ps1` (or documenting "run under Git-Bash / node") so `forge board create ...` works on every host. No CLI logic changes - it stays a thin wrapper over `node scripts/<area>/<cmd>.mjs`. Windows-first rule: emitted files must instruct argv-array spawns and never assume POSIX `%TEMP%` expansion, matching the current managed block.

---

## (d) The honest degradation matrix

For each forge capability, per host. Full = works as on Claude; Partial = works with manual steps or reduced automation; Manual = human must drive each step; Lost = not available.

| Capability | Claude Code | Codex | Antigravity/Gemini |
| --- | --- | --- | --- |
| Board law (create/move/comment/escalate) | Full (MCP + shell) | Full (MCP + shell) | Full (MCP + shell) |
| Mechanical gates (ac/dep/ground/...) | Full | Full (MCP tools) | Full (MCP tools) |
| Graph RAG | Full | Full (register `forge-graph`) | Full (register `forge-graph`) |
| Release readiness + cut | Full | Full | Full |
| Pipeline / deliver (spec->plan->execute->ship) | Full (skills auto-orchestrate) | Partial (explicit tool calls, no auto-flow) | Partial (explicit tool calls) |
| Autopilot board fan-out (parallel subagents) | Full (Task tool spawns role subagents) | **Manual/Lost** (single context; sequential) | **Manual/Lost** (single context; sequential) |
| Skill auto-invocation | Full | **Lost** (explicit invocation only) | **Lost** (explicit invocation only) |
| Safety denylist (block force-push/hard-reset) | Full (PreToolUse hook) | **Partial/Lost** (prose + host sandbox) | **Partial/Lost** (prose + host sandbox) |
| Journal capture (auto learning-loop) | Full (PostToolUse hook) | **Lost** (no auto-capture) | **Lost** (no auto-capture) |
| Slash-command UX | Full | Lost (use `forge <cmd>` / MCP) | Lost (use `forge <cmd>` / MCP) |
| Background monitors (ci-watch/decisions-watch) | Full | Lost (manual poll) | Lost (manual poll) |
| Statusline | Full | Lost | Lost |

**The two sharpest losses, called out:**
1. **Automatic safety rails.** The PreToolUse denylist (`hooks/denylist.mjs`) that mechanically blocks force-push / hard-reset / protected-branch delete has NO portable equivalent. Off-Claude it degrades to written guidance + whatever sandbox/approval the host offers. This is the single biggest risk of running forge on another host and must be an explicit owner-accepted trade, not silent.
2. **Parallel subagent fan-out.** Autopilot's throughput comes from spawning fresh-context role subagents (scoper/planner/implementer/reviewer) via the Claude Task tool. Codex/Antigravity have no equivalent guaranteed today, so autopilot collapses to single-context sequential work - functionally it becomes "one ticket, one context," losing the parallelism that makes hands-off board-burndown fast.

---

## Owner sign-off (AC1) - decisions to approve or amend before build

Per AC1 ("Owner approves before build"), the following are product/architecture calls that are NOT the engine's to make. Build (AC2-AC5) is blocked until the owner rules on each:

1. **MCP server home** - RECOMMEND a sibling `mcp/forge` (`forge-core`) server sharing a factored-out `mcp/lib/rpc.mjs` transport with `forge-graph`. Options: (a) sibling server [recommended], (b) extend `mcp/graph` into one multi-feature server, (c) one server, feature-gated tool groups. Approve (a) or pick.
2. **The MCP tool-surface cut line** - RECOMMEND the 9 `forge-core` tools in (b), with `board_create`/`board_escalate` included and everything fire-and-forget left as shell. The specific escalation-worthy sub-decision: **should `autopilot_merge_bar` be callable by a non-Claude host at all** (i.e. may Codex/Antigravity auto-merge)? Options: expose it everywhere / expose read-only everywhere but gate the live merge to Claude / do not port auto-merge off-Claude [conservative]. Owner picks.
3. **Per-host rail strategy for the two Claude-native rails** - RECOMMEND: safety denylist -> re-implement in each host's hook mechanism *if one exists*, else ship as prose + rely on host sandbox and accept the degradation; journal capture -> same. Owner must explicitly accept that off-Claude forge runs with weaker automatic safety rails (matrix loss #1), or require build to gate forge-on-other-hosts behind a host that has a real PreToolUse-equivalent.
4. **Scope of AC2-AC5** - confirm the build order: AC2 = build `mcp/forge` server + factor shared transport; AC3 = extend `init` to emit AGENTS.md/GEMINI.md forge-tools sections + per-host MCP registration stanzas + cross-host dispatcher shim; AC4 = per-host rail decision implementation; AC5 = the documented degradation matrix shipped in-repo. Owner confirms or re-cuts.
5. **Host confirmation at build time** - the exact Codex (`~/.codex/config.toml`) and Antigravity/Gemini (`.gemini/settings.json`) MCP-registration schemas must be verified against the live tools before `init` generates them. Owner acknowledges these are confirm-at-build, not assumed.

Until the owner rules, this ADR stays **Proposed** and epic #174 is parked (escalation `esc-174`).
