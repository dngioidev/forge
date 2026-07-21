# Spike — Claude Code plugin capabilities vs. forge, and an enhancement plan

**Kind:** spike (research) · **Source:** code.claude.com/docs/en/{plugins, plugins-reference, plugin-marketplaces} · **Date:** 2026-07-21.

Time-boxed read of the full plugin surface to answer: *what can a plugin do that forge doesn't yet, and what's worth adding?*

## 1. The full capability surface (component types)

| Component | Location | forge today | Notes |
|---|---|---|---|
| **skills/** | `skills/<name>/SKILL.md` | ✅ 18 skills | model- + user-invokable; `$ARGUMENTS`; `disable-model-invocation` for user-only |
| **agents/** | `agents/*.md` | ✅ 12 compiled cards | model/tool pins |
| **hooks/** | `hooks/hooks.json` | ✅ denylist + capture | Pre/PostToolUse |
| **MCP** | `.mcp.json` / manifest | ✅ forge-graph | stdio graph RAG |
| **commands/** | flat `.md` | — (uses skills) | legacy; skills preferred ✅ |
| **LSP** | `.lsp.json` / `lspServers` | ❌ | real-time diagnostics + navigation; official `typescript-lsp` exists |
| **monitors/** | `monitors/monitors.json` | ❌ | background watchers that push stdout lines to Claude as notifications; `when: always \| on-skill-invoke:<skill>`; interactive-only, unsandboxed |
| **bin/** | `bin/` | ❌ | executables added to the Bash tool PATH while enabled |
| **themes/** | `themes/*.json` (experimental) | ❌ | ship a `/theme`; `base` + sparse `overrides` |
| **output-styles/** | `output-styles/` | ❌ | custom response styles |
| **plugin settings.json** | root `settings.json` | ❌ | default settings on enable; only `agent` (activate a custom agent as main thread) + `subagentStatusLine` supported |
| **channels** | manifest `channels[]` | ❌ | Telegram/Slack/Discord message injection, bound to an MCP server |

## 2. Manifest + distribution features forge under-uses

- **`plugin.json` is minimal** — only `name`, `version`, `description`, `author.name`, `mcpServers`. Missing discovery/validation metadata: `displayName`, `homepage`, `repository`, `license`, `keywords`, `$schema`.
- **`claude plugin validate [--strict]`** exists and is run by the community review pipeline — forge does not run it in CI. `--strict` turns unrecognized/misspelled manifest fields into errors.
- **`${CLAUDE_PLUGIN_DATA}`** — a persistent per-plugin dir (`~/.claude/plugins/data/<id>/`) that survives updates. Ideal for caches/generated state (e.g. the code-graph SQLite db) instead of rebuilding each update or writing into the version-pinned `${CLAUDE_PLUGIN_ROOT}` (which is wiped ~14 days after an update).
- **`userConfig`** — enable-time prompts stored in user settings / keychain. forge's config lives in project `forge.json` (via init), so this is a weak fit except for a few user-level prefs.
- **`defaultEnabled`, dependencies, release channels** — not needed for a single solo plugin today.

## 3. Recommendations (tiered)

### Tier 1 — clear wins (low effort, low risk)
1. **Manifest completeness + `plugin validate --strict` in CI.** Fill `displayName`/`homepage`/`repository`/`license`/`keywords`/`$schema`; add a `claude plugin validate --strict` step to `verify.yml`. Catches manifest drift; improves marketplace listing.
2. **`bin/forge` dispatcher on PATH.** A single `forge <area> <cmd>` entry point wrapping the `scripts/**` node CLIs, so skills' prose and manual use stop repeating `node "${CLAUDE_PLUGIN_ROOT}/scripts/.../x.mjs"`. *Honest caveat:* it still needs `node` resolvable — it shortens commands, it doesn't fix a missing node on PATH.

### Tier 2 — strong fits (medium effort)
3. **Monitors for autopilot.** A CI-status watcher so the auto-merge bar reacts to green instead of polling, and a watcher on `.forge/decisions/` so answered escalations surface immediately. Directly strengthens autopilot + escalate. (Interactive-only, unsandboxed — fine for a user-installed plugin.)
4. **Persist the code-graph index in `${CLAUDE_PLUGIN_DATA}`.** Move the graph SQLite db / caches there so they survive plugin updates instead of rebuilding. (Spike: confirm where the db currently lives.)

### Tier 3 — polish / brand (small)
5. **`themes/forge.json`** — the smithy/ember identity as a selectable `/theme`.
6. **`disable-model-invocation`** on user-only skills (`init`, `release`, `deploy-init`) so Claude doesn't auto-invoke them.
7. **`settings.json` `subagentStatusLine`** — surface role-subagent status during fan-out.
8. **Recommend official `typescript-lsp`** in the install guide (don't bundle — the binary is the user's to install).

### Not now (out of scope)
`channels` (Slack/Telegram notifications), `output-styles`, bundling LSP servers, `userConfig` for board config (init/forge.json already owns it), `settings.json agent` (forge is many skills, not one main-thread agent).

## 4. Suggested delivery order
T1.1 (metadata+validate, trivial) → T1.2 (bin/forge, high leverage) → T2.3 (monitors, new autopilot power) → T2.4 (graph data dir) → T3 polish bundle.
