# Plan: #430 - bug: emitted agy package tells the agent to write `.claude/settings.local.json`

**Ticket:** #430 (board #8, parent #182) - **Kind:** bug - **Base:** main - **Branch:** fix/430-emitted-skill-host-prose

The agy emitter (`plugin/scripts/agy/emit.mjs`) copies `skills/` and `commands/`
byte-for-byte (`COMPONENT_DIRS`) and only rewrites `${CLAUDE_PLUGIN_ROOT}` in
`.md` files (#294). `plugin/skills/autopilot/SKILL.md`'s Permissions block
therefore shipped verbatim into the agy package, instructing an agy-hosted
agent to run `perms.mjs` and merge its output into `.claude/settings.local.json`
— a file agy never reads (#429/#439 established agy's real pre-authorization
path is hook-mediated instead, via `hooks/agy-deny.mjs` + the shared
`scripts/lib/allowed-commands.mjs`). The repeated "necessary but NOT
sufficient" caveat about Claude's harness auto-mode classifier also survived
unqualified, describing a mechanism agy does not have. Two other emitted
commands (`init.md`, `statusline.md`) carried the same literal-filename
pattern for the (Claude-only) statusline feature.

## AC map

- **AC-430.1** An agy-hosted agent reading the emitted `skills/autopilot/SKILL.md`
  is not told to write `.claude/settings.local.json` or any other Claude-only
  file; it is pointed at agy's real hook-mediated pre-authorization path.
- **AC-430.2** A test pins it against the EMITTED tree (same regression class
  as #294): no emitted skill or command references `.claude/settings.local.json`,
  and the emitted autopilot skill positively documents the agy hook path.
- **AC-430.3** `perms.mjs`'s Claude behaviour (source + emitted script content)
  is unchanged.

## Fix shape (implementer's call, per ticket)

Chosen: **host-neutral-at-source, no new emit-time rewrite rule.** The three
affected `.md` files (`skills/autopilot/SKILL.md`, `commands/init.md`,
`commands/statusline.md`) are edited so the Claude-only mechanics are
explicitly host-scoped in prose ("Claude Code:" / "**Claude-only**" /
"Antigravity (agy):" branches) and the literal `.claude/settings.local.json`
string is replaced with descriptive phrasing ("the local Claude settings
file") wherever it would otherwise ship unqualified. `perms.mjs` itself (the
script, not the skill prose) is untouched — it still prints the real path at
runtime for Claude users, per AC-430.3 — and it still ships in the agy
package's `scripts/` tree (inert: nothing in the emitted skill tells an agy
agent to invoke it; AC-430.4 in the test file pins that). This avoids adding
another emit-time string-rewrite rule (the exact failure class that let this
bug happen in the first place — a rewrite the emitter forgets to apply);
instead the shipped prose is correct for both hosts by construction, in the
one place it's authored.

## Task 1 (fix): host-scope the autopilot skill's Permissions section (AC-430.1, AC-430.3)

Rewrite `## Permissions`, `## Merge-authorization preflight`, the Auto-merge
bar item 0, and the Driver-scripts `perms.mjs` bullet in
`plugin/skills/autopilot/SKILL.md` so:
- the Permissions section branches explicitly into a **Claude Code** path
  (run `perms.mjs`, merge its printed block) and an **Antigravity (agy)** path
  (hook-mediated, pointing at `docs/guides/cross-gai.md`'s permissions
  section);
- every remaining "necessary but not sufficient" / auto-mode-classifier
  mention is visibly scoped to Claude (the classifier and the merge-auth
  preflight it gates have no agy analogue, since unattended auto-merge is
  Claude-only by policy per ADR-0007 and an agy run always stops at the open
  green PR regardless);
- no literal `.claude/settings.local.json` string remains anywhere in the file.

**Files:** plugin/skills/autopilot/SKILL.md

## Task 2 (fix): host-scope the two other affected commands (AC-430.1, AC-430.2)

`commands/init.md` (statusline wiring question) and `commands/statusline.md`
(the whole command, which diagnoses a Claude-only feature) carry the same
literal-filename pattern for the Claude-only statusline. Add explicit
"Claude Code only" scoping and drop the literal filename in favour of
descriptive phrasing, consistent with Task 1's treatment.

**Files:** plugin/commands/init.md, plugin/commands/statusline.md

## Task 3 (test): pin the emitted-tree guard + the source-doc guard (AC-430.2, AC-430.3)

Add an `AC-430` describe block to `tests/agy/emit.test.mjs` (mirrors the
existing `AC-294` block's pattern of asserting against `emitAgyPlugin`'s
actual output, not the source): no emitted skill/command matches
`/settings\.local\.json/i`; the emitted autopilot skill positively documents
the agy hook path (`Antigravity (agy)`, `hook-mediated`, `cross-gai.md`); every
remaining "auto-mode classifier" / `perms.mjs` mention in the emitted skill is
visibly Claude-scoped; `perms.mjs` still ships in the agy package's
`scripts/autopilot/` and its own Claude behaviour (source content + exports)
is unchanged.

Also update the one pre-existing assertion this fix necessarily invalidates:
`tests/skills/autopilot.test.mjs`'s `#156` test asserted the source skill
literally contains `settings\.local\.json` — updated to assert the new
host-scoped documentation instead (both hosts documented, hook-mediated path
named, literal Claude-only filename absent). Flagged for explicit reviewer
sign-off per spec §13 anti-gaming law (a pre-existing test's assertion
changed) — see PR body.

**Files:** tests/agy/emit.test.mjs, tests/skills/autopilot.test.mjs
