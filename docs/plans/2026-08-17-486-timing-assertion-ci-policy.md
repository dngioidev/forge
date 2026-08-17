# Plan: #486 - tests: denylist perf test is timing-flaky on CI

**Ticket:** #486 (board #8) - **Kind:** test/policy
**Base:** main - **Branch:** fix/486-denylist-perf-flake - **Verify:** `pnpm verify`

## Task T1 — replace the ratio assertion, name the policy

**Kind:** test-fix + doc. **AC-IDs:** AC-486.2 (robustness fix), AC-486.4 (no
coverage reduction); AC.1 and AC.3 are analysis/documentation criteria,
satisfied by this doc and the PR body, not by a test id.

**Files:** tests/hooks/denylist.test.mjs, docs/plans/2026-08-17-486-timing-assertion-ci-policy.md, docs/README.md

**Test plan:** `AC-3.4/AC-486.2/AC-486.4` in `tests/hooks/denylist.test.mjs`
asserts two independent absolute wall-clock ceilings (2000ms each) replacing
the flaky ratio; full `pnpm verify` must stay green (1573/1573 pre-existing +
0 net new, since this rewrites an existing test rather than adding one);
`testintent.mjs` must report clean (no assertion weakened) and `acgate.mjs`
must cover AC-486.2/AC-486.4 from passing test output.

## AC.1 — what flaked, and why

The flaking assertion is `tests/hooks/denylist.test.mjs`'s `'AC-3.4: normalisation
stays linear on large, quote-heavy input'` test (the perf regression test added
for #452's quadratic-scan finding). Pre-fix, it read:

```js
const small = Math.max(timeFor(150000), 1);
const large = Math.max(timeFor(300000), 1);
expect(large / small).toBeLessThan(3);
```

This is a **timing ratio**, not an absolute budget: it measures two wall-clock
samples (a ~150k-pair and a ~300k-pair quote-heavy `echo` command through
`check()`) and asserts the larger one is under 3x the smaller.

**Quantified, not assumed (per AC.1's own instruction).** Run locally 8x on
ordinary (non-shared-tenancy) dev hardware, warm-started exactly as the test
does:

| run | small (ms) | large (ms) | ratio |
|---|---|---|---|
| 1 | 58 | 73 | 1.26 |
| 2 | 35 | 91 | 2.60 |
| 3 | 36 | 75 | 2.08 |
| 4 | 35 | 74 | 2.11 |
| 5 | 34 | 75 | 2.21 |
| 6 | 50 | 73 | 1.46 |
| 7 | 48 | 64 | 1.33 |
| 8 | 29 | 79 | 2.72 |

Observed ratios already range 1.26–2.72 against a threshold of 3 — on a quiet,
dedicated machine. GitHub-hosted runners are shared-tenancy VMs with real
scheduling noise (documented already in #482's evidence for the sibling
`lock.test.mjs` flake). The mechanism that defeats the ratio: **the "small"
sample is the more vulnerable one.** It is the faster, ~30–90ms measurement, so
a single GC pause or scheduler preemption landing inside just that window
shrinks the denominator — a 20ms stall roughly triples a 30ms sample, but only
adds ~20–25% to a 75–90ms one. A ratio of two wall-clock samples is *more*
sensitive to jitter than either sample alone, because jitter in the smaller
sample is amplified rather than absorbed. That is a structural property of the
assertion shape, not a one-off unlucky CI box — which is why AC.2 below fixes
the shape, not the threshold.

## AC.3 — does #486 share a root cause / policy with #482?

**No shared root cause. #482 was a genuine bug; #486 is a genuine
assertion-shape problem.** Both were verified against what actually landed in
this run before writing this down:

- **#482** (`tests/lib/lock.test.mjs`, merged as commit `130627e`, PR #542):
  diagnosed as a real **TOCTOU race** in `reclaimStaleLock()` — the
  `.reclaiming` marker serialized concurrent reclaimers but never re-validated
  that the lock was still stale immediately before overwriting it, so a slow
  straggler could clobber a fresh reclaim. Fixed with a re-read + re-validate
  step (`plugin/scripts/lib/lock.mjs`, `readLock`/`isStale` re-checked right
  before the overwrite) plus a deterministic, seam-based regression test
  (`_beforeMarkerAttempt`). **No assertion was loosened** — the "exactly one
  wins" invariant is unchanged. CI-runner scheduling variance did not cause
  the bug; it only made a real concurrency bug *visible* often enough to
  notice.
- **#486** (this ticket): the test itself has no concurrency and no bug in the
  code under test — `normalizeShellText()` is genuinely linear post-#452. The
  problem is entirely in how the test *measures* that: a ratio of two live
  timings, which amplifies exactly the kind of scheduling noise shared-tenancy
  CI runners introduce.

So the two tickets are **independent one-offs in root cause**, but they share
a **policy-level lesson**: a CI failure that *looks* timing-related must be
diagnosed, not reflexively treated as "just CI noise" — #482 would have been
mis-fixed (or ignored) if someone had loosened its assertion instead of
finding the race. The shared, useful takeaway is therefore about how to
*write* timing assertions that are safe to run on this class of runner, not
about a common bug. That shared takeaway is the policy below.

## The policy (for the next timing test written against CI)

> **On shared-tenancy CI runners, assert absolute wall-clock ceilings, never
> ratios or relative-to-baseline comparisons, for anything performance- or
> timing-sensitive.** Pick the ceiling generously above the slowest plausible
> legitimate run (order-of-magnitude headroom, not a tight margin) but well
> below the failure mode the test exists to catch. A ratio comparing two live
> samples is *more* jitter-sensitive than either sample alone, because noise
> in the smaller/faster sample is amplified on division. Before treating any
> CI failure as "just timing flakiness," diagnose it first — #482 shows a
> timing-flavoured CI failure can be a real bug that variance merely exposed
> often enough to notice, not evidence the test should be loosened.

**Reference implementation:** `tests/hooks/denylist.test.mjs`'s `AC-448.3`
(landed in #448, PR #534, which already cited this ticket by number before
this ticket's own fix landed) — a single absolute ceiling (500ms) on an
adversarial ~180KB input, picked with ~20x headroom over the zero-materialisation
implementation's normal run time while staying far below the multi-second
blowup a real regression back toward materialisation would produce. This
ticket's own fix (`AC-3.4`/`AC-486.2` in the same file) follows the identical
shape: absolute ceilings on both measured sizes, no division between samples.

## AC.2 / AC.4 — the fix, and why coverage is not reduced

The fix (`tests/hooks/denylist.test.mjs`) replaces the ratio with two
independent absolute-ceiling assertions (2000ms each, matching the ceiling the
sibling JSON-payload assertion in the same test already used) on the same two
input sizes the original test measured (150000 and 300000 quote-pairs). This:

- **Does not raise the threshold "until it never fails"** in the sense AC.2
  warns against — the ceiling is unchanged in kind from what the JSON-payload
  half of the same test already asserts (2000ms, already present and
  unmodified by this ticket), not a newly-invented lenient number.
- **Still catches the #452 regression class.** Pre-fix quadratic behaviour
  measured 7s for 600KB and 32s for 1.2MB — tens of times past a 2000ms
  ceiling at even the smaller of the two sizes this test exercises. A
  reintroduced quadratic scan fails this test immediately and unambiguously.
- **Keeps both measured sizes** (not collapsed to one), so a regression that
  only shows up at scale still has something to blow up against — the only
  thing removed is the division between them.
- **No test deleted, no assertion weakened, and the #452 quadratic-regression
  class this test exists to pin is still caught** — AC.4 is satisfied by
  construction for that class, not by omission.

**Named tradeoff (found by the adversarial `forge:security` pass on this
ticket's branch, not glossed over).** The old ratio, on the runs where it
didn't flake, was *incidentally* more sensitive than a fixed ceiling to a
*milder*, sub-catastrophic superlinear regression (something like O(n^1.2))
that stays comfortably under 2000ms at these two fixed sample sizes but would
still have nudged the ratio upward. The new assertion, by design, only fires
reliably on the catastrophic end of the spectrum the #452 bug actually
occupied (7s/32s vs. a 2000ms ceiling — multiple orders of magnitude of
margin). This is accepted, not accidental: a test sensitive enough to catch
that intermediate band from two fixed-size samples is inherently noise-prone
— that sensitivity is exactly the mechanism AC.1 diagnosed as the flake's
cause, so keeping it would trade the flake for a different flake. Catching a
milder superlinear drift, if ever wanted, belongs to a differently-shaped
test (e.g. more sample points, or a dedicated algorithmic-complexity check on
`normalizeShellText()` directly) — out of scope for a flake fix, and not what
AC.4's "no reduction in coverage of the regression class" was written to
promise beyond the class the test was actually built for.
