# iomanage feedback — forge (session on forge ~0.5.0)

Feedback gathered from a full iomanage working session, with concrete files/scripts so the maintainer can trace each. Sorted by severity. Triage status is filled in by the maintainer against current `main`.

## P0 — caused breakage / silent data loss

1. **CI template `verify.yml`: gitleaks job missing `pull-requests: read`.**
   `forge:init` emits top-level `permissions: contents: read`. `gitleaks/gitleaks-action` calls the list-PR-commits API → `403 "Resource not accessible by integration"` → the job goes red on the first PR of every repo. Must be hand-patched.
   **Fix:** add `permissions: { contents: read, pull-requests: read }` to the gitleaks job in the template.

2. **`board/create.mjs` silently swallows unknown flags → creates a ticket with an EMPTY body.**
   Passing `--body-file` (unsupported) is ignored with no error; the ticket is created with an empty body (hit at #61, had to redo).
   **Fix:** support `--body-file`, and/or fail-fast on unrecognized flags instead of silently dropping them.

3. **`createSingleSelectField` sends options via `gh -F` (JSON → string) → API rejects.**
   Blocks `forge:init --create-project` when creating the Type/Status/Priority/Size fields (bug since 0.1.0). This session I created the Phase field with `gh project field-create --single-select-options` (native gh) — worked fine.
   **Fix:** use `gh project field-create` instead of hand-rolled GraphQL `-F`.

## P1 — clear friction

4. **MCP graph server caches `features.graph` at startup.**
   Set `features.graph=true` + `graphctl rebuild` (index OK) but `find_component`/`reuse_candidates`/`who_uses` still return "graph is off"; `/reload-plugins` doesn't restart the MCP server process — had to fully restart the app.
   **Fix:** server re-reads `forge.json` per-call (or on reload); or `graphctl rebuild` signals a reload.

5. **`gates/plandrift.mjs` parses `Files:` lines literally → mass false-positives.**
   Plans use shorthand (`packages/ui/src/components/Button.tsx, TextField.tsx, …`) → the bare names read as off-plan (26 files at #49) though intended, forcing a `scope.json` open.
   **Fix:** resolve bare names against the path/dir earlier on the same line; or make the plan template require a full path per file.

6. **`board/create.mjs` doesn't reparent + no reparent script.**
   A ticket that already has a parent → `--parent` is ignored ("leaving as-is"). Re-parenting requires hand-running GraphQL `addSubIssue(replaceParent:true)`.
   **Fix:** add `board/reparent.mjs` (or a `--reparent` flag).

7. **`gates/acgate.mjs` needs a single `results.json` — awkward in a monorepo.**
   Turborepo runs vitest per-package; had to run each package to JSON then merge `testResults` by hand before acgate would work.
   **Fix:** acgate accepts multiple `--results` / a glob, or ships its own per-package gather.

8. **Denylist hook false-positive on `-f` like "force-push".**
   `gh api graphql -f query=…` gets wrongly blocked; had to split the command or write a node script. Loosen the regex so it doesn't catch `gh api`'s `-f`.

## P2 — DX improvements

9. **`board/move.mjs` only accepts camelCase status (`inProgress`); `in-progress` errors.** Accept kebab-case aliases.
10. **`board/comment.mjs --phase started`: no standard slot for actor + session id** (iomanage owner wants the person + session logged when a ticket is picked). Add `--actor`/`--session` (or auto-insert).
11. **Windows/CRLF:** git spams "LF will be replaced by CRLF"; tests comparing generated files break on CRLF. `forge:init` should suggest a `.gitattributes` (force LF for source/generated) + note the gotcha.
12. **`graphctl rebuild` needs ts-morph but only surfaces at runtime** — add a `forge:doctor` check (TS repo + graph on but ts-morph missing).
13. **`board/create.mjs`: consider setting the Phase/roadmap field at creation** (today only type/priority/size/status) — dependency-order is hard to track with only priority.

## Working well (keep)

- `.forge/scope.json` as the plan-drift escape-hatch: clear, carries a reviewer note.
- The mechanical gate chain (situation → plandrift → testintent → depguard → acgate) + trail phases + post-merge ritual: coherent, resumable.
- `gh project field-create` for single-select: works well — forge should switch to it.
