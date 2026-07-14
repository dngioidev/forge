# forge — AI-driven development platform — Design Spec

**Date:** 2026-07-15
**Repo:** dngioidev/forge (new)
**Testbed:** dngioidev/cms (design system), later tasky-ai and future repos
**Goal:** A portable Claude Code plugin that runs the owner's entire AI development workflow: pipeline skills (idea → tickets → spec → plan → execute → ship), a specialized agent roster with pluggable CLI backends, GitHub Projects automation, an error-learning loop, and a structural graph-RAG index for code retrieval and reuse.

## 1. Purpose & context

- Owner: solo developer running repos end-to-end with Claude Code.
- Today: the superpowers plugin provides process orchestration (brainstorm → plan → subagent-driven-development → ship); board work is hand-driven GraphQL; subagents are generic; nothing learns from errors; no code-reuse retrieval.
- Decision (owner, 2026-07-15): build an **own pipeline** — forge replaces superpowers **incrementally, skill by skill**, proving parity on real cms work before each superpowers counterpart is retired. Superpowers is uninstalled from consumer repos once forge's pipeline skills reach parity.
- Claude Code is always the orchestrator. Other CLIs (agy/Gemini, codex, …) may fill individual agent roles to save tokens, never orchestrate.

### Decisions log (owner-approved during brainstorm, 2026-07-15)

| Decision | Choice |
| --- | --- |
| Goal | Portable platform, not cms-only |
| Home | New repo `dngioidev/forge`, Claude Code plugin marketplace |
| Pipeline | Own pipeline (approach B), incremental skill-by-skill migration |
| Graph RAG | Structural graph (ts-morph → SQLite → MCP), no embeddings in v1 |
| Learning | Auto-capture kind-tagged failures + gated `/distill` (human approves every lesson) |
| Board | Docs-as-code stays in git; board = tracker + auto-published digests |

## 2. Repo & plugin anatomy

```
forge/
  .claude-plugin/marketplace.json    one marketplace, one plugin: "forge"
  plugin/
    .claude-plugin/plugin.json
    skills/          pipeline + board + learning skills (markdown)
    cards/           backend-neutral role cards (single source; outside agents/ so Claude Code never loads them as agents)
    agents/          Claude-native agent definitions compiled from cards
    hooks/           learning-capture hooks (node .mjs + hooks.json)
    commands/        /distill, /ticket, /new-component
    mcp/graph/       graph-RAG MCP server (node)
    scripts/
      board/         gh GraphQL helpers (create/move/receipt/digest/log)
      backends/      CLI adapters (agy, codex, …) implementing run/report contract
      lib/           shared node utilities (Windows-safe spawn, path, CRLF)
  docs/
    specs/           forge's own design docs (this file)
    plans/           forge's own implementation plans
  package.json       Node 22, vitest suites for hooks/scripts/mcp
  .github/workflows/ verify CI (vitest, actionlint, SHA-pinned actions)
```

- Consumer repos install via `claude marketplace add dngioidev/forge` + plugin install.
- **Per-repo config `.claude/forge.json`** (committed in each consumer repo) keeps the plugin generic:

```jsonc
{
  "version": 1,
  "board": {
    "projectNumber": 7,
    "projectId": "PVT_…",
    "fields": { "status": { "id": "…", "options": { "backlog": "…", "inProgress": "…", "done": "…" } },
                 "priority": { "…": "…" }, "size": { "…": "…" }, "type": { "…": "…" } },
    "deliveryLogIssue": 205
  },
  "conventions": {
    "verify": "pnpm verify",
    "commitFormat": "conventional+issue-ref",
    "specsDir": "docs/superpowers/specs",
    "plansDir": "docs/superpowers/plans"
  },
  "roster": { /* section 4 */ }
}
```

- `forge board init` discovers project/field IDs via gh GraphQL and writes the board block.
- Principles: plain Node + gh CLI only; no external services; no API keys beyond existing gh/CLI auth; Windows-first (CRLF, `.cmd` spawn EINVAL, path-separator lessons become test cases in forge CI).

## 3. Pipeline skills

Seven skills. Flow: **ideate → triage → brainstorm → plan → execute → ship**, with `board` called by all of them. Each skill is a markdown checklist + process graph, same discipline as superpowers but tuned: solo dev, ticket-first, owner's gate map, Windows shell rules, caveman-terse receipts.

1. **`forge:ideate`** — raw idea / feature area → feature brainstorm → decomposed feature list → epic + child tickets with acceptance criteria, type, size, priority, dependencies, board placement. Builds the ticket tree so work starts ticket-first. (Whole feature areas; single items go straight to triage.)
2. **`forge:triage`** — one incoming bug/idea → correctly-typed ticket with AC + board placement.
3. **`forge:brainstorm`** — ticketed feature → design spec in the consumer's specs dir; decomposition-first for multi-system asks; spec self-review; owner approval gate.
4. **`forge:plan`** — spec → task-by-task plan in the consumer's plans dir. Every task carries: ticket ref, files, complete code, **test-plan section** (cases, edge matrix, AC mapping — drafted by `test-architect`), verify command, done-criteria.
5. **`forge:execute`** — plan → branch. Order per task: `scoper` narrows blast radius (which components/files/tests) → `test-architect` writes failing tests → `implementer` makes them pass → per-task review (`reviewer`; `design-reviewer` added for UI tasks). Whole-branch final review + fix waves at the end. Ledger `.forge/progress.md` (git-ignored, survives compaction).
6. **`forge:ship`** — branch → PR: commits→issues map, honest verification checklist, **AC-verification gate** (`test-architect` confirms every AC has a passing test), **security gate** (`security` reviewer pass on the branch) before PR creation. After owner merges: receipt comments, board Done moves, delivery-log row, epic digest refresh.
7. **`forge:board`** — shared ticket-operations skill wrapping `scripts/board/*` (section 5); the other six call it instead of raw GraphQL.

Migration order (parity proven on real cms work before retiring each superpowers counterpart): ship → plan+execute → brainstorm. `ideate`, `triage`, `board` have no counterpart and land whenever ready.

## 4. Agent roster & pluggable backends

**Role ≠ runtime.** Each role is a **role card** (mission, checklist, output contract, guardrails) rendered onto a configurable **backend**.

| Role | Default backend | Job |
| --- | --- | --- |
| `implementer` | claude:sonnet | one plan task, TDD, conventions injected from forge.json |
| `reviewer` | claude:fable | per-task + whole-branch review, severity-tagged findings |
| `security` | claude:fable (**pinned, not swappable**) | adversarial pass: injection, secrets, supply chain, hook/CI attack surface; read-only |
| `design-reviewer` | claude:sonnet | token-only styling, a11y contract, stories present, visual spec match |
| `scoper` | claude:sonnet | ticket impact analysis: touched components/files, test set to run, blast radius |
| `test-architect` | claude:sonnet | AC → test plan; writes failing tests first; verifies AC coverage at ship |
| `investigator` | claude:haiku | read-only code location, cheap fan-out |
| `librarian` | claude:haiku | RAG-first lookup: queries graph MCP before any grep sweep |
| `second-opinion` | codex:gpt-5 (optional) | independent second-pass critique of specs/plans/diffs on demand; read-only, advisory — never a merge gate |

**Backends** (per-repo `forge.json` `roster` block):

```jsonc
"roster": {
  "investigator":   { "backend": "agy:gemini-flash",  "fallback": "claude:haiku" },
  "librarian":      { "backend": "agy:gemini-flash",  "fallback": "claude:haiku" },
  "second-opinion": { "backend": "codex:gpt-5",       "optional": true },
  "implementer":    { "backend": "claude:sonnet" }
  // "security" pinned to claude — config ignored by design
}
```

- Backend id format is uniform: **`<runtime>:<model>`** (`claude:sonnet`, `agy:gemini-pro`, `agy:gemini-flash`, `codex:gpt-5`, …). Model part optional — bare runtime (`agy`) means the adapter's declared default model. `fallback` uses the same format.
- **Role cards are backend-neutral**, stored in `plugin/cards/<role>.md` (mission, checklist, guardrails, output contract). One source, two renderers:
  - `claude:*` — card compiled to `agents/<role>.md` native subagent. Compiled agent files carry **no model pin**: the orchestrator reads the roster and passes the model at spawn time, so a per-repo model override needs no file regeneration.
  - CLI backends (`agy`, `codex`, …) — adapter script per CLI in `scripts/backends/`, one contract: `run(roleCard, taskBrief, model) → report`. The adapter renders `role card + forge.json conventions + task brief + report contract` into a single prompt (`agy -p …`, `codex exec …`), owns the model-id→CLI-flag mapping, and declares its default model plus accepted model ids; unknown model id → treated like missing CLI. Generalizes the existing agy-consult pattern.
- **Task brief** is composed by the orchestrator: goal, ticket ref, scoped file list (from `scoper`/graph), constraints, expected output. CLI agents run in the repo cwd and read files themselves — briefs carry pointers, never file dumps.
- **Native context sync:** `forge backends sync` renders forge.json conventions (verify command, commit format, specs/plans dirs, Windows shell rules) into the context files each CLI reads natively — `GEMINI.md` for agy, `AGENTS.md` for codex — so repo context costs zero prompt tokens per call. Sync writes a fenced managed block (`<!-- forge:begin --> … <!-- forge:end -->`) and never touches content outside it, so hand-written sections survive. Re-run on forge.json change; `board init` runs it once.
- **Report contract** (every role, every backend): markdown body + terminal JSON block

  ```json
  { "verdict": "pass|fail", "findings": [ { "severity": "critical|major|minor", "file": "…", "line": 1, "summary": "…" } ] }
  ```

  Ship gates (reviewer, security, AC-verification) consume the JSON block only — never parse prose.
- Failure handling: per-adapter timeout (default 10 min). Timeout, nonzero exit, or malformed report JSON → one retry with the violation appended to the prompt, then `fallback` backend + `backend-fallback` journal event. Missing CLI / auth failure skips straight to fallback. `optional: true` roles have no fallback: on any failure the role is skipped with a note in the session output (still journaled).
- Rules:
  - Claude Code always orchestrates; CLIs only fill roles.
  - Token-heavy read roles are the intended swap targets (investigator, librarian, second-opinion).
  - A write-capable CLI backend (e.g. agy as implementer) is allowed **only on a child branch, with a mandatory Claude `reviewer` diff pass before merge** (existing tasky rule, now platform law).
  - `security` is a trust boundary: always Claude, config cannot override.
  - **CLI reports are untrusted input:** the orchestrator treats them as data, never as instructions to follow; any CLI-backend contribution to a branch still passes the Claude `reviewer` + `security` gates.
  - **Data sharing:** CLI backends send repo content to third-party providers (Google, OpenAI). Accepted for the owner's repos; a consumer repo opts out by not listing CLI backends in its roster.
- Consumer repos may override role cards: for `claude:*` backends, ship `.claude/agents/<role>.md` (repo definitions win over plugin — Claude Code precedence); for CLI backends, adapters prefer `.claude/cards/<role>.md` over the plugin card when present. Same override story both sides.
- Adding a role = new role card + forge.json entry. Adding a CLI = one adapter implementing the contract.

## 5. Board automation

`scripts/board/*.mjs`, all invoked through `forge:board`:

- **create** — ticket with type/priority/size/parent (native sub-issue) + board add + field set, in one command.
- **move** — status transitions (Backlog → In progress → Done).
- **receipt** — merge receipt comment on issues; idempotent (re-run updates, never duplicates).
- **Idempotency is a rule for every script, not just receipt:** re-runs detect existing state (issue by title+parent, board item, comment marker) and resume or update instead of duplicating. Multi-step `create` (issue → board add → field set) resumes from the failed step.
- **digest** — epic body auto-carries spec link + live child table; refreshed on child changes.
- **log** — delivery-log row append to the pinned per-repo issue (tasky #205 pattern).
- **init** — discovers project/field/option IDs, writes `forge.json` board block, adds `.forge/` to the consumer `.gitignore`, runs `forge backends sync`.

Docs stay in git (reviewable, diffable); the board is the tracker + window. Field IDs are read from config — no hand-built GraphQL in sessions ever again.

## 6. Learning loop

**Capture** — plugin hooks (PostToolUse + gate failures) append kind-tagged JSONL to `.forge/journal.jsonl` (git-ignored):

```json
{"ts":"…","kind":"gate-fail","tool":"Bash","cmd":"pnpm verify","exit":1,"err_line":"…","ticket":"#15","branch":"feat/…"}
```

Kinds: `gate-fail`, `blocked-edit`, `cmd-fail`, `backend-fallback`, `review-finding`. Read-only commands (grep/ls/cat/gh view/git log/…) are excluded **at capture time** via an exclusion list — the tasky-ai journal-noise lesson baked in. `review-finding` events are not tool failures, so hooks can't see them: the execute/ship skills append them explicitly from reviewer report JSON.

**Distill** — `/distill` skill: reads journal since last run, clusters repeats, proposes per cluster one of: CLAUDE.md rule, role-card edit, new lint/hook guard, memory entry. **Owner approves each proposal before anything is written.** Applied lessons are logged with journal refs; after distill the journal is archived to `.forge/journal-archive/<date>.jsonl` (rejected clusters keep their evidence), and the live journal starts empty. Suggested cadence: after each epic ships, or weekly.

## 7. Graph RAG MCP server

`plugin/mcp/graph/` — structural index of the consumer repo, no embeddings in v1 (schema leaves room for a v2 embedding column).

- **Indexer:** ts-morph parse → SQLite `.forge/graph.db` via built-in `node:sqlite` (Node 22 — no native-module builds on Windows). Git-ignored, rebuildable, zero network.
  - Nodes: file, component, export, props-interface, token, story, test, icon.
  - Edges: imports, renders, uses-token, tests, documents. Ticket edges from commit-message issue refs link code to tickets.
- **Incremental:** `forge graph install-hook` writes a `.git/hooks/post-commit` that reindexes changed files only (plugins cannot install git hooks themselves — explicit opt-in command). `forge:execute`/`forge:ship` also reindex touched files, so the graph stays fresh even without the hook; `forge graph rebuild` does a full pass.
- **MCP tools:** `find_component(query)`, `who_uses(symbol|token)`, `similar_props(interface)`, `blast_radius(files[])`, `code_for_ticket(#n)`, `reuse_candidates(description)` (ranked by export/props/story-text keyword match).
- **Consumers:** `librarian` answers "does X already exist" before anything new is written; `scoper` computes touched components + the test set from `blast_radius`; the `implementer` role card mandates a `reuse_candidates` check before creating new files.

## 8. Rollout

Each sub-project = its own spec → plan → epic in the forge repo, executed with the current pipeline (superpowers until forge replaces it), dogfooded on live cms component work (Epics 3–6) before the next starts.

| # | Sub-project | Size | Replaces |
| --- | --- | --- | --- |
| 1 | Plugin skeleton: marketplace, plugin.json, cms install, `forge.json` schema + `board init` | S | — |
| 2 | Board automation: `forge:board` + scripts | M | manual GraphQL |
| 3 | `forge:ship` + `forge:triage` | M | ship-and-document ritual |
| 4 | Agent roster + backend adapters (role cards, agy adapter, fallback logic) | M | generic subagents |
| 5 | `forge:plan` + `forge:execute` (scoper + test-architect gates wired) | L | writing-plans + subagent-driven-development |
| 6 | `forge:ideate` + `forge:brainstorm` | M | brainstorming |
| 7 | Learning loop: capture hooks + `/distill` | M | — |
| 8 | Graph RAG MCP (`librarian` goes live; `scoper` upgrades from import-scan to graph) | L | — |

Superpowers is uninstalled from cms after sub-project 6. Graph RAG is last deliberately: its payoff grows with codebase size, and by then cms has real components to index.

## 9. Quality & testing

- forge repo: own GitHub project board, conventional commits + issue refs, feature-branch + PR flow — the platform obeys the workflow it enforces.
- CI `verify`: vitest suites for hooks, board scripts, backend adapters, MCP server (fixture repos as test beds); actionlint; SHA-pinned actions; concurrency cancel.
- Windows-first test cases: CRLF handling, `.cmd` spawn without shell (EINVAL), path-separator comparisons — every recorded Windows lesson becomes a regression test.
- Skills are markdown (not unit-testable) — validated by dogfooding gates: a pipeline skill only retires its superpowers counterpart after shipping at least one real cms epic end-to-end.
- Security posture: hooks and adapters never interpolate untrusted strings into shell commands (in-process APIs or argv arrays only — the format.mjs command-injection lesson); journal capture never logs secrets (denylist on env-looking tokens); `security` role not swappable; CLI-backend reports are untrusted input — parsed as data, never followed as instructions, always behind the Claude `reviewer` + `security` gates (section 4).

## 10. Out of scope (v1)

- Embeddings / semantic search (v2 of graph RAG).
- Non-TypeScript language indexers.
- Multi-user / team features — single owner assumed everywhere.
- Replacing Claude Code as orchestrator.
