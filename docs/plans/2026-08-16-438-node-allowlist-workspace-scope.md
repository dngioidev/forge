# Plan: #438 - narrow the `node <path>` allowlist guard to the workspace

**Ticket:** #438 (board #8, child of epic #182) - **Kind:** chore
**Base:** main - **Branch:** fix/438-node-allowlist-workspace-scope - **Verify:** `pnpm verify`

**Decision (esc-438-msrn1h5s, resolved by owner):** narrow the `node` allowlist
entry's argument guard to anything inside the workspace (repo root) - looser
than forge's-own-tree, closes arbitrary path traversal and absolute-path
escapes without needing to enumerate forge's own script layout. This plan
implements exactly that scope; AC.1 is already decided, not re-litigated here.

`plugin/scripts/lib/allowed-commands.mjs`'s `node` `argsOk` (added by #429)
only checks that the first argument is a plain, non-flag operand
(`PLAIN_OPERAND`). It validates that a script path was given, not which one:
`node ../../../../tmp/evil.mjs` satisfies `PLAIN_OPERAND` (dots and slashes
are both in its character class) and reaches a bare `allow`. This plan adds a
workspace-containment check: resolve the script argument against the
workspace root and require the result to stay inside it.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC.1** - Scope decided (workspace root). No code change needed for this
  AC beyond implementing it.
- **AC.2** - The guard rejects paths escaping the workspace (`..` segments
  that resolve outside it, absolute paths outside it) while still
  auto-approving every invocation forge itself makes from the workspace root
  (`node plugin/scripts/**`, `node bin/forge.mjs`, `node scripts/**`) and any
  other in-workspace path, since the chosen scope is "anywhere inside the
  workspace," not "forge's own tree" - no need to enumerate forge's script
  layout or verify against an emitted agy package's post-install layout (that
  requirement applied only to the forge's-own-tree option, which was not
  chosen).
- **AC.3** - No regression in the #429 guard: inline execution
  (`-e`/`--eval`/`-p`/`-`) and the bare REPL keep asking.
- **AC.4** - `docs/guides/cross-gai.md`'s guarded-verbs table updated to
  state the workspace-root scope.

**Workspace root, resolved consistently with the file's existing precedent:**
`agy-capture.mjs:19` already resolves the workspace root as
`payload?.workspacePaths?.[0] || process.cwd()` for journal writes. The
`node` guard's `isAllowedCommand()` gets an optional `cwd` passed through from
`agy-deny.mjs` using that same precedent, defaulting to `process.cwd()` when
absent (preserves the existing standalone-call contract pinned by
AC-429.3's "isAllowedCommand called standalone" test).

## Task 1 (test): failing tests first

Add to `tests/lib/allowed-commands.test.mjs`:
- New describe block, AC-438.2: `node` allows any path resolving inside the
  workspace (`node plugin/scripts/board/move.mjs ...`, `node ./scripts/x.mjs`,
  `node bin/forge.mjs board status`, a deeply nested in-workspace relative
  path) - all `true`.
- Traversal/absolute-escape refusals: `node ../../../../tmp/evil.mjs`,
  `node ../outside.mjs`, `node ../../etc/passwd`, `node /etc/passwd`,
  `node C:/Windows/System32/evil.js` (still blocked by `PLAIN_OPERAND`'s
  existing character class, pinned so a future change to that regex can't
  silently reopen it), and the workspace root itself as a bare operand
  (`node .`) - all `false`.
- A `cwd`-aware case: passing an explicit `cwd` option to `isAllowedCommand`
  and confirming a path that escapes THAT root is refused even though it
  would resolve inside `process.cwd()`, proving the check uses the supplied
  workspace root rather than always defaulting silently.
- Confirm AC.3 is untouched: re-run the existing inline-exec/bare-REPL
  refusal cases from the pre-existing `AC-429.3` test and assert they are
  still `false` (regression pin, not a new mechanism).

Add to `tests/hooks/agy-deny.test.mjs`:
- New case: a payload with `workspacePaths: ['/workspace']` and
  `CommandLine: 'node ../../etc/passwd'` yields `{"decision":"ask"}` (proves
  the hook actually threads `workspacePaths` through to the guard, not just
  the library function in isolation).
- A payload with `workspacePaths: ['/workspace']` and
  `CommandLine: 'node plugin/scripts/x.mjs'` yields `{"decision":"allow"}`.

Run `npx vitest run tests/lib/allowed-commands.test.mjs tests/hooks/agy-deny.test.mjs`
and confirm the new assertions fail against pre-change source (the traversal
cases currently return `true`, not `false`).

**Files:** tests/lib/allowed-commands.test.mjs, tests/hooks/agy-deny.test.mjs
**AC map:** AC.2, AC.3
**Test plan:** see above.

## Task 2 (code): workspace-containment guard

`plugin/scripts/lib/allowed-commands.mjs`:
- Add an `isWithinWorkspace(scriptArg, cwd)` helper (lexical `path.resolve` +
  `path.relative`; rejects `''`, anything starting `..`, and anything that
  resolves absolute relative to `cwd` - i.e. escapes it).
- Change the `node` `ARGUMENT_SENSITIVE_PREFIXES` entry's `argsOk` to accept
  `(args, ctx)` and additionally require `isWithinWorkspace(args[0], ctx.cwd)`.
- Thread an optional `ctx` (`{ cwd }`, defaulting `cwd` to `process.cwd()`)
  through `argsAreSafe()` and `isAllowedCommand(command, { segments, cwd })`.
  Other `argsOk` implementations (`flagsAndOperands()`-built) ignore the
  extra parameter, so this is additive, not a signature break for them.
- Update the file's doc comments: the "Honest scope limit" paragraph on the
  `node` entry no longer applies as written (the gap it named is what this
  ticket closes) - replace it with a short note stating the workspace-root
  scope and pointing at #438 as the ticket that set it, not one still open.

`plugin/hooks/agy-deny.mjs`:
- Resolve `cwd` the same way `agy-capture.mjs` already does:
  `payload?.workspacePaths?.[0] || process.cwd()`.
- Pass `{ segments: splitSegments, cwd }` to `isAllowedCommand()`.

**Files:** plugin/scripts/lib/allowed-commands.mjs, plugin/hooks/agy-deny.mjs
**AC map:** AC.1, AC.2, AC.3
**Done:** Task 1's `allowed-commands.test.mjs` and `agy-deny.test.mjs`
assertions pass; no existing test in either file regresses.

## Task 3 (docs): cross-gai.md guarded-verbs table

- `docs/guides/cross-gai.md`: update the `node` row of the guarded-verbs
  table (and any prose describing its scope limit) to state the workspace-
  root containment, replacing language that describes the gap as open.

**Files:** docs/guides/cross-gai.md
**AC map:** AC.4
**Done:** docsync gate clean; no other doc references the old "any on-disk
script" scope as current.
