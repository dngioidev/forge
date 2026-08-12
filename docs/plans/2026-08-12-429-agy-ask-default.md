# Plan: #429 - flip agy hook default allow -> ask

**Ticket:** #429 (board #8, parent #182) - **Kind:** bug / security fix - **Base:** main - **Branch:** fix/429-agy-ask-default

`plugin/hooks/agy-deny.mjs:29,42` returns `{"decision":"allow"}` as the default
for every `run_command` that isn't a denylist hit. The #428 spike
(`docs/spikes/2026-08-12-agy-approval-semantics.md`, PR #435) confirmed agy's
own `allow` decision auto-approves and suppresses agy's own prompt, so this is
a live blanket pre-authorization on every agy-hosted forge session (finding
#434, p0). This plan delivers the fix: flip the default to `ask`, ship a
known-good allowlist single-sourced with the Claude host's own allowlist, and
document the residual gaps honestly.

## Owner decisions consumed as given (not re-litigated)

1. Hook-mediated (`agy-deny.mjs`), not a native `permissions.allow` emission.
2. New default `ask` for unrecognised commands; `allow` only for a known-good
   allowlist shipped **with** this fix.

## AC map

Ticket-scoped ids (`AC-429.<n>`) are used in test titles so the ac-gate can
map each one to a passing test; they correspond 1:1 to the ticket's AC.1-AC.8.

- **AC-429.1** `agy-deny.mjs`'s default for a non-denylisted `run_command` is
  `ask`, not `allow`. Test pins an arbitrary unrecognised command -> `ask`.
- **AC-429.2** A known-good allowlist returns `allow` - `node`, `pnpm verify`,
  the `gh pr`/`gh issue` verbs, the `git` verbs. Tests pin representative
  members.
- **AC-429.3 (invariant)** The denylist strictly outranks the allowlist - a
  command that is both allowlisted and denylisted is denied (force-push
  pinned explicitly).
- **AC-429.4** The command set is single-sourced and shared with the Claude
  host's `ALLOW` (`perms.mjs:13`), not copy-pasted.
- **AC-429.5** The fail-open-on-timeout hole is addressed or explicitly,
  honestly documented as un-closable from forge's side.
- **AC-429.6** The `run_command`-only matcher is either widened or a
  follow-up is filed with the spike's evidence.
- **AC-429.7** `docs/guides/cross-gai.md` gains an honest permissions section
  and a parity-matrix row for command pre-authorization.
- **AC-429.8** The fix is opt-in-safe: existing agy users get more prompting,
  never less - called out in the PR body and pinned by a behavioural test.

## Task 1 (code): shared allowlist module

New `plugin/scripts/lib/allowed-commands.mjs` exporting
`ALLOWED_COMMAND_PREFIXES` (the command set from the ticket body) and
`isAllowedCommand(command, { segments })`, which requires every shell-split
segment to match a prefix at a word boundary **and** the command to carry no
shell metacharacter. The metacharacter guard is load-bearing, not defensive
polish: prefix matching constrains only how a command *starts*, so without it
`git status > f` (an explicitly "read-only" verb) becomes an arbitrary-file
overwrite and `git push $(x)` becomes arbitrary code execution — both silently
allowed, which would have re-opened the exact hole this ticket exists to
close. Caught by adversarial review of the first implementation; now
regression-tested at both the unit and the hook level.

**Files:** plugin/scripts/lib/allowed-commands.mjs

## Task 2 (code): perms.mjs derives ALLOW from the shared list (AC-429.4)

`plugin/scripts/autopilot/perms.mjs`'s `ALLOW` is built by mapping
`ALLOWED_COMMAND_PREFIXES` into `Bash(<prefix>:*)` entries instead of
hardcoding 14 strings, so the Claude host list and the agy list share one
source.

**Files:** plugin/scripts/autopilot/perms.mjs

## Task 3 (code): agy-deny.mjs decision flip (AC-429.1, AC-429.3)

Denylist check runs first and unconditionally (unchanged path) - `deny` wins
on a hit. Else `isAllowedCommand()` -> `allow`. Else -> `ask` (was: bare
`allow`). The `main().catch()` internal-error fail-open path is left at
`allow` - an unrelated crash/unparseable-stdin backstop, not the "default for
an evaluated run_command call" this ticket targets.

**Files:** plugin/hooks/agy-deny.mjs

## Task 3b (code): close the force-push spelling gaps (AC-429.3)

`plugin/hooks/denylist.mjs`'s force-push rule matched only two of git's
**four** documented force-update spellings. All were survivable while the agy
hook allowed everything anyway; none is survivable once AC-429.2's allowlist
grants a bare `allow` to anything starting `git push ` — each miss becomes a
silent auto-approved history rewrite, i.e. the exact #434 failure mode.

- **bundled short `-f`** — git's parse-options bundles short booleans (same
  mechanism as `git commit -am`), so `git push -uf` / `-fu` force. Rule now
  collects single-dash short-flag clusters (the technique `recursive-delete`
  already uses).
- **`--mirror`** — force-updates every ref under `refs/` *and* deletes remote
  refs absent locally; strictly worse than a single-branch `--force`.
- **a leading `+` on the refspec** (`git push origin +trunk:trunk`) —
  documented force syntax, previously caught only by *accident*, and only when
  a protected-branch name happened to appear in the string (via
  `env-branch-delete`'s `:` + `PROTECTED_BRANCHES`).
- Also fixed a false positive in the same rule: `--force-if-includes`, git's
  recommended companion to `--force-with-lease`, was denied as if it were a
  bare `--force`.

Scope note: the original ticket body lists "changing the denylist rules" as a
non-goal, but that predates the scope update, when this was a feature ticket.
Revised AC-429.3 makes denylist-outranks-allowlist load-bearing and names a
force-push as the pinned case; an allowlist that green-lights
`git push --mirror` does not satisfy it. Strictly *more* blocking; grants
nothing. All found by `forge:security`.

**Files:** plugin/hooks/denylist.mjs, tests/hooks/denylist.test.mjs

## Task 3c (code): allowlist argument guards (AC-429.3, defense in depth)

Three of those spellings were found missing across two successive review
rounds. The *pattern* is the real finding: `denylist.mjs` self-describes as "a
tripwire ... not a security boundary", and an allowlist layered on top
converts every one of its gaps into a **silent** approve rather than a prompt.
Decisively, enumerating dangerous spellings cannot work here at all: git's
parse-options accepts **unambiguous long-option abbreviations**, so
`git push --mir` is `--mirror` and `git push --del` is `--delete`. Verified
against the branch — both reached `allow` under the first, deny-shaped version
of this guard. A dangerous-flag list would need `--mir`, `--mirr`, `--mirro`,
… and still never be complete.

So `allowed-commands.mjs` guards the four verbs whose danger lives in their
arguments, with a **positive** model — auto-allow only when every argument is
known-safe:

- **`node`** (critical, round 3) — `node -e "<code>"` / `--eval` / `-p` / `-`
  was reaching a bare `allow`: unrestricted code execution with full
  fs/child_process/network reach, silently. node stops parsing its own options
  at the first non-option, so requiring the first argument to be a plain script
  path closes it while keeping the whole forge script tier auto-approved —
  which is the entire reason `node` is on the allowlist.
- **`git push`** — inert flags (`-u`/`--set-upstream`, `-q`, `-v`,
  `--dry-run`, `--porcelain`, `--progress`) or a plain remote/ref token.
- **`git checkout`** (major, round 3) — `git checkout -- .` / `.` / `src/` /
  `-f` silently discard uncommitted work. `git checkout <name>` is genuinely
  ambiguous (git resolves a ref if one exists, else a path; the path form
  discards changes) and no syntactic heuristic separates `main` from
  `package.json` from `src`. So only branch **creation** (`-b <name>`)
  auto-approves; plain `git checkout main` asks. Closes the class rather than
  half-closing it, for ~1 extra prompt per ticket.
- **`gh pr merge`** (major, round 3) — `--admin` bypasses branch protection.

Anything else asks, including abbreviations and any flag a tool adds in
future. Deliberately redundant with the denylist; the tests are written to
keep passing even if a denylist rule regressed. Two intended side effects:
`--force-with-lease` asks (permitted, but a human sees it), and a bare `node`
asks (an unattended session must not silently enter a REPL).
`ARGUMENT_SENSITIVE_COMMANDS` is exported so tests reason about the set rather
than hardcoding it twice.

Also fixed in `denylist.mjs`: the short-flag cluster scan was `[a-zA-Z]`-only,
so `git push -4f` (bundling git's IPv4 flag with `-f`) evaded it — verified on
live git as a real forced update. Now `[a-zA-Z0-9]`.

Deliberately left at `ask` rather than `deny`: `git push --prune --all`
(deletes remote-only branches) and the `--mir`/`--del` abbreviations. The
allowlist guard stops all of them executing silently; extending the *denylist*
to every abbreviation is the unwinnable enumeration described above, and `ask`
is the right outcome for a destructive-but-legitimate maintenance command.

**Files:** plugin/scripts/lib/allowed-commands.mjs, plugin/hooks/denylist.mjs,
tests/lib/allowed-commands.test.mjs, tests/hooks/denylist.test.mjs

## Task 4 (test): pin single-sourcing (AC-429.4)

New `tests/lib/allowed-commands.test.mjs`: every prefix in
`ALLOWED_COMMAND_PREFIXES` appears in the Claude host's `ALLOW` as
`Bash(<prefix>:*)` and nothing else does (perms.mjs is a pure map, not a
fork), plus `isAllowedCommand()` behaviour for every listed prefix and a
look-alike-prefix rejection (`git pushx` != `git push`).

**Files:** tests/lib/allowed-commands.test.mjs

## Task 5 (test): pin the new decision logic (AC-429.1, AC-429.2, AC-429.3, AC-429.8)

`tests/hooks/agy-deny.test.mjs`: update the two pre-existing assertions that
assumed the old allow-by-default; add AC-429.1 (unrecognised command -> ask),
AC-429.2 (representative allowlist members -> allow, one per category),
AC-429.3 (force-push -> deny despite `git push` being an allowlisted verb,
plus a chained command with one non-allowlisted segment -> ask), and
AC-429.8 (a command that would have been silently pre-authorized before this
fix now prompts - the opt-in-safe, more-prompting-never-less behavioural
guarantee). `tests/agy/emit.test.mjs`'s emitted-shim integration case is
updated for the same default flip, and `tests/deps/vitest-4.test.mjs`'s
spawn-count regression guard is bumped for the one added case.

**Files:** tests/hooks/agy-deny.test.mjs, tests/agy/emit.test.mjs,
tests/deps/vitest-4.test.mjs

## Task 6 (docs): cross-gai.md permissions section + parity matrix (AC-429.5, AC-429.6, AC-429.7)

New "Permissions: the allow / ask / deny default (#429)" subsection: the
flip, the behaviour-change warning, the shared allowlist, the AC-429.3
precedence, the AC-429.5 timeout gap stated honestly (agy's host-level hook
timeout fails open; forge cannot close this from its side), and the AC-429.6
matcher-scope note (why the `run_command`-only matcher was not widened here).
Parity matrix gains a "Command pre-authorization" row instead of an implicit
"everything load-bearing is Full" claim.

**Files:** docs/guides/cross-gai.md

## Task 7 (test): grounding tests for the doc-only ACs (AC-429.5, AC-429.7)

New vitest file that reads `docs/guides/cross-gai.md` and asserts the
required honest content is present (mirrors the #423/#428 doc-content-
assertion pattern) - machine evidence for the ac-gate on the two ACs that are
otherwise doc-only.

**Files:** tests/docs/agy-ask-default.test.mjs

## Task 8 (board): file the AC-429.6 follow-up

File a child-of-#182 item carrying the spike's non-shell-tool-hooking
evidence and the reasoning for not widening the matcher in this PR (timeout
blast radius, non-command payload shape). Board item only, no repo file.

**Files:** (none - board item #436)

## Task 9 (docs): route index entry (docsync gate)

Add this plan to the docs route index.

**Files:** docs/README.md

## Non-goals

- Emitting a native `permissions.allow` settings file (owner decision: hook-
  mediated only).
- Widening the hook matcher beyond `run_command` (AC-429.6 -> follow-up #436).
- Changing the denylist rules themselves.
- Reaching the owner's already-installed agy plugin automatically (#433,
  separate ticket - the PR body says so explicitly, AC-429.8).

## Test plan

`npx vitest run tests/hooks/agy-deny.test.mjs tests/hooks/denylist.test.mjs
tests/autopilot/engine.test.mjs tests/agy/emit.test.mjs
tests/deps/vitest-4.test.mjs tests/docs/agy-ask-default.test.mjs`, then full
`pnpm verify` before shipping.
