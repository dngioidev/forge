# Plan: #459 - a command substitution fused mid-word (or adjacent) defeats shortFlagCluster

**Ticket:** #459 (board #8, child of epic #182) - **Kind:** bug - **Size:** S
**Base:** main - **Branch:** fix/459-shortflagcluster-substitution-fusion - **Verify:** `pnpm verify`
**Absorbs:** #495 (closed as duplicate — same flaw, opposite edge)

## The gap

`shortFlagCluster()` (`plugin/hooks/denylist.mjs`) collects short-flag
letters with `(?:^|\s)-([a-zA-Z]+)` — a contiguous letter run after a dash.
Two edges of the same flaw, both live bypasses (verified via `check()`):

1. **#459 (mid-word):** a substitution fused INSIDE an already-started flag
   run breaks the contiguous letter match at the `$`/backtick —
   `rm -r$(true)f /prod-secrets` collects only `r`, losing `f`.
2. **#495 (adjacent):** a flag glued onto the END of a substitution with no
   preceding whitespace — `rm $(true)-rf /prod-secrets` — never satisfies
   the `(?:^|\s)-` start anchor at all, since the substitution's own
   characters sit where whitespace would need to be.

Verified live on `main` (pre-fix) against all four `shortFlagCluster()`
consumers, both spellings (`$(...)`, backtick) and both edges:
`recursive-delete`, `force-push` (short `-f` AND long `--force`),
`env-branch-delete`, `git-clean-force` all bypassed by the mid-word edge;
`recursive-delete`, `force-push`, `env-branch-delete` bypassed by the
adjacent edge too (`git-clean-force`'s own unanchored inline regex happens
to survive the adjacent edge, but not the mid-word edge).

**force-push has zero remaining mitigation**: `git push` is on
`ALLOWED_COMMAND_PREFIXES` (pre-approved since #429), so a bypassed
force-push here runs unattended — no denylist block AND no human
confirmation prompt. The other three still fall back to a human prompt.
This is why the ticket is P1.

## Also found in scope: an existing, related false positive

While probing, confirmed `shortFlagCluster()`'s total lack of substitution-
boundary awareness ALSO produces a false positive today, same root cause,
opposite direction: `git push origin "$(gh api -f q=1)"` already blocks on
`main` (force-push) because the flat regex has no concept that the `-f`
sits INSIDE an unrelated inner command's own substitution. The bounded fix
below (deleting substitution spans wholesale before flag-matching, rather
than reading their interior) closes this as a natural side effect — it is
not a separate change.

## Design

New helper `descrambleFlags(command, guarded)`, built on the exact same
`guardedText`/depth-tracking technique as `beforeEndOfOptions()` (#454's
precedent — explicitly NOT `shell-tokenize.mjs`, per the triage trail and
esc-449-mst7pghx staying untouched): a single linear pass that deletes every
`$(...)`/backtick SPAN (including its own delimiters) from the text,
wherever it appears, leaving every other character — including the literal
letters either side of a span — untouched and in place.

This is sufcient for both edges at once: deleting a span can only ever
MERGE the literal characters immediately before and after it (never insert
new whitespace or new dashes), so:
- `-r$(true)f` -> `-rf` (mid-word edge closed)
- `$(true)-rf` -> `-rf` (adjacent edge closed, since the deleted span's
  removal exposes `-rf` sitting right where a real bash argv would also
  fuse it)
- an unrelated word like `$(gh api -f q=1)` (no leading `-` once its span is
  deleted — the whole word IS the span) -> `` (empty) contributes nothing,
  closing the false-positive found above
- ordinary two-argument use (`rm -rf "$(mktemp -d)"`) is untouched by this
  function specifically (target-parsing is a separate, pre-existing code
  path — see Non-goals)

**AC.5 (categorical block-on-ambiguity):** an unterminated substitution
(depth never returns to 0 by segment end) cannot be resolved — some suffix
is unscanned and may hide a flag letter. `descrambleFlags()` returns
`{ text, ambiguous }`; every affected rule treats `ambiguous` as an
automatic block, mirroring `recursive-delete`'s own existing `trustworthy`
gate for the same class of problem.

## Tasks

### T1 — descrambleFlags() + wire into all four rules (bug)

**Files:** `plugin/hooks/denylist.mjs`, `tests/hooks/denylist.test.mjs`

Add `descrambleFlags()`; wire it into `force-push`, `env-branch-delete`,
`git-clean-force` (via a per-segment 4th `test()` argument from `check()`,
same pattern as `spacedText`/`guardedText`) and into `recursive-delete`
(applied to its own post-`beforeEndOfOptions()` `flagsSegment`, since that
rule already does its own segment-narrowing). New `describe` block,
AC-459.* tests, in `tests/hooks/denylist.test.mjs`.

**AC-IDs:** AC.1, AC.2, AC.3, AC.4, AC.5

**Test plan:** see below.

## Non-goals / explicitly out of scope

- `safeRmTarget()`'s target-parsing (a DIFFERENT, pre-existing code path)
  is not touched. It already treats an unresolvable substitution-as-target
  as unsafe (blocks) — consistent with this ticket's own block-on-ambiguity
  philosophy, but it is not this ticket's Sources and not touched here.
- No tokenizer integration (`shell-tokenize.mjs`) — the triage trail is
  explicit this is a bounded, hand-rolled fix, not Phase 2.
- No change to branch-name fusion, verb-spelling fusion, or `+refspec`
  fusion — out of the ticket's named scope (shortFlagCluster + the
  affected rules' own flag-matching regexes only).

## AC map

- AC.1 (absorbs #495): mid-word and adjacent fusion, all four rules, both
  substitution spellings, force-push spellings pinned explicitly.
- AC.2: #437/#446/#450/#452/#454 corpora re-run, no regression.
- AC.3: no new false positive on ordinary/unrelated substitution use;
  additionally closes the pre-existing `-f`-inside-an-unrelated-
  substitution false positive found during triage.
- AC.4: tests confirmed to fail pre-fix (stash/restore discipline); any
  latency assertion is a wall-clock ceiling, never a ratio (#486).
- AC.5: categorical block-on-ambiguity for an unterminated substitution
  inside a flag-candidate word.

## Test plan

New `describe('shortFlagCluster substitution fusion (#459/#495, AC-459.*)')`
block in `tests/hooks/denylist.test.mjs`:
- AC-459.1: mid-word `$(...)`/backtick fusion blocks recursive-delete,
  force-push (both spellings), env-branch-delete, git-clean-force.
- AC-459.2: adjacent (#495) fusion blocks the same four.
- AC-459.3: #437/#446/#450/#452/#454 pinned cases re-run unchanged.
- AC-459.4: no new false positive — ordinary substitution in an unrelated
  argument position, AND the inner-flag-leakage case found during triage.
- AC-459.5: an unterminated substitution inside a flag-candidate word
  blocks categorically, across the affected rules.

All new tests confirmed to fail against pre-fix `denylist.mjs` (stash the
source change, re-run, restore) before the fix lands.
