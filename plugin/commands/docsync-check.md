---
description: Read-only docs-structure check — every doc under docs/ linked in the route index, every new skill mentioned in the handbook, README version badge in sync
---

Run the docs-sync check from the repo root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/docsync.mjs"
```

It checks that every file under `docs/` is linked from `docs/README.md` (the route index), that any newly-added skill is mentioned in the handbook, and that the README version badge matches `package.json` — the same check `forge:ship` runs before a PR, exposed here to run on demand. It prints one ✗ line per gap with the exact fix (e.g. "docs/X is not linked in docs/README.md"), and exits nonzero when anything is out of sync. If `docs/README.md` doesn't exist yet, it says so and skips — this repo hasn't adopted the route-index convention.

Relay the results to the user:
- Clean: say the docs are in sync (state the doc count it indexed).
- Gaps: list each ✗ line with its fix hint. Route-index gaps are usually a one-line addition to `docs/README.md`; offer to add it. Skill-handbook gaps need a short description in `docs/guides/handbook.md`. A README badge gap means `package.json`'s version and the badge have drifted — usually from a release that didn't go through `forge:release`.

This command is read-only — it never mutates the repo.
