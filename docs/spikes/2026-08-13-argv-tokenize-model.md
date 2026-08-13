# Spike — tokenize-then-judge for the denylist hook: does one argv model retire six sibling tickets? (#451)

**Date:** 2026-08-13 · **Ticket:** #451 (parent #182) · **Route:** spike (deliverable = this findings doc; **no production-source changes** — `plugin/hooks/denylist.mjs` is untouched by this branch).

## The question

`#451`'s own diagnosis, carried over from the `#446` escalation, is that `plugin/hooks/denylist.mjs`'s rules "ask text questions about argv semantics" instead of structural ones — and that every patch round closes one spelling of that mistake and reveals another. Four PRs in two days (#439, #445, #453, #455), four adversarial rounds plus two escalations on #446 alone, and six filed sibling tickets (#451, #452, #454, #456, #448, #449) are the evidence for that claim. This spike does not assume the diagnosis is right — it designs the alternative (**tokenize the command into argv the way a real shell would, then let rules ask structural questions of the tokens**) and tests it against all six tickets, one at a time, with evidence.

## Grounding methodology

Every tokenization/argv claim below was verified against a real `bash -c`/`read` session, run from a script file under a scratch dir outside the repo (`C:/Users/dngioi/AppData/Local/Temp/claude/C--mywp-forge/451-spike/`, not part of this branch), per the discipline #446/#437 established. Shell: GNU bash 5.3.15 (Cygwin), the same interpreter class `denylist.mjs`'s own comments are written against. **Seven probes** — the last four written *after* the adversarial reviews, to test their findings rather than argue with them:

- `probe1_traversal.sh` — does bash resolve `..` before argv is built, and how does lexical (no-filesystem) normalisation compare to real (`realpath`) resolution.
- `probe2_argv_semantics.sh` — env-var-assignment prefixes (#454), POSIX `--` (#456), command-substitution token boundaries (#449), and NUL delivery over a live bash session (#452).
- `probe3_nul_fuse.sh` — the exact NUL-splice shapes from #446/#452's own test cases, to settle whether deleting (bash's real behaviour) vs. spacing (the current code's behaviour) changes the outcome.
- `probe4_nested_subshell.sh` — #449's own named boundary cases (nested `$()`, quoted subshells, a literal `)` inside a quoted string inside a substitution, backtick and mixed forms, an unterminated `$(`). **Added after adversarial review** correctly flagged that probes 1–3 did *not* cover the boundary cases #449's ticket explicitly asks for. Its results **changed this spike's verdict on #449** — see §3.
- `probe5_symlink_midword.sh` — whether this repo's `node_modules` is genuinely symlink-based (it is: pnpm), how `..` after a symlink component resolves, and whether a command substitution fused mid-word yields an intact flag in real argv. Added after adversarial review refuted §2's original "an attacker would have to plant a symlink" framing; grounds the corrected §2 and the discovery in §3.
- `probe6_check.mjs` — drives the working tree's own `check()` directly (not bash) over the cases the other probes raised, to separate "what bash does" from "what the guard currently decides". Grounds §3's new live bypass (#459) and §4's claims about `AC-446.1`/`AC-446.6`, which are claims about the *guard*, not about bash.
- `probe7_separating_rule.mjs` — extracts the single-quoted literal `rm` commands from the pinned corpus in `tests/hooks/denylist.test.mjs` (39 occurrences / 31 unique — see §4 for the exact scope and its independent corroboration over a larger superset) and diffs the current safe-target rule against the absolute-strict variant over their targets. Written in round 2 to check a security-review claim before adopting it; it confirmed the claim (0 divergences) **and** turned up the cost the review had not stated (§4).

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
- **`$(...)` / backtick spans are opaque substitution tokens**, not raw text a flag-scanner walks character-by-character. Verified: a flag-shaped string generated *inside* a substitution's own inner command never becomes a top-level flag to the outer command in real bash — `rm -rf "$(echo -x)" safe-target` hands `rm` the argv `[-rf, -x, safe-target]`, where `-x` is the substitution's **output**, delivered as one ordinary word, not parsed as a second `-x` flag by `rm` itself. The point for the tokenizer is narrower and simpler: it must not let the *characters inside* a `$(...)`/backtick span leak into a flag-cluster scan of the *outer* command, the way a raw `command.match(/-[a-zA-Z]+/g)` over the whole string does today (#449's exact bug). Recognising the span and treating it as one opaque `substitution` token closes that without attempting to parse the substitution's own contents.

  **Span-termination is the hard part, and it is not "scan to the first `)`".** #449's ticket explicitly asks for the nested and quoted boundary cases to be verified, and `probe4` shows why — a naive first-`)` terminator is wrong in two independent ways:

  ```
  $ printf '[%s]\n' rm -rf "$(echo "a$(echo -n b)c")" safe-target
  [rm] [-rf] [abc] [safe-target]           # nested $( ) — outer span ends at the SECOND )

  $ printf '[%s]\n' rm -rf "$(echo ')')" safe-target
  [rm] [-rf] [)] [safe-target]             # a literal ) inside a QUOTED string inside the span
  ```

  So correct span detection requires **both** paren-depth tracking *and* quote-awareness inside the span — a first-`)` terminator closes the second case early and spills the remainder of the line back into the outer scan as raw text, which is precisely the #449 bug reintroduced by the fix meant to close it. This is the same shape of mistake that cost this file two review rounds on `normalizeShellText()`'s `\c` lookahead (see its in-file comment: "guarding case by case was losing"). Also note `probe4` case 3: a **quoted** substitution's output stays one word while an **unquoted** one is word-split by bash — so the span's quoting context, not just its extent, affects tokenization. And an **unterminated** `$(` (which real bash refuses to run at all, but which the hook can still be handed as text) must have a defined, safe outcome rather than an unbounded scan. None of this is unbounded or recursive work — it is one pass with a depth counter and a quote flag — but it is real, must-be-tested work, and §3 downgrades #449's verdict accordingly rather than treating "treat the span as opaque" as self-executing.

### What the tokenizer explicitly refuses to model, and why

- **Brace expansion.** #448's own findings (eight defects across five review rounds, ending in a **4.65s ReDoS** through the real hook entry point on a 74-byte input) are a direct, already-paid-for lesson: enumerating expansions has an unbounded cost on *both* sides — generating the candidates and the cost every rule then pays scanning them — and no per-call budget is safe against a sufficiently deep nested-group construction. The tokenizer does not expand braces. It recognises brace-group *syntax* (`{a,b}`, `{a..b}`, `{a..b..c}`) touching a token that participates in flag classification and marks that token `unresolved-brace` instead. See §3 for how rules use that classification.
- **Globs** (`*`, `?`, `[...]`). Filesystem-dependent; none of the six sibling tickets are about a glob completing a flag, and the same conservative pattern (mark unresolved rather than expand) is available later if one shows up.
- **Filesystem-backed path resolution** (symlinks, cwd-relative resolution, mounted paths). See §2 — kept out of the tokenizer entirely so `check()` stays synchronous with zero syscalls, which is a real, already-stated constraint (`docs/spikes/2026-08-12-agy-approval-semantics.md`'s AC-428 finding: the hook has a **10-second fail-open timeout** at the agy host, so it "must stay trivially fast").
- **Variable *value* substitution** (`$FOO` → its runtime value). The hook has no execution environment to consult. `$TMP`/`$TEMP` are recognised as opaque `word` tokens whose *literal text* is matched, exactly as today — no regression, but stated here as a refusal rather than left implicit.
- **Full recursive re-parsing of nested substitutions' own inner grammar.** The tokenizer treats `$(...)` as one opaque span, found by a single pass that tracks paren depth and quote state (per the probe evidence above) but never recurses into the span's contents to tokenize them as their own command. That is enough to stop the span leaking into the outer scan (#449); it is not a second parser instance, and it deliberately does not attempt to judge what the substitution would evaluate to.

## 2. Path-resolution scope for #451's `..` case

Three options, evaluated rather than defaulted:

**(a) Refuse to judge — block any target containing `..`.** Zero new surface, but a real false-positive cost: `rm -rf ../build` from a subdirectory, or any monorepo script that legitimately walks upward, gets blocked outright. Given the owner's repeated AC.2-style framing across every #446 escalation ("a false positive here breaks the delivery loop and trains people to route around the guard"), a blanket `..`-block is a real, not hypothetical, cost.

**(b) Lexical normalisation — resolve `.`/`..` as pure string algebra, no filesystem access.** Verified directly against Node's own `path.posix.normalize` (no shell involved, but this is exactly the algorithm bash's own path handling — and any correct lexical resolver — must implement, and it requires no bash verification because it's pure string algebra, not shell parsing):

  ```
  $ node -e "console.log(require('path').posix.normalize('dist/../../prod-secrets'))"
  ../prod-secrets
  ```

  `dist/../../prod-secrets` normalises to `../prod-secrets` — a target that (1) no longer contains `dist` as a component at all, and (2) starts with `..`, i.e. it provably escapes upward past wherever it was anchored.

  **The judge rule, stated precisely — and a stronger variant explicitly rejected.** The rule is: *lexically normalise the target first, then apply the **existing** component-anchored `SAFE_RM_TARGET` test to the normalised result, and additionally block when the normalised path still begins with `..`.* Nothing about the existing per-component semantics changes; normalisation only ensures the test is applied to what the path actually denotes. `dist/../../prod-secrets` → `../prod-secrets` → no safe component **and** escapes upward → blocked. `packages/app/dist` → normalisation is a no-op → `dist` still matches as a whole component → stays allowed, exactly as `AC-446.1` pins it.

  An earlier draft of this section instead proposed *"...or its new **leading** component is not a recognised safe root, block."* **That variant is wrong and is rejected here**, because adversarial review correctly caught that it contradicts a pinned test the doc had not cited: `AC-446.1` (`tests/hooks/denylist.test.mjs:300-306`) deliberately pins `rm -rf packages/app/dist` and `rm -rf ~/project/node_modules` as **allowed**, on the stated principle that anchoring is per-component, *not* top-level. Both have a non-safe leading component (`packages`, `~`), so the leading-component rule would block them — a large new false-positive class across every nested build/temp directory in the repo, in a file whose entire AC.2 tradition is that false positives train people around the guard. Recording the rejected variant rather than quietly deleting it, because it is the natural rule to reach for and the next person will reach for it too. It also has a second consequence, which turns out to matter more than the false positives — see §4.

  Cost, stated honestly: lexical normalisation cannot see that a component is a **symlink**. If `dist` were a symlink pointing elsewhere, `dist/../real-target` normalises (correctly, by string rules) to a path that "stays under dist," while the kernel's own path walk resolves `..` against the symlink's *real* parent and lands somewhere else.

  An earlier draft called this gap narrow on the grounds that it "requires an attacker to have already planted a symlink under a name this rule trusts." **Adversarial review refuted that, and the refutation is confirmed against this very repo:** it is pnpm-managed, and pnpm's `node_modules` layout is symlink-based *by default* — no attacker required.

  ```
  $ ls -la node_modules | grep '^l'
  ts-morph -> /c/mywp/forge/node_modules/.pnpm/ts-morph@28.0.0/node_modules/ts-morph
  vitest   -> /c/mywp/forge/node_modules/.pnpm/vitest@4.1.10_vite@7.3.6/node_modules/vitest
  ```

  `node_modules` is on the safe list, so the "symlink under a trusted name" precondition is satisfied by ordinary tooling on a clean checkout. A target like `node_modules/<pkg>/../<sibling>` gets a computed "safe" verdict from the lexical judge while its real deletion resolves through the store — and note option **(a)** would have blocked that outright, since the literal text contains `..`. So for this specific shape, (b) is genuinely *weaker* than (a). That is a real cost of the recommended option, not a footnote, and it is why §6 does not treat the traversal class as settled by this decision alone. *(Honest limit on my own evidence: the pnpm symlinks above are directly confirmed in this repo; the physical-vs-lexical `..` divergence is POSIX-specified kernel path-walk behaviour, but I could not demonstrate it directly on this Windows/Cygwin filesystem — `ln -s` in my scratch dir did not produce a symlink the kernel treated as one, so `realpath` there returned the lexical answer. The mechanism is standard and the pnpm precondition is proven; the end-to-end divergence on *this* host is not, and I am not going to claim it is.)*

**(c) Real filesystem resolution** (`fs.realpathSync`, using `payload.cwd`). Closes the symlink gap in (b), but at a real architectural cost: a synchronous fs syscall per delete target on **every single Bash tool call in the session** (this hook runs unconditionally), a new failure mode (permission-denied, broken symlink components, cross-platform path quirks already flagged elsewhere in this repo for Windows MAX_PATH), a TOCTOU race between judgment time and execution time, and — most concretely — it breaks the property every comment in `denylist.mjs` currently guarantees: `check()` is pure, synchronous, and side-effect-free, importable with zero side effects by `agy-deny.mjs`. Adding a syscall per call is exactly the kind of change the agy spike's own finding warns against ("the hook script must stay trivially fast... so the 10-second, fail-open timeout is never realistically hit" — a slow network-mounted `cwd`, WSL2 interop, or a stalled drive turns this into the fail-open case the guard exists to avoid).

**Decision: (b), lexical normalisation — with the symlink gap recorded as a real, non-hypothetical limitation, not a rounding error.** (b) closes #451's actual reported case, preserves every currently-safe case in the pinned corpus (once the judge rule is stated as above rather than as the rejected leading-component variant), and respects the hard synchronous/fast constraint the guard operates under, which (c) cannot. But the honest scorecard is that (b) is *better than (a) overall and worse than (a) on one specific shape* — a `..` traversal through a symlinked component, which pnpm makes ordinary here. That is not "a narrow, low-probability gap"; it is a known-reachable case the recommended option computes a wrong answer for, where the cruder option would have refused. It is accepted because the guard is a tripwire rather than a security boundary and (c)'s costs are disqualifying, not because the gap is small (§6 returns to this).

## 3. Subsumption matrix

| Ticket | Verdict | Evidence |
| --- | --- | --- |
| **#451** (`..` traversal) | **Closed** | `dist/../../prod-secrets` → lexical-normalise → `../prod-secrets` → starts with `..` → blocked. No regression: every AC-446.2 safe case has no `..`, normalisation is a no-op. |
| **#454** (unanchored `indexOf` finds the wrong `rm`) | **Closed** | Tokenizer locates the verb as "the first `word` token after skipping `assignment` tokens", not by `c.indexOf('rm')`. `TERM=xterm rm -rf dist` tokenizes to `[assignment:TERM=xterm, word:rm, word:-rf, word:dist]` — `xterm`'s embedded "rm" substring is never scanned as text at all, because the assignment prefix is consumed as its own token, matching what real bash actually does (probe2: `TERM=xterm` never reaches `rm`'s argv in the first place). |
| **#456** (`--` end-of-options false positive) | **Closed** | `--` is a structural `ddash` token; flag/target classification is **one shared, token-position-aware pass**, not two independently hand-maintained regexes (one `--`-aware on the target half since #450, one not, on the detection half). There is structurally no way to reproduce the asymmetry #456 names, because there's only one classification stage left to be inconsistent with itself. |
| **#449** (`shortFlagCluster` subshell awareness) | **Partially closed — the structural direction is right, but correct span termination is its own must-be-tested sub-problem.** *(Downgraded from "Closed" after adversarial review; see below.)* | The direction is sound and structural: `$(...)`/backtick spans become opaque `substitution` tokens, and a flag-cluster classifier reading the *token stream* cannot see characters inside a span it never tokenized as `word`s — the bug class (`command.match(/-[a-zA-Z]+/g)` over raw text) cannot recur once no rule scans raw text directly. **But** the first draft of this matrix rated it "Closed" on one un-nested, unquoted probe, which is exactly the evidentiary shortfall #449's own ticket warns against ("needs empirical verification against real bash for the boundary cases (nested subshells, quoted subshells)"). `probe4` (added in response) shows a naive first-`)` terminator is wrong twice over — nested `$( … $( … ) … )` needs depth tracking, and `"$(echo ')')"` puts a literal `)` inside a quoted string inside the span, so a depth counter alone still closes it early and spills the rest of the line back into the outer scan as raw text. That failure mode *is* #449, reintroduced by its own fix. Correct termination needs depth **and** quote state, plus a defined outcome for an unterminated `$(`. One pass, bounded, no recursion — but real work with its own bug surface, and this file has already lost two review rounds to precisely this class of terminator bug (`normalizeShellText()`'s `\c` lookahead). Rated partial on the same standard as #448. |
| **#452** (raw NUL defeats 4 rules; two candidate fixes mutually exclusive) | **Split verdict: the flag-cluster bypass closes; the target-splice sub-case does NOT — faithful tokenization actually *regresses* `AC-446.6`, and the obvious fix collides with `AC-446.1`. #452's AC.4 is untouched.** *(Downgraded from "closed as a package" after adversarial review; this is the spike's most consequential correction — see §4.)* | The flag-cluster bypass (`-r<NUL>f`) closes outright: bash deletes the byte and fuses `-rf`, and a faithful tokenizer reads exactly that (probe3). But the NUL-onto-safe-target splice does the same fusing, and there the fused result is a *legitimate* path — `/prod-secrets<NUL>/scratchpad` → `/prod-secrets/scratchpad`, which `check()` **already allows today** (verified: `allowed  "rm -rf /prod-secrets/scratchpad"`). `AC-446.6` only passes at present because the current NUL→space substitution *over-blocks* by splitting the token. A tokenizer that faithfully reproduces bash removes that accident and the pinned test regresses. A rule requiring a safe *leading* component **scoped to absolute paths only** does close it while preserving `AC-446.1` — verified over the pinned corpus with zero divergences, and independently re-derived by the security gate over a larger superset against the real `check()` (§4) — so this is reconcilable at a stated cost (spelling-dependent false positives), not the unsatisfiable conflict an earlier draft of this row claimed. It still needs an owner semantics call before the port, which is why this stays partial rather than closed. See §4. **Scope caveat:** #452 also carries **AC.4** (correcting the "exec layer truncates at the NUL" narrative in `plugin/hooks/denylist.mjs` / `tests/hooks/denylist.test.mjs`) — a documentation item orthogonal to this design and untouched by it. PR #453 already corrected that wording once, so AC.4 needs a re-read against the file as it stands rather than an assumption either way. |
| **#448** (brace expansion completes an unspoken flag) | **Partially closed — structural direction is right, needs its own scoping/test pass, not a free ride.** | The tokenizer marks a brace-syntax-adjacent token `unresolved-brace` instead of expanding (see §1's refusal). A judge rule of "cannot certify a flag-adjacent unresolved token is safe → treat the segment as if the flag were present" closes the **bypass** direction (`--forc{e,}` no longer slips through, because the tokenizer refuses to vouch for it) without ever enumerating expansions, so #448's own ReDoS class (finding 8) cannot recur — there is no generation step to blow up. It is **not** full parity with real expansion (a brace group in an *unrelated* argument position, e.g. a commit message, must not trigger this — the design has to scope "adjacent to a flag position" narrowly enough not to blanket-flag `query='mutation{...}'`-style prose, #85's pinned case), and that scoping is real implementation work this spike does not do. Marked partial for that reason. |

**Count, after adversarial review corrected two of the six: 2 cleanly closed (#454, #456) · 1 closed with a stated residual limitation (#451 — closed for the literal-`..` case it reports, with the pnpm-symlink shape from §2 left open) · 3 partial (#449, #452, #448), each for a *different* reason, none of them "just needs implementing."**

The first draft of this matrix scored 3 clean + 2 paired + 1 partial. That was too generous, and it was too generous in exactly the direction the owner would have acted on. The corrected count is the honest answer to the ticket's question — **one rewrite does not retire six tickets; it cleanly retires two, meaningfully advances three, and surfaces one previously-unrecognised design conflict (§4) that no amount of tokenizing resolves.** That conflict is arguably the single most useful thing this spike found, and it was invisible until the model was specified precisely enough to collide with the existing test corpus.

**One genuinely new bypass found while testing this matrix, not previously filed.** A command substitution fused *mid-word* with flag letters defeats `shortFlagCluster()` today, because its `(?:^|\s)-([a-zA-Z]+)` run stops at the `$`:

```
$ printf '[%s]\n' rm -r$(true)f /tmp/nope     # real bash argv
[rm] [-rf] [/tmp/nope]

$ node -e "…check('rm -r\$(true)f /prod-secrets')…"
allowed        # and the backtick spelling too; `rm -rf /prod-secrets` correctly BLOCKS
```

Real bash delivers an intact `-rf`; the guard sees only `-r` and lets it through. This is a **live bypass on `main`**, pre-existing and unrelated to this branch, and it is a seventh spelling of the same root cause — which is itself evidence for #451's diagnosis. It also constrains the design: a token model where `substitution` is a flat sibling of `word` cannot represent `-r$(true)f` as one word, so the tokenizer must model a substitution *embedded within* a word, not merely adjacent to one. Filed separately (see §6).

## 4. #452's mutual exclusivity — does it dissolve under tokenization?

**Partly. The forced-choice artifact dissolves — but underneath it, tokenization *exposes* a harder conflict that was previously hidden, and that conflict is not a NUL problem at all.** This section was rewritten after adversarial review; the first version claimed a clean "closed as a package," and that claim was wrong. Evidence:

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
This is where it gets interesting. When the NUL sat right before a `/`, deletion fuses to a **real, legitimate path** `/prod-secrets/scratchpad` — that is genuinely what bash does with those bytes. And that path **is already exempt today**, with no NUL involved at all:

```
$ node -e "…check('rm -rf /prod-secrets/scratchpad')…"
allowed
$ node -e "…check('rm -rf packages/app/dist')…"
allowed        # AC-446.1 pins this as REQUIRED behaviour
```

So `AC-446.6`'s pinned guarantee ("a NUL splice cannot exempt the real target") does not currently rest on any semantic understanding of the splice. It rests on the NUL→space substitution *over-blocking* — splitting one real bash argument into two so `/prod-secrets` gets judged alone. **A tokenizer that faithfully reproduces bash removes that accident, and `AC-446.6` regresses.** Not because tokenization is wrong — because tokenization stops hiding that `/prod-secrets/scratchpad` was always exemptable.

**A separating rule does exist — an earlier version of this section said it didn't, and that was wrong.** The claim here was that `/prod-secrets/scratchpad` and `packages/app/dist` are structurally indistinguishable, dismissing absolute-vs-relative on the grounds that `AC-446.1` also pins `~/project/node_modules`. Adversarial review caught the factual error: **`~/project/node_modules` does not begin with `/`.** It begins with `~`, which §1 explicitly refuses to expand, so under the tokenizer's own stated boundaries it sits on the *relative* side of that divide, not the absolute one. With the error corrected, the review's proposed rule works:

> for a target beginning with a literal `/`, the first path component must itself be a recognised safe root; for a relative or `~`-prefixed target, keep the existing per-component (anywhere) match.

I verified this independently rather than taking it on trust — `probe7_separating_rule.mjs` extracts literal `rm` commands from the pinned corpus and diffs the two rules over their targets. **Precise scope of that extraction**, because an earlier phrasing here said "all 39" and implied more completeness than it had: the probe's regex matches only the single-quoted `check('rm …')` form, giving **39 occurrences / 31 unique**; a broader sweep for any literal `rm` string in the file finds 59 / 48 unique. The round-3 security review independently re-derived the same comparison over that *larger* superset and validated it against the real exported `check()` rather than against either reimplementation — same answer. So the result below is corroborated beyond probe7's own extraction, not resting on it.

```
39 literal rm commands extracted (single-quoted check('rm …') form)
0 divergence(s) between current and proposed rule across the pinned corpus.

  "packages/app/dist"          current=allowed  proposed=allowed
  "~/project/node_modules"     current=allowed  proposed=allowed
  "/prod-secrets/scratchpad"   current=allowed  proposed=BLOCKED
```

So `AC-446.1` and `AC-446.6` **can** both be satisfied, and `AC-446.6` survives a faithful tokenizer under this rule. **§4's previous "unconditionally unsatisfiable" conclusion is withdrawn, and §5's Phase-2 gate is downgraded from a blocker to a decision (see below).**

**What survives the correction, stated at its real strength.** Two things, and they are smaller than the withdrawn claim but not nothing:

1. **The proposed rule buys the pinned corpus at the price of spelling-dependence, which the review did not surface and which I found by testing it further.** The verdict starts depending on *how the same directory is written*:

   ```
   "~/project/node_modules"           current=allowed  proposed=allowed
   "/home/user/project/node_modules"  current=allowed  proposed=BLOCKED   <- same directory
   "project/node_modules"             current=allowed  proposed=allowed
   "/var/tmp/build"                   current=allowed  proposed=BLOCKED
   "/c/mywp/forge/dist"               current=allowed  proposed=BLOCKED
   ```

   Nothing in the pinned corpus catches this because the corpus happens to spell its nested-safe-dir cases relatively. But absolute spellings of ordinary build/temp paths are completely normal in scripts and Makefiles, and every one of them starts blocking. That is a new false-positive class in exactly the AC.2 direction this file has been burned by before — not disqualifying, but it makes the rule a **policy tradeoff**, not a free win.

2. **The relative twin stays open, which the review conceded too.** `rm -rf prod-secrets/scratchpad` — no leading slash — is allowed today, is allowed under the proposed rule, and is structurally identical to `packages/app/dist`. Nothing pins it either way. So "a safe word anywhere exempts the path" is still the operative semantics for every non-absolute target.

**Conclusion, corrected.** The mechanism behind #452's *reported* mutual exclusivity genuinely dissolves under tokenization, and the flag-cluster bypass closes outright. `AC-446.6`'s current pass really is an over-block accident — that part stands and is verified. But the two pinned tests are **reconcilable**, at a stated cost, so this is an owner **decision** with at least three live options (keep per-component semantics and accept that `AC-446.6`'s guarantee was never real; adopt the absolute-strict rule and accept the spelling-dependent false positives; or something else), **not** the unsatisfiable conflict claimed a version ago.

Recording the withdrawn claim rather than quietly deleting it, because the reasoning that produced it — "these two paths look the same to any component rule" — is exactly the intuition the next person will have, and the `~`-is-not-`/` detail is what breaks it.

(For completeness: when there was **no** slash before the NUL, deletion fuses to `/prod-secretsscratchpad` — no component boundary at all, so even today's rule blocks it. That placement was never mutually exclusive; only the slash-adjacent one is.)

## 5. Migration plan — no big-bang swap

The external contract (`check(command: string): { blocked, rule?, msg? }`, and `handle(payload, appendFn)`) is imported directly by `agy-deny.mjs` and this hook's own `main()` and must not change shape. Proposed phasing, matching the per-ticket, adversarially-reviewed round discipline already proven on this file (#437, #446, #450):

1. **Phase 1 — tokenizer module alone, zero behaviour change.** Land `plugin/scripts/lib/shell-tokenize.mjs` (following the existing `shell-split.mjs` precedent: small, pure, side-effect-free, its own unit tests validated against real bash the way this spike's probes are) as dead code — imported by nothing in `denylist.mjs` yet. Independently reviewable, independently mergeable, zero risk to the shipped guard.
2. **Phase 2 — port `recursive-delete` first**, since it is the rule every one of #451/#452/#454/#456 touches, plus #449's `shortFlagCluster` reuse. The **regression corpus is the existing `AC-429.*`, `AC-437.*`, `AC-446.*`, `AC-450.*` describe blocks** in `tests/hooks/denylist.test.mjs` (already ~90 pinned cases across those four blocks) — every one must pass unmodified, same input strings and expected verdicts, before this phase ships, plus new cases for #451/#452/#454/#456's own reproductions from their ticket bodies. Same "confirmed to fail against pre-fix code" discipline #437/#446/#450 already established.

   **Decide §4's safe-target question before writing the port — a decision to surface early, not a blocker.** An earlier version of this plan called it a hard prerequisite on the grounds that the two pinned tests were unsatisfiable together; that was withdrawn (§4). They *are* satisfiable, so Phase 2 is not blocked. But a faithful tokenizer changes what `AC-446.6` actually tests, so the port has to pick a semantics deliberately rather than discover one: *when a safe word appears as a non-root component of an otherwise-unrecognised path, is that exempt?* Three live options — keep per-component semantics (and restate `AC-446.6` honestly, since its current guarantee is an over-block artifact); adopt the absolute-strict rule (and accept the spelling-dependent false positives §4 measures); or something else. It is a product call about the guard's contract, so it wants an owner answer up front — but the phase can be planned and scoped without it, and only the final semantics choice depends on it.
3. **Phase 3 — port `force-push` / `env-branch-delete` / `hard-reset` / `git-clean-force`.** These already share `shortFlagCluster()`/`abbrev()`/`longFlag()`, so the token-based equivalents can share the same way.
4. **Phase 4 — retire the raw-text scanning paths** (`normalizeShellText()`'s role narrows to feeding the tokenizer; the ad hoc `shortFlagCluster()`/`safeRmTarget()` helpers are replaced by tokenizer-consuming equivalents) once every rule is ported and nothing still consumes the flat string.

Each phase is its own PR, sized the way every successfully-shipped round on this file has been sized — not the single, ever-expanding branch that produced #446's two escalations.

## 6. Recommendation

**Proceed, but scoped to Phase 1 only as a filed ticket right now — not a commitment to the full rewrite up front.**

Weighed honestly, both directions:

**For proceeding:** the matrix still shows real leverage, though less than the first draft claimed — two tickets close cleanly, one closes with a stated limitation, three are meaningfully advanced (§3). The pattern behind #446's four rounds and two escalations — round *N*'s fix creating round *N+1*'s new critical, twice — is a classic sign of a wrong abstraction (regex-over-text) rather than insufficient care patching it; more patching on the same model keeps finding new spellings, and this spike found a **seventh** one (#459, `rm -r$(true)f`) without looking hard, which is about as direct a confirmation of #451's diagnosis as evidence gets. A tokenizer is also a bounded, single-pass, independently-testable unit — unlike brace expansion, it has no exponential-cost failure mode, so it doesn't repeat #448's cautionary story.

**Against proceeding (weighed, not dismissed):** this guard **fails open** on agy's hook timeout (`docs/spikes/2026-08-12-agy-approval-semantics.md`, confirmed empirically) and its own file header says outright it is "a tripwire for a few known-catastrophic commands, not a security boundary." And **no host currently auto-approves any of the six commands these tickets are about** — `rm` is absent from `ALLOWED_COMMAND_PREFIXES` (`plugin/scripts/lib/allowed-commands.mjs`) entirely, and while plain `git push` *is* allowlisted, its dangerous spellings (`--force`, `-D`, etc.) are still gated by the denylist regardless of the allowlist (`AC-429.3`'s pinned precedence test) — so every bypass in #451/#452/#448, and every false positive in #454/#456/#449, still requires a human already looking at the literal command text at an approval prompt before anything runs. Investing a multi-phase rewrite in hardening a component that is explicitly *not* the security boundary has a real opportunity cost against backlog items that touch one.

**The resolution:** those two positions are not in conflict once the work is phased the way §5 lays out. Phase 1 (the tokenizer module) is small, bounded, reviewable in isolation, and creates **zero exposure** either way — it changes nothing about what the guard currently catches or misses. It respects "this is a tripwire, don't over-invest" while still capturing the leverage the matrix does show. Committing to Phases 2–4 *before* Phase 1's real cost is known would repeat #446's own mistake — sizing work by projection instead of evidence.

**And the adversarial review of this very spike sharpened that recommendation rather than merely surviving it.** Both gates failed the first draft, and both were right: the matrix over-claimed on #449 and #452, and §2's judge rule contradicted a pinned test it hadn't cited. Correcting those did not weaken the case for Phase 1 — it *strengthened* it, by turning up (a) the `AC-446.1`/`AC-446.6` conflict in §4, which is an owner decision that must be made **before** any Phase 2 code is written and which nobody had named before, and (b) a seventh live bypass (#459). Both are pure spike output: findings that cost nothing to produce and would have cost a full patch round each to discover mid-implementation. That is the argument for stopping at Phase 1 and re-deciding with evidence, stated better than the first draft stated it.

**A note on the "don't do it at all" option, since the brief asked for it to be genuinely live:** it remains defensible. Everything in this family reaches a human prompt today, the guard fails open anyway, and closing all seven tickets `wontDo` with the limits documented would be a coherent position. I do not recommend it, for one reason: §4's conflict means the guard's *current* behaviour is not what its own tests claim it is (`AC-446.6` passes by accident). Walking away leaves a test corpus that asserts a guarantee the code does not actually provide — and that misleads the next reader far more than an honestly-documented gap would. At minimum, §4 should be written into the file's comments even if no rewrite ever happens. **That is the one piece of work I would call non-optional**, and it is small.

**Filed:**
- **#457** — "denylist: build a real argv tokenizer (Phase 1 of tokenize-then-judge) — spike #451 follow-up", child of #182. Phase 1 only, explicitly **not** closing any sibling ticket.
- **#459** — the new live bypass found here (`rm -r$(true)f /prod-secrets` is not blocked; a substitution fused mid-word truncates `shortFlagCluster()`'s letter run), child of #182, p2, pre-existing on `main`.

The six sibling tickets stay open. Whoever picks up Phase 2 must first get §4's `AC-446.1`/`AC-446.6` question decided by the owner, then re-verify each ticket's own example against the real tokenizer output before claiming any of them closed — this matrix is a design prediction, not a test result.

## Sources

- `plugin/hooks/denylist.mjs` — current `normalizeShellText()`, `safeRmTarget()`, `shortFlagCluster()`, `SAFE_RM_TARGET`, and the full `RULES` set this design replaces incrementally.
- `plugin/scripts/lib/shell-split.mjs` — the existing shared, pure, side-effect-free module this design's `shell-tokenize.mjs` follows as precedent.
- `plugin/scripts/lib/allowed-commands.mjs` — `ALLOWED_COMMAND_PREFIXES` (confirms `rm` is absent; `git push` present but argument-sensitive elsewhere), cited in §6.
- `tests/hooks/denylist.test.mjs` — `AC-429.*`, `AC-437.*`, `AC-446.*`, `AC-450.*` describe blocks, the regression backbone for §5; **`AC-446.1` at `:300-306`** and **`AC-446.6` at `:442-456`** specifically, the two pinned tests §4's conflict is between.
- Issues **#451**, **#452**, **#454**, **#456**, **#448**, **#449** — each ticket's own reproduction and acceptance criteria, read in full; **#446**'s two escalations (`esc-446-msqfnq7f`, `esc-446-msqh7snx`), including the mutual-exclusivity table §4 evaluates. Filed by this spike: **#457** (Phase 1 tokenizer), **#459** (the new mid-word-substitution bypass).
- `forge:reviewer` and `forge:security` adversarial reviews of this spike's first draft (2026-08-13, isolated worktrees at tip `a3d1fb8`) — both returned **fail**; their findings drove the corrections to §1's span-termination requirement, §2's judge rule and symlink framing, §3's #449 and #452 verdicts, and §4's rewritten conclusion. Recorded here because the corrections changed the spike's answer, not just its wording.
- `docs/spikes/2026-08-12-agy-approval-semantics.md` — the fail-open-at-10s-timeout finding and the guard's tripwire-not-boundary framing, both load-bearing for §2 and §6.
- Probe scripts `probe1_traversal.sh`, `probe2_argv_semantics.sh`, `probe3_nul_fuse.sh`, `probe4_nested_subshell.sh`, `probe5_symlink_midword.sh` (GNU bash 5.3.15, Cygwin), plus `probe6_check.mjs` and `probe7_separating_rule.mjs` (both drive the working tree's own `check()`/rule logic directly) — run from a scratch dir outside the repo, not included in this branch; raw output quoted inline above. Probes 4–7 were written *after* the adversarial reviews, to test their findings rather than argue with them; probe7 both confirmed a review claim and found the cost that claim omitted.
