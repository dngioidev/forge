# Plan: #474 - watchdog: relay held review verdicts to a stalled subagent automatically

**Ticket:** #474 (board #8, child of epic #183) - **Kind:** bug
**Base:** main - **Branch:** feat/474-watchdog-relay-held-verdicts - **Verify:** `pnpm verify`

`watchdog.mjs` `resolveReturnedTicket({outcome, pr, ciGreen, mergeMode})` (#319,
#464, #522) classifies a non-conforming terminal report into `respawn` (a PR
already exists — resume/re-spawn) or `escalate` (no PR — the working tree's
state is unobservable, so #522 deliberately forces a human/orchestrator to
look before anything touches it). Both recoveries are manual today: a human
or the orchestrator notices the stall, and — when it's holding the verdict(s)
the report says it's waiting on — relays them via `SendMessage`, which
resumes the *same* subagent from its own transcript.

That manual recovery has now worked six times (#429, #437, #446, #460 per
#464's own body; #469, #472 fresh in the current run) with zero failures. The
two fresh examples are also the two informative edge shapes:

- **#469** — "Reviewer passed clean. Now waiting for the security agent's
  completion notification before proceeding to ship." (reviewer resolved
  inline; only security named as outstanding) — no PR open yet.
- **#472** — "I'll wait for the notification when both agents finish; no
  further action needed from me right now." (no role named individually,
  "both" implies reviewer AND security) — no PR open yet.

Both are the #460 shape #464's own ticket names. Both stalled **before a PR
existed** — i.e. exactly `resolveReturnedTicket`'s no-PR branch, which #522
hard-escalates on purpose (its own concern is a *blind respawn* — a fresh
subagent placed onto a possibly-uncommitted shared tree). `SendMessage` is a
different mechanism: it resumes the *same, already-running* subagent from
its own transcript, not a fresh one onto an unknown tree — so a confident
match between "what the report says it's waiting on" and "verdicts the loop
already holds" can safely act ahead of, and independent of, `resolveReturnedTicket`'s
pr-based branch, without weakening #522's invariant for the genuinely
ambiguous/unmatched case.

## Design

New pure function, composed **before** `resolveReturnedTicket`, which stays
byte-for-byte unchanged (#464/#522's regression suites keep passing
untouched):

- `matchHeldVerdicts(report, heldVerdicts)` in `watchdog.mjs`.
  - `report = { issue, outcome }` — the subagent's raw terminal report (same
    shape the caller already has before calling `resolveReturnedTicket`).
  - `heldVerdicts` — caller-observed state: an array of
    `{ issue, role: 'reviewer'|'security', verdict, summary? }` the
    orchestrator already holds from task notifications it received in-run.
    Never parsed out of the report's own text — same trust-boundary
    discipline `resolveReturnedTicket`'s own JSDoc already documents for
    `pr`/`ciGreen`/`mergeMode`.
  - First: if `report.outcome` is the `STALL_OUTCOME` sentinel or already in
    `RESOLVED_OUTCOMES`, this function has nothing to do — `resolveReturnedTicket`
    alone handles those, unchanged — so it returns `action: 'defer'`
    immediately without inspecting `heldVerdicts` at all.
  - Otherwise (a non-conforming report — the same universe
    `resolveReturnedTicket` classifies as `respawn`/`escalate`): parse the
    free text for the role(s) it names as outstanding —
    `parseAwaitedRoles(text)` recognises literal `security` (only when a
    forge-review-vocabulary anchor word co-occurs in the same clause —
    `agent`/`verdict`/`check`/`pass`/`notification`/`confirmation`/
    `clear(ance)`/`sign-off`/`review(er)`/`result`/`hold`), literal
    `reviewer` (never bare `review` alone), and literal `both` (implying
    `['reviewer', 'security']`) — all via word-boundary matching within a
    clause that also contains a wait/await keyword and does NOT contain a
    negation cue, deliberately narrow (never a fuzzy/NLP match — AC.2's
    "never guess" is the load-bearing rule; see Fix wave below for how this
    narrowed from the first draft). No recognisable role name at all → no
    awaited roles → cannot match → `defer`.
  - Filter `heldVerdicts` to `report.issue`. For every awaited role, a held
    verdict for that role + that issue must be present. **All** awaited
    roles must be covered — a partial match (e.g. "both" named, only one
    held) is still `defer`, never a partial relay.
  - On a full match: `{ action: 'relay', verdicts: [...matched], reason }` —
    `verdicts` is the filtered subset of `heldVerdicts` actually being
    relayed (only the awaited roles, not every held verdict for the issue).
  - Pure — no IO, no `SendMessage` call inside this function (mirrors
    `resolveReturnedTicket`'s own split; the file-level JSDoc gets a short
    paragraph naming this as the fourth stall shape and its non-goal: it
    never weakens #522's escalate-on-no-PR default for the genuinely
    unmatched case).
- Orchestrator composition (documented in SKILL.md, not code — same as how
  `resolveReturnedTicket` itself is only ever *called* from orchestrator
  prose today): call `matchHeldVerdicts` first; `action: 'relay'` →
  `SendMessage` the matched verdict(s) to the stalled subagent and stop (wait
  for its next report); `action: 'defer'` → fall through to
  `resolveReturnedTicket` exactly as today.

## Fix wave: both adversarial `forge:reviewer` and `forge:security` independently found the same class of bug

Both full-branch passes returned `verdict: fail`. `forge:reviewer` reproduced
three false relays and one false defer by actually running the exported
`matchHeldVerdicts` against plausible, non-adversarial report text (not
hypothetical); `forge:security` independently reproduced the same class of
false relay with three different example strings and flagged it as
undermining the module's own stated safety invariant ("never guess — a wrong
auto-resume is not [safe]"). No secrets/injection/ReDoS/prototype-pollution
findings from the security pass — the `--held` CLI JSON parse, the strict
`issue` equality filter, and the relayed-verdict provenance (always the
caller-supplied held-verdict objects, never derived from the free text
itself) were all confirmed safe.

Root cause: the first draft's `parseAwaitedRoles` used bare `\bsecurity\b`
and `\breview(?:er)?\b` with no negation handling — any clause containing a
wait keyword plus either bare word triggered a match, regardless of context.
Fixed with three changes, all in `parseAwaitedRoles` only (`matchHeldVerdicts`
itself, and its caller-contract, are unchanged):

1. **Negation guard.** A clause containing a `not`/`no need`/`n't`-style cue
   anywhere alongside the wait keyword contributes NO roles at all, even if
   role words are also present — e.g. "Not waiting on the reviewer, just
   security." and "No need to wait on the security or reviewer sign-off
   anymore…" both now correctly `defer` instead of relaying both roles.
2. **`reviewer` requires the literal word — bare `review` no longer
   qualifies.** "review" alone collided with "security review", "code
   review", and "waiting to review the deployment logs myself", each
   falsely adding the reviewer role. `reviewer` (full word) is unambiguous
   enough on its own; the two live canonical examples (#464's own "Waiting
   on the reviewer's re-confirmation") already used the full word.
3. **`security` requires a co-occurring forge-review-vocabulary anchor** in
   the same clause (`agent`/`verdict`/`check`/`pass`/`notification`/
   `confirmation`/`clear(ance)`/`sign-off`/`review(er)`/`result`/`hold`) —
   bare "security" collided with "security group ingress rule" (an
   unrelated infra term). "security review"/"security agent" both still
   match (via the `review`/`agent` anchor), but generic security-adjacent
   noise no longer does.

Also fixed: the clause splitter now splits on `,` in addition to `.!?;` —
`forge:reviewer` found that without it, a comma-joined rephrasing of #469's
own shape ("Reviewer passed clean, now waiting for the security agent to
finish.") folded the already-resolved "Reviewer passed clean" mention into
the SAME clause as the awaited "security", incorrectly requiring a held
reviewer verdict too. Splitting on comma correctly separates the two
clauses, matching #469's punctuated original.

Minor findings also addressed: the `AC-474.2` "defers immediately, without
even inspecting held verdicts" test previously couldn't distinguish the
early-return branch from the (also-defer) "no recognisable role" fallback,
since neither branch's *result* differs for a `RESOLVED_OUTCOMES` value —
fixed by asserting on the `reason` string, which genuinely differs per
branch. The loop diagram's watchdog line said `matchHeldVerdicts` runs "on
every non-conforming report" when the code actually calls it unconditionally
on every `deliver`/`resume` report (deferring internally for a
resolved/`awaiting-merge` outcome) — corrected to match.

Six new regression tests pin every adversarial phrasing found (a fix-wave
`describe` block in `tests/autopilot/engine.test.mjs`, titled `AC-474.2
fix-wave`).

### Round 2: forge:security found the negation word-list was itself incomplete

Re-running both adversarial passes against the round-1 fix: `forge:reviewer`
confirmed all three of its own round-1 repros now correctly `defer`, probed
several new adversarial phrasings of its own, and returned `verdict: pass`
with zero findings. `forge:security` confirmed its own three round-1 repros
were fixed and the CLI/issue-filtering surface was safe, but found a genuine
new gap: round 1's `NEGATION_RE` only covered grammatical negation
(`not`/`n't`/`no need`/…) — it does not cover a wait described as
CONCLUDED without any grammatical negation at all. Reproduced live against
the actual CLI (`node watchdog.mjs --held ...`, exit code 5 = relay) with
eight plausible strings: *"The wait on the security agent's clearance is
over."* / *"We are done waiting on the reviewer's sign-off…"* / *"…that's
moot now…"* / *"There is nothing left to wait for…"* / *"Stopped waiting
on…"* / *"Used to be waiting on…however that requirement was waived."* /
*"Hardly waiting on…anymore since it's essentially done."* / *"Waiting is
unnecessary for…"* — every one incorrectly relayed.

Fixed by widening `NEGATION_RE` to also cover completion/mootness cues
(`done`/`over`/`unnecessary`/`moot`/`nothing left`/`stopped`/`used to`/
`formerly`/`waived`/`concluded`/`hardly`) alongside the round-1 grammatical
ones — closing all eight repro strings (pinned verbatim as a new `AC-474.2
fix-wave round 2` describe block, 8 more regression tests). This is
explicitly documented as a curated cue-word list, not a semantic negation
parser — it cannot be exhaustive against arbitrary free text, and the code's
own JSDoc now carries an "Honest limit" paragraph (matching this codebase's
established precedent, e.g. #465's hedged-not-certain framing, #505's
"Honest limit" section) naming the residual risk and why it's bounded rather
than eliminated: `outcome` is a delivery subagent's own cooperative
narration, not adversarial human-crafted input, and a wrong relay's blast
radius is small — it only resumes the SAME already-running subagent with a
verdict message for it to reason about in context, and every downstream gate
(adversarial review, the merge bar) independently re-verifies everything
regardless of what this heuristic decided.

### Round 3: both passes returned `verdict: pass`; one non-blocking structural finding fixed proactively

`forge:reviewer`, re-run a third time, confirmed its own round-1 repros stay
fixed and returned `verdict: pass` with zero findings, but noted the round-2
word-list widening was itself capable of over-catching (bare `over`/`done`
in their ordinary senses, e.g. "waiting for **over** an hour" or "get my own
checks **done** in parallel") — a fail-safe direction (falls to the
pre-existing respawn/escalate path, not a wrong relay), rated `minor`.

`forge:security`, re-run a third time in its own disposable worktree,
confirmed all 8 round-2 repros now correctly defer and also returned
`verdict: pass` (explicitly: "no critical/blocking issue... not escalating
this as a gate-halting critical"), but found one more genuine, well-isolated
gap and rated it `major` even though non-blocking: a negation/completion cue
joined to the wait clause by a comma + coordinating conjunction ("I was
waiting on the security agent, **but** that's done now.") defeats detection
even for an *already-listed* cue word, because the comma-split architecture
puts the cue in the NEXT segment, which the same-segment check never
inspects. Explicitly called this "not fixable by adding more words" — a
structural gap, not a vocabulary one — and recommended a targeted one-time
fix rather than another vocabulary-widening round.

Both verdicts already satisfied the merge bar (`pass`, zero critical/high),
so this was not required to ship — but the security agent's specific,
narrow, well-reasoned fix (look one segment ahead when it starts with a
coordinating conjunction) was cheap and clearly bounded, so it was applied
proactively rather than deferred: `TRAILING_NEGATION_RE` (best-effort over
five common conjunctions — `but`/`however`/`except`/`though`/`yet`, not
exhaustive — `or` was deliberately excluded, since it collides with
legitimate non-negating phrasing like "the reviewer or the security agent,
whichever finishes first"). Four new regression tests pin the exact repro
shape; a fifth documents the deliberate `or`/two-clauses-away scope boundary
as a known, disclosed miss rather than hiding it.

Reviewer's over-catching finding was investigated but NOT acted on with more
word removals: the JSDoc's "Honest limit" paragraph was instead extended to
name the trade-off explicitly. Adding `complete`/`finished`/`resolved`/
`closed` (as one path to closing the round-2 gap further) was deliberately
REJECTED after tracing it against this ticket's own `#464`/#522-era test
fixture ("Still waiting on the security review **to complete** before I can
proceed.") — that phrasing is one of the most common ways to describe a
still-ONGOING wait, and adding those words would have broken it, trading a
narrow under-catching gap for a much wider over-catching one against exactly
the phrasing this feature exists to catch. A regression test now pins that
decision (`tests/autopilot/engine.test.mjs`, "waiting for X to complete" is
NOT treated as a negation cue).

No further adversarial round was spawned after this: both gates already
returned `pass` twice running (round 3 was itself a re-confirmation, not a
fail), and the residual gaps that remain (the `or`/two-clauses-away miss,
and the acknowledged word-list incompleteness in both directions) are
explicitly disclosed rather than chased indefinitely — consistent with this
codebase's own precedent (#465's seven-round fix-wave eventually settling on
a hedged, disclosed limitation rather than pursuing an unreachable "perfect
classifier").

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC.1** `matchHeldVerdicts` returns `action: 'relay'` with the matched
  verdict(s) when the report names one or more awaited roles and every named
  role has a held verdict for that issue — independent of whether a PR
  exists yet.
- **AC.2** Never guesses: `action: 'defer'` on no held verdicts, a named role
  with no matching held verdict, a partial match when multiple roles are
  named, no recognisable role named, held verdicts for a different issue, or
  a report that's already a resolved/`awaiting-merge` outcome.
  `resolveReturnedTicket` itself is untouched.
- **AC.3** Tests pin the #460 shape ("both" implied, both held → relay), the
  #469 shape (one role resolved inline, one named + held → relay with just
  that one), the #472 shape (no role individually named, "both agents"
  implied → both required → relay), and the AC.2 negative/fallback cases.
- **AC.4** `matchHeldVerdicts` is pure/no-IO (same input → same output); the
  `SendMessage` relay is the orchestrator's IO, invoked only on
  `action: 'relay'`. SKILL.md's § Return-then-resume watchdog (loop diagram,
  § Orchestration, § forge-agents monitor cross-reference) documents this as
  landed, citing #469/#472, replacing the "#474 is the follow-up, out of
  this ticket's scope" phrasing left by #464/#522.

Not touched: `resolveReturnedTicket` (behaviour and exports unchanged),
`#475`'s synchronous-adversarial-passes question (a delivery-contract
product decision, not this ticket's to make).

## Task 1 (test): regression tests first

Add an `AC-474.*`-titled describe block to `tests/autopilot/engine.test.mjs`
(importing the new `matchHeldVerdicts` alongside the existing watchdog
imports) covering:

- AC.1 / #460 shape: `outcome` implying "both" (e.g. "I'm waiting on both
  re-review verdicts for the final tip."), `heldVerdicts` carrying both
  `reviewer` and `security` for the same issue → `action: 'relay'` with both
  verdicts.
- AC.1 / #469 shape (verbatim): "Reviewer passed clean. Now waiting for the
  security agent's completion notification before proceeding to ship.",
  `heldVerdicts` carrying only `security` for the issue → `action: 'relay'`
  with just the security verdict (reviewer never required, since the text
  resolves it inline).
- AC.1 / #472 shape (verbatim): "I'll wait for the notification when both
  agents finish; no further action needed from me right now.", both held →
  `relay`.
- AC.2 negative cases, each asserting `action: 'defer'`: no `heldVerdicts` at
  all; #472's text with only ONE of the two held (partial-when-both-named);
  #469's text but the held verdict is for a *different* issue number;
  free text naming no recognisable role ("Still waiting on the full verify
  suite to finish."); an already-resolved report (`outcome: 'merged'`) with
  verdicts held — must defer without even inspecting them (proves the
  early-return); the `STALL_OUTCOME` sentinel (`awaiting-merge`) likewise
  defers untouched.
- Purity: same input twice yields `toEqual` output, no IO.
- Regression: `resolveReturnedTicket`'s own existing #464/#522 describe
  blocks are unmodified and still pass — proves this ticket didn't touch it.

Also add an `AC-474.4` doc test to `tests/skills/autopilot.test.mjs`
(mirroring the file's existing `AC-464.5`/`AC-522.5` pattern) pinning the §
Return-then-resume watchdog section naming `#474`, `matchHeldVerdicts`, the
relay-before-respawn/escalate ordering, and the #469/#472 citations —
written first so it fails against the pre-doc-update SKILL.md.

**Files:** tests/autopilot/engine.test.mjs, tests/skills/autopilot.test.mjs
**AC map:** AC-474.1, AC-474.2, AC-474.3, AC-474.4
**Test plan:** see above; run
`npx vitest run tests/autopilot/engine.test.mjs tests/skills/autopilot.test.mjs`.

## Task 2 (code): `matchHeldVerdicts` in watchdog.mjs

- Add `parseAwaitedRoles(text)` (internal helper, word-boundary regex over
  "security" / "review"/"reviewer" / "both"|"each"+agent-plural phrasing) and
  export `matchHeldVerdicts({ issue, outcome }, heldVerdicts = [])`
  implementing the Design section above.
- No change to `resolveReturnedTicket`, `STALL_OUTCOME`, `RESOLVED_OUTCOMES`,
  `NONCONFORMING_OUTCOME`, or the `isMain` CLI block's existing flags.
  `isMain` CLI gains its own small addition: `--held <json>` (a JSON array)
  so the CLI entry point can exercise `matchHeldVerdicts` too — printing
  `watchdog: relay (...)` / `watchdog: defer (...)` ahead of the existing
  `resolveReturnedTicket` line when `--held` is passed, exit code `5` for
  `relay` (distinct from the existing `0`/`3`/`4`).
- Update the file's top-of-file JSDoc: add a fourth shape paragraph (the
  relay recovery) alongside the existing three, and note explicitly that it
  runs *before*, not inside, `resolveReturnedTicket`.

**Files:** plugin/scripts/autopilot/watchdog.mjs
**AC map:** AC.1, AC.2, AC.4
**Done:** Task 1's tests pass; `npx vitest run tests/autopilot/engine.test.mjs`
green.

## Task 3 (docs): SKILL.md + route index

- `plugin/skills/autopilot/SKILL.md` § Return-then-resume watchdog: add a
  paragraph documenting `matchHeldVerdicts` as the step that runs **before**
  `resolveReturnedTicket` on every non-conforming report — citing #469/#472
  as the concrete recoveries, and stating explicitly that an unmatched
  report still falls through to today's `respawn`/`escalate` behaviour
  unchanged. Update the loop diagram's watchdog line (`WATCHDOG:
  matchHeldVerdicts → (no match) → resolveReturnedTicket(report)`) and the §
  Orchestration step-2 paragraph. Replace the § forge-agents monitor
  cross-reference's "#474, deliberately not built here" phrasing, and the
  trailing "#460 ... today's ordinary re-selection; automating that relay
  via SendMessage is #474, out of this ticket's scope" sentence at the end
  of § Return-then-resume watchdog, with the landed description.
- Add this plan to `docs/README.md`.

**Files:** plugin/skills/autopilot/SKILL.md, docs/README.md
**AC map:** AC.4
