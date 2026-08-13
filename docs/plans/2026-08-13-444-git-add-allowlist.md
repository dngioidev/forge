# Plan: #444 - allowlist `git add`, positive-model argument guard

**Ticket:** #444 (board #8, child of epic #182) - **Kind:** chore
**Base:** main - **Branch:** fix/444-git-add-allowlist - **Verify:** `pnpm verify`

`git add` is on neither host's command set. It is genuinely non-destructive in
its common form (stages, never discards) but `-p`/`-i` are interactive prompt
loops and `-e`/`--edit` opens the patch in `$EDITOR` - an arbitrary program
launch, the same vector class as `node -e` / `pnpm verify --reporter=<path>` /
`git rebase -x` / `git fetch --upload-pack=`. Triage already made the AC.1
decision (`git add` joins the shared allowlist) and finalized the exact safe
flag set; this plan only implements it, following the seven-times-shipped
positive-model pattern in `plugin/scripts/lib/allowed-commands.mjs`.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC.1** - `git add` joins `ALLOWED_COMMAND_PREFIXES`. Already decided.
- **AC.2** - `ARGUMENT_SENSITIVE_PREFIXES` entry for `git add`, positive model,
  safe set: `-A`, `--all`, `--no-ignore-removal`, `-u`, `--update`, `-n`,
  `--dry-run`, `-v`, `--verbose`, `-f`, `--force`, `--sparse`, `--refresh`,
  `--ignore-errors`, `--ignore-missing`, `--no-warn-embedded-repo`,
  `--renormalize`, plus `PLAIN_OPERAND` paths. `-p`/`--patch`, `-i`/
  `--interactive`, `-e`/`--edit` excluded by omission. Tests pin both allowed
  and refused forms, plus one abbreviation probe.
- **AC.3** - Denylist-precedence invariant extended to cover `git add` as a
  test-coverage addition (no rule in `denylist.mjs` overlaps `git add`).
- **AC.4** - `docs/guides/cross-gai.md` and `docs/guides/install.md` each gain
  a `git add` line stating the Claude-side asymmetry (unguarded
  `Bash(git add:*)` including `-p`/`-i`/`-e`) as the same accepted trade
  already documented for the other seven verbs.
- **AC.5** - The residual `-p`/`-i`/`-e` prompts documented as expected/
  by-design in the same doc location, pinned with a docs-assertion test.

**Care point (positive model):** allow known-safe forms, never enumerate
unsafe spellings. `flagsAndOperands()` already achieves this by construction -
any flag not literally in the safe set falls through to `ask`, so an
abbreviation of `--edit` (verified against live git 2.55: `--edi` resolves to
`--edit` since no other `git add` long option starts `edi`) can never slip in
without an explicit, deliberate addition to the safe set.

## Task 1 (test): failing tests first

Add `git add` coverage to `tests/lib/allowed-commands.test.mjs`:
- Extend the `ARGUMENT_SENSITIVE_COMMANDS` pinned-array assertion to include
  `git add`.
- New describe block, AC-444.2: allowed forms (`git add -A`, `git add .`,
  `git add src/foo.mjs`, `git add -u`, a couple more of the safe-flag set) all
  `true`; refused forms (`git add -e`, `--edit`, `-p`, `--patch`, `-i`,
  `--interactive`, `--edi` abbreviation probe, plus an arbitrary unknown flag)
  all `false`.
- Add `git add` to the existing shared "unrecognised flag asks" loop
  (mirrors AC-429.3's per-prefix unknown-flag test) and to the metacharacter-
  smuggling `smuggled` array (`git add $(touch pwned)`).

Add `git add` coverage to `tests/hooks/agy-deny.test.mjs`:
- Add `git add -A` to the end-to-end known-good allowlist list (AC-429.2
  style).
- New AC-444.3 test: denylist-precedence invariant, per-verb - a chained
  `git add -A && git push --force origin main` is `deny` (force-push rule),
  proving the newly-widened allowlist does not weaken denylist precedence for
  a segment sitting next to it.

Add `tests/docs/git-add-allowlist.test.mjs` (AC-444.4/AC-444.5 docs-assertion
tests, run before the docs edits so they fail first): both guides mention
`git add`, state the Claude-side unguarded-glob asymmetry, and state the
residual `-p`/`-i`/`-e` prompts as expected/by-design.

Run `npx vitest run tests/lib/allowed-commands.test.mjs tests/hooks/agy-deny.test.mjs tests/docs/git-add-allowlist.test.mjs`
and confirm the new assertions fail against pre-change source (AC.2/AC.3
tests fail because `git add` isn't allowlisted yet; AC.4/AC.5 docs tests fail
because the doc lines don't exist yet).

**Files:** tests/lib/allowed-commands.test.mjs, tests/hooks/agy-deny.test.mjs,
tests/docs/git-add-allowlist.test.mjs
**AC map:** AC.2, AC.3, AC.4, AC.5
**Test plan:** see above.

## Task 2 (code): allowlist + argument guard

`plugin/scripts/lib/allowed-commands.mjs`:
- Add `'git add'` to `ALLOWED_COMMAND_PREFIXES` (mutating-verb group).
- Add a `git add` entry to `ARGUMENT_SENSITIVE_PREFIXES` using
  `flagsAndOperands(...)` with the AC.2 safe set, with a comment explaining
  the three excluded interactive/editor flags and why they're excluded by
  omission rather than enumerated.
- Update the file's own doc comments: "Seven do" -> "Eight do", add the
  `git add` bullet to the enumerated list, keep in step with
  `docs/guides/cross-gai.md`'s guarded-verb table (per the file's own stated
  invariant).

**Files:** plugin/scripts/lib/allowed-commands.mjs
**AC map:** AC.1, AC.2
**Done:** Task 1's `allowed-commands.test.mjs` and `agy-deny.test.mjs`
assertions pass.

## Fix wave: adversarial `reviewer` and `security` passes, run in parallel on the full branch

Both independently found the same critical/high issue: an earlier draft of
the `git add` safe set included `-f`/`--force`, reasoned about only as
"stages otherwise-ignored files, does not discard anything" — true for
destruction, but blind to a second threat class, **exfiltration**.
`-f`/`--force` is git's own mechanism for overriding `.gitignore`, and this
repo's own `.gitignore` protects exactly the file class that matters
(`runner.env`, carrying a live PAT per `docs/guides/runner-adoption.md`).
`git add --force runner.env` followed by the already-unguarded
`git commit`/`git push` chain would be a zero-human-checkpoint path from a
gitignored credential to a pushed commit — and the reviewer noted `git add`'s
own hint text for a blocked add literally suggests `-f` as the fix, so this
isn't a contrived spelling. Cleanly excludable by the positive model (drop it
from the safe set; it falls to `ask` exactly like `-p`/`-i`/`-e` already do),
so this did not reopen AC.1 — it narrowed AC.2's enumerated safe set by one
flag. Fixed: `-f`/`--force` removed from `git add`'s `flagsAndOperands()`
call, comment updated to state the exfiltration risk explicitly, `cross-gai.md`'s
table and by-design-asks sentence updated, and a dedicated regression test
added (`git add -f runner.env`, `--force .env`, etc. all refused).

The reviewer also flagged three smaller gaps in the same pass, all fixed
here: no test exercised a bundled short-flag cluster for `git add` (e.g.
`-uf`) — the exact hazard class this file's own history comment already
names as previously missed for `git push` — now pinned; several of the
stated-safe flags (`--no-ignore-removal`, `--update`, `--dry-run`,
`--verbose`, `--refresh`, `--ignore-errors`, `--ignore-missing`,
`--no-warn-embedded-repo`) had no "allowed" test case even though the
mechanism (`flagsAndOperands`'s flat Set lookup) made them low-risk — now all
pinned; and `cross-gai.md`'s table row omitted `--no-ignore-removal` and
`--no-warn-embedded-repo` from the auto-approved column despite both being in
the code's actual safe set — now complete.

## Task 3 (docs): cross-gai.md + install.md + docsync

- `docs/guides/cross-gai.md`: add `git add` as an eighth row to the
  guarded-verb table, add it to the "code execution" verb list (its `-e`
  form), state the Claude-side asymmetry line, and add a sentence noting the
  three residual prompt spellings are expected/by-design (mirroring the
  existing `git checkout main` treatment).
- `docs/guides/install.md`: add a `git add` mention to the "Pre-authorizing
  outward commands" section's verb list, stating the same Claude-side
  unguarded-glob asymmetry.
- Add this plan to `docs/README.md` route index (docsync).

**Files:** docs/guides/cross-gai.md, docs/guides/install.md, docs/README.md
**AC map:** AC.4, AC.5
**Done:** Task 1's `tests/docs/git-add-allowlist.test.mjs` passes; `docsync`
gate clean.
