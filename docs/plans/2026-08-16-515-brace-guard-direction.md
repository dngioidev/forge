# Plan: #515 - spike: which brace-expansion guard direction closes #448's bypass class soundly

**Ticket:** #515 (board #8, parent #182, spike for #448) - **Kind:** spike - **Base:** main - **Exploration branch:** spike/515-brace-guard-direction (throwaway, never merges) - **Delivery branch (this doc's own PR):** docs/515-brace-guard-direction-findings

`esc-448-msrs9z1u` named three candidate directions for closing the live, real-bash-verified brace-expansion bypass in `plugin/hooks/denylist.mjs`'s `tokenHasBraceGroup()` without reintroducing the round-1 false positive (`git push origin {main,develop}`). The owner answered "spike needed" rather than picking one directly. This spike prototypes and bash-verifies all three; it does not implement a fix — `plugin/hooks/denylist.mjs` is untouched by this branch.

## AC map

- **AC-515.1** each of the three named directions is prototyped and evaluated against one fixed corpus of real-bash-verified cases (known bypasses, the known false positive, and the AC-448.1 baseline reproductions), with raw bash output quoted as evidence.
- **AC-515.2** the findings doc states, for each direction, whether it closes the known bypass class, whether it introduces the `{main,develop}`-style false positive, and what it costs.
- **AC-515.3** a recommendation is given, honestly stating what the evidence does and does not settle.

**Post-merge step (not test-mapped — sequenced after this PR, tracked on the board/issue, not a claim this doc's content can assert about itself):** #448 is re-escalated citing the merged findings doc.

## Task 1 (docs): prototype all three directions + bash-verify + write the findings doc (AC-515.1, AC-515.2, AC-515.3)

Build throwaway Node prototypes for direction 1 (no pairing), direction 2 (nesting-depth-aware group detection), and direction 2-full (nesting-depth-aware pairing + alternative-content classification), plus direct empirical tests of direction 3 (narrow to the flag-relevant argument region) against live `git`/GNU `rm` argument-permutation behavior. Score all three against one corpus. Write up the design, evidence, and a weighed recommendation.

**Files:** docs/spikes/2026-08-16-brace-guard-direction.md

## Task 2 (test): grounding tests for the spike doc content (AC-515.1 through AC-515.3)

New vitest file that reads the spike doc and the route index and asserts the required content is present — machine evidence for the ac-gate on a docs-only change (mirrors the #451 doc-content-assertion pattern, `tests/docs/argv-tokenize-model.test.mjs`). Also pins that `plugin/hooks/denylist.mjs` carries no direction-specific rewrite, so a future branch cannot quietly slip an implementation into this spike's scope.

**Files:** tests/docs/brace-guard-direction.test.mjs

## Task 3 (docs): route index

Add the spike doc and this plan to the docs route index.

**Files:** docs/README.md
