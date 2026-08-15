import { describe, it, expect } from 'vitest';
import { ALLOWED_COMMAND_PREFIXES, ARGUMENT_SENSITIVE_COMMANDS, isAllowedCommand } from '../../plugin/scripts/lib/allowed-commands.mjs';
import { ALLOW } from '../../plugin/scripts/autopilot/perms.mjs';
import { splitSegments } from '../../plugin/scripts/lib/shell-split.mjs';

describe('#429 — single-sourced command allowlist (AC-429.4)', () => {
  it('AC-429.4: every prefix appears in the Claude host ALLOW as Bash(<prefix>:*) — perms.mjs derives from, not forks, the shared list', () => {
    for (const prefix of ALLOWED_COMMAND_PREFIXES) {
      expect(ALLOW, `perms.mjs ALLOW missing ${prefix}`).toContain(`Bash(${prefix}:*)`);
    }
    // And nothing in ALLOW is NOT explained by the shared list (no copy-pasted extras).
    expect(ALLOW).toHaveLength(ALLOWED_COMMAND_PREFIXES.length);
  });

  it('AC-429.4: perms.ALLOW is a pure map over ALLOWED_COMMAND_PREFIXES — same order, one source', () => {
    expect(ALLOW).toEqual(ALLOWED_COMMAND_PREFIXES.map((p) => `Bash(${p}:*)`));
  });

  it('AC-429.2: isAllowedCommand() allows every NON-argument-sensitive prefix, bare or with trailing args', () => {
    const plain = ALLOWED_COMMAND_PREFIXES.filter((p) => !ARGUMENT_SENSITIVE_COMMANDS.includes(p));
    expect(plain.length, 'expected most prefixes to be argument-insensitive').toBeGreaterThan(10);
    for (const prefix of plain) {
      expect(isAllowedCommand(prefix, { segments: splitSegments }), prefix).toBe(true);
      expect(isAllowedCommand(`${prefix} --flag value`, { segments: splitSegments }), prefix).toBe(true);
    }
  });

  it('AC-429.3: every argument-sensitive prefix REFUSES an arbitrary unknown flag', () => {
    // The guard's whole point: an unrecognised flag may be an abbreviation of a
    // destructive one (`--mir` IS `--mirror`), so unknown means ask, per verb.
    expect(ARGUMENT_SENSITIVE_COMMANDS).toEqual([
      'node', 'pnpm verify', 'git push', 'git add', 'git fetch', 'git rebase', 'git checkout', 'gh pr merge',
    ]);
    for (const prefix of ARGUMENT_SENSITIVE_COMMANDS) {
      expect(isAllowedCommand(`${prefix} --some-unknown-flag`, { segments: splitSegments }), prefix).toBe(false);
    }
  });

  it('AC-429.3: `pnpm verify` takes no arguments — pnpm forwards them to vitest, whose --reporter/--config import arbitrary code', () => {
    // pnpm passes trailing args through to the script (`vitest run`), and vitest
    // dynamically import()s a --reporter=<path> / --config=<path> module at
    // startup, before any test runs. An unguarded trailing arg is therefore
    // arbitrary code execution — the same class as `node -e`.
    for (const cmd of [
      'pnpm verify --reporter=./evil.mjs',
      'pnpm verify --reporter ./evil.mjs',
      'pnpm verify --config=./evil.mjs',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
    // The bare command — the only form forge itself ever runs — still allows.
    expect(isAllowedCommand('pnpm verify', { segments: splitSegments })).toBe(true);
  });

  it('AC-429.3: `node` auto-allows only a script path — inline code execution asks', () => {
    // node -e/--eval/-p is unrestricted code execution (full fs/child_process/
    // network) and was reaching a bare `allow`. node stops parsing its own
    // options at the first non-option, so requiring a plain first argument both
    // closes that and keeps the whole forge script tier auto-approved.
    for (const cmd of [
      'node -e "require(\'os\').hostname()"',
      'node --eval "1+1"',
      'node -p "process.env"',
      'node -',        // read program from stdin
      'node',          // bare REPL: an unattended session must not enter one silently
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
    for (const cmd of [
      'node plugin/scripts/board/move.mjs --issue 429 --status done',
      'node scripts/x.mjs',
      'node bin/forge.mjs board status',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it('AC-429.3: `git fetch --upload-pack=<program>` executes that program and asks; ordinary fetches still allow', () => {
    // --upload-pack overrides the remote helper and runs the named program for
    // local/file transports. Like `git rebase -x`, it needs no shell
    // metacharacter, so only the argument guard catches it. Abbreviations too.
    for (const cmd of [
      'git fetch --upload-pack=/tmp/evil.sh origin',
      'git fetch --up=/tmp/evil.sh origin',
      'git fetch --upload-pack /tmp/evil.sh origin',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
    // The mirror image on push is closed by that verb's own safe-flag set.
    expect(isAllowedCommand('git push --receive-pack=/tmp/evil.sh origin', { segments: splitSegments })).toBe(false);
    for (const cmd of ['git fetch', 'git fetch origin', 'git fetch origin main', 'git fetch --all', 'git fetch --prune']) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it('AC-429.3: `git rebase -x/--exec` runs arbitrary shell and asks; flow-control rebases still allow', () => {
    // --exec runs a shell command after EVERY replayed commit. It needs no shell
    // metacharacter to do it, so the metacharacter guard does not catch it —
    // `git rebase -x "touch pwned" main` is plain text and was reaching allow.
    for (const cmd of [
      'git rebase -x "touch pwned" main',
      'git rebase --exec "touch pwned" main',
      'git rebase --exec script.sh main',
      'git rebase -i main', // interactive: opens an editor an unattended session must not enter
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
    for (const cmd of ['git rebase main', 'git rebase origin/main', 'git rebase --continue', 'git rebase --abort']) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it('AC-429.3: `git checkout` auto-allows only branch CREATION, because ref-vs-path is ambiguous', () => {
    // `git checkout <name>` resolves <name> as a ref if one exists and otherwise
    // as a PATH — and the path form discards that path's uncommitted changes
    // irrecoverably. Nothing in the string distinguishes them (`main` is a ref,
    // `package.json` is a file, `src` could be either), so only the
    // unambiguously non-destructive form (`-b`, branch creation) auto-approves.
    for (const cmd of [
      'git checkout -- .',                      // discards ALL uncommitted changes
      'git checkout .',                         // same
      'git checkout src/',                      // discards changes under a directory
      'git checkout src',                       // ...and without the trailing slash
      'git checkout package.json',              // discards one file's changes
      'git checkout plugin/hooks/denylist.mjs', // ditto, nested
      'git checkout -f main',                   // force-switch, discarding conflicts
      'git checkout -B main',                   // force-reset a branch pointer
      'git checkout main',                      // safe, but indistinguishable from a path
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
    for (const cmd of ['git checkout -b feat/x', 'git checkout -b feat/x origin/main']) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it('AC-429.3: `gh pr merge --admin` (branch-protection bypass) asks; ordinary merges still allow', () => {
    expect(isAllowedCommand('gh pr merge 429 --admin --squash', { segments: splitSegments })).toBe(false);
    expect(isAllowedCommand('gh pr merge 429 --squash --delete-branch', { segments: splitSegments })).toBe(true);
  });

  it('AC-444.2: `git add` argument guard — positive model, `-p`/`-i`/`-e` excluded by omission', () => {
    // `git add -p`/`-i` are interactive prompt loops; `-e`/`--edit` opens the
    // patch in $EDITOR — an arbitrary program launch, same class as `node -e`.
    // Nothing here enumerates those three as unsafe: they simply aren't in the
    // safe set, so they fall to `ask` the same way any other unrecognised flag
    // does — the positive-model guarantee, not a special case for them.
    for (const cmd of [
      'git add -A',
      'git add .',
      'git add src/foo.mjs',
      'git add -u',
      'git add --all',
      'git add -n',
      'git add -v src/foo.mjs',
      'git add --sparse',
      'git add --renormalize',
      // Full remaining stated safe set (#444 reviewer finding), so every
      // entry in argsOk's flagsAndOperands() list is actually pinned, not
      // just a representative subset.
      'git add --no-ignore-removal',
      'git add --update',
      'git add --dry-run',
      'git add --verbose',
      'git add --refresh',
      'git add --ignore-errors',
      'git add --ignore-missing',
      'git add --no-warn-embedded-repo',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
    for (const cmd of [
      'git add -e',
      'git add --edit',
      'git add -p',
      'git add --patch',
      'git add -i',
      'git add --interactive',
      'git add --edi',           // abbreviation probe: git 2.55 resolves this to --edit
                                  // (verified live — no other `git add` long option starts "edi"),
                                  // and the guard must not let it through either
      'git add --some-unknown-flag',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('AC-444.2 (fix wave, reviewer finding): a bundled short-flag cluster cannot smuggle `git add` past the guard — the class the file\'s own history (allowed-commands.mjs:98-99, "-uf bundled short flags") already found missed once for `git push`', () => {
    // flagsAndOperands() does an exact-string Set lookup per token; a bundled
    // cluster like `-uf` is a single token that equals none of the safe
    // strings and doesn't match PLAIN_OPERAND (leading `-`), so it must ask —
    // proven here rather than left to follow from the mechanism alone.
    for (const cmd of ['git add -uf', 'git add -Af', 'git add -nf', 'git add -fu']) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('AC-444.2 (fix wave, adversarial security finding): `-f`/`--force` is EXCLUDED from the `git add` safe set — it overrides .gitignore, not just "stages ignored files"', () => {
    // `-f`/`--force` shipped in an earlier draft of the guard on the reasoning
    // "stages otherwise-ignored files, does not discard anything" — true, but
    // that's ONE threat class (destruction). It missed a second: EXFILTRATION.
    // `--force` is git's literal mechanism for overriding `.gitignore`, and this
    // repo's own `.gitignore` protects exactly the file class that matters
    // (`runner.env`, carrying a live PAT per docs/guides/runner-adoption.md).
    // `git add --force runner.env` followed by the already-unguarded
    // `git commit`/`git push` would be a zero-human-checkpoint path from a
    // gitignored credential to a pushed commit — so this must ask, not allow.
    for (const cmd of [
      'git add -f',
      'git add --force',
      'git add -f runner.env',
      'git add --force runner.env',
      'git add --force .env',
      'git add -f secrets/prod.key',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('AC-438.2: `node` auto-allows any path resolving inside the workspace, not just forge\'s own tree', () => {
    for (const cmd of [
      'node plugin/scripts/board/move.mjs --issue 429 --status done',
      'node ./scripts/x.mjs',
      'node bin/forge.mjs board status',
      'node some/other/deeply/nested/tool.mjs --flag',
      'node README.md', // not a real script, but "any workspace path" is the chosen scope
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it('AC-438.2: `node` refuses a path that resolves outside the workspace — traversal and absolute escapes', () => {
    for (const cmd of [
      'node ../../../../tmp/evil.mjs',
      'node ../outside.mjs',
      'node ../../etc/passwd',
      'node /etc/passwd',            // POSIX absolute — already excluded by PLAIN_OPERAND
      'node C:/Windows/System32/evil.js', // Windows absolute — `:` excluded by PLAIN_OPERAND
      'node .',                      // the workspace root itself, not a script path
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('AC-438.2: the workspace-containment check uses the supplied `cwd`, not always process.cwd()', () => {
    const cwd = process.cwd().replace(/[\\/]+$/, '') + '/nested/fake-root';
    // Escapes the SUPPLIED cwd two levels up (back to process.cwd() itself) —
    // still outside the declared workspace root, so it must ask.
    expect(isAllowedCommand('node ../../plugin/scripts/x.mjs', { segments: splitSegments, cwd })).toBe(false);
    // Resolves inside the supplied cwd — allowed.
    expect(isAllowedCommand('node plugin/scripts/x.mjs', { segments: splitSegments, cwd })).toBe(true);
  });

  it('AC-438.3 (regression): #429\'s inline-execution and bare-REPL guard is unaffected by the workspace-containment addition', () => {
    for (const cmd of [
      'node -e "require(\'os\').hostname()"',
      'node --eval "1+1"',
      'node -p "process.env"',
      'node -',
      'node',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('isAllowedCommand() rejects an unrecognised command and a look-alike prefix without the required word boundary', () => {
    expect(isAllowedCommand('curl https://example.com', { segments: splitSegments })).toBe(false);
    // "git pushx" must not be confused with the "git push" prefix.
    expect(isAllowedCommand('git pushx origin', { segments: splitSegments })).toBe(false);
  });

  it('AC-429.3: an allowlisted prefix cannot smuggle a shell exec/redirect vector in its tail', () => {
    // Prefix matching constrains only how a command STARTS. Without the
    // metacharacter guard each of these is a silent `allow` for arbitrary code
    // execution or arbitrary file overwrite behind a "known-good" verb — and
    // for status/diff/log, behind an explicitly "read-only" one.
    const smuggled = [
      'git push $(touch pwned)',                // command substitution -> arbitrary exec
      'git diff `id`',                          // backtick substitution -> arbitrary exec
      'git status > important-config.txt',      // redirection -> arbitrary file overwrite
      'git log --format=$(id) > out.txt',       // both at once
      'git log < /etc/passwd',                  // input redirection
      'gh pr view 1 $(id)',                     // substitution under a gh verb
      'git status & curl https://evil.example', // `&` alone is NOT a splitSegments separator
      'git fetch ${IFS}evil',                   // brace-form parameter expansion
      'git add $(touch pwned)',                 // command substitution behind the newly-added verb
    ];
    for (const cmd of smuggled) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('AC-429.2: the metacharacter guard does not reject ordinary forge commands (parens, dashes, slashes, quotes)', () => {
    const ordinary = [
      'git commit -m "fix(board): key the repo cache by cwd"', // conventional-commit parens
      'node plugin/scripts/board/move.mjs --issue 429 --status done',
      'gh pr create --title "x" --body-file body.md',
      'gh issue comment 429 --body-file note.md',
      'git rev-parse HEAD',
      'pnpm verify',
    ];
    for (const cmd of ordinary) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it("AC-429.3: `git push` argument guard — the allowlist does not blanket-trust a push's arguments, independent of the denylist", () => {
    // Defense in depth. Three force-push spellings were found missing from
    // denylist.mjs during #429's review rounds (-uf, --mirror, +refspec). Each
    // is fixed there, but denylist.mjs is self-described as "a tripwire ... not
    // a security boundary", and an allowlist on top turns every one of its gaps
    // into a SILENT approve. So these must fail the ALLOWLIST too — this test
    // keeps passing even if a denylist rule regressed.
    for (const cmd of [
      'git push --mirror origin',
      'git push origin +trunk:trunk',
      'git push origin +develop',
      'git push -uf origin main',
      'git push --force origin main',
      'git push --delete origin some-branch',
      'git push origin :some-branch',              // the colon-deletion form
      'git push --force-with-lease origin feat/x', // a force op: a human should see it
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('AC-429.3: an ABBREVIATED destructive flag cannot reach allow — the guard enumerates safe args, not dangerous ones', () => {
    // The decisive reason the guard is a positive model. git's parse-options
    // accepts unambiguous long-option abbreviations, so `--mir` IS `--mirror`
    // and `--del` IS `--delete`. Any deny-list of dangerous spellings would
    // need an entry per abbreviation (--mir, --mirr, --mirro, ...) and could
    // never be complete; enumerating the safe arguments is finite and closed.
    for (const cmd of [
      'git push --mir origin',
      'git push --mirr origin',
      'git push --mirro origin',
      'git push --del origin some-branch',
      'git push --dele origin some-branch',
      'git push --recurse-submodules=on-demand origin main', // simply unknown-to-us
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
  });

  it('AC-429.2: the push argument guard still auto-allows the ordinary push shapes agents actually type', () => {
    for (const cmd of [
      'git push',
      'git push origin main',
      'git push origin fix/429-agy-ask-default',
      'git push -u origin feat/x',
      'git push --set-upstream origin feat/x',
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it('AC-429.3: the guard holds when isAllowedCommand is called standalone, without a segments splitter', () => {
    // The `segments` option is optional; the metacharacter guard must not
    // depend on it (it runs against the full string before any splitting).
    expect(isAllowedCommand('git push $(touch pwned)')).toBe(false);
    expect(isAllowedCommand('git status > f')).toBe(false);
    expect(isAllowedCommand('git status')).toBe(true);
  });
});
