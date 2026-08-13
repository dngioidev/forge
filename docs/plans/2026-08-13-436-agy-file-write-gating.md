# Plan: #436 - spike: widen the PreToolUse hook matcher beyond run_command

**Ticket:** #436 (board #8, parent #182) - **Kind:** spike - **Base:** main - **Branch:** spike/436-agy-file-write-gating

`plugin/scripts/agy/emit.mjs`'s `buildHooksConfig()` scopes `hooks.json` to
`matcher: 'run_command'` — the 2026-08-12 spike proved this is forge's own
choice (agy's matcher supports `"*"`), so file writes/edits are completely
unhooked on agy today. Widening isn't mechanical: it compounds the same
spike's fail-open-hook-timeout finding, and it isn't clear whether agy has its
own native gate on file writes the way it does on `run_command`. This spike
gathers that evidence and proposes (without choosing) candidate rule shapes.
It does not implement a fix and does not touch `plugin/hooks/*.mjs` or
`plugin/scripts/agy/emit.mjs` — both are untouched by this branch.

## AC map

- **AC-436.1** the hook-timeout blast radius is empirically re-verified when
  the matcher fires on every tool call, across a representative multi-call
  session (not one worst-case probe), reusing the 2026-08-12 spike's
  scratch-plugin method.
- **AC-436.2** whether agy has its own native approval gate for
  `write_to_file`, independent of forge's hook, is empirically determined and
  reported either way.
- **AC-436.3** candidate rule shapes for a non-command (path+content) payload
  are proposed, grounded in `denylist.mjs`'s own stated scope discipline, with
  tradeoffs stated and no winner picked.
- **AC-436.4** a conclusion (not a commitment) is stated on whether the
  evidence supports widening the matcher at all, and the smallest safe next
  step is filed as a scoped follow-up ticket under #182.
- **AC-436.5** `docs/guides/cross-gai.md`'s permissions section (#429) is
  updated with what AC.1/AC.2 found, so it does not go stale.

## Task 1 (docs): representative-session timeout re-verification + native-gate determination (AC-436.1, AC-436.2)

Build a scratch plugin outside the repo (matcher `"*"`, decision + sleep-ms
read from control files, every invocation logged), drive it headlessly via
`agy --print ... --add-dir <scratch> --mode accept-edits` across multiple
tool-call shapes (`write_to_file`, `run_command`, `list_dir`, `view_file`),
below and at/above the configured 10s timeout, and cross-check
`cli.log`'s host-level hook-failure events against the hook's own log to
distinguish "hook answered slowly" from "hook was killed and agy defaulted."
Separately test `write_to_file` and `run_command` both with and without any
`hooks.json` present at all, to isolate whether either has an independent
native gate.

**Files:** docs/spikes/2026-08-13-agy-file-write-gating.md

## Task 2 (docs): candidate rule shapes + conclusion + follow-up tickets (AC-436.3, AC-436.4, AC-436.5)

Propose candidate rule shapes for `write_to_file`'s `TargetFile`/`CodeContent`/
`Overwrite` payload, grounded in `denylist.mjs:1-16`'s stated scope
("a TARGETED backstop... NOT a general destructive-command sandbox"), stating
tradeoffs without picking a winner. State the AC.4 conclusion and file the
scoped decide-then-design follow-up under #182. Update
`docs/guides/cross-gai.md`'s permissions section in place with the findings.
File any other significant finding surfaced along the way as its own ticket
rather than silently dropping or folding it into an unrelated AC's scope.

**Files:** docs/spikes/2026-08-13-agy-file-write-gating.md, docs/guides/cross-gai.md

## Task 3 (test): grounding tests for the spike doc content (AC-436.1 through AC-436.5)

New vitest file that reads the spike doc, the cross-gai.md update, and the
route index, and asserts the required content is present — machine evidence
for the ac-gate on a docs-only change (mirrors the #428/#451 doc-content
pattern). Also pins that `plugin/scripts/agy/emit.mjs` still matches only
`run_command` and that `plugin/hooks/denylist.mjs` carries no
`write_to_file`-payload vocabulary, so a future branch cannot quietly slip
implementation into this spike's scope.

**Files:** tests/docs/agy-file-write-gating.test.mjs

## Task 4 (docs): route index

Add the spike doc and this plan to the docs route index.

**Files:** docs/README.md
