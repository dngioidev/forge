# forge plugin — feedback (observed 0.1.0 → 0.3.0)

Collected while bootstrapping and running the `iomanage` board. File/line refs are the
installed **0.3.0** cache: `~/.claude/plugins/cache/forge/forge/0.3.0/`.

---

## Confirmed bugs (still live in 0.3.0)

### BUG-1 — `createSingleSelectField` sends options as a stringified `-F`; field creation always fails
- **Where:** `scripts/lib/board.mjs` (`createSingleSelectField`).
- **What:** builds the mutation with `gh api graphql -F options=<JSON array>`. `gh -F` delivers
  the value as a *string*, so the GraphQL API rejects it:
  `Variable $options … Expected … to be a key-value object`.
- **Impact:** every `forge:init --create-project` dies when it creates the Type/Status/
  Priority/Size fields. Invisible only on repos where those fields already exist.
- **Repro:** run `forge:init` in create-project mode against a brand-new Project.
- **Fix (worked locally):** build the mutation with inline literals, exactly like the file's
  own `buildStatusMutation`. Patch is lost on every plugin update; 0.1.0/0.2.0/0.3.0 all ship
  it unpatched.

### BUG-2 — `denylist` force-push rule false-positives on chained `gh … -f`
- **Where:** `hooks/denylist.mjs:15`
  `test: (c) => /\bgit\b[^\n]*\bpush\b/.test(c) && /(\s--force\b(?!-with-lease)|\s-f\b)/.test(c)`
- **What:** the two sub-patterns match the **whole command string**, not one sub-command. A
  compound line like `git push … && gh api graphql -f query=…` trips "force-push" because
  `git push` appears somewhere and the unrelated `gh -f` matches `\s-f\b`.
- **Impact:** blocked legitimate board mutations all project; had to split git push and
  `gh … -f` into separate calls.
- **Fix:** tokenize on `&&` / `;` / `|` and test each segment independently, or require
  `-f`/`--force` to be an argument of the `git push` invocation specifically.

### BUG-3 — `forge:init --create-project` is not idempotent
- **What:** because BUG-1 kills init *after* the Project is created, each failed run leaves an
  orphan GitHub Project. Re-running `--create-project` makes another orphan instead of resuming.
- **Fix:** checkpoint (write partial `forge.json`) as soon as the project exists so a re-run
  adopts it; or detect an owned same-name project and offer adoption (`--project <n>`).

---

## Friction (not bugs, but cost time)

- **No re-parent script.** Restructuring the tree required hand-written GraphQL `addSubIssue`
  with `replaceParent`. A `board/reparent.mjs --issue <n> --parent <m>` would cover a common refactor.
- **`create.mjs` has no batch mode.** N tickets = N sequential `gh` round-trips, which blows the
  2-minute tool timeout; had to shard into ≤4/batch. A `create.mjs --from tickets.json` fixes both.
- **"Program" type isn't first-class.** A project-tracker parent can't be `type: epic`, but init
  only seeds epic/item/bug/test. Had to add a `program` option in the GitHub UI and hand-sync
  `forge.json`. Worth seeding by default (or documenting the tracker pattern).
- **`doctor` secret-scanning check can't be satisfied on a private free-plan repo** and stays a
  permanent ⚠. Doctor could detect plan/visibility and say "n/a on this plan" instead.
- **Version-path drift in skills (historical).** The `board-status` skill once hard-coded
  `…/forge/0.2.0/scripts/board/status.mjs` while other skills pointed at 0.3.0 — a stale absolute
  path survives a plugin bump. Appears resolved by the 0.3.0 `board` skill restructure; flagging in
  case the hard-coded-version pattern recurs.

---

## What worked well (keep it)

- **`escalate.mjs` decision-comment mechanism** — one consistent path for every human decision
  (spec approval, blocked questions, ADR sign-off). Carried the whole architecture phase.
- **Plan grammar as a contract** — machine-parseable `**Files:**` / `**AC map:**` / `AC-n.x`
  lines made plans load-bearing, not decorative.
- **spike → ADR → brainstorm → plan lane separation** — "spikes never merge, write the finding as
  a numbered ADR" produced a clean `docs/decisions/` trail (0001–0004) without polluting the build lane.
- **`digest.mjs` + trail comments** kept a 30+ item board readable.
- **statusline** — ticket/branch/context strip was useful day to day.

---

# Ready-to-paste GitHub issues

## Issue 1 — `forge:init --create-project` fails: field options sent as string

**Labels:** bug, init

`createSingleSelectField` in `scripts/lib/board.mjs` sends the options array via
`gh api graphql -F options=<JSON>`. `gh -F` delivers the value as a string, so the API rejects it:

```
Variable $options ... Expected ... to be a key-value object
```

Every `forge:init --create-project` against a new GitHub Project fails when creating the
Type/Status/Priority/Size single-select fields. Repos whose fields already exist are unaffected,
which hides the bug.

**Repro:** `forge:init` in create-project mode against a brand-new Project.

**Fix:** build the mutation with inline literals like the file's own `buildStatusMutation`, instead
of passing the array through `-F`.

**Aggravating factor:** init creates the Project *before* this step, so each failed run leaves an
orphan Project and `--create-project` is not idempotent. Consider checkpointing forge.json (or
adopting an existing same-name project) so re-runs resume instead of orphaning.

---

## Issue 2 — denylist force-push rule false-positives on chained `gh … -f`

**Labels:** bug, hooks

`hooks/denylist.mjs:15`:

```js
test: (c) => /\bgit\b[^\n]*\bpush\b/.test(c) && /(\s--force\b(?!-with-lease)|\s-f\b)/.test(c),
```

Both sub-patterns match the whole command string rather than a single sub-command. A compound like:

```sh
git push origin my-branch && gh api graphql -f query='...'
```

is blocked as "force-push" because `git push` appears and the unrelated `gh -f` matches `\s-f\b`.

**Impact:** legitimate board mutations chained after a push are blocked.

**Fix:** split the command on `&&` / `;` / `|` and test each segment, or require `-f`/`--force`
to belong to the `git push` invocation specifically.

---

## Issue 3 — quality-of-life: batch create + re-parent scripts

**Labels:** enhancement, board

Two gaps hit during a normal decomposition/restructure:

1. **No batch create.** `create.mjs` does one `gh` round-trip per ticket; creating ~9 tickets
   exceeds a 2-minute tool timeout and forces manual sharding. Request: `create.mjs --from tickets.json`.
2. **No re-parent.** Moving an item to a different epic requires hand-written GraphQL
   `addSubIssue` with `replaceParent`. Request: `board/reparent.mjs --issue <n> --parent <m>`.
