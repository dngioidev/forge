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
    expect(ARGUMENT_SENSITIVE_COMMANDS).toEqual(['node', 'git push', 'git checkout', 'gh pr merge']);
    for (const prefix of ARGUMENT_SENSITIVE_COMMANDS) {
      expect(isAllowedCommand(`${prefix} --some-unknown-flag`, { segments: splitSegments }), prefix).toBe(false);
    }
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

  it('AC-429.3: `git checkout` auto-allows switching refs, never discarding local work', () => {
    for (const cmd of [
      'git checkout -- .',   // discards ALL uncommitted changes
      'git checkout .',      // same
      'git checkout src/',   // discards changes under a path
      'git checkout -f main',// force-switch, discarding conflicting changes
      'git checkout -B main',// force-reset a branch pointer
    ]) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(false);
    }
    for (const cmd of ['git checkout main', 'git checkout -b feat/x', 'git checkout fix/429-agy-ask-default']) {
      expect(isAllowedCommand(cmd, { segments: splitSegments }), cmd).toBe(true);
    }
  });

  it('AC-429.3: `gh pr merge --admin` (branch-protection bypass) asks; ordinary merges still allow', () => {
    expect(isAllowedCommand('gh pr merge 429 --admin --squash', { segments: splitSegments })).toBe(false);
    expect(isAllowedCommand('gh pr merge 429 --squash --delete-branch', { segments: splitSegments })).toBe(true);
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
