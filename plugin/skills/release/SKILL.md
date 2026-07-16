---
name: release
description: Cut a named release — semver from conventional commits, CHANGELOG, annotated tag, GitHub Release, artifact naming. Use after merges when the owner wants a release, or before promoting deploy repos to production.
---

# forge:release

"Merged" → "a deployable artifact with a name" (spec §4 item 7). Release **names** artifacts, it never builds them.

## Timing rule (spec §4)

- **Deploy repos** (`features.deploy`): release *after* the staging merge + smoke pass — there must be a verified digest to name. Production then promotes the release-named digest.
- **Library/non-deploy repos**: release any time after merge.

## Steps

1. Preview first: `node "${CLAUDE_PLUGIN_ROOT}/scripts/release/release.mjs" --dry-run` — relay the readiness checklist, computed version, and changelog section to the user.
2. On the user's go: run without `--dry-run`. The script enforces the readiness checklist (refuses on: not-main, dirty tree, behind remote, verify failing, open critical findings, empty delta), prepends CHANGELOG, commits `chore(release): vX.Y.Z`, creates the annotated tag, pushes, and publishes the GitHub Release with the generated description shape (summary · grouped changes with ticket links · deploy notes · image digest).
3. Relay the follow-ups the script prints: image retag command (deploy repos — run where docker is available) and npm publish (public packages only).
4. Trail-comment the epic/driving ticket (`--phase note`) with the release link.

Never move or delete an existing `v*` tag; never release from a branch. If the checklist fails, fix the cause — do not bypass.
