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
`.forge/journal.jsonl`, which keeps growing as the run continues — ~216
`blocked-edit` events at final analysis time), the SHIPPED classifier
resolves 184/216 (~85.2%) as carrying at least one guard-testing signal:
importing/invoking the denylist-guard machinery itself
(`\bcheck(`/`denylist.mjs`/`isAllowedCommand`/anything under `plugin/hooks/`),
a scratch/tmp/review-worktree path with no `..` traversal following the
marker (`scratchpad`/`/tmp`/`AppData\Local\Temp`/`forge-security-N`/
`forge-review-N`), a `$(cat <<EOF … EOF)` command-substitution doc-write or
`--body-file` — the literal-string caveat — or a ReDoS/length-padding tail
(`; echo yyyy…`). Recall is materially lower than earlier drafts (a peak of
~96.6% on the first unreviewed draft) — see the two removed signal
categories below, both closed for the same reason: they are not just a
*shape* a security role happens to favour, they are the literal *mechanism*
a real bypass would use.

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

A THIRD adversarial round (security role, run separately from the reviewer
pass above) found two more instances of the same class, plus one organic
false positive, all reproduced directly against `classifyBlockedEdit()`:

- Every discriminator matched anywhere in the (already-truncated) `cmd`
  string with no requirement the match characterize the whole command — so a
  genuinely destructive command could borrow a guard-testing label by
  appending a free decoy, e.g. a trailing `# check(this)` shell comment
  (inert, never executed) or a `; echo $'x'` tail chained after the real
  payload. Closed the comment-decoy case (cheapest for an attacker — no real
  guard-testing shape needed, just a `#`) with a `stripComment()` pass before
  any discriminator runs; the compound-command case (a decoy segment chained
  via a real `&&`/`;`) is a documented, accepted residual limitation — closing
  it fully needs `denylist.mjs`'s own quote-aware segmentation, out of this
  ticket's scope (see the KNOWN LIMITATION comment in `distill.mjs`). AC.3's
  printed excerpt is the backstop: a maintainer approving "no role-card
  change" is always looking at the same text the classifier saw.
- The "two-or-more consecutive brace groups" bar from the prior fix wave still
  passed ordinary bash Cartesian-product syntax (`backup{2024,2025}{01,02}`,
  2-3 groups is a completely normal multi-dimension target list). Raised to
  four-or-more.
- The repeated-character-run bar (15+) could fire on an organic 20-char run in
  a real path/token. Raised to 30+ — comfortably below every real probe tail
  in the validated data (shortest is 35 chars, most are 260+) and comfortably
  above the counterexample.

A follow-up re-review (`forge:reviewer`, verifying the third round's fixes)
found the same class survived in two more forms, both closed in the same
commit as the third round above:

- The nested-brace check (`\{[^{}]*\{`) matched ANY two nested braces, so
  ordinary bash command-grouping (`{ cmd; }`) and a harness's own embedded
  code (`node -e "function f(){ if(1){…} }"`) — both real shapes in this
  repo's own commands — mislabelled too. Every real nested-brace PROBE has
  its braces glued with zero whitespace (`{{a,b},-D}`); ordinary
  grouping/code always has a space or other character between them. Anchored
  to `\{\{` specifically.
- The bare `$'…'` check fired on any ANSI-C quote-open with no requirement of
  an actual obfuscating escape — mislabelling ordinary data-shaped usage this
  repo's OWN `tests/hooks/denylist.test.mjs` (AC-437.5) pins as benign
  (`$'\n'`, `$'hello\tworld'`). Tightened to require either a hex/octal/
  unicode escape (`$'\x2df'` — spelling an arbitrary byte) or the quoted
  content starting with a literal dash (`$'-f'` — denylist.mjs's own
  documented flag-hiding bypass class).

A FOURTH round (`forge:reviewer`, re-reviewing the diff after round 3 landed)
found a critical-severity gap the first three rounds' fixture-driven approach
never surfaced, because it required reasoning about what the *matched text
itself bash-expands to*, not just what shape it has:

- `git branch {{a,b},-D} release-2026` — the exact nested-brace shape round 3
  anchored to `\{\{` and pinned as guard-testing — bash-expands to three
  CLEAN standalone arguments (`a`, `b`, `-D`), i.e. a real, complete `-D`
  flag with no interfering garbage. Reproduced directly: the un-wrapped bare
  form is a genuinely working `git branch -D` bypass, not a benign shape.
  Generalizing the same review, the "4+ consecutive groups" bar from round 3
  (meant to require spelling-obfuscation/range-spam, not ordinary 2-3-group
  Cartesian syntax) does not close this either: `{--,}{r,}{f,}{,X}` is 4
  non-nested groups, each with an empty-string branch, whose Cartesian
  product includes the single clean combination `--rf` — the identical flaw,
  spread across groups instead of nesting.
- `$'-f'` cleanly, unconditionally bash-expands to the literal two-char
  string `-f` — no combinatorics needed at all. `git push $'-f' origin main`
  really does force-push if executed for real; round 3's ANSI-C tightening
  (require a hex/octal escape or a leading dash) was aimed at ruling out
  ordinary *data* usage, but a leading-dash `$'-f'` is exactly the shape
  round 3 kept as a *positive* signal, and it is exactly as dangerous as
  writing `-f` literally.

Both are the same underlying problem: brace-expansion and ANSI-C/quote
obfuscation are evasion TECHNIQUES, not "probe shapes" — text alone cannot
tell "a security role spelling out a bypass to prove the guard catches it"
from "an attacker (or a confused agent) spelling out a real one", because
the command text is deliberately identical in both cases by design of these
techniques. Fixed by removing brace-expansion and ANSI-C/quote-spelling from
`adversarial-probe` entirely, rather than attempting a fifth, sixth, … regex
refinement of an unsound premise — this is the same class of unsolved
problem the board's own #448/#459 tickets are independently working on for
`denylist.mjs` itself, and reproducing that work inside `distill.mjs` is
explicitly out of this ticket's scope. This is the honest finding the
ticket's own brief asked for: **the recorded evidence (command text alone,
with no actor/role/ticket-context field ever journaled) does not contain
enough signal to safely treat brace/ANSI-C obfuscation as proof of benign
intent.** Only the ReDoS/length-padding tail survives in `adversarial-probe`
— it is different in kind, not degree: the primary command sits in full,
un-obscured plain text before the `;`, so padding neither hides nor helps
construct anything, and a real attacker gains nothing from appending 30+
repeated characters.

A subsequent `forge:security` pass (adversarial, reviewing the same diff
independently) found two more issues, both non-blocking (verdict: pass) but
fixed in the same wave: `cmdExcerpt()` truncated the human-visible `Sample:`
line to 140 chars while `classifyBlockedEdit()` classified against the full
~300-char `cmd`, so a crafted command could earn the softer "guard-testing"
label while hiding both the destructive content and the matched signal from
the report — contradicting the code's own stated AC.3 invariant. Fixed by
raising the excerpt bound to 300, matching `denylist.mjs`'s own journal
storage cap exactly, so the excerpt can never truncate below what the
classifier itself saw. Separately, the excerpt was spliced into a Markdown
inline-code span with no escaping (unlike this codebase's own `escapeMd()`
precedent in `board/escalate.mjs`); backticks are now replaced before
embedding.

A FIFTH, self-directed round (building an adversarial fixture set in the
same spirit as rounds 3-4, rather than waiting for a further external pass)
found two more instances of the exact round-4 pattern — a signal that is the
literal delivery mechanism for a real attack, not just a probe shape:
`cat > ~/.ssh/authorized_keys <<EOF … EOF` and `cat > .git/hooks/pre-commit
<<EOF … EOF` both matched the round-2 `cat`-anchored doc-write signal, but a
bare `cat > file <<EOF` genuinely WRITES the heredoc content to `file` —
installing a real backdoor SSH key or a real malicious git hook is exactly
as dangerous as any other destructive write, `cat` or not. Only `$(cat
<<EOF … EOF)` COMMAND SUBSTITUTION is actually safe unconditionally, because
it never touches the filesystem at all — it just captures the heredoc as a
shell string (the real validated shape: `--body "$(cat <<EOF … EOF)"`).
Fixed by anchoring doc-write to the `$(cat …)` form specifically; a
scratch-path `cat > file` still classifies via the independent scratch-path
signal, so this costs no recall against the validated data. Also found:
`rm -rf /home/user/myapp/tmp/uploads --force` — a genuine destructive
command against a real project's own directory that merely happens to be
*named* `tmp` — matched the unanchored `/tmp/` substring check. Fixed by
anchoring `/tmp/` to a path start (preceded by whitespace/`=`/a quote/string
start), never a bare mid-path substring; the other scratch markers keep a
substring match since they are this repo's own distinctive path components,
not a generic word an unrelated real directory would also contain.

Recall lost across all six walk-backs (~11 points total, from a peak of
~96.6% on the first unreviewed draft down to ~85.2% shipped) is the accepted
trade: never widen the guard-testing label past what survives adversarial
review with no plausible false positive, per AC.2's design caution.

The remaining ~32/216 (~14.8%) are not a defect to be regex'd away — they
split several honest ways: several are `node -e` proof-of-concept scripts
whose identifying `import .../check(` text sits past the journal's 300-char
`cmd` truncation (a real, disclosed recall ceiling, not a modelling gap);
several reference `plugin/scripts/` specifically (the first walked-back
signal above); several use the now-removed brace-expansion/ANSI-C shapes
(rounds 4-5); one is the single genuinely bare `git push --force origin
main` with no distinguishing context anywhere in this run's evidence; one is
a real `git checkout -B ... && git fetch origin main` mid-branch-fixup
command (from this repo's own #454 branch history) that happens to trip
`hard-reset` and reads as plausibly genuine work, not a probe. All of them
correctly stay unclassified/visible rather than guessed either way — this is
exactly why AC.2 exists.

**A SIXTH round** (one more pass each from `forge:reviewer` and
`forge:security`, both re-reviewing after round 5) found four more instances
of the identical unresolved class, none closable by narrowing a regex
further: `stripComment()` is quote-blind and can hide a real `&& rm -rf ~`
tail behind a `#` inside an executed quoted string; a `$(cat <<EOF …)`
capture genuinely executes when fed to `eval`/`bash -c`; a `$(...)`
substitution embedded in a scratch-looking path string executes for real
regardless of where the final path lands; a generic `child_process` API name
(`spawnSync`) is not exclusive to this repo's own denylist-testing harness.
Four independent adversarial rounds each finding a NEW shape of "can a
text-substring match ever be trusted to characterize an entire unparsed
shell command" — rather than converging toward zero — is itself the answer:
no, not without real shell parsing, which `denylist.mjs` itself does not yet
have and which board #448/#449/#459 are separately, still working on. A
fifth regex-narrowing round would very likely find a seventh shape.

The fix moved one level up instead of chasing another instance: `proposalFor()`
no longer asserts confident dismissal for a `guardTesting: true` cluster
("kept as evidence only") — it now reads as a hedged hypothesis ("likely
guard-testing, not a diagnosis") that explicitly names the residual risk and
points at the excerpt, symmetric with the `guardTesting: false` branch's
existing "question, not a diagnosis" framing. AC.1 does not require a
perfect signal ("the signal need not be perfect") — only that the report
never present a match as proof of benign intent. That invariant now holds
regardless of what a future adversarial round finds, because the excerpt
(AC.3) is drawn from the ORIGINAL `cmd`, never from `stripComment()`'s
output, so a maintainer is always looking at the full text regardless of
what the classifier itself missed. The `toolCall`/`isAllowedCommand`/
`spawnSync` markers were also dropped from `denylist-harness` entirely
(zero-recall-cost per the validated data — every real event using one of
them also carried a scratch-path or `plugin/hooks/` marker), since each is a
generic identifier that ordinary, unrelated real code could also contain.

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
