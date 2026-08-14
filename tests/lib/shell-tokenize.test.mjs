import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../plugin/scripts/lib/shell-tokenize.mjs';

const TOKENIZER_PATH = fileURLToPath(new URL('../../plugin/scripts/lib/shell-tokenize.mjs', import.meta.url));
const DENYLIST_PATH = fileURLToPath(new URL('../../plugin/hooks/denylist.mjs', import.meta.url));
const VALID_KINDS = ['word', 'assignment', 'separator', 'ddash', 'substitution', 'unresolved-brace'];

/** Drop `separator` tokens — most assertions below only care about the rest. */
const nonSep = (tokens) => tokens.filter((t) => t.kind !== 'separator');

describe('tokenize() — AC-457.1: exported Token shape', () => {
  it('AC-457.1: every token is { text: string, kind: one of the six named kinds }', () => {
    const tokens = tokenize('TERM=xterm rm -- -rf "$(echo -x)" dist{a,b} `echo y`');
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(typeof t.text).toBe('string');
      expect(VALID_KINDS).toContain(t.kind);
      expect(Object.keys(t).sort()).toEqual(['kind', 'text']);
    }
  });

  it('AC-457.1: empty command tokenizes to an empty array; pure whitespace to one separator token', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([{ text: '   ', kind: 'separator' }]);
  });
});

/**
 * AC-457.2 — every case here was verified against this machine's real bash
 * (GNU bash 5.3.15, Cygwin) from a script file, not asserted from memory —
 * the same discipline `docs/spikes/2026-08-13-argv-tokenize-model.md`'s
 * probe1-7 and `denylist.mjs`'s own rule comments establish. Raw transcripts
 * are quoted inline below wherever they ground a claim.
 */
describe('tokenize() — AC-457.2: bash-verified pinned cases from the spike', () => {
  it('AC-457.2a: env-assignment prefix is its own token, never fused into the verb (probe2)', () => {
    // $ rm() { printf 'ARGV[%d]=[%s]\n' "$#" "$*"; printf '[%s]\n' "$@"; }; TERM=xterm rm -rf dist
    // ARGV[2]=[-rf dist]
    // [-rf]
    // [dist]                     <- "TERM=xterm" never reaches rm's argv at all
    const tokens = nonSep(tokenize('TERM=xterm ' + 'rm -rf dist'));
    expect(tokens).toEqual([
      { text: 'TERM=xterm', kind: 'assignment' },
      { text: 'rm', kind: 'word' },
      { text: '-rf', kind: 'word' },
      { text: 'dist', kind: 'word' },
    ]);
  });

  it('AC-457.2a: an assignment prefix is only recognised BEFORE the verb, never after', () => {
    // A KEY=VALUE-shaped token appearing after the verb is an ordinary
    // argument (e.g. `git config KEY=VALUE`), not a shell assignment.
    const tokens = nonSep(tokenize('git config KEY=VALUE'));
    expect(tokens).toEqual([
      { text: 'git', kind: 'word' },
      { text: 'config', kind: 'word' },
      { text: 'KEY=VALUE', kind: 'word' },
    ]);
  });

  it('AC-457.2a: an assignment value may embed a substitution, captured as ONE whole token', () => {
    // $ X=$(echo bar) rm -rf dist   ->  argv [-rf] [dist], X never reaches rm
    const tokens = nonSep(tokenize('X=$(echo bar) ' + 'rm -rf dist'));
    expect(tokens[0]).toEqual({ text: 'X=$(echo bar)', kind: 'assignment' });
  });

  it('AC-457.2b: a standalone -- is a structural ddash token, not a dash-prefixed word (probe2)', () => {
    // $ printf '[%s]\n' rm -- -rf target
    // [rm] [--] [-rf] [target]        <- -rf is a literal filename, not flags
    const tokens = nonSep(tokenize('rm -- -rf target'));
    expect(tokens).toEqual([
      { text: 'rm', kind: 'word' },
      { text: '--', kind: 'ddash' },
      { text: '-rf', kind: 'word' },
      { text: 'target', kind: 'word' },
    ]);
  });

  it('AC-457.2b: a quoted -- token still counts (AC-454.5 precedent — resolved text is what matters)', () => {
    const tokens = nonSep(tokenize("rm '--' -rf target"));
    expect(tokens[1]).toEqual({ text: '--', kind: 'ddash' });
  });

  it('AC-457.2c: a raw NUL fuses the surrounding bytes with no separator inserted (delete, not space)', () => {
    // { printf 'rm -r\x00f /tmp/nope\n'; } | bash -c 'while IFS= read -r line; do printf "GOT: [%s]\n" "$line"; done'
    // GOT: [rm -rf /tmp/nope]           <- one intact "-rf" token, byte deleted
    const tokens = nonSep(tokenize('rm -r\0f /tmp/nope'));
    expect(tokens).toEqual([
      { text: 'rm', kind: 'word' },
      { text: '-rf', kind: 'word' },
      { text: '/tmp/nope', kind: 'word' },
    ]);
  });

  it('AC-457.2c: a NUL inside a quoted target still fuses (no space, no split introduced)', () => {
    const tokens = nonSep(tokenize("rm -rf '/prod-secrets\0/scratchpad'"));
    expect(tokens).toEqual([
      { text: 'rm', kind: 'word' },
      { text: '-rf', kind: 'word' },
      { text: '/prod-secrets/scratchpad', kind: 'word' },
    ]);
  });

  it('AC-457.2d: a $(...) span is one opaque substitution token — inner text never leaks as a sibling word (probe2/#449)', () => {
    // $ printf '[%s]\n' rm -rf "$(echo -x)" safe-target
    // [rm] [-rf] [-x] [safe-target]     <- "-x" is the substitution's OUTPUT,
    // never its literal source text — the tokenizer does not evaluate it
    // (module non-goal); it only has to keep "-x" here from leaking into an
    // OUTER flag scan as if it were literal command text, which it does by
    // emitting one opaque `substitution` token instead of a `word`.
    const tokens = nonSep(tokenize('rm -rf "$(echo -x)" safe-target'));
    expect(tokens).toEqual([
      { text: 'rm', kind: 'word' },
      { text: '-rf', kind: 'word' },
      { text: '$(echo -x)', kind: 'substitution' },
      { text: 'safe-target', kind: 'word' },
    ]);
  });

  it('AC-457.2d: a backtick span is equally opaque', () => {
    // $ printf '[%s]\n' rm -rf `echo -x` safe-target  ->  [rm] [-rf] [-x] [safe-target]
    const tokens = nonSep(tokenize('rm -rf `echo -x` safe-target'));
    expect(tokens).toEqual([
      { text: 'rm', kind: 'word' },
      { text: '-rf', kind: 'word' },
      { text: '`echo -x`', kind: 'substitution' },
      { text: 'safe-target', kind: 'word' },
    ]);
  });

  it('AC-457.2d: a nested $( $( ) ) span is tracked by depth, closing at the OUTER close, not the first one (probe4)', () => {
    // $ printf '[%s]\n' rm -rf $(echo $(echo -n b)) safe-target  ->  [rm] [-rf] [b] [safe-target]
    const tokens = nonSep(tokenize('rm -rf $(echo $(echo -n b)) safe-target'));
    expect(tokens).toEqual([
      { text: 'rm', kind: 'word' },
      { text: '-rf', kind: 'word' },
      { text: '$(echo $(echo -n b))', kind: 'substitution' },
      { text: 'safe-target', kind: 'word' },
    ]);
  });

  it('AC-457.2d: whitespace INSIDE a substitution span never splits the outer run', () => {
    const tokens = nonSep(tokenize('rm -rf $(echo -x -y) safe-target'));
    expect(tokens).toEqual([
      { text: 'rm', kind: 'word' },
      { text: '-rf', kind: 'word' },
      { text: '$(echo -x -y)', kind: 'substitution' },
      { text: 'safe-target', kind: 'word' },
    ]);
  });

  it('AC-457.2d: an unterminated $( has a defined, safe outcome — runs to end of input, never throws', () => {
    expect(() => tokenize('rm -rf $(echo unterminated')).not.toThrow();
    const tokens = nonSep(tokenize('rm -rf $(echo unterminated'));
    expect(tokens[2]).toEqual({ text: '$(echo unterminated', kind: 'substitution' });
  });

  it('AC-457.2e: brace-group syntax (comma list, range, step range) is marked, never expanded (real bash resolves these BEFORE argv)', () => {
    // $ printf '[%s]\n' git push --forc{e,} origin main   ->  [git] [push] [--force] [origin] [main]
    // $ printf '[%s]\n' rm -r{f,} /opt/danger              ->  [rm] [-rf] [/opt/danger]
    // $ printf '[%s]\n' --f{o..o..1}rce                    ->  [--force]
    // The tokenizer never enumerates these — see #448's ReDoS history for why.
    expect(nonSep(tokenize('git push --forc{e,} origin main'))[2]).toEqual({ text: '--forc{e,}', kind: 'unresolved-brace' });
    expect(nonSep(tokenize('rm -r{f,} /opt/danger'))[1]).toEqual({ text: '-r{f,}', kind: 'unresolved-brace' });
    expect(nonSep(tokenize('--f{o..o..1}rce'))[0]).toEqual({ text: '--f{o..o..1}rce', kind: 'unresolved-brace' });
    expect(nonSep(tokenize('-{e..f}'))[0]).toEqual({ text: '-{e..f}', kind: 'unresolved-brace' });
    expect(nonSep(tokenize('--forc{d..e}'))[0]).toEqual({ text: '--forc{d..e}', kind: 'unresolved-brace' });
  });

  it('AC-457.2e: brace syntax is never expanded — no candidate materialisation, cost is O(command length)', () => {
    // A large single-element-range-style construction (#448 defect 3's
    // stack-overflow shape) must complete instantly and without throwing —
    // there is no generation step here to overflow or blow up.
    const adversarial = 'x' + '{a,'.repeat(20000) + 'a' + '}'.repeat(1);
    expect(() => tokenize(adversarial)).not.toThrow();
  });

  it('AC-457.2e: brace detection is a linear scan, immune to catastrophic backtracking on a comma run with no closing brace (security finding, fix-wave 1)', () => {
    // A full-branch adversarial security review found the FIRST version of
    // this module's brace detector — a regex,
    // `/\{[^{}]*(?:,[^{}]*)+\}/` — was catastrophically backtracking on a
    // long comma run with NO closing `}`: the outer `[^{}]*` and the
    // repeated group's own `[^{}]*` both accept a comma, so the engine tries
    // exponentially many ways to partition the run before concluding no
    // match. Measured against the ORIGINAL regex: 14.3s for 30 commas
    // (`'rm -r{f' + ','.repeat(30)`, a ~37-character, entirely plausible
    // command fragment), not returned after 120s at 35 — the exact ReDoS bug
    // class #448's own finding (a 4.65s hang on a 74-byte input) warns
    // about, silently relearned in this new module. Fixed by replacing the
    // regex with a hand-written linear scan (`hasBraceGroupSyntax()`) whose
    // index only ever advances — see that function's own comment for the
    // full account, recorded rather than quietly dropped.
    const adversarial = 'rm -r{f' + ','.repeat(2000);
    const start = process.hrtime.bigint();
    const tokens = nonSep(tokenize(adversarial));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
    // No closing brace anywhere in the input -> never classified as a brace
    // group; the unterminated `{f,,,...` text is ordinary (if odd) word text.
    expect(tokens.every((t) => t.kind !== 'unresolved-brace')).toBe(true);
  });

  it('AC-457.2e: brace syntax outside any flag-shaped position is still marked unresolved-brace (scoping is a Phase 2 consumer concern, not this module\'s)', () => {
    // #85's pinned false-positive case: this module only detects and
    // classifies; deciding whether a GraphQL-shaped {...} in a commit
    // message should ever be treated as flag-relevant is explicitly left to
    // whichever rule consumes this token — see module NON-GOALS.
    const tokens = nonSep(tokenize("git commit -m 'mutation{addUser, removeUser}'"));
    const brace = tokens.find((t) => t.text.includes('mutation'));
    expect(brace.kind).toBe('unresolved-brace');
  });
});

describe('tokenize() — AC-457.3: zero behaviour change to the shipped guard', () => {
  it('AC-457.3: plugin/hooks/denylist.mjs does not import shell-tokenize.mjs — this module is dead code, imported by nothing', () => {
    const denylistSource = readFileSync(DENYLIST_PATH, 'utf8');
    expect(denylistSource).not.toMatch(/shell-tokenize/);
  });

  it('AC-457.3: shell-tokenize.mjs does not import from denylist.mjs (no reverse dependency either — the module comment may still reference it by name for context)', () => {
    const tokenizerSource = readFileSync(TOKENIZER_PATH, 'utf8');
    expect(tokenizerSource).not.toMatch(/(?:import|from|require)\s*\(?\s*['"][^'"]*denylist\.mjs['"]/);
  });

  it('AC-457.3: check()/handle() in denylist.mjs are unchanged by this ticket — the full existing pinned corpus (AC-429.*, AC-437.*, AC-446.*, AC-450.*, AC-454.*, AC-456 absorption) is exercised unmodified by tests/hooks/denylist.test.mjs, which this PR does not edit', async () => {
    // This is a structural assertion, not a re-run of that suite (vitest
    // already runs it as its own file in the same `pnpm verify` pass) — it
    // exists so a reviewer sees the claim stated as a test, not only as PR
    // body prose. The single authoritative proof is: `git diff main --
    // plugin/hooks/denylist.mjs` is empty, verified at ship time.
    const denylistSource = readFileSync(DENYLIST_PATH, 'utf8');
    expect(denylistSource).toContain('export function normalizeShellText');
    expect(denylistSource).toContain('function shortFlagCluster');
    expect(denylistSource).toContain('function beforeEndOfOptions');
  });
});

describe('tokenize() — AC-457.4: the module states its own refusals', () => {
  it('AC-457.4: the doc comment names every explicit non-goal (globs, variable-value substitution, real filesystem resolution, recursive substitution re-parsing)', () => {
    const src = readFileSync(TOKENIZER_PATH, 'utf8');
    expect(src).toMatch(/NON-GOALS/);
    expect(src).toMatch(/glob expansion/i);
    expect(src).toMatch(/variable \*?value\*? substitution/i);
    expect(src).toMatch(/filesystem-backed path resolution/i);
    expect(src).toMatch(/never recurses into/i);
    // The AC.1 flat-sibling shape limitation triage flagged (spike §3,
    // #459/#495's mid-word fusion) must be stated, not merely true in
    // practice — see the corpus test below that PINS the actual behaviour.
    expect(src).toMatch(/#459/);
  });
});

/**
 * AC-457.5 (optional, triage-suggested, implemented per the ticket) — an
 * absolute wall-clock ceiling, never a ratio. #486 is a live timing-RATIO
 * flake in tests/hooks/denylist.test.mjs; this assertion is deliberately
 * insensitive to CI runner variance because it never compares two timings
 * against each other.
 */
describe('tokenize() — AC-457.5: absolute wall-clock performance ceiling', () => {
  it('AC-457.5: an adversarial nested-substitution input tokenizes in well under agy\'s 10s fail-open budget', () => {
    const nested = 'rm -rf ' + '$('.repeat(2000) + 'true' + ')'.repeat(2000) + ' /tmp/x';
    const start = process.hrtime.bigint();
    tokenize(nested);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    // Generous absolute ceiling (agy's own fail-open budget is 10s / 10000ms).
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('AC-457.5: a long, ordinary command (no adversarial structure) also stays far under the ceiling', () => {
    const long = 'git commit -m ' + JSON.stringify('x'.repeat(50000));
    const start = process.hrtime.bigint();
    tokenize(long);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
  });
});

/**
 * Conformance corpus — the real reproductions from #448, #449, #452, #454,
 * #456, #459, #495 (the sibling tickets in the #451/#182 family), each
 * exercised against the tokenizer directly. This is NOT a claim that #457
 * closes any of these tickets (see the PR body / ticket for the precise,
 * non-overstated unblock accounting — only #449 is sequenced behind #457,
 * and even then only "partially" per the spike). It is evidence that the
 * tokenizer's OWN token stream, on the exact strings that defeated the text
 * model, classifies each shape the way the spike's design predicts —
 * including the shapes it explicitly does NOT close.
 */
describe('tokenize() — conformance corpus: family reproductions (#448/#449/#452/#454/#456/#459/#495)', () => {
  it('#454 repro: TERM=xterm / X=affirm prefixes are assignment tokens, never fused into an unanchored verb search', () => {
    expect(nonSep(tokenize('TERM=xterm ' + 'rm -rf dist'))[0].kind).toBe('assignment');
    expect(nonSep(tokenize('X=affirm ' + 'rm -rf dist'))[0].kind).toBe('assignment');
  });

  it('#456 repro: rm -- -rf target and rm -- --recursive --force target both mark -- as ddash, tokens after it as plain words', () => {
    const a = nonSep(tokenize('rm -- -rf target'));
    expect(a.map((t) => t.kind)).toEqual(['word', 'ddash', 'word', 'word']);
    const b = nonSep(tokenize('rm -- --recursive --force target'));
    expect(b.map((t) => t.kind)).toEqual(['word', 'ddash', 'word', 'word', 'word']);
  });

  it('#452 repro: a NUL inside a short-flag cluster fuses to an intact word token (all four affected verbs)', () => {
    expect(nonSep(tokenize('rm -r\0f /prod-secrets')).map((t) => t.text)).toEqual(['rm', '-rf', '/prod-secrets']);
    expect(nonSep(tokenize('git push -u\0f origin main')).map((t) => t.text)).toEqual(['git', 'push', '-uf', 'origin', 'main']);
    expect(nonSep(tokenize('git clean -xd\0f')).map((t) => t.text)).toEqual(['git', 'clean', '-xdf']);
    expect(nonSep(tokenize('git branch -\0D somebranch')).map((t) => t.text)).toEqual(['git', 'branch', '-D', 'somebranch']);
  });

  it('#449 repro: a flag-shaped token inside a well-formed $(...)/backtick span is opaque, never a sibling word', () => {
    const dollar = nonSep(tokenize('rm $(cat -- flagfile) -rf /important-template-configs'));
    expect(dollar.map((t) => t.kind)).toEqual(['word', 'substitution', 'word', 'word']);
    const backtick = nonSep(tokenize('rm `cat -- flagfile` -rf /important-template-configs'));
    expect(backtick.map((t) => t.kind)).toEqual(['word', 'substitution', 'word', 'word']);
  });

  it('#449 repro (nested + quoted boundary, probe4 shapes): depth and quote state both matter for correct span extent', () => {
    // Nested $( $( ) ) — depth-tracked, closes at the true outer boundary.
    const nested = nonSep(tokenize('rm $(cat <(true) -- ) -rf /important-secrets'));
    expect(nested.map((t) => t.kind)).toEqual(['word', 'substitution', 'word', 'word']);
  });

  it('#459 repro (documented non-goal, NOT closed by this module): a substitution fused mid-word with flag letters is NOT re-fused into one word token', () => {
    // Real bash: `rm -r$(true)f /prod-secrets` delivers argv [-rf] — one
    // intact flag. This module's flat-sibling Token shape cannot represent
    // that: it emits three siblings. A consumer reading only `kind: 'word'`
    // tokens for flag letters would still see "-r" and "f" separately and
    // miss the fused "-rf" — this is #459's own live bypass, UNCHANGED by
    // Phase 1, and stated as such in the module's NON-GOALS.
    const tokens = nonSep(tokenize('rm -r$(true)f /prod-secrets'));
    expect(tokens.map((t) => [t.text, t.kind])).toEqual([
      ['rm', 'word'],
      ['-r', 'word'],
      ['$(true)', 'substitution'],
      ['f', 'word'],
      ['/prod-secrets', 'word'],
    ]);
  });

  it('#459 repro: the backtick spelling has the identical, unfused shape', () => {
    const tokens = nonSep(tokenize('rm -r`true`f /prod-secrets'));
    expect(tokens.map((t) => [t.text, t.kind])).toEqual([
      ['rm', 'word'],
      ['-r', 'word'],
      ['`true`', 'substitution'],
      ['f', 'word'],
      ['/prod-secrets', 'word'],
    ]);
  });

  it('#495 repro: a flag fused directly onto a whitespace-free substitution boundary lands as its own intact word token', () => {
    // Real bash: `rm `a`$(b --)-rf /important-secrets` delivers argv [-rf]
    // [/important-secrets] — a live flag with no preceding whitespace at
    // all. UNLIKE #459 (where the flag LETTERS themselves are split across
    // a substitution, "-r" before and "f" after), #495's repro has no text
    // preceding "-rf" within the same run before the two substitutions, so
    // it survives as ONE clean word-part token here — the original bug was
    // `shortFlagCluster()`'s own `(?:^|\s)-` anchor requiring a PRECEDING
    // whitespace character, a regex-level assumption, not a token-fusion
    // one. This module does not claim to close #495 (per triage, #495 stays
    // fully open, unblocked by nothing) — whether a Phase 2 rule chooses to
    // scan word-kind tokens without requiring a whitespace-anchor is a
    // Phase 2 decision this ticket does not make.
    const tokens = nonSep(tokenize('rm `a`$(b --)-rf /important-secrets'));
    expect(tokens.map((t) => [t.text, t.kind])).toEqual([
      ['rm', 'word'],
      ['`a`', 'substitution'],
      ['$(b --)', 'substitution'],
      ['-rf', 'word'],
      ['/important-secrets', 'word'],
    ]);
  });

  it('#448 repro: every named brace-expansion argv example is marked unresolved-brace, none expanded', () => {
    const cases = [
      'git push --forc{e,} origin main',
      'rm -r{f,} /opt/danger',
      'git branch -{D,} main',
      '--f{o..o..1}rce',
    ];
    for (const c of cases) {
      const tokens = nonSep(tokenize(c));
      expect(tokens.some((t) => t.kind === 'unresolved-brace')).toBe(true);
      // No token equals a fully-expanded spelling — nothing was expanded.
      expect(tokens.some((t) => t.text === '--force' || t.text === '-rf' || t.text === '-D')).toBe(false);
    }
  });

  it('KNOWN LIMITATION (documented, inherited from normalizeShellText\'s flat quote model): a literal ) inside a single-quoted string nested inside a DOUBLE-quoted span is not guaranteed opaque', () => {
    // $ printf '[%s]\n' rm -rf "$(echo ')')" safe-target
    // [rm] [-rf] [)] [safe-target]     <- real bash: one intact opaque span
    //
    // This module tracks quoting with ONE flat state variable across the
    // whole command (same model normalizeShellText() uses — see that
    // function's own `quote` variable), so it cannot tell that the `'` here
    // opens a FRESH quote context because it is inside a substitution nested
    // inside an already-open outer double quote. The span is cut short at
    // the first bare-looking `)`, exactly the failure mode this module's
    // NON-GOALS section names. Pinning the ACTUAL (imperfect) behaviour here
    // so a future change to it is a deliberate, visible decision, not a
    // silent regression either direction.
    const tokens = nonSep(tokenize('rm -rf "$(echo \')\')" safe-target'));
    expect(tokens.map((t) => [t.text, t.kind])).toEqual([
      ['rm', 'word'],
      ['-rf', 'word'],
      ["$(echo ')", 'substitution'],
      ["')", 'word'],
      ['safe-target', 'word'],
    ]);
  });
});
