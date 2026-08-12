# Plan: #428 - spike: agy's real command-approval semantics

**Ticket:** #428 (board #8, parent #182) - **Kind:** spike - **Base:** main - **Branch:** spike/428-agy-approval-semantics

`plugin/hooks/agy-deny.mjs:29` returns `{"decision":"allow"}` as the default for
every non-denylisted `run_command`; ADR-0007 records that agy accepts
`allow`/`deny`/`ask`/`force_ask` (`:37`, `:54`) but never states what each does
to agy's own approval prompt. Two readings fork every downstream ticket:
`allow` = auto-approve (a live security finding) vs. `allow` = "no objection,
agy still asks" (the allowlist gap is real, #429's original framing). This
spike determines which, against a live `agy` (v1.1.7 installed), and does not
implement a fix — #429 is parked on the answer.

## AC map

- **AC-428.1** the spike doc states, from observed behaviour against the live
  agy version tested, what each of `allow`/`deny`/`ask`/`force_ask` does to
  agy's approval prompt.
- **AC-428.2** the doc answers definitively whether agy has a native
  pre-authorization config file (the analogue of Claude's
  `.claude/settings.local.json`), and if so its path + schema.
- **AC-428.3** a recommendation is made and justified (hook-mediated allowlist
  vs. emit a native settings file), with the current default's security
  posture assessed either way.
- **AC-428.4** if the spike finds forge is currently blanket-auto-approving on
  agy, a bug is filed immediately (separate from #429) and linked here.
- **AC-428.5** if reality differs from what ADR-0007 records at `:37`/`:54`,
  the ADR is updated.
- **AC-428.6** the spike doc is linked from the docs route index (docsync
  gate).

## Task 1 (docs): empirical research + findings doc (AC-428.1, AC-428.2, AC-428.3)

Run `agy --help` + subcommand help, inspect agy's shipped hook-contract docs
and config locations, and build a scratch agy plugin (outside the forge repo,
under the session scratchpad — never committed here) to empirically test each
`PreToolUse` decision, the hook timeout's fail-open/closed behaviour, and
whether hooks cover non-`run_command` tools. Write up the findings and a
justified recommendation.

**Files:** docs/spikes/2026-08-12-agy-approval-semantics.md

## Task 2 (docs): file the bug if reading 1 confirmed (AC-428.4)

If the spike confirms `allow` auto-approves (reading 1), file a p0 bug via
`board/create.mjs --type bug --priority p0 --parent 182`, separate from #429,
and reference it from the spike doc + a trail comment on #428.

**Files:** docs/spikes/2026-08-12-agy-approval-semantics.md (reference only;
the bug itself is a board item, not a repo file)

## Task 3 (docs): ADR-0007 addendum (AC-428.5)

Append a dated addendum to ADR-0007 recording the confirmed approval-semantics
finding and linking the spike doc, without altering the ADR's already-Accepted
decisions.

**Files:** docs/decisions/0007-cross-gai-mcp-first.md

## Task 4 (test): grounding tests for the spike doc content (AC-428.1 through AC-428.6)

New vitest file that reads the spike doc, the ADR, and the route index and
asserts the required content is present — machine evidence for the ac-gate on
a docs-only change (mirrors the #423 doc-content-assertion pattern).

**Files:** tests/docs/agy-approval-semantics.test.mjs

## Task 5 (docs): route index (AC-428.6)

Add the spike doc to the docs route index.

**Files:** docs/README.md
