# Plan: #550 - init: creating the standard 'Type' field fails — GitHub now reserves the name for the built-in issue Type field

**Ticket:** #550 (board #8) - **Kind:** bug - **Parent:** epic #182
**Base:** main - **Branch:** fix/550-reserved-type-field-name - **Verify:** `pnpm verify`

## Task T1 — rename the kind field to a non-reserved name, alias it back to config key `type`

**Kind:** fix. **AC-IDs:** AC-550.2, AC-550.5

GitHub Projects v2 now reserves the literal field name "Type" for its
built-in issue-type field, so `createProjectV2Field` rejects any attempt to
mint a *new* field called "Type". forge's kind dimension (config key `type`)
is created under the non-reserved name "Kind" on new boards
(`STANDARD_FIELD_NAMES.type` in `lib/board.mjs`, consumed by `init.mjs`'s
field-creation loop). `getProjectFields` (`lib/board.mjs`) aliases a
`fields['kind']` entry to the `type` key whenever no `fields['type']` entry
already exists — so a board carrying a grandfathered custom field literally
named "Type" (this repo's own board #8, see `.claude/forge.json` →
`board.fields.type.id`) keeps resolving via the legacy name with no
forge.json edit, and the alias prefers the legacy name if a board somehow
carries both. Every downstream consumer (`lib/config.mjs` FIELD_KEYS,
`board/create.mjs`, `lib/boardctx.mjs`) is untouched — they only ever read
the config key `type`, never the GitHub display name.

**Files:** plugin/scripts/lib/board.mjs, plugin/scripts/init.mjs

**Test plan:** `AC-550.2` in `tests/init.test.mjs` unit-tests
`getProjectFields` aliasing directly — a new "Kind" field aliases to `type`,
a legacy "Type" field aliases to `type`, and a legacy "Type" wins over "Kind"
when a board somehow has both. `AC-550.5` end-to-end covers both bootstrap
paths against the injected `gh` double: fresh `--create-project` creates
Status/Priority/Size/Kind and maps Kind into config key `type`; adopt-mode
`--project <n>` against board #8's grandfathered "Type" field completes with
zero `createProjectV2Field` calls.

## Task T2 — a rejected field-create degrades to a warning, not an abort

**Kind:** fix. **AC-IDs:** AC-550.1, AC-550.3

`init.mjs`'s step-4 field loop previously did
`if (!r.ok) return { ok: false, ... }` on the first `createProjectV2Field`
rejection, aborting the whole run before forge.json was ever written — the
exact failure mode in the bug report (`fresh mode` dies after creating
priority/size, `adopt mode` re-run dies at the same step every time). The
loop now logs a `fields: WARNING could not create "<name>" (<key>) — <error>`
line and continues to the next field instead of returning early, and step 6
(write forge.json) only includes a field's config entry when it actually
resolved live (pre-existing or just created) — a rejected field is simply
omitted rather than crashing on `toConfigField(undefined)`. Steps 5-10 (delivery
log, forge.json, gitignore/gitattributes, CI template, docs scaffold,
statusline, doctor) all still run.

**Files:** plugin/scripts/init.mjs

**Test plan:** `AC-550.1`/`AC-550.3` in `tests/init.test.mjs` reproduces the
report through the injected `gh` double — a project whose fields query
returns no type/kind node, whose `createProjectV2Field` call for the kind
field is rejected with GitHub's literal reserved-name error text — and
asserts init still returns `ok:true`, priority/size are still created, the
warning is logged, and forge.json is written (without a `type` entry, since
nothing resolved live).

## Task T3 — doctor calls out a missing kind field by name

**Kind:** fix. **AC-IDs:** AC-550.4

`doctor.mjs`'s board-ids-resolve block previously only ran when
`cfg.ok` was true (a fully valid forge.json), so a board whose `type` key
never got written (Task T2's degraded path) surfaced only as a generic
`board.fields.type: missing` config error with no explanation of *why*
(GitHub's name reservation) or *how* to recover. A new check runs off the
live project fields whenever `board.projectId` is present and well-shaped —
independent of whether the rest of forge.json validated — and reports a
distinct `kind-field` finding: fail with an actionable hint
(`re-run /forge:init to create it — GitHub reserves the literal name "Type"
… so forge creates "Kind"`) when neither "Kind" nor legacy "Type" resolves
live, ok naming which one did when one does.

**Files:** plugin/scripts/doctor.mjs

**Test plan:** `AC-550.4` in `tests/doctor.test.mjs` — a board missing the
kind field under both names is a distinct `kind-field` fail with the
reserved-name hint; a board with a grandfathered "Type" field (this repo's
own board #8 shape) resolves to `kind-field` ok.
