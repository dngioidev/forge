# Plan: #460 - fix landing-page agy install command + gate-count consistency

**Ticket:** #460 (board #8, parent #182) - **Kind:** docs/bug (p1)
**Base:** main - **Branch:** fix/460-site-agy-install

`site/index.html:462` told an agy adopter to run `node plugin/scripts/init.mjs
--host agy` - a relative path. `plugin/scripts/init.mjs:56` resolves the emit
destination relative to **cwd**, so a reader following the site from inside the
forge checkout emits the package into forge's own tree instead of their
project. `docs/guides/install.md:45-56` (PR #441, #433) already has the
corrected three-step agy path - clone a checkout, emit from the project
directory with an absolute path, commit the emitted `.agents/plugins/forge/`
- but nothing ever reconciled the site against it after #423 added the box.
The page also framed the agy path as "one command" (hiding the clone +
commit steps) and disagreed with itself on the mechanical-gate count (6 in
the stat tile, 8 tiles in the grid, vs "the seven gates" in README/cross-gai/
decisions-0007).

**Gate-count finding:** the real count is **seven** - already correct in
README.md:46, cross-gai.md:577, and decisions/0007:155. Cross-checked against
`plugin/skills/ship/SKILL.md`'s actual pre-PR checklist and
`docs/guides/handbook.md`'s "gate ladder" table: `situation`, `conventions`,
`plandrift`, `testintent`, `depguard`, `acgate` (`ac-gate`), `docsync` = 7.
`license` and `groundgate` are real, registered gate scripts
(`plugin/mcp/forge/server.mjs`'s `GATE_NAMES` has 9 total) but are not part of
this seven: `license` runs standalone in CI (`verify.yml`), and `groundgate`
only runs during `forge:shape`, not at ship. `reviewer`/`security` are
adversarial subagent passes - model-driven, not mechanical scripts - and were
never part of the count; the site's own sub-copy already said "plus an
adversarial reviewer and security pass," it just then put their tiles in the
same grid as the mechanical ones. Only `site/index.html` was wrong (stat said
6, grid rendered 8 mixed items); README/cross-gai/decisions-0007 needed no
change. Fix: correct the stat to 7, and split the grid into the seven
mechanical gates plus a separately-labeled two-tile "adversarial passes" row,
so the framing matches the sub-copy instead of contradicting it.

## AC map

- **AC-460.1** The landing page's agy install instructions match
  `docs/guides/install.md`'s corrected adopter path: the checkout prerequisite
  is stated, the emitter is invoked from the reader's project directory with
  an absolute path, and the committed-`.agents/` step is not omitted.
- **AC-460.2** `agy` on PATH appears in the site's prerequisites wherever the
  agy path is offered.
- **AC-460.3** The "one command" / "three commands" framing is corrected so
  it does not contradict `install.md:35`'s three-step agy path.
- **AC-460.4** The mechanical-gate count is consistent across
  `site/index.html` and `README.md`: one number (7), correct, everywhere -
  and the tile grid stops conflating mechanical gates with the adversarial
  reviewer/security passes.
- **AC-460.5** A test pins the site's agy command against
  `docs/guides/install.md` so a third divergence fails CI.

## Task 1 (docs): rewrite the agy install box and prerequisites (AC-460.1, AC-460.2, AC-460.3)

`site/index.html` `#install` section: replace the single-line relative agy
command with the three-step path (`git clone` the checkout, `cd` to the
project + absolute-path `node ... --host agy`, commit `.agents/plugins/forge/`),
add `agy` on PATH to the prerequisites paragraph, and change the "one command"
/ "one-command emit flow" framing (h2 + prerequisites paragraph + box header)
to state three steps for agy, matching Claude Code's three commands. Mirror
the existing `.installbox`/`.top`/`.p`/`.req` markup idiom - no new CSS
classes.

**Files:** site/index.html

## Task 2 (docs): fix the mechanical-gate count and grid framing (AC-460.4)

`site/index.html`: change the proof-section stat tile from 6 to 7. Rebuild the
`#gates` section's tile grid to show exactly the seven mechanical gates
(`situation`, `conventions`, `plandrift`, `testintent`, `depguard`, `ac-gate`,
`docsync`) and move `reviewer`/`security` into a separately-labeled
"Adversarial passes - model-driven, not mechanical" row so the markup agrees
with the section's own sub-copy. Drop the `license` tile from this grid (it
is a real gate but not one of the seven ship-time ones; it runs standalone in
CI). No change needed to README.md/cross-gai.md/decisions-0007 - they already
say "seven."

**Files:** site/index.html

## Task 3 (test): pin the site against the guide and the gate count (AC-460.1, AC-460.2, AC-460.3, AC-460.4, AC-460.5)

Extend `tests/docs/agy-install-docs.test.mjs` (the existing #423 suite) with
a `#460` describe block: a doc-assertion test that reads both
`docs/guides/install.md` and `site/index.html` and asserts the site's agy
command matches the guide's corrected absolute-path form (the anti-drift pin
AC-460.5 asks for), tests for the checkout/project-dir/commit steps, the
`agy` on PATH prerequisite, the "not one command" framing, and the gate-grid
consistency (7 in the stat tile, the seven names in the mechanical grid,
reviewer/security only in the adversarial row). Updates the pre-existing
`AC-423.1` assertion (it pinned the old, buggy relative-path command) -
reviewer sign-off for that change is quoted in the PR body per spec §13.

**Files:** tests/docs/agy-install-docs.test.mjs

## Task 4 (docs): route index (AC-460.1 fyi)

Add this plan to the docs route index.

**Files:** docs/README.md
