# ADR-0007 - Cross-GAI forge: MCP-first portable core + full host-native adapters

**Date:** 2026-07-25 (revised 2026-07-26) - **Status:** **Proposed** (AC1 gate; needs owner sign-off before build) - **Ticket:** #174 - **Route:** spike (deliverable = this decision record; the throwaway spike branch `spike/174-cross-gai-mcp-first` never merges - it graduates to main after owner sign-off)

## Goal (owner-set, 2026-07-26)

**One forge plugin. Install it into a project whose team uses Claude Code, Codex, *or* Antigravity - and it works the same.** The owner explicitly raised the bar to **full parity with a host-native wrapper**: not "portable capabilities + degraded automation," but the automation layer re-homed into each host's own native mechanism. The only accepted trade is the one deliberate policy line below (auto-merge stays Claude-only, owner decision).

## Context

Epic #174 makes forge natively runnable on GAI hosts other than Claude Code - concretely **Codex** and **Antigravity/Gemini** - by inverting the architecture into an **MCP-first core** plus per-host adapter emission. Today only the graph is exposed over MCP (`plugin/mcp/graph/server.mjs`); the rest of the engine is reachable only as node CLIs invoked by Claude-Code skills, or via the `forge` bash dispatcher (`plugin/bin/forge`). Everything that orchestrates those CLIs - skills, agent cards, hooks, slash commands - is Claude-Code-native today.

AC1 is the gate: a design spike must resolve the architecture and the owner must approve before any build. This ADR is that spike's deliverable, grounded in (1) the actual repo and (2) **researched, current (2026-07-26) capability facts for both target hosts** - not assumptions.

### The repo as it actually is (grounded)

- **Existing MCP server** - `plugin/mcp/graph/server.mjs`: a hand-rolled, zero-dependency JSON-RPC 2.0 server over newline-delimited stdio. Implements `initialize`, `ping`, `tools/list`, `tools/call`; exposes 6 read-only graph tools each with an `inputSchema`, local `validateInput`, and repo-root path canonicalization. Results return as `{ content: [{ type:'text', text: JSON.stringify(payload,null,2) }], isError }`. Re-reads `features.graph` from `.claude/forge.json` per call; fails soft when off. Supporting layers: `db.mjs`, `indexer.mjs`, `queries.mjs`.
- **MCP registration** - `plugin/.claude-plugin/plugin.json` -> `mcpServers.forge-graph = { command:"node", args:["${CLAUDE_PLUGIN_ROOT}/mcp/graph/server.mjs"] }`. The only registration surface today; Claude-plugin-manifest-shaped.
- **The portable engine (node CLIs under `plugin/scripts/`)** - every one an ESM module exporting `runX(ctx, args) -> { ok, ... }`, self-executing only under an `isMain` guard: `board/` (create, move, comment, close, digest, escalate, log, receipt, reparent, status), `gates/` (acgate, depguard, docsync, groundgate, plandrift, situationgate, testintent), `release/` (core, readiness, release), `autopilot/` (select, merge, ledger, newwork, perms, readiness). Depend only on `node`, `gh`, `git`, and `.claude/forge.json`. **None imports a Claude-Code runtime API.**
- **Shell dispatcher** - `plugin/bin/forge`: `forge <area> <command> [args]`, a thin **bash** wrapper over `node scripts/<area>/<cmd>.mjs`. Bash is the one portability caveat (Decision c).
- **The Claude-Code-native layer** - `plugin/.claude-plugin/plugin.json`, `plugin/skills/**` (21 skills - orchestration prose + auto-invocation), `plugin/agents/**` (12 role cards), `plugin/hooks/hooks.json` + `hooks/denylist.mjs` + `hooks/capture.mjs` (PreToolUse Bash denylist / PostToolUse capture-to-journal), `plugin/commands/**` (slash commands), `plugin/monitors/**` (ci-watch, decisions-watch), statusline. **Key insight for this ADR: `denylist.mjs` and `capture.mjs` are already portable node scripts** - only their *registration* (Claude's `hooks.json` + Claude's stdin/stdout hook contract) is Claude-specific. The role cards are portable prompt text; only their frontmatter format is Claude-specific.
- **`init` today** - `plugin/scripts/init.mjs` bootstraps the board, writes `.claude/forge.json`, `.gitignore`, `.gitattributes`, verify CI template. **Does NOT emit AGENTS.md/GEMINI.md today** - those exist hand-maintained with a `<!-- forge:context:begin -->...<!-- forge:context:end -->` block. The generator mechanism is proven: `plugin/scripts/lib/markers.mjs` `upsertBlock(text, marker, content)` rewrites only the marked span, byte-for-byte-preserving everything outside. This is exactly what per-host adapter emission extends.

**Grounding verdict:** the portable engine IS genuinely host-agnostic. The MCP-first direction is not blocked. The one real caveat is the bash dispatcher (addressed in c).

---

## Host capability reality (researched 2026-07-26)

The 2025 pessimism ("Codex/Antigravity can't re-home Claude's hooks or subagents") is **obsolete**. Both hosts shipped the full extension surface. This is the single most important finding of the spike and it is what makes full parity achievable.

| Claude Code mechanism | Codex CLI native equivalent | Antigravity / Gemini CLI native equivalent |
| --- | --- | --- |
| **MCP tool servers** | `[mcp_servers.<name>]` in `~/.codex/config.toml` (stdio via `command`/`args`; project `.codex/config.toml`; `codex mcp add` helper) | Gemini CLI: `mcpServers` in `~/.gemini/settings.json`. Antigravity: `mcpServers` in `~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json` (**no `httpUrl`/`timeout`; env-expansion buggy**) |
| **Instructions file** (board law) | `AGENTS.md` (repo-root + `~/.codex/`, concatenated root->cwd) | `GEMINI.md` (+ honors portable `AGENTS.md`); Antigravity Rules under `.agents/rules/` |
| **Slash commands** | `~/.codex/prompts/*.md` -> `/prompts:<name>` (deprecated in favor of **Skills**) | Gemini CLI: **TOML** in `.gemini/commands/*.toml` -> `/name`. Antigravity: markdown **Workflows** `/workflow-name` + `SKILL.md` skills |
| **Hooks: deny + capture** | **`hooks.json`** (or `[hooks]` in config.toml): `PreToolUse` -> `permissionDecision:"deny"` / exit 2; `PostToolUse` -> capture. JSON on stdin. Search `~/.codex/` + `.codex/` | Gemini CLI: `hooks` in `settings.json` (`BeforeTool`/`AfterTool`, exit 2 or `"decision":"deny"`). Antigravity: `.agents/hooks.json` (`PreToolUse`/`PostToolUse`, `allow`/`deny`/`ask`) |
| **Parallel subagents** | native subagents, **<=6 concurrent/session**; roles in `~/.codex/agents/*.toml` (`explorer`/`worker`/`default`) | Gemini CLI subagents (md+YAML in `.gemini/agents/`, parallel); Antigravity **Agent Manager** = genuine parallel orchestrator |

**Two caveats that shape the build, not blockers:**
1. **No host has a *declarative* command denylist.** On all three (and on Claude), the denylist is *a hook script that inspects the command and returns deny*. forge already ships that script (`denylist.mjs`) - so parity here is "teach the script each host's stdin/stdout contract + register it," not "reimplement."
2. **Antigravity CLI specifics are newer/less stable** than Gemini CLI's (several facts come from Google-employee blogs, and env-var expansion in its MCP config is currently buggy). The adapter must **version-gate** and prefer the portable `AGENTS.md` layer where formats diverge.

---

## (a) The split - portable core vs re-homable orchestration

| Capability | Where it lives today | Off-Claude form (revised to full-parity) |
| --- | --- | --- |
| Board create/move/comment/close/reparent/status/digest/receipt/log | `scripts/board/*.mjs` | MCP tool (structured) OR `forge board <cmd>` shell - **Full** |
| Escalate (halt-and-ask) | `scripts/board/escalate.mjs` | MCP tool - **Full** |
| Mechanical gates (7) | `scripts/gates/*.mjs` | MCP tools - **Full** |
| Release readiness + cut | `scripts/release/*.mjs` | MCP tool (readiness) + shell (cut) - **Full** |
| Autopilot select / merge-bar / ledger | `scripts/autopilot/*.mjs` | MCP tools - **Full** (compute); live *merge action* Claude-only by policy |
| Graph RAG | `mcp/graph/server.mjs` | Same server, host-registered - **Full** |
| Init / doctor / statusline wiring | `scripts/{init,doctor,statusline}.mjs` | `forge init` emits per-host files - **Full** (statusline surface itself Claude-only) |
| **Safety denylist** (block force-push/hard-reset) | `hooks/denylist.mjs` + Claude `hooks.json` | **Full** - same script, re-registered in Codex `hooks.json` / Gemini+Antigravity hooks (PreToolUse deny) |
| **Journal capture** (learning loop) | `hooks/capture.mjs` + Claude `hooks.json` | **Full** - same script, re-registered as PostToolUse/AfterTool |
| **Subagent role fan-out** (scoper/planner/implementer/reviewer) | `plugin/agents/**` + Task tool | **Full** - role prompts emitted as Codex `agents/*.toml` (<=6) / Gemini `agents/*.md` / Antigravity agents |
| **Slash-command UX** | `plugin/commands/**` | **Full** - emitted as Codex prompts/skills / Gemini TOML commands / Antigravity workflows |
| Skill auto-invocation | skills + Claude runtime | **Near-full** - model-driven on all hosts (prose + skill descriptions nudge, not runtime-enforced trigger) |
| Background monitors (ci-watch/decisions-watch) | `plugin/monitors/**` | **Partial** - host session events (`SessionStart`/notify) where present, else manual/cron |
| Statusline | `scripts/statusline.mjs` + settings | **Lost** off-Claude (no statusline API anywhere) - cosmetic only |

The dividing line is no longer "portable vs Claude-native." It is: **one portable source of truth (node CLIs, MCP tools, hook scripts, role prompts) that `init` re-registers into whatever config shape the target host expects.** Only the statusline (cosmetic) and the runtime-*enforced* skill-trigger have no equivalent - and skill invocation is model-driven everywhere, so that gap is soft.

---

## (b) The MCP tool surface to expose

**Server home:** add a **sibling** `mcp/forge` server (`plugin/mcp/forge/server.mjs`), NOT an extension of `mcp/graph`. `mcp/graph` is single-feature, gated on `features.graph`, and graph-db-specific; board/gate/autopilot tools have a different lifecycle (`makeBoardCtx` + `gh`) and gate. Keep `forge-graph` untouched; add `forge-core` as a second server reusing the *protocol skeleton* factored into **`mcp/lib/rpc.mjs`** (the ~50-line JSON-RPC loop, `validateInput`, `canonicalize`, `toolText`) so both share one hardened transport and neither regresses.

**MUST-be-MCP rule:** a capability is an MCP tool when the *caller needs the structured return to decide its next move* (pass/fail, changed/verified, the merge-bar vector, the readiness checklist). Fire-and-forget stays `forge <area> <cmd>` shell.

Proposed `forge-core` tools (beyond the 6 graph tools):

| Tool | Input | Structured return | Why MCP |
| --- | --- | --- | --- |
| `board_move` | `{ issue, status }` | `{ ok, changed, verified, status }` | Caller branches on `verified` |
| `board_comment` | `{ issue, phase:enum, body, actor?, session? }` | `{ ok, action }` | Trail law; `phase` enum validated |
| `board_create` | `{ title, body?, type?, priority?, size?, area?, parent? }` | `{ ok, number, url }` | Caller needs the new number |
| `board_escalate` | `{ issue, reason, options[>=2], recommend?, context? }` | `{ ok, id, boardNote, pending }` | The halt-and-ask spine |
| `board_status` | `{ issue? }` | `{ ok, items[] }` | Read-model to reason over |
| `gate_run` | `{ gate:enum(ac|dep|docsync|ground|plandrift|situation|testintent), ...args }` | `{ ok, level:pass\|fail, findings[] }` | Gates ARE decision points |
| `release_readiness` | `{}` | `{ ok, items:[{name,level,msg}] }` | Checklist evaluated item-by-item |
| `autopilot_select` | `{ area?, shape? }` | `{ ok, next\|null, queue[] }` | Picks next ticket; structured return is the point |
| `autopilot_merge_bar` | `{ signals:{ship,gates,reviewer,security,ci} }` | `{ ok, merge:bool, blockedOn[] }` | The trust bar; typed, never stdout-scraped |

Stay shell: `board close/digest/receipt/log/reparent`, `release release` (the cut), `graph rebuild/reindex`, `init`, `doctor`, `learn`.

**Claude-only auto-merge (owner decision, 2026-07-26).** `autopilot_merge_bar` is exposed on every host as a *computation* (a host may see whether the bar is green). But the plugin does **NOT** wire an unattended merge action on non-Claude hosts: on Codex/Antigravity, forge stops at an **open, green PR / awaiting-human**. The live `gh pr merge` remains Claude-only, where the full auto-safety stack (denylist hook + merge authority grant) is proven. This is the one deliberate parity exception, and it is a policy line, not an engine limit.

---

## (c) Per-host adapters, concretely

`init` gains a `--host` mode (or auto-detect from present config dirs) that emits, from **one portable source of truth**, the config shape each host expects. All emission uses `markers.upsertBlock` so re-runs refresh in place and never touch user prose outside the block. Windows-first shell rules (argv-array spawns, no POSIX `%TEMP%` assumptions) are preserved verbatim in every emitted file. All emitted `.ps1`/`.cmd`/`.md` stay ASCII-only.

**Five things `init` emits per host (the host-native wrapper):**

| Layer | Source of truth | Claude | Codex | Antigravity/Gemini |
| --- | --- | --- | --- | --- |
| Instructions / board law | managed context block | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` (+ portable `AGENTS.md`) |
| MCP registration | `forge-core`/`forge-graph` server paths | plugin manifest | `[mcp_servers.*]` in `~/.codex/config.toml` | `mcpServers` in `~/.gemini/settings.json` / `.agents/mcp_config.json` |
| Deny + capture hooks | `hooks/denylist.mjs`, `hooks/capture.mjs` (already portable) | `hooks.json` | `hooks.json` PreToolUse/PostToolUse | Gemini `settings.json` hooks / Antigravity `.agents/hooks.json` |
| Role subagents | `plugin/agents/**` prompt text | agent cards | `~/.codex/agents/*.toml` (<=6) | `.gemini/agents/*.md` / Antigravity agents |
| Slash commands | `plugin/commands/**` / skill prose | commands | `~/.codex/prompts/*.md` or Skills | Gemini `.gemini/commands/*.toml` / Antigravity Workflows |

**Hook contract shim (the one piece of real new code beyond registration):** `denylist.mjs`/`capture.mjs` currently read Claude's hook stdin JSON and emit Claude's decision shape. Codex, Gemini, and Antigravity each pass tool context as JSON on stdin and read a deny/allow decision back - *close but not identical* shapes. The adapter adds a thin I/O normalization layer (or per-host entry shims) so the same denylist/capture logic speaks each host's contract. The denylist *rules* stay in one place.

**The `forge` dispatcher:** `plugin/bin/forge` is bash. Adapter work is a sibling `forge.cmd`/`forge.ps1` (or "run under node/Git-Bash") so `forge board create ...` works on a bare Windows shell. No CLI logic changes.

**Build-time confirmation:** exact config paths/schemas above are researched-current but MUST be re-verified against the installed host versions before `init` writes them (Codex has had MCP-config regressions; Antigravity CLI is young). `init` should emit + also print the stanza for the user to verify, and `forge doctor --host <h>` should validate what landed.

---

## (d) The parity matrix (revised - was "degradation")

Full = works as on Claude; Near = model-driven equivalent; Partial = reduced/manual; Lost = unavailable.

| Capability | Claude Code | Codex | Antigravity/Gemini |
| --- | --- | --- | --- |
| Board law (create/move/comment/escalate) | Full | **Full** (MCP+shell) | **Full** (MCP+shell) |
| Mechanical gates (7) | Full | **Full** (MCP) | **Full** (MCP) |
| Graph RAG | Full | **Full** (register server) | **Full** (register server) |
| Release readiness + cut | Full | **Full** | **Full** |
| Safety denylist (block force-push/hard-reset) | Full | **Full** (PreToolUse deny hook) | **Full** (BeforeTool/PreToolUse deny) |
| Journal capture (learning loop) | Full | **Full** (PostToolUse hook) | **Full** (AfterTool/PostToolUse) |
| Parallel subagent fan-out | Full | **Full** (native subagents, <=6) | **Full** (subagents / Agent Manager) |
| Slash-command UX | Full | **Full** (prompts/Skills) | **Full** (TOML commands / Workflows) |
| Pipeline / deliver (spec->plan->execute->ship) | Full (auto) | **Near** (model orchestrates via tools + instructions) | **Near** (model orchestrates) |
| Skill auto-invocation | Full (runtime trigger) | **Near** (model-driven) | **Near** (model-driven) |
| Autopilot unattended auto-merge on green | Full | **Stops at green PR** (owner policy, not a limit) | **Stops at green PR** (owner policy) |
| Background monitors (ci-watch/decisions-watch) | Full | **Partial** (session events / cron) | **Partial** |
| Statusline | Full | Lost (no API) | Lost (no API) |

**What actually differs, honestly:** (1) auto-merge is *deliberately* Claude-only (policy). (2) The pipeline/skill *auto-flow* is runtime-triggered on Claude but model-driven elsewhere - same capability, invoked because the instructions tell the model to, not because a runtime trigger fires it; in practice near-identical for an agent following AGENTS.md. (3) Background monitors degrade to session events/cron. (4) The statusline is cosmetic and Claude-only. **Everything load-bearing - board law, all seven gates, the safety denylist, journal capture, parallel fan-out - reaches Full parity.** The 2025 "two sharpest losses" are gone.

---

## Owner sign-off (AC1) - decisions

Resolved with the owner (2026-07-26):
- **Parity bar** = **full parity, host-native wrapper** (this ADR's target). [DECIDED]
- **Auto-merge trust** = **Claude-only**; non-Claude hosts stop at green PR / awaiting-human. `autopilot_merge_bar` computes everywhere, live merge Claude-only. [DECIDED]
- **MCP server home** = sibling `mcp/forge` (`forge-core`) sharing a factored `mcp/lib/rpc.mjs` with `forge-graph`. [RECOMMEND - approve or pick]
- **MCP tool cut line** = the 9 `forge-core` tools above. [RECOMMEND - approve or pick]

Open confirmations (not blockers, but owner should acknowledge):
1. **Which non-Claude host to prove first (AC4 dogfood).** RECOMMEND **Antigravity** (the owner already runs `agy`), driving one real ticket through forge end-to-end on it before generalizing to Codex.
2. **Host schemas are confirm-at-build.** Codex `~/.codex/config.toml` + `hooks.json` and Antigravity/Gemini `settings.json`/`.agents/*` shapes are researched-current but MUST be re-verified against installed versions before `init` writes them (Codex MCP-config regressions; young Antigravity CLI).

## Build plan (AC2-AC5)

- **AC2 - MCP core.** Factor `mcp/lib/rpc.mjs` out of `mcp/graph`; build `mcp/forge/server.mjs` exposing the 9 `forge-core` tools over it; register `forge-core` in the Claude manifest. Tests: tool contract + structured-return shape per tool.
- **AC3 - `init` host-native emission.** `forge init --host <claude|codex|antigravity>` (+ auto-detect) emits the five-layer wrapper (instructions / MCP registration / deny+capture hooks / role subagents / slash commands) via `upsertBlock`, from the portable source of truth. Includes the hook-contract shim for `denylist.mjs`/`capture.mjs` and the `forge.cmd`/`.ps1` dispatcher shim.
- **AC4 - dogfood on one non-Claude host.** Drive one real ticket through forge on Antigravity (owner's runnable host) end-to-end - board move, a gate, an escalate, stop-at-green-PR - proving the wrapper.
- **AC5 - docs.** Ship the cross-GAI guide + this parity matrix + README wiring so an adopter can install forge on any of the three.

Until the owner rules on the two RECOMMENDs + the AC4 host, this ADR stays **Proposed** and epic #174 is parked.
