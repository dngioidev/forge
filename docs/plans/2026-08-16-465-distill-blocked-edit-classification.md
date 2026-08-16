# Plan: #465 - distill: blocked-edit clusters by rule name only, so guard-testing reads as destructive intent

**Ticket:** #465 (board #8, child of epic #183) - **Kind:** bug
**Base:** main - **Branch:** fix/465-distill-blocked-edit-classification - **Verify:** `pnpm verify`

The 2026-08-13 `/distill` round the ticket reports produced 8 recurring
`blocked-edit` clusters from 126 events, all 8 role-card proposals rejected
because the premise was false (per the ticket body). A second dated archive,
`.forge/journal-archive/2026-08-14.jsonl` (65 events, 60 `blocked-edit`),
shows the journal was distilled and archived again the next day — this plan
does not assert that round's own proposal/rejection count, only that its raw
events are real, additional evidence for the classifier below.
`distill.mjs`'s `signature()` clusters `blocked-edit` events by
`event.rule` alone, so every blocked command that trips e.g. `hard-reset`
lands in one cluster regardless of *why* it was blocked, and the fixed
`PROPOSALS['blocked-edit']` text always reads "the agent keeps reaching for
a denylisted action; teach the escalation path instead" — even when the
cluster is close to 100% guard-testing.

Measured against this run's real evidence (`.forge/journal-archive/
2026-08-13.jsonl`, `.forge/journal-archive/2026-08-14.jsonl`, and the live
`.forge/journal.jsonl`, which keeps growing as the run continues — 119 + 60 +
~27 = ~206 `blocked-edit` events at analysis time), the SHIPPED classifier
resolves 191/206 (~92.7%) as carrying at least one guard-testing signal:
importing/invoking the denylist-guard machinery itself
(`check(`/`denylist.mjs`/`isAllowedCommand`/anything under `plugin/hooks/`),
a scratch/tmp/review-worktree path
(`scratchpad`/`/tmp`/`AppData\Local\Temp`/`forge-security-N`/
`forge-review-N`), writing *about* a blocked command via a `cat`-anchored
heredoc or `--body-file` — the literal-string caveat — or an
adversarial-probe shape (multi-group/nested brace expansion, a long
repeated-character/echo-padding tail, or ANSI-C/quoted flag-spelling
tricks).

Two drafts were walked back before shipping, both caught by adversarial
review of the diff, not by the original data pass — the accuracy-on-real-data
audit alone did not surface either:

- An earlier draft matched anything under `plugin/scripts/` (not just
  `plugin/hooks/`) and any bare `--body` flag (not just `--body-file`), which
  would have caught a few more real noise cases (board/comment.mjs calls whose
  `--body` text happens to quote a blocked string as data) but risks
  classifying a genuinely dangerous command as guard-testing whenever it
  happens to run near an unrelated forge script or comment call.
- A second draft matched *any* heredoc (`<<DELIM`) as doc-write and *any*
  single `{a,b}` brace pair as an adversarial probe. Reviewer counterexamples,
  reproduced directly: `bash <<EOF` / `sh <<EOF` **executes** the heredoc body
  rather than writing it as data, so a genuinely destructive payload delivered
  that way would have read as "just documentation"; and a lone brace pair is
  ordinary shell multi-target syntax (`rm -rf {secretA,secretB}` is a
  plausible real destructive command), not evidence of anything adversarial.
  Fixed by anchoring the heredoc check to `cat` specifically (every real
  doc-write shape in the data pipes into `cat`) and requiring the brace check
  to see either two-or-more CONSECUTIVE groups (the real spelling-obfuscation
  and range-spam shapes below) or NESTED braces, never a single pair.

Recall lost by both walk-backs (~4 points total, from a peak of ~96.6% on an
unreviewed draft down to ~92.7% shipped) is the accepted trade: never widen
the guard-testing label past what survives adversarial review with no
plausible false positive, per AC.2's design caution.

The remaining ~15/206 (~7.3%) are not a defect to be regex'd away — they
split several honest ways: a few are `node -e` proof-of-concept scripts whose
identifying `import .../check(` text sits past the journal's 300-char `cmd`
truncation (a real, disclosed recall ceiling, not a modelling gap); a few
reference `plugin/scripts/` specifically (the first walked-back signal
above); one is the single genuinely bare `git push --force origin main` with
no distinguishing context anywhere in this run's evidence; one is a real
`git checkout -B ... && git fetch origin main` mid-branch-fixup command
(from this repo's own #454 branch history) that happens to trip `hard-reset`
and reads as plausibly genuine work, not a probe. All of them correctly stay
unclassified/visible rather than guessed either way — this is exactly why
AC.2 exists.

## Design

Bounded to `distill.mjs`'s clustering/report functions and their tests, per
the ticket's non-goal (denylist matching behaviour itself is untouched).

- `classifyBlockedEdit(cmd)` (new, exported): returns `{ guardTesting,
  reasons }`. Deliberately two states, not three — absence of a
  guard-testing signal is not proof of genuine intent, so there is no
  confident "genuine" label, only `guardTesting: true` (a discriminator
  matched — evidence of guard-testing) and `guardTesting: false`
  ("unclassified" — no signal either way, the safe/visible default per the
  "err toward keeping an event visible" caution). Four discriminator groups,
  documented inline with the counts above so the next reader can see the
  classifier is data-derived: denylist-harness, scratch-path, doc-write,
  adversarial-probe.
- `signature()`: `blocked-edit` case becomes `` `${rule} [${guardTesting ?
  'guard-testing' : 'unclassified'}]` `` so clustering itself splits
  genuine-looking events from guard-testing events under the same rule
  (AC.1) — this is the mechanical fix, not just a wording change.
  `escalation-resolved` stops falling back to the shared literal
  `'unspecified'` when `event.reason` is absent (it always is —
  `escalate.mjs`'s resolve path only ever wrote `issue`/`id`/`answer`, never
  `reason`) and instead falls back to the escalation's own `id` (unique per
  decision), so unrelated resolved decisions across different tickets never
  merge into one fake pattern (AC.5). `escalation` (the open, not resolved,
  event) is untouched — it already carries `reason` and has a pinned test.
- `renderReport()`: `blocked-edit` clusters get proposal text selected by
  `classifyBlockedEdit()` instead of the fixed `PROPOSALS['blocked-edit']`
  string (removed from that map). A `guardTesting: true` cluster proposes NO
  role-card edit and states plainly this reads as the guard being
  deliberately exercised, never "the agent keeps reaching for a denylisted
  action" (AC.1). An unclassified cluster is phrased as a question with
  evidence, not an instruction (AC.2). Every `blocked-edit` cluster gets a
  truncated, whitespace-collapsed excerpt of its sample event's `cmd`
  printed inline via a new `cmdExcerpt()` helper (AC.3) — the pre-fix report
  only printed bare timestamps under `Refs:`, which is why the 2026-08-13
  misreading needed a manual `journal.jsonl` read to catch.

Not touched: `denylist.mjs`/`check()` matching behaviour (explicit
non-goal), `gate-fail`/`cmd-fail`/`backend-fallback`/`incident` clustering,
the archive/report skeleton, `PROPOSALS` entries for kinds other than
`blocked-edit`.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC.1** `blocked-edit` clustering distinguishes "probable genuine
  attempt" from "guard-testing / literal-string"; the report never presents
  guard-testing/literal-string as "the agent keeps reaching for a
  denylisted action".
- **AC.2** An unclassifiable cluster is phrased as a question with
  evidence, not an instruction.
- **AC.3** The report prints a representative, truncated `cmd` excerpt per
  `blocked-edit` cluster inline, not just bare timestamps.
- **AC.4** Tests pin classification against a fixture built from this
  round's real shapes: a `check()` harness invocation, an adversarial probe
  with a long echo tail, a brace-expansion probe, a `--body-file` doc write,
  and a genuine bare destructive command — the genuine one still clusters
  separately (false positives are not fixed by suppressing true ones).
- **AC.5** `escalation-resolved` clustering does not group unrelated
  escalations under `unspecified`.

## Task 1 (test): regression tests

`tests/learn/distill.test.mjs` gains `AC-465.*`-titled tests:
`classifyBlockedEdit` unit tests for a `check()`-harness `node -e` script, a
scratch-path command, a `--body-file`/heredoc doc write, a long-echo-tail
probe, a brace-expansion probe, and a genuine bare `git push --force origin
main` with no scaffolding (AC.4); a `clusterEvents` test proving the same
`rule` splits into a `guard-testing` cluster and an `unclassified` cluster
rather than merging (AC.1); a `renderReport` test asserting the
guard-testing cluster's proposal never contains "reaching for a denylisted
action" and the unclassified cluster's proposal contains question language
(AC.1, AC.2); a `renderReport` test asserting a truncated `cmd` excerpt
(with an ellipsis) appears inline (AC.3); and `escalation-resolved`
signature tests proving resolved decisions for different issues never share
a signature while the same escalation `id` resolved twice still clusters as
a repeat (AC.5).

**Files:** tests/learn/distill.test.mjs
**AC map:** AC-465.1, AC-465.2, AC-465.3, AC-465.4, AC-465.5
**Test plan:** see above; run `npx vitest run tests/learn/distill.test.mjs`.

## Task 2 (code): classifier + signature + report changes in distill.mjs

`plugin/scripts/learn/distill.mjs`: add `classifyBlockedEdit(cmd)` (exported)
and its backing regexes, documented inline with the observed-event-count
grounding above; update `signature()`'s `blocked-edit` and
`escalation-resolved` cases; add `cmdExcerpt()` and `proposalFor()` helpers
and wire them into `renderReport()`'s per-cluster `**Proposal:**`/`Sample:`
lines for `blocked-edit` (every other kind keeps using the existing
`PROPOSALS` map, unchanged).

**Files:** plugin/scripts/learn/distill.mjs
**AC map:** AC.1, AC.2, AC.3, AC.4, AC.5
**Done:** Task 1's tests pass; `npx vitest run tests/learn/distill.test.mjs`
green; the pre-existing AC-7.4/7.5/7.7 assertions in the same file are
unchanged and still green.

## Task 3 (docs): route index

Add this plan to `docs/README.md`'s plan index.

**Files:** docs/README.md
**AC map:** (none — housekeeping only, required by repo doc-sync convention)
