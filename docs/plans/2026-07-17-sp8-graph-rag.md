# SP8 — Graph RAG MCP server

**Ticket:** #10 · **Branch:** `feat/10-graph-rag` · **Spec:** §9, rollout row 8.

Structural index of the consumer repo: ts-morph parse → SQLite `.forge/graph.db` via built-in `node:sqlite` (Node ≥22.13 — no native builds on Windows), exposed as MCP tools over stdio. Feature-flagged `features.graph`, **TypeScript repos only**; with the flag off (or a non-TS repo) `librarian` stays grep-first and `scoper` import-scan — that fallback is permanent, not a stopgap. No embeddings initially; the schema keeps an embedding column slot (backlog).

**Dependency decision (records the zero-runtime-deps stance):** forge itself stays dependency-free — the indexer `import('ts-morph')`s lazily and resolves it **from the consumer repo**, which is where a TS project's tooling lives. `doctor` turns a missing ts-morph into an actionable warning when `features.graph` is on. ts-morph enters this repo as a **devDependency only** (test fixtures need a real parse).

## Tasks

- [ ] T1 — DB layer: `plugin/mcp/graph/db.mjs` — `node:sqlite` DatabaseSync; tables `nodes(id, kind, name, file, meta, embedding)` / `edges(src, dst, kind)`; node kinds file/component/export/props-interface/token/story/test/icon, edge kinds imports/renders/uses-token/tests/documents/ticket; **parameterized SQL only**; `resetDb` for rebuild; upserts idempotent.
- [ ] T2 — Indexer: `plugin/mcp/graph/indexer.mjs` — lazy ts-morph from the consumer repo; per-file extraction: exports, components (JSX-returning functions/classes), props interfaces, imports edges, test files (`*.test.*` → tests edges by import), stories (`*.stories.*` → documents edges); `indexFiles(paths)` incremental (delete file-scoped rows, re-add) and `rebuild()` full pass; non-TS repo or missing ts-morph ⇒ teaching error naming the permanent fallback.
- [ ] T3 — Queries: `plugin/mcp/graph/queries.mjs` — `find_component`, `who_uses` (symbol or token), `similar_props` (interface-member overlap), `blast_radius` (transitive dependents of files[]), `code_for_ticket` (ticket edges), `reuse_candidates` (ranked export/props/story keyword match).
- [ ] T4 — MCP stdio server: `plugin/mcp/graph/server.mjs` — hand-rolled JSON-RPC 2.0 (initialize/tools list+call; no SDK dep); every tool input schema-validated; file-path params canonicalized — traversal outside the repo root refused. Registered in `plugin/.claude-plugin/plugin.json` `mcpServers` behind the flag check (server exits cleanly with a flag-off notice).
- [ ] T5 — Ticket edges + CLI: `plugin/scripts/graph/graphctl.mjs` — `rebuild`, `reindex <files…>`, `tickets` (git log issue-ref scan → ticket edges), `install-hook` (writes `.git/hooks/post-commit` reindexing changed files — explicit opt-in, plugins can't install git hooks themselves).
- [ ] T6 — Wiring: `features.graph` in config validation; `doctor` checks (flag on + non-TS repo, flag on + ts-morph missing, db staleness note); ts-morph devDep for fixtures.
- [ ] T7 — Tests + dogfood: TS fixture project under `tests/fixtures/graph-ts/`; index it for real; drive the server over stdio end-to-end; `code_for_ticket` live against this repo's own git history.

**Files:** plugin/mcp/graph/db.mjs, plugin/mcp/graph/indexer.mjs, plugin/mcp/graph/queries.mjs, plugin/mcp/graph/server.mjs, plugin/scripts/graph/graphctl.mjs, plugin/scripts/lib/config.mjs, plugin/scripts/doctor.mjs, plugin/.claude-plugin/plugin.json, package.json, pnpm-lock.yaml, docs/README.md

## Acceptance criteria

- AC-8.1 — schema created with parameterized statements only; rebuild wipes and repopulates; upserts are idempotent (re-index ⇒ no duplicate rows).
- AC-8.2 — the indexer extracts components, exports, props interfaces, import/tests/documents edges from the TS fixture; a non-TS repo (or missing ts-morph) gets a teaching error naming the permanent grep/import-scan fallback.
- AC-8.3 — the stdio server answers initialize and tools/list, executes tools/call, and returns JSON-RPC errors for unknown tools and schema-invalid inputs.
- AC-8.4 — find_component/who_uses/similar_props/blast_radius/reuse_candidates return the expected fixture results (blast_radius is transitive).
- AC-8.5 — code_for_ticket maps commits carrying `(#n)` refs to their files via ticket edges.
- AC-8.6 — file-path params are canonicalized; traversal outside the repo root is refused.
- AC-8.7 — incremental reindex touches only the named files' rows; install-hook writes the post-commit hook once (idempotent re-run).
- AC-8.8 — doctor warns actionably when `features.graph` is on but the repo is non-TS or ts-morph is unresolvable.

## Out of scope

- Embeddings / semantic similarity — schema slot only (spec backlog).
- Icon and design-token extraction beyond the schema kinds — token nodes populate when a token source exists (`design.tokens` config); repos without one skip silently. Full token pipeline arrives with design-lane iterate/system modes.
- `forge:execute`/`forge:ship` auto-reindex wiring — one-line skill edits after this epic proves the CLI (avoids two skills depending on an unmerged branch).
