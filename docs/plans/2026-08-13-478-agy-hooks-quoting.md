# Plan: #478 - agy hooks.json command quoting breaks Node module resolution on Windows

**Ticket:** #478 (board #8, child of epic #182) - **Kind:** bug
**Base:** main - **Branch:** fix/478-agy-hooks-quoting - **Verify:** `pnpm verify`

`plugin/scripts/agy/emit.mjs`'s `buildHooksConfig()` emits hook commands as a
plugin-root-relative literal wrapped in double quotes:
`node "hooks/agy-deny.mjs"`. On Windows with agy 1.1.12 the literal `"`
characters leak into the module path Node tries to resolve instead of being
stripped as shell quoting, e.g.
`Cannot find module 'C:\...\"hooks\agy-deny.mjs"'`. Because both
`forge-safety` and `forge-capture` carry `timeout: 10` and agy fails OPEN on a
hook error/timeout (per `docs/spikes/2026-08-12-agy-approval-semantics.md`),
a hook that fails to *load* leaves every `run_command` in an agy-hosted
session unchecked, silently.

## AC.1 - fresh-install repro (evidence, not simulated)

The machine's existing global install (`~/.gemini/config/plugins/forge/`,
imported 2026-07-27) was a stale dogfood copy carrying the pre-#307
*absolute*-path quoted form (`node "C:/mywp/agy-dogfood/hooks/agy-deny.mjs"`)
-- not what ships on `main` today, so it could not stand in for AC.1.

Did a real, fresh `agy plugin install` of the current package:
1. `node plugin/scripts/agy/emit.mjs --out <scratchpad>/fresh-emit` from a
   clean `main` checkout.
2. `agy plugin install "<scratchpad>/fresh-emit"` -- `agy` (1.1.12, real
   binary on PATH) reported `[ok] forge` with `hooks: 2 processed`, and
   **overwrote** the stale dogfood install at
   `~/.gemini/config/plugins/forge/` (same install target agy always uses;
   there is no side-by-side install mode) with the current relative-quoted
   form: `"command": "node \"hooks/agy-deny.mjs\""` -- confirming the bug's
   premise against a genuinely fresh install, not the superseded absolute
   variant.
3. Invoked the real installed `hooks/agy-deny.mjs` the way agy's own
   documented contract (`hooks.md`: `cmd /c` on Windows, cwd = the directory
   containing `hooks.json`) plus the AC.2 mechanism below actually spawns it:
   `execFileSync('cmd.exe', ['/c', cmd], { cwd: installRoot })`. Result,
   byte-for-byte the bug report's symptom:
   ```
   Error: Cannot find module 'C:\Users\dngioi\.gemini\config\plugins\forge\"hooks\agy-deny.mjs"'
   code: 'MODULE_NOT_FOUND'
   ```

## AC.2 - best-effort root cause (which layer mangles the quotes)

agy 1.1.12 is a closed binary; its internal spawn call cannot be inspected
directly, so this is bounded to what is externally observable by
constructing and testing each candidate layer:

- **`cmd /c` itself, given the raw string as-is, is NOT the culprit.**
  `cmd /c 'node "hooks/agy-deny.mjs"'` (a single pre-built command-line
  string, cmd's own outer-quote-stripping heuristic applied once) resolves
  and runs correctly.
- **Node's own `child_process.exec()` (naive JS callers) is NOT the
  culprit either** -- it treats the string as raw and does not reproduce the
  bug.
- **The reproducing shape is: the command string handed to `cmd /c` as a
  single argv element via an argv-array-style spawn** (e.g.
  `execFileSync('cmd.exe', ['/c', command])`, Node's own `execFile`/argv path,
  or the Go/Rust/.NET equivalent). Windows has no OS-level argv -- any
  argv-array spawn API must serialize the array into one command-line string
  using the standard MS C-runtime quoting rules (wrap in quotes if the
  argument has a space; backslash-escape any literal `"` inside it). Because
  our command string (`node "hooks/agy-deny.mjs"`) already contains embedded
  `"` characters, that serialization backslash-escapes them, producing
  `cmd /c "node \"hooks/agy-deny.mjs\""` on the wire. `cmd.exe`'s
  outer-quote-stripping heuristic does not understand backslash-escaped
  quotes (cmd does not implement `\"` escaping), so it strips only the true
  outer pair and hands `node \"hooks/agy-deny.mjs\"` on to be
  tokenized/spawned. `node.exe`'s own (MS-convention-correct) argv
  unescaping *does* understand `\"`, and turns it into a literal `"`
  character embedded inside its module-path argument -- exactly the observed
  corruption.
  - Reproduced directly: `execFileSync('cmd.exe', ['/c', 'node "hooks/agy-deny.mjs"'])`
    (no manual re-wrapping at all -- just letting Node's own argv-to-command-line
    serializer do its normal job) throws the identical `MODULE_NOT_FOUND` shape.
  - This is consistent with agy's documented Windows invocation (`cmd /c`,
    per `hooks.md`) being reached through an argv-style process-spawn API
    internally, which is the common/default cross-platform-safe way most
    languages spawn subprocesses -- not a defect unique to one obscure code
    path.
- Conclusion (best-effort, timeboxed per triage's instruction not to spelunk
  into agy's closed internals further): the mangling happens in the
  serialization step between "an argv array containing a command string with
  embedded quotes" and the literal command line `cmd.exe` receives -- i.e.
  agy's own command-invocation layer, not `cmd /c`'s parsing in isolation.
  This does not gate AC.3: regardless of exactly which internal agy call
  performs that serialization, removing the embedded `"` characters from the
  emitted command string removes the only input that triggers it.

## AC.3 / AC.4 - the fix

Drop the quoting. `buildHooksConfig()` now emits `node hooks/agy-deny.mjs`
(no quotes) instead of `node "hooks/agy-deny.mjs"`.

This satisfies AC.4's by-construction platform-neutrality requirement
directly: a command string containing **zero** quote characters relies on
no quote-stripping behavior at all, on either platform -- there is nothing
for `sh -c` or `cmd /c` to strip, so the fix cannot depend on the two
differing. (Checked first, per the ticket's instruction not to assume:
`hooks.md` §"Hook Handler Fields" documents `command` as a single required
shell **string** only -- `sh -c` on Unix, `cmd /c` on Windows -- with no
argv-array alternative in agy's schema, so an argv-array form is not
available here.)

AC.3 explicitly forbids a fix that merely *relies on* hook paths never
containing spaces "because our filenames are short today." Unquoted paths
are only safe for as long as that holds, so the fix pairs the unquoting with
a new guard, `assertUnquotedSafe()`, that `buildHooksConfig()` runs against
every path it embeds: it throws if the path contains whitespace or a shell
metacharacter. This converts "no spaces" from an implicit, unenforced
convention into a checked invariant -- if a future hook filename ever
violated it, `buildHooksConfig()` (and therefore `pnpm verify`, since the
regression tests below call it directly) fails loudly at build/test time
instead of silently reproducing #478's Windows-only failure. That is the
"safe by construction, not by luck" argument AC.3 asks for.

`hooks/agy-deny.mjs` and `hooks/agy-capture.mjs` are forge's own fixed,
ASCII, kebab-case filenames -- not user input, not installer-chosen, not
derived from any external path -- so today they trivially pass the guard;
the guard's job is to keep that true going forward, not to justify the fix
today.

## Task 1 (test): regression tests first, pinning the broken shape as wrong

Add to `tests/agy/emit.test.mjs`:
- Update the existing exact-string pinned assertions (previously asserting
  `'node "hooks/agy-deny.mjs"'` / `'node "hooks/agy-capture.mjs"'`) to the
  new unquoted form. Called out explicitly in the PR body -- this is the bug
  being fixed, not a weakened test.
- A new assertion that the emitted command contains **no** `"` character at
  all (directly guards against ever regressing back to the quoted form that
  caused #478).
- A Windows-only regression test (skipped elsewhere, `process.platform`
  guarded) that spawns the REAL emitted `hooks/agy-deny.mjs` the same way
  AC.2 found reproduces the bug -- `execFileSync('cmd.exe', ['/c', command])`,
  cwd = the emitted package root, valid agy stdin payload -- and asserts a
  valid `{decision: ...}` comes back rather than a `MODULE_NOT_FOUND` crash.
  Run against the pre-fix code this fails with the exact #478 symptom;
  against the fix it passes.
- A unit test for `assertUnquotedSafe()` (exported for testability) proving
  it throws on a hypothetical unsafe filename, so the "safe by construction"
  claim is itself verified, not just asserted in prose.

**Files:** tests/agy/emit.test.mjs
**AC map:** AC-478.1 (fresh-install evidence, recorded in this plan + PR
body, not itself a unit test), AC-478.2 (root-cause evidence, same),
AC-478.3, AC-478.4
**Test plan:** `npx vitest run tests/agy/emit.test.mjs`; the new/updated
assertions fail against pre-fix `emit.mjs` and pass after Task 2.

## Task 2 (code): drop quoting + add the by-construction guard

- `plugin/scripts/agy/emit.mjs`: add `assertUnquotedSafe(relPath)` (exported),
  rewrite `buildHooksConfig()` to build `node ${assertUnquotedSafe(...)}`
  (no quotes) for both the deny and capture commands, and rewrite the
  function's doc comment to describe the new no-quote form and reference
  #478 instead of presenting quoting as settled #307 policy.

**Files:** plugin/scripts/agy/emit.mjs
**AC map:** AC-478.3, AC-478.4
**Done:** Task 1's tests pass; `npx vitest run tests/agy/emit.test.mjs` green.

## Task 3 (docs): keep the live guide in sync + route index

`docs/guides/cross-gai.md`'s "The generated file" example currently shows
the old quoted command; update both `command` lines to the unquoted form so
the guide matches what actually ships. Add this plan to `docs/README.md`.

**Files:** docs/guides/cross-gai.md, docs/README.md
**AC map:** AC-478.3

## Out of scope / filed separately

- **#480** (already filed at triage, child of #182, blocked on environment
  access): the empirical macOS/Linux re-verification of AC.4. Deliberately
  not attempted here -- no Unix environment is available in this session,
  and the ticket explicitly forbids fabricating that result.
- Whether the root cause also affects the **Claude host's** own hook wiring:
  `plugin/hooks/hooks.json` (the Claude-format config, untouched by this
  fix) uses the identical quoted shape:
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/denylist.mjs"`. Checked what could
  honestly be checked in this session: Node's own idiomatic shell-invocation
  API, `child_process.exec()`, given that exact quoted command string on
  Windows, does **not** reproduce the bug (see AC.2 evidence -- "Case A").
  Claude Code is itself a Node.js/TypeScript application, so if its hook
  invocation uses that same idiomatic API (or an equivalent that builds the
  `cmd /c "<command>"` wrapper as a single string rather than serializing an
  argv array), it would not share this mechanism. This is reassuring but
  **not a confirmed clean bill of health** -- Claude Code's actual internal
  spawn implementation is closed-source and was not directly inspected, and
  no live Claude-hosted repro was attempted. Recorded here honestly rather
  than either filing an unfounded new ticket or silently asserting safety.
