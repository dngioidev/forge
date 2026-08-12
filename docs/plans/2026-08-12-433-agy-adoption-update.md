# Plan: #433 - agy consumer adoption + update story

**Ticket:** #433 (board #8, child of epic #182) - **Kind:** docs
**Base:** main - **Branch:** docs/433-agy-adoption-update

Surfaced by the owner: an agy-only adopter (no Claude subscription) is never
told to clone forge (Gap 1), the existing "From a forge checkout" wording
describes the wrong working directory for the in-place emit flow (Gap 2,
`init.mjs:56` resolves the dest relative to **cwd**, not the forge source),
and there is no documented update path or staleness signal (Gap 3).

**Owner decision, settled 2026-08-12, not re-litigated here:** the emitted
`.agents/plugins/forge/` **is** committed to the consumer's repo.
`/forge:init` must not add `.agents/` to `.gitignore` (it already only adds
`.forge/` — confirmed by reading `init.mjs`, not re-derived), and an update
is expected to show up as a ~126-file diff.

**Scope boundary with #431:** #431 owns doctor-side tooling health checks
(agy on PATH, package integrity, automated staleness detection). This ticket
owns the adopter-facing install/update narrative. AC.5 is satisfied by
surfacing the version where an adopter will look (the emitted `plugin.json`);
no doctor check is built here.

## AC map

- **AC-433.1** `docs/guides/install.md`'s Antigravity section is a complete,
  self-contained path for a no-Claude-subscription adopter: obtain a forge
  checkout, then emit from the project directory.
- **AC-433.2** The "From a forge checkout" wrong-cwd framing is corrected in
  both `install.md` and `cross-gai.md` to match what `init.mjs:56` actually
  resolves (cwd-relative, not checkout-relative).
- **AC-433.3** A documented update path: re-run the existing emitter (see
  "Command vs. prose" below for why no new command is added), including the
  copy-install (`--out` + `agy plugin install`) variant.
- **AC-433.4** The committed-package decision is documented in `install.md`,
  and a regression test pins that `/forge:init` never adds `.agents/` to
  `.gitignore`.
- **AC-433.5** The emitted version is surfaced (via `plugin.json`), with
  staleness *detection* explicitly deferred to #431.

## Command vs. prose (AC.3 judgment call)

The ticket allows either; a thin command is preferred **only if it can reuse
the existing emitter**. Re-running `node <checkout>/plugin/scripts/init.mjs
--host agy` from the project directory **already is** the update mechanism —
`emit.mjs` is an idempotent, self-managing re-emit (confirmed: it clears and
rewrites its own owned output dir, `emitAgyPlugin` in `plugin/scripts/agy/emit.mjs:230-234`).
A wrapper command would do nothing but shell out to that exact one-liner, so
it would add an indirection layer with no new capability — not "thin", just
redundant. The real gap was that nobody was told this is the update path, and
nobody could tell what version they were on. Both are addressable in prose:
document "update = re-run the same command" plus where to read the pinned
version (`plugin.json`) and the source's own version (the checkout's
`plugin/.claude-plugin/plugin.json`, refreshed via `git pull`). Decision:
**prose, not a new command.** No code changes to the emitter are needed for
this ticket; #431's staleness *check* is left the seam of "compare these two
plugin.json version fields", stated plainly in the docs.

## Task 1 (docs): rewrite the Antigravity section of install.md (AC.1, AC.2, AC.3, AC.4, AC.5)

Replace the single-paragraph Antigravity section with three numbered steps
(clone, emit-from-project, commit) plus an "Updating later" paragraph and a
version-check pointer. Grounded entirely in the verified facts already on
the ticket and in `emit.mjs`/`init.mjs` — no invented mechanics.

**Files:** docs/guides/install.md

## Task 2 (docs): correct the wrong-cwd framing in cross-gai.md + add update/vendoring notes (AC.2, AC.3, AC.4)

Fix the prerequisites-table row and the Step 1 lead-in that currently say
"from the forge plugin source" / "From a forge checkout" — replace with the
correct cwd (the consumer's project). Add a short "Updating the emitted
package" section covering both the in-place and copy-install (`--out`)
variants, and one sentence in "What gets emitted" noting the package is
meant to be committed (cross-referencing install.md for the rationale, not
duplicating it).

**Files:** docs/guides/cross-gai.md

## Task 3 (test): grounding tests for the new/corrected doc content (AC.1-AC.5)

New vitest file mirroring the AC-423/AC-429 doc-assertion pattern
(`tests/docs/agy-install-docs.test.mjs`, `tests/docs/agy-ask-default.test.mjs`):
asserts the clone step, the project-cwd emit step, the committed-package
statement, the update-path prose, and the version-surfacing pointer are all
present in both files.

**Files:** tests/docs/agy-adoption-update.test.mjs

## Task 4 (test): regression pin for the gitignore/gitattributes behavior (AC.4)

`/forge:init` already only adds `.forge/` to `.gitignore` (confirmed by
reading `init.mjs` before writing any doc claim) — add a test asserting
`.agents/` never appears in the written `.gitignore`, so the AC.4 doc claim
has machine backing even though no gitignore logic itself is touched.

**Files:** tests/init.test.mjs

## Task 5 (test, pre-existing): update AC-423.2's now-incorrect exact-string assertion

`tests/docs/agy-install-docs.test.mjs`'s AC-423.2 test currently asserts the
literal substring `node plugin/scripts/init.mjs --host agy` appears in
`install.md` — that string *is* the wrong-cwd wording Gap 2 says must be
corrected, so pinning it forever would re-lock the bug this ticket fixes.
Updated to assert the corrected absolute-path invocation instead. Flagged
here for explicit reviewer sign-off per spec §13 (anti-gaming law) rather
than a blanket note.

**Files:** tests/docs/agy-install-docs.test.mjs

## Task 6 (docs): route index

Add this plan to `docs/README.md`.

**Files:** docs/README.md
