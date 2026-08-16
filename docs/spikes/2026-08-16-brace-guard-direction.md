# Spike — which brace-expansion guard direction closes #448's bypass class soundly?

**Date:** 2026-08-16 · **Ticket:** #515 (spike, child of #182) · **Feeds:** #448's re-escalation (`esc-448-msrs9z1u`) · **Route:** spike (deliverable = this findings doc; **no production-source changes** — `plugin/hooks/denylist.mjs` is untouched by this branch; all prototypes below are throwaway Node/bash scripts under a scratch dir, never part of any commit).

## The question and the decision it feeds

Two full adversarial review rounds on branch `fix/448-brace-expansion-detect-refuse` each found a live, real-bash-verified bypass in `tokenHasBraceGroup()`'s brace-to-nearest-close pairing, and the round-1 fix separately introduced a false positive (an ordinary brace-expanded multi-branch push now blocks). The owner answered the resulting escalation "spike needed" rather than picking one of its five options directly. `esc-448-msrs9z1u` names three technical directions (two explicitly, one only implicitly as "never evaluated"):

1. Drop brace pairing entirely — refuse if a scoped token contains `{` anywhere followed later by `,`/`..` anywhere. Provably sound against the bypass, but the escalation states it blocks `git push origin {main,develop}`.
2. Nesting-depth-aware pairing, to keep `{main,develop}` allowed — a third attempt at pairing logic, "0-for-2" so far on this ticket.
3. Narrow the guard to the flag-relevant argument region so refspec/target tokens are out of scope by construction — never evaluated by either review round. (The escalation's own `recommend` field favors option 1, the "no pairing" direction, not this one; this spike was scoped to give direction 3 real weight anyway, precisely because neither review round had tested it and an unevaluated option is not the same as a weak one.)

**This spike's question:** can any of these three directions close the known bypass class *and* avoid the known false positive, verified against real bash — and if not, which one gets closest, at what cost? The answer feeds the owner's re-decision on #448, re-surfaced via a fresh escalation once this doc lands.

## Grounding methodology

Every argv claim below is quoted from a real `bash -c`/interactive session (GNU bash 5.3.15, Cygwin — the same interpreter class this file's own comments are written against), run from a scratch dir outside the repo (`.../scratchpad/448-spike/`, not part of this branch). Every candidate-direction claim is backed by a runnable Node prototype scored against a single fixed corpus, not by hand-argument. Two supporting facts (git's own option-permutation behavior, GNU coreutils' option-permutation behavior) are verified directly against live `git`/`rm` in a disposable scratch repo, not asserted from memory.

Probe scripts (all under the scratch dir, not committed): `probe_argv.sh` (bash argv ground truth for the full corpus), `prototypes.mjs` (directions 1 and 2-detect-only), `prototypes2.mjs` (direction 2-full: nesting-aware pairing + alternative-content classification), `run_corpus.mjs` (scores all three against ground truth).

## 1. Direction 3 — narrow the guard to the flag-relevant argument region

**Verdict: does not dissolve the tradeoff. Ruled out — structurally unsound, not merely unevaluated.**

The premise is that a "flag-relevant argument region" is distinguishable from a "refspec/target region" well enough to exclude the latter from brace scanning by construction. Two independent pieces of direct evidence refute this for every rule #448 touches:

**(a) The commands in question do not confine flags to a region.** Verified directly against live git and GNU coreutils in a disposable scratch repo — a flag placed *after* the positional refspec/target is honored exactly as if it came first:

```
$ git push origin main --dry-run --verbose      # flag AFTER "origin main"
Pushing to .../remote.git
   484ee3d..e7cfe60  main -> main                # honored — real update shown, not "Everything up-to-date"

$ rm junk2.txt -v                                # flag AFTER the target, no -r/-f involved
removed 'junk2.txt'                              # honored
```

Both `git`'s `parse-options` (shared by `push`/`branch`/`reset`, all three git-based rules #448 touches) and GNU coreutils' `getopt_long` (which `rm` uses) permute options and positionals by default. There is no textual position in these command lines that is reliably "never a flag."

**(b) A brace group sitting in what looks like the target/refspec position can itself expand to a standalone dangerous flag.** Verified against real bash:

```
$ printf '[%s]\n' push origin '{main,-f}'
[push]
[origin]
[main]
[-f]                                             # a real, standalone -f argv entry
```

`{main,-f}` sits exactly where an ordinary multi-ref list like `{main,develop}` sits — same shape, same position, one is dangerous and one is not, and nothing about *where* the token sits distinguishes them. Any redesign that excluded "the target region" from scanning would reopen exactly the bypass class #448 exists to close; any redesign that *kept* scanning it (because a real flag can hide there) has not actually narrowed anything — the `{`-leading token still has to be classified on its content, which is directions 1/2's problem restated, not escaped. A second counter-example the other direction — `git push -f{ee,} origin {main,develop}` — puts the real danger in the conventionally-flag-shaped early position and the benign brace group in the conventionally-target-shaped later position, confirming the split runs the same way regardless of which slot the danger happens to occupy.

**Conclusion:** direction 3, taken literally, is not a viable third path. It collapses back into needing directions 1/2's content question for `{`-leading tokens, because git/coreutils argument parsing makes "region" carry no information here.

## 2. Directions 1 and 2 — prototyped and scored against one corpus

Three implementations were built and run against a 19-case corpus covering: every AC-448.1 baseline reproduction from #448's own ticket body, both round-1 defects (nested non-final alternative, empty-alternative-glues-suffix), the exact round-2 verified bypass (`git push -{{},f} origin main`) and three variants of it (rm/branch, `{`-leading), the round-1 verified false positive (`git push origin {main,develop}`), and four additional stress shapes constructed while building the corpus (danger hiding in a target-shaped group, danger in an early flag-shaped group alongside a benign later group, an inert single-element group followed by unrelated literal text containing a comma, and a signed/negative numeric range — bash supports `{-1..3}`-style ranges, which was not in the ticket's original list of range forms).

Of the 19 cases, 17 are ground-truth **dangerous** (real bash resolves them to a spelled flag) and 2 are ground-truth **safe** (`git push origin {main,develop}` and the inert-group-plus-unrelated-comma shape `{a}-f,x`) — the corpus is bypass-heavy by construction, since the round-2 bypass and its variants dominate the case count, but the scoring below is broken out by both halves so a direction that's merely "quiet" on the small false-positive side isn't mistaken for precise.

| Direction | Mechanism | Bypasses (17 dangerous cases) | False positives (2 known-safe cases) | Notes |
| --- | --- | --- | --- | --- |
| **1 — no pairing** | any `{`, then any `,`/`..` later in the token, unconditionally | **0 missed** | **2 of 2 wrong** (`{main,develop}` blocked; `{a}-f,x` — an inert group followed by unrelated literal comma — also wrongly blocked) | Simplest, O(token length), no recursion. |
| **2 (detect-only)** — nesting-depth-aware group *detection*, no content classification | proper `{`/`}` depth tracking finds the real group; still doesn't ask what the alternatives say | **0 missed** | **1 of 2 wrong** (`{main,develop}` still blocked; correctly ALLOWS `{a}-f,x` because the inert group is now correctly recognized as inert) | Still O(token length), still iterative, no recursion. Strictly dominates direction 1: same soundness, fewer false positives, same cost. |
| **2-full** — nesting-depth-aware pairing **+ alternative-content classification** (recurses into each top-level alternative, asks whether it could start with `-`/`+`; an empty alternative defers to what follows the group; a range group is checked for a literal `-` in its own spec) | **0 missed** | **0 of 2 wrong** — the only one of the three that also allows `{main,develop}` | **Crashes on a constructible adversarial input — see below.** |

Raw scoring run (`node run_corpus.mjs`) — the script prints and scores all 19 rows; the aggregate line and the two rows where any direction disagreed with ground truth are quoted below (the full 19-row table is reproducible from the corpus/script named in Sources, not re-pasted here):

```
Wrong verdicts — direction1: 2/19, direction2(detect-only): 1/19, direction2-full(detect+classify): 0/19
```

The two rows direction 1 gets wrong and direction 2-detect-only gets right of them:

```
git push origin {main,develop}    truth=ALLOW  d1=BLOCK<-WRONG  d2=BLOCK<-WRONG  d2full=ALLOW
git push origin {a}-f,x           truth=ALLOW  d1=BLOCK<-WRONG  d2=ALLOW         d2full=ALLOW
```

### 2-full's disqualifying defect, found in ~20 minutes of adversarial self-testing

Direction 2-full is exactly the "third attempt at pairing logic" the escalation was cautious about, and it earned that caution: it is the only candidate built with real recursion (each alternative is classified by recursing into `mightStartWithDash()`), and recursion depth is driven directly by the token's own brace-nesting depth. A mechanically-constructed 20,000-deep nested comma-bearing token — the *exact same shape* as **defect 3** in the original removed implementation ("single-element range yields one alternative... 20k of them overflowed the stack with an uncaught RangeError") — reproduces the identical crash in this brand-new implementation:

```
$ node -e "... mightStartWithDash('{' * 20000 nested ...)"
THREW: RangeError Maximum call stack size exceeded
```

Directions 1 and 2-detect-only are both iterative (no recursion) and complete the same 20,000-deep input in single-digit milliseconds with no error:

```
d1 OK, result= true ms= 1
d2 OK, result= true ms= 6
```

Given the file's own stated invariant (`check()` must be total — AC-3.4/AC-448.5, "no input causes any rule to be skipped") and its fail-open-on-internal-error framing, an uncaught exception here is not merely a crash bug — on the real hook entry point it most likely degrades to **fail-open on exactly the class of pathological input an attacker would construct on purpose**, which would make 2-full's failure mode a *bypass*, not just a robustness gap. This is disqualifying as prototyped. It is plausibly fixable (rewrite the recursion as an explicit stack, the same fix class the original implementation needed for its own defect 3), but that rewrite is unproven, untested here, and would need its own fresh adversarial round before shipping — this spike did not attempt it, in keeping with the time-box.

## 3. Recommendation

**Direction 2, detect-only (nesting-depth-aware group *detection* without alternative-content classification).** Evidence-based reasoning:

- It is exactly as sound as direction 1 against every known bypass (0/17 missed) and strictly more precise (1/2 known-safe cases wrong vs. 2/2) at the same implementation cost — a single iterative depth-counting pass, no recursion, no new failure mode found under the same adversarial pressure that broke 2-full in minutes.
- It still accepts the documented, narrow false positive the escalation's own option 1 already named (`git push origin {main,develop}` and equivalent ordinary multi-ref pushes block) — that is a real, owner-facing cost, not eliminated by this recommendation, only slightly narrowed (the `{a}-f,x`-shaped inert-group-plus-unrelated-comma class direction 1 additionally over-blocks is closed).
- Direction 2-full remains the only prototype that also clears the `{main,develop}` false positive, and is worth keeping on record as a fast-follow *if* the owner judges that false positive unacceptable long-term — but it is not ready: it needs a non-recursive rewrite and a full fresh adversarial round (its own "0-for-2" history plus this spike's newly-found defect-3 recurrence make a third un-reviewed attempt a bad trade against #448's two-strikes discipline).
- Direction 3 should be dropped from consideration entirely. It is not "higher-risk" — §1 shows it is unsound by direct evidence against both git's and coreutils' actual argument parsers, for reasons unrelated to how carefully any implementation of it would be written.

**What this spike did not settle:** whether the owner accepts the `{main,develop}`-class false positive at all (the actual guard-behavior-model decision `esc-448-msrs9z1u` reserves for the owner) is unchanged by this spike — the evidence here narrows *which implementation* pays that cost most cheaply and soundly, it does not remove the cost. AC-448.4's other named false-positive cases (`query='mutation{...}'`, `feat/{a,b}` branch-name arguments, `node_modules/{a,b}` paths, commit-message braces) are unaffected by the choice among directions 1/2/2-full — none of those tokens are `{`/`-`/`+`-leading, or the rule's own verb-gate (`\bgit\b...\bpush\b` etc.) excludes the command before `hasFlagBrace()` is ever consulted, so this three-way comparison only matters for the narrow class of tokens that already start with `{`.

## Sources

- `.forge/decisions/esc-448-msrs9z1u.json` — the escalation this spike answers.
- `gh issue view 448` (body + comments) — AC-448.1–AC-448.6, the eight defects of the removed implementation, the triage verdict's detect-don't-enumerate design insight, and both delivery escalation comments with full round-1/round-2 evidence.
- `plugin/hooks/denylist.mjs` on branch `fix/448-brace-expansion-detect-refuse` (commits `53fdc7e`, `de1e60e`) — `hasFlagBrace()`, `tokenHasBraceGroup()`, and how each of the four dangerous rules wires the brace check in as an OR-condition behind its own verb-gate.
- `docs/spikes/2026-08-13-argv-tokenize-model.md` — adjacent spike; §1 explicitly refuses to model brace expansion in the tokenizer design and cites #448's own defect list as the reason; its subsumption matrix rates #448 only "partially closed" even by the hypothetical full tokenizer.
- This spike's own scratch-dir artifacts (not committed): `probe_argv.sh`, `prototypes.mjs`, `prototypes2.mjs`, `run_corpus.mjs` — raw output for every claim above is quoted inline; the corpus and scoring run are reproducible from these files.
