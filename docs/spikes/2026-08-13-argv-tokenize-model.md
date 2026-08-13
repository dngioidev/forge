# Spike — tokenize-then-judge for the denylist hook: does one argv model retire six sibling tickets? (#451)

**Date:** 2026-08-13 · **Ticket:** #451 (parent #182) · **Route:** spike (deliverable = this findings doc; **no production-source changes** — `plugin/hooks/denylist.mjs` is untouched by this branch).

## The question

`#451`'s own diagnosis, carried over from the `#446` escalation, is that `plugin/hooks/denylist.mjs`'s rules "ask text questions about argv semantics" instead of structural ones — and that every patch round closes one spelling of that mistake and reveals another. Four PRs in two days (#439, #445, #453, #455), four adversarial rounds plus two escalations on #446 alone, and six filed sibling tickets (#451, #452, #454, #456, #448, #449) are the evidence for that claim. This spike does not assume the diagnosis is right — it designs the alternative (**tokenize the command into argv the way a real shell would, then let rules ask structural questions of the tokens**) and tests it against all six tickets, one at a time, with evidence.

## Grounding methodology

Every tokenization/argv claim below was verified against a real `bash -c`/`read` session, run from a script file under a scratch dir outside the repo (`C:/Users/dngioi/AppData/Local/Temp/claude/C--mywp-forge/451-spike/probe{1,2,3}_*.sh`, not part of this branch), per the discipline #446/#437 established. Shell: GNU bash 5.3.15 (Cygwin), the same interpreter class `denylist.mjs`'s own comments are written against. Three probes:

- `probe1_traversal.sh` — does bash resolve `..` before argv is built, and how does lexical (no-filesystem) normalisation compare to real (`realpath`) resolution.
- `probe2_argv_semantics.sh` — env-var-assignment prefixes (#454), POSIX `--` (#456), command-substitution token boundaries (#449), and NUL delivery over a live bash session (#452).
- `probe3_nul_fuse.sh` — the exact NUL-splice shapes from #446/#452's own test cases, to settle whether deleting (bash's real behaviour) vs. spacing (the current code's behaviour) changes the outcome.

Raw results are quoted inline below wherever they ground a claim.

## 1. Design — tokenize-then-judge

### What the tokenizer does

A single-pass, synchronous, side-effect-free scan (no filesystem access, no subprocess) that turns the command string into a flat sequence of **classified tokens**, replacing the current approach of running several independent regexes against a flat, partially-normalised string. It **subsumes and extends** `normalizeShellText()` — the existing quote/escape/NUL/CR handling is correct groundwork and is kept, not thrown away — but instead of emitting a flat string for every rule to re-scan with its own regex, it emits a token stream:

```
Token = { text: string, kind: 'word' | 'assignment' | 'separator' | 'ddash' | 'substitution' | 'unresolved-brace' }
```

- **Word splitting on bash's own default IFS** (space/tab/newline), not JavaScript's `\s` — this is already correct in `safeRmTarget()`'s `/[ \t\n]+/` split (AC-446.6) and gets promoted from one rule's local helper to the tokenizer itself, so every rule gets it, not just `recursive-delete`.
- **NUL bytes are deleted, not space-substituted.** Probe evidence (see §4) shows real bash drops an embedded NUL and fuses the surrounding bytes into one token with **no separator inserted**. The current code's space-substitution is a deliberate over-block chosen specifically because a single flat string had to serve two different consumers (flag-cluster scanning and target-splitting) with one substitution. A tokenizer doesn't have that constraint — see §4.
- **Environment-assignment prefixes are recognised and skipped when locating the verb.** Verified (`probe2`, below): `TERM=xterm rm -rf dist` — the shell consumes `TERM=xterm` as an assignment *before* invoking `rm`; it is never in `rm`'s argv at all.

  ```
  $ rm() { printf 'ARGV[%d]=[%s]\n' "$#" "$*"; printf '[%s]\n' "$@"; }; TERM=xterm rm -rf dist
  ARGV[2]=[-rf dist]
  [-rf]
  [dist]
  ```

  A token matching `^[A-Za-z_][A-Za-z0-9_]*=` occurring before the first non-assignment word is classified `assignment`, not `word`; the **verb is the first `word` token**, found by exact token match (`token.text === 'rm'`), never by substring search over the raw command text.
- **`--` is a structural token (`ddash`), not a dash-prefixed word.** Verified: `rm -- -rf target` really does deliver `--`, `-rf`, and `target` as three unmangled argv entries — `-rf` is not re-interpreted as flags after `--`.

  ```
  $ printf '[%s]\n' rm -- -rf target
  [rm]
  [--]
  [-rf]
  [target]
  ```

  Because classification is **one shared pass over one token stream**, "does this token count as a flag" is answered once, for every rule, as: *a token starting with `-` is a flag unless a `ddash` token has already been seen earlier in the same segment*. There is no second, independently-authored regex pass that could fall out of sync with the first — see §3's answer to #456.
- **`$(...)` / backtick spans are opaque substitution tokens**, not raw text a flag-scanner walks character-by-character. Verified: a flag-shaped string generated *inside* a substitution's own inner command never becomes a top-level flag to the outer command in real bash — `rm -rf "$(echo -x)" safe-target` hands `rm` the argv `[-rf, -x, safe-target]`, where `-x` is the substitution's **output**, delivered as one ordinary word, not parsed as a second `-x` flag by `rm` itself. The point for the tokenizer is narrower and simpler: it must not let the *characters inside* an unterminated `$(...)`/backtick span leak into a flag-cluster scan of the *outer* command, the way a raw `command.match(/-[a-zA-Z]+/g)` over the whole string does today (#449's exact bug). Recognising the span and treating it as one opaque `substitution` token closes that without attempting to parse the substitution's own contents.

### What the tokenizer explicitly refuses to model, and why

- **Brace expansion.** #448's own findings (eight defects across five review rounds, ending in a **4.65s ReDoS** through the real hook entry point on a 74-byte input) are a direct, already-paid-for lesson: enumerating expansions has an unbounded cost on *both* sides — generating the candidates and the cost every rule then pays scanning them — and no per-call budget is safe against a sufficiently deep nested-group construction. The tokenizer does not expand braces. It recognises brace-group *syntax* (`{a,b}`, `{a..b}`, `{a..b..c}`) touching a token that participates in flag classification and marks that token `unresolved-brace` instead. See §3 for how rules use that classification.
- **Globs** (`*`, `?`, `[...]`). Filesystem-dependent; none of the six sibling tickets are about a glob completing a flag, and the same conservative pattern (mark unresolved rather than expand) is available later if one shows up.
- **Filesystem-backed path resolution** (symlinks, cwd-relative resolution, mounted paths). See §2 — kept out of the tokenizer entirely so `check()` stays synchronous with zero syscalls, which is a real, already-stated constraint (`docs/spikes/2026-08-12-agy-approval-semantics.md`'s AC-428 finding: the hook has a **10-second fail-open timeout** at the agy host, so it "must stay trivially fast").
- **Variable *value* substitution** (`$FOO` → its runtime value). The hook has no execution environment to consult. `$TMP`/`$TEMP` are recognised as opaque `word` tokens whose *literal text* is matched, exactly as today — no regression, but stated here as a refusal rather than left implicit.
- **Full recursive re-parsing of nested substitutions' own inner grammar.** The tokenizer treats `$(...)` as one opaque span (bounded by matching parens/backtick, single pass, no recursion into its own tokenizing rules) — enough to stop it leaking into the outer scan (#449), not a second parser instance.

## 2. Path-resolution scope for #451's `..` case

Three options, evaluated rather than defaulted:

**(a) Refuse to judge — block any target containing `..`.** Zero new surface, but a real false-positive cost: `rm -rf ../build` from a subdirectory, or any monorepo script that legitimately walks upward, gets blocked outright. Given the owner's repeated AC.2-style framing across every #446 escalation ("a false positive here breaks the delivery loop and trains people to route around the guard"), a blanket `..`-block is a real, not hypothetical, cost.

**(b) Lexical normalisation — resolve `.`/`..` as pure string algebra, no filesystem access.** Verified directly against Node's own `path.posix.normalize` (no shell involved, but this is exactly the algorithm bash's own path handling — and any correct lexical resolver — must implement, and it requires no bash verification because it's pure string algebra, not shell parsing):

  ```
  $ node -e "console.log(require('path').posix.normalize('dist/../../prod-secrets'))"
  ../prod-secrets
  ```

  `dist/../../prod-secrets` normalises to `../prod-secrets` — a target that (1) no longer contains `dist` as its leading component at all, and (2) starts with `..`, i.e. it provably escapes upward past wherever it was anchored. A judge rule of "after lexical normalisation, if the target still starts with `..`, or its new leading component is not itself a recognised safe root, block" closes #451's exact reproduction with **no filesystem access, no new failure mode, and no change to any currently-safe case** — `packages/app/dist` (AC-446.2) has no `..` in it, so normalisation is a no-op and it stays unblocked.

  Cost, stated honestly: lexical normalisation cannot see that a component is a **symlink**. If `dist` were a symlink pointing somewhere else entirely, `dist/../real-target` normalises (lexically, correctly by string rules) to a path that "stays under dist," while the real filesystem would actually delete through the symlink into unrelated territory. This is a genuine residual gap — but it requires an attacker (or a pre-compromised environment) to have **already planted** a symlink under a name this rule trusts, which is a materially higher bar than typing a literal `..` in a command, and is outside this guard's own stated threat model (a tripwire against an agent typing an obviously-bad *literal* command — see the recommendation in §6 for why that threat model matters to the whole call).

**(c) Real filesystem resolution** (`fs.realpathSync`, using `payload.cwd`). Closes the symlink gap in (b), but at a real architectural cost: a synchronous fs syscall per delete target on **every single Bash tool call in the session** (this hook runs unconditionally), a new failure mode (permission-denied, broken symlink components, cross-platform path quirks already flagged elsewhere in this repo for Windows MAX_PATH), a TOCTOU race between judgment time and execution time, and — most concretely — it breaks the property every comment in `denylist.mjs` currently guarantees: `check()` is pure, synchronous, and side-effect-free, importable with zero side effects by `agy-deny.mjs`. Adding a syscall per call is exactly the kind of change the agy spike's own finding warns against ("the hook script must stay trivially fast... so the 10-second, fail-open timeout is never realistically hit" — a slow network-mounted `cwd`, WSL2 interop, or a stalled drive turns this into the fail-open case the guard exists to avoid).

**Decision: (b), lexical normalisation.** It is the only option that closes #451's actual reported case, costs nothing in new failure surface or false positives on the existing corpus, and respects the hard synchronous/fast constraint the guard already operates under. The symlink gap in (b) is accepted and stated plainly rather than glossed over — it is a narrow, low-probability gap given the guard's own stated role as a tripwire, not a security boundary (§6 returns to this).

## 3. Subsumption matrix

| Ticket | Verdict | Evidence |
| --- | --- | --- |
| **#451** (`..` traversal) | **Closed** | `dist/../../prod-secrets` → lexical-normalise → `../prod-secrets` → starts with `..` → blocked. No regression: every AC-446.2 safe case has no `..`, normalisation is a no-op. |
| **#454** (unanchored `indexOf` finds the wrong `rm`) | **Closed** | Tokenizer locates the verb as "the first `word` token after skipping `assignment` tokens", not by `c.indexOf('rm')`. `TERM=xterm rm -rf dist` tokenizes to `[assignment:TERM=xterm, word:rm, word:-rf, word:dist]` — `xterm`'s embedded "rm" substring is never scanned as text at all, because the assignment prefix is consumed as its own token, matching what real bash actually does (probe2: `TERM=xterm` never reaches `rm`'s argv in the first place). |
| **#456** (`--` end-of-options false positive) | **Closed** | `--` is a structural `ddash` token; flag/target classification is **one shared, token-position-aware pass**, not two independently hand-maintained regexes (one `--`-aware on the target half since #450, one not, on the detection half). There is structurally no way to reproduce the asymmetry #456 names, because there's only one classification stage left to be inconsistent with itself. |
| **#449** (`shortFlagCluster` subshell awareness) | **Closed** | `$(...)`/backtick spans are opaque `substitution` tokens; a flag-cluster classifier reading the *token stream* cannot see characters inside a span it never tokenized as `word`s. This is a structural fix, not a case-by-case guard — the bug class (`command.match(/-[a-zA-Z]+/g)` over raw text) cannot recur once no rule scans raw text directly. |
| **#452** (raw NUL defeats 4 rules; two candidate fixes mutually exclusive) | **Closed, as a package with #451's target judge — not by tokenization alone.** | See §4. The *mutual-exclusivity artifact* dissolves under tokenization. The flag-cluster bypass (`-r<NUL>f`) closes outright. The NUL-onto-safe-target splice (`AC-446.6`'s exact regression case) only stays closed if the safe-target judge is *also* upgraded per §2 — tokenization alone is not sufficient for that one sub-case. |
| **#448** (brace expansion completes an unspoken flag) | **Partially closed — structural direction is right, needs its own scoping/test pass, not a free ride.** | The tokenizer marks a brace-syntax-adjacent token `unresolved-brace` instead of expanding (see §1's refusal). A judge rule of "cannot certify a flag-adjacent unresolved token is safe → treat the segment as if the flag were present" closes the **bypass** direction (`--forc{e,}` no longer slips through, because the tokenizer refuses to vouch for it) without ever enumerating expansions, so #448's own ReDoS class (finding 8) cannot recur — there is no generation step to blow up. It is **not** full parity with real expansion (a brace group in an *unrelated* argument position, e.g. a commit message, must not trigger this — the design has to scope "adjacent to a flag position" narrowly enough not to blanket-flag `query='mutation{...}'`-style prose, #85's pinned case), and that scoping is real implementation work this spike does not do. Marked partial for that reason. |

**Count: 3 cleanly closed (#454, #456, #449) + 2 closed as a matched pair (#451, #452) + 1 partially closed needing its own scoping (#448) = all six sibling tickets meaningfully addressed by one coherent model, none left fully open.**

## 4. #452's mutual exclusivity — does it dissolve under tokenization?

**Yes, as a forced-choice artifact — but the specific AC-446.6 regression case needs pairing with §2, not tokenization alone.** Evidence:

The current mutual exclusivity exists because ONE global text substitution (`normalizeShellText()`'s NUL handling) has to produce ONE output string that TWO different downstream consumers then scan differently — a whitespace-sensitive word/flag splitter, and a path-component matcher. Mapping NUL → space serves the second consumer (keeps `AC-446.6`'s target-splice case blocked) but breaks the first (a space is a non-letter, so it fractures `-r<NUL>f`'s flag cluster exactly as the raw byte did). Deleting the NUL (bash's real behaviour) serves the first consumer but changes what the second sees.

A tokenizer removes the forced choice because tokenization happens **once**, faithfully reproducing what bash actually does (delete, don't space), and *both* downstream judges then read the *same, correct* token:

```
$ { printf 'rm -r\x00f /tmp/should-not-run\n'; } | bash -c 'while IFS= read -r line; do printf "GOT: [%s]\n" "$line"; done'
GOT: [rm -rf /tmp/should-not-run]
```
The flag cluster fuses to the intact, correct `-rf` — the tokenizer reads this token exactly as `-rf`, closing the flag-cluster bypass outright (probe3, confirmed against three independent NUL placements).

```
$ { printf "rm -rf '/prod-secrets\x00/scratchpad'\n"; } | bash -c '...'
GOT: [rm -rf '/prod-secrets/scratchpad']

$ { printf "rm -rf '/prod-secrets\x00scratchpad'\n"; } | bash -c '...'   # no slash before the NUL
GOT: [rm -rf '/prod-secretsscratchpad']
```
This is the subtle part. When the NUL sat right before a `/`, deletion fuses to a **real, legitimate path** `/prod-secrets/scratchpad`, where `scratchpad` genuinely is the trailing path component — because that's what bash itself actually does with that byte sequence. Whether **that fused, real path** should be treated as safe is no longer a NUL-handling question at all; it is exactly the same question §2 answers for `#451` — does the safe-target judge trust *any* occurrence of a safe basename as a trailing component (today's behaviour, which would exempt this), or does it require the path to actually be rooted under a recognised safe prefix once resolved? Under the current component-anywhere heuristic, a real, tokenizer-faithful reconstruction of this command **would** re-open `AC-446.6`'s specific pinned case (`/prod-secrets<NUL>/scratchpad` staying blocked) — not because tokenization failed, but because it correctly stopped hiding the fact that `/prod-secrets/scratchpad` was *always* exemptable by the existing heuristic, NUL or no NUL. Pairing the tokenizer with a resolution-aware judge (lexically normalise, then require the *resolved* target's rooting to match a recognised safe prefix, not merely its trailing basename) closes it for real, because `/prod-secrets/scratchpad`'s leading component `prod-secrets` is not itself a recognised safe root.

When there was **no** slash before the NUL, deletion fuses to `/prod-secretsscratchpad` — no component boundary at all, so even today's plain component-anchored rule already blocks it. That case was never actually mutually exclusive; only the slash-adjacent placement is.

**Conclusion:** the *mechanism* that produced the mutual-exclusivity finding (one substitution, two incompatible consumers) is closed by tokenization. The flag-cluster class of #452 is closed outright. The target-splice class needs the same path-resolution upgrade #451 needs — which this design already proposes — so #452 is closed **as a package**, not as a free side effect of tokenizing alone. That nuance is worth stating precisely rather than claiming a clean win.

## 5. Migration plan — no big-bang swap

The external contract (`check(command: string): { blocked, rule?, msg? }`, and `handle(payload, appendFn)`) is imported directly by `agy-deny.mjs` and this hook's own `main()` and must not change shape. Proposed phasing, matching the per-ticket, adversarially-reviewed round discipline already proven on this file (#437, #446, #450):

1. **Phase 1 — tokenizer module alone, zero behaviour change.** Land `plugin/scripts/lib/shell-tokenize.mjs` (following the existing `shell-split.mjs` precedent: small, pure, side-effect-free, its own unit tests validated against real bash the way this spike's probes are) as dead code — imported by nothing in `denylist.mjs` yet. Independently reviewable, independently mergeable, zero risk to the shipped guard.
2. **Phase 2 — port `recursive-delete` first**, since it is the rule every one of #451/#452/#454/#456 touches, plus #449's `shortFlagCluster` reuse. The **regression corpus is the existing `AC-429.*`, `AC-437.*`, `AC-446.*`, `AC-450.*` describe blocks** in `tests/hooks/denylist.test.mjs` (already ~90 pinned cases across those four blocks) — every one must pass unmodified, same input strings and expected verdicts, before this phase ships, plus new cases for #451/#452/#454/#456's own reproductions from their ticket bodies. Same "confirmed to fail against pre-fix code" discipline #437/#446/#450 already established.
3. **Phase 3 — port `force-push` / `env-branch-delete` / `hard-reset` / `git-clean-force`.** These already share `shortFlagCluster()`/`abbrev()`/`longFlag()`, so the token-based equivalents can share the same way.
4. **Phase 4 — retire the raw-text scanning paths** (`normalizeShellText()`'s role narrows to feeding the tokenizer; the ad hoc `shortFlagCluster()`/`safeRmTarget()` helpers are replaced by tokenizer-consuming equivalents) once every rule is ported and nothing still consumes the flat string.

Each phase is its own PR, sized the way every successfully-shipped round on this file has been sized — not the single, ever-expanding branch that produced #446's two escalations.

## 6. Recommendation

**Proceed, but scoped to Phase 1 only as a filed ticket right now — not a commitment to the full rewrite up front.**

Weighed honestly, both directions:

**For proceeding:** the subsumption matrix is real leverage, not manufactured — one coherent model addresses all six sibling tickets (three cleanly, two as a matched pair, one partially), each justified with a concrete, evidenced example, not a hand-wave. The pattern behind #446's four rounds and two escalations — round *N*'s fix creating round *N+1*'s new critical, twice — is a classic sign of a wrong abstraction (regex-over-text) rather than insufficient care patching it; more patching on the same model is likely to keep finding new spellings, exactly as #451's own diagnosis predicted and as #448/#449 (both filed as "not fixed inline, needs its own ticket" for scope reasons, not because the underlying gap was fake) already illustrate. A tokenizer is also a bounded, single-pass, independently-testable unit — unlike brace expansion, it does not have an exponential-cost failure mode, so it doesn't repeat #448's own cautionary story.

**Against proceeding (weighed, not dismissed):** this guard **fails open** on agy's hook timeout (`docs/spikes/2026-08-12-agy-approval-semantics.md`, confirmed empirically) and its own file header says outright it is "a tripwire for a few known-catastrophic commands, not a security boundary." And **no host currently auto-approves any of the six commands these tickets are about** — `rm` is absent from `ALLOWED_COMMAND_PREFIXES` (`plugin/scripts/lib/allowed-commands.mjs`) entirely, and while plain `git push` *is* allowlisted, its dangerous spellings (`--force`, `-D`, etc.) are still gated by the denylist regardless of the allowlist (`AC-429.3`'s pinned precedence test) — so every bypass in #451/#452/#448, and every false positive in #454/#456/#449, still requires a human already looking at the literal command text at an approval prompt before anything runs. Investing a multi-phase rewrite in hardening a component that is explicitly *not* the security boundary has a real opportunity cost against backlog items that touch one.

**The resolution:** those two positions are not actually in conflict once the work is phased the way §5 lays out. Phase 1 (the tokenizer module) is small, bounded, reviewable in isolation, and creates **zero exposure** either way — it changes nothing about what the guard currently catches or misses. It is exactly the kind of low-cost, high-optionality first step that respects "this is a tripwire, don't over-invest" while still capturing the real leverage the subsumption matrix demonstrates. Committing to Phases 2–4 (the actual bug-closing work) *before* Phase 1's real cost is known would repeat #446's own mistake — sizing a piece of work by projection instead of evidence. This spike does not manufacture a rewrite to justify itself: it recommends the one slice of the rewrite that costs almost nothing and leaves every later phase as an open, evidence-informed decision rather than a foregone conclusion.

**Filed: #457** — "denylist: build a real argv tokenizer (Phase 1 of tokenize-then-judge) — spike #451 follow-up", child of #182, Phase 1 only, explicitly **not** closing any of #451/#452/#454/#456/#448/#449. Those six tickets stay open; whoever picks up #457's follow-on work (Phase 2 onward) should re-read this matrix and re-verify each ticket's example against the real tokenizer output before claiming any of them closed.

## Sources

- `plugin/hooks/denylist.mjs` — current `normalizeShellText()`, `safeRmTarget()`, `shortFlagCluster()`, `SAFE_RM_TARGET`, and the full `RULES` set this design replaces incrementally.
- `plugin/scripts/lib/shell-split.mjs` — the existing shared, pure, side-effect-free module this design's `shell-tokenize.mjs` follows as precedent.
- `plugin/scripts/lib/allowed-commands.mjs` — `ALLOWED_COMMAND_PREFIXES` (confirms `rm` is absent; `git push` present but argument-sensitive elsewhere), cited in §6.
- `tests/hooks/denylist.test.mjs` — `AC-429.*`, `AC-437.*`, `AC-446.*`, `AC-450.*` describe blocks, the regression backbone for §5.
- Issues **#451**, **#452**, **#454**, **#456**, **#448**, **#449** — each ticket's own reproduction and acceptance criteria, read in full; **#446**'s two escalations (`esc-446-msqfnq7f`, `esc-446-msqh7snx`), including the mutual-exclusivity table §4 evaluates.
- `docs/spikes/2026-08-12-agy-approval-semantics.md` — the fail-open-at-10s-timeout finding and the guard's tripwire-not-boundary framing, both load-bearing for §2 and §6.
- Probe scripts `probe1_traversal.sh`, `probe2_argv_semantics.sh`, `probe3_nul_fuse.sh` (GNU bash 5.3.15, Cygwin), run from a scratch dir outside the repo, not included in this branch; raw output quoted inline above.
