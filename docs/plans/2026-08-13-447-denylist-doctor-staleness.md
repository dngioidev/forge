# Plan: #447 - denylist-staleness diagnostic (forge:doctor check + docs)

**Ticket:** #447 (board #8, child of epic #182) - **Kind:** feature (health-check, diagnostic only)
**Base:** main - **Branch:** fix/447-denylist-doctor-staleness
**Verify:** `pnpm verify`

Filed from the `forge:security` adversarial review on #437 (PR #445): the
`PreToolUse` denylist hook is wired via `${CLAUDE_PLUGIN_ROOT}/hooks/denylist.mjs`
(`plugin/hooks/hooks.json`), which resolves to the **installed plugin cache**,
not a forge checkout's working tree. An agent editing
`plugin/hooks/denylist.mjs` is not necessarily editing the rules enforced
against its own tool calls that session, and every hardening fix only takes
effect on an existing install after a reinstall — nobody is currently told.
Corroborated first-hand today (2026-08-13): the same stale-cache resolution
hit `plugin/scripts/autopilot/ledger.mjs` right after PR #468 merged — the
cache path still ran the pre-merge code while the working-tree path picked up
the fix immediately, confirming the failure mode isn't confined to `hooks/**`.

## Scope boundary with #484 — do not widen

`forge:shape` split this ticket in two. **#447 (this plan) is AC.3 + AC.4
only — the decision-free diagnostic slice.** The actual resolution-order
decision (should a forge checkout resolve hooks/`scripts/**` against the
working tree instead of the cache, and how) is **#484**, escalated to the
owner (`esc-484-msrowtoy`) and Blocked pending a human call. This plan
implements no resolution-order change, and does not touch `hooks.json`'s
`CLAUDE_PLUGIN_ROOT` wiring or `forge init`'s hook wiring.

## Comparison basis decision (required by the ticket body)

**Content equality, not `plugin.json` version.** A version-only compare would
have missed the exact incident that motivated this ticket: the
`ledger.mjs` divergence existed while both the cache copy and the
working-tree copy still claimed the same plugin version (the version bump for
that fix hadn't happened yet). Content is the only comparison that actually
catches that failure mode. `plugin.json` version is still surfaced in the
`warn` row (both sides named) as supporting diagnostic context, not as the
signal itself.

## AC map

- **AC-447.3** `forge:doctor` gains a new check family (own lib module,
  mirroring `plugin/scripts/lib/agy-checks.mjs`'s `checkAgyStaleness` /
  `checkAgyAdapter` idiom from #442) that: resolves the plugin root the
  running `doctor.mjs` instance itself loaded from (`ownPluginRoot()`,
  mirroring the agy-checks precedent); when the cwd also carries its own
  `plugin/hooks/denylist.mjs`, compares that working-tree file's *content*
  against the resolved live `<root>/hooks/denylist.mjs`; emits `ok` when they
  match, `warn` (naming both paths + each side's `plugin.json` version) when
  they differ; stays completely silent — no row at all — when there is no
  working-tree copy to compare against (a plain consumer install must never
  see this fire).
- **AC-447.4** `docs/guides/troubleshooting.md` §4 ("Hooks not firing") gets
  a new "Denylist staleness" subsection: what the AC.3 `denylist-staleness`
  warning means, and a cross-link to §1's existing reinstall/cache-refresh
  ladder (marketplace update → plugin update → reload → restart → nuclear
  reinstall) as the fix — not a restatement of those steps.

## Task 1 (feature): denylist-checks lib module

New `plugin/scripts/lib/denylist-checks.mjs`: `ownPluginRoot()` (own copy of
the two-levels-up-from-`lib/` idiom, self-contained rather than importing
agy-checks' internals so the module stays independently testable),
`WORKING_TREE_DENYLIST_RELPATH`, and `checkDenylistStaleness({ cwd, ownRoot })`
— content comparison first (the actual signal), `plugin.json` version lookup
via `agy-checks.mjs`'s already-generic, reused-as-is `resolveOwnManifest()`
only for the warn message's supporting detail. Never throws; unreadable live
file degrades to a `warn` naming the read failure, same defensive contract as
`runner-checks.mjs`/`agy-checks.mjs`.

**Files:** plugin/scripts/lib/denylist-checks.mjs
**AC map:** AC-447.3

## Task 2 (feature): wire into doctor.mjs

Import and call `checkDenylistStaleness({ cwd })` from `runDoctor`, placed
alongside the agy-adapter block (both silent-unless-applicable, no `cfg.ok`
dependency — this check only needs a filesystem, not a valid `forge.json`).

**Files:** plugin/scripts/doctor.mjs
**AC map:** AC-447.3

## Task 3 (docs): troubleshooting.md staleness subsection

New `### Denylist staleness` subsection under `## 4. Hooks not firing`:
explains what `${CLAUDE_PLUGIN_ROOT}` resolving to the cache means for a
checkout, documents the `denylist-staleness` row's ok/warn/silent contract,
cross-links `#1-updated-the-plugin-but-changes-arent-visible` for the fix
instead of duplicating the ladder, and states plainly that this is diagnostic
only — the resolution-order question is #484.

**Files:** docs/guides/troubleshooting.md
**AC map:** AC-447.4

## Task 4 (test): denylist-checks unit tests

New `tests/lib/denylist-checks.test.mjs`: the silence contract (no
working-tree copy at all; a `plugin/` dir present but no `hooks/denylist.mjs`
inside it), content-match → `ok`, the load-bearing break-it case (identical
`plugin.json` version, different content → `warn` — the exact shape that
would defeat a version-only compare), different content + different version
→ `warn` naming both, unresolvable live manifest → `warn` with `vunknown`
rather than throwing, and an unreadable live file → `warn`, never a throw.

**Files:** tests/lib/denylist-checks.test.mjs
**AC map:** AC-447.3

## Task 5 (test): doctor wiring

New describe block in `tests/doctor.test.mjs`: silent when cwd has no
working-tree `plugin/hooks/denylist.mjs`; `ok` when the working-tree copy is
byte-identical to this checkout's own live `plugin/hooks/denylist.mjs`; warn
(never a doctor-level fail) when a working-tree copy is hand-edited to
diverge from the live copy.

**Files:** tests/doctor.test.mjs
**AC map:** AC-447.3

## Task 6 (test): docs-assertion pin

New `tests/docs/denylist-staleness-docs.test.mjs`: the subsection lives
inside §4 (not a new top-level section), documents the `denylist-staleness`
name and its ok/warn/silent contract, cross-links §1's anchor instead of
duplicating its steps, and names both #447 and #484 so the diagnostic/decision
split stays traceable from the doc itself.

**Files:** tests/docs/denylist-staleness-docs.test.mjs
**AC map:** AC-447.4

## Task 7 (docs): route index

Add this plan to `docs/README.md`.

**Files:** docs/README.md
