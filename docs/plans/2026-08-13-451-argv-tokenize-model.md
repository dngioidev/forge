# Plan: #451 - spike: tokenize-then-judge argv model for the denylist hook

**Ticket:** #451 (board #8, parent #182) - **Kind:** spike - **Base:** main - **Branch:** spike/451-argv-model

`plugin/hooks/denylist.mjs`'s rules match regex-over-text, not argv structure. #451's
own diagnosis — carried from the `#446` escalation, after four PRs, four
adversarial rounds and two escalations on #446 alone — is that every patch
round closes one spelling of "a text question standing in for an argv
question" and reveals another; six sibling tickets (#451, #452, #454, #456,
#448, #449) are the evidence. This spike designs the alternative (tokenize the
command into argv the way a real shell would, then judge structurally) and
tests it against all six tickets. It does not implement a fix —
`plugin/hooks/denylist.mjs` is untouched by this branch.

## AC map

- **AC-451.1** the spike states the tokenizer design and the explicit boundary
  of what it refuses to model (brace/glob expansion, real filesystem
  resolution, variable-value substitution, recursive substitution re-parsing).
- **AC-451.2** the spike decides the path-resolution scope for `..` (refuse /
  lexical-normalise / real-filesystem-resolve), grounded in evidence, stating
  each option's false-positive/false-negative cost honestly.
- **AC-451.3** a subsumption matrix covers #451, #452, #454, #456, #448, #449
  with a closed/partial/open verdict and a concrete example each.
- **AC-451.4** the #452 mutual-exclusivity finding is re-examined under the
  tokenizer model with evidence for whether it dissolves.
- **AC-451.5** a migration plan states the regression corpus (the existing
  `AC-429.*`/`AC-437.*`/`AC-446.*`/`AC-450.*` blocks) and phases the work —
  no big-bang swap.
- **AC-451.6** a recommendation is made, weighing the guard's fail-open/
  tripwire status and the fact no host currently auto-approves these commands,
  including the option of not doing the rewrite at all.
- **AC-451.7** if the recommendation is to proceed, the scoped consolidation
  ticket is filed under #182 and named in the spike doc.

## Task 1 (docs): tokenizer design + path-resolution scope + subsumption matrix + recommendation (AC-451.1–AC-451.6)

Bash-verify every argv/tokenization claim from a script file under a scratch
dir outside the repo (never inlined), against real bash — env-assignment
prefixes, POSIX `--`, NUL delivery (space vs. delete), and command-substitution
token boundaries. Write up the design, the path-resolution decision, the
per-ticket subsumption matrix, the #452 re-examination, the migration plan,
and a genuinely-weighed recommendation (including "don't do it" as a live
option).

**Files:** docs/spikes/2026-08-13-argv-tokenize-model.md

## Task 2 (docs): file the Phase-1-only consolidation ticket if recommending proceed (AC-451.7)

If the recommendation is to proceed, file it scoped to the smallest
independently-reviewable slice (the tokenizer module alone, zero behaviour
change), child of #182, explicitly not closing any of the six sibling tickets
yet, and reference the filed number from the spike doc.

**Files:** docs/spikes/2026-08-13-argv-tokenize-model.md (reference only; the
ticket itself is a board item, not a repo file)

## Task 3 (test): grounding tests for the spike doc content (AC-451.1 through AC-451.7)

New vitest file that reads the spike doc and the route index and asserts the
required content is present — machine evidence for the ac-gate on a docs-only
change (mirrors the #428 doc-content-assertion pattern). Also pins that
`plugin/hooks/denylist.mjs` carries no tokenizer/token-kind vocabulary, so a
future branch cannot quietly slip implementation into this spike's scope.

**Files:** tests/docs/argv-tokenize-model.test.mjs

## Task 4 (docs): route index

Add the spike doc (and this plan) to the docs route index.

**Files:** docs/README.md
