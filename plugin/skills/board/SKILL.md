---
name: board
description: Ticket operations for the forge board — create/move/comment/receipt/log/digest/status. Use for ANY board or ticket work instead of raw gh GraphQL; also defines the ticket-trail moments every skill must post.
---

# forge:board

All ticket/board operations go through `plugin/scripts/board/*` — never hand-build GraphQL in a session (spec §6). Every script is idempotent: re-runs resume or update, never duplicate. IDs come from `.claude/forge.json`.

Run any script as: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board/<script>.mjs" <args>`

| Script | Use | Key args |
| --- | --- | --- |
| `create.mjs` | new ticket, fully placed | `--title` `--body` `--type item\|bug\|epic\|test` `--priority p0..p2` `--size xs..xl` `--status backlog` `--parent <epic#>` `--assignee <login>` |
| `move.mjs` | status transition | `--issue N --status backlog\|ready\|inProgress\|inReview\|blocked\|done` (keys from forge.json) |
| `comment.mjs` | ticket-trail comment | `--issue N --phase <phase> --body "…"` — same phase twice updates in place |
| `receipt.mjs` | merge receipt | `--issue N --pr N --sha <sha> --title "…"` |
| `log.mjs` | delivery-log row | `--pr N --sha <sha> --issues "1,2" --title "…"` |
| `digest.mjs` | refresh epic child table | `--epic N` — rewrites only the managed block in the epic body |
| `status.mjs` | catch-up card | no args |

## Ticket-trail moments (platform law, spec §6)

Post `comment.mjs` on the driving ticket at every one of these moments — the owner follows work from the issue, not the session:

- `started` — work begins: branch name, board → inProgress (also run `move.mjs`)
- `spec` / `plan` — doc ready: link it
- `pr` — PR opened: link + AC status
- `gate-fail` — a gate or CI failed: which, why, the fix
- `escalation` — halted on a human decision (also `move.mjs --status blocked`)
- `ci-green` — all checks pass, ready for merge
- `merged` — use `receipt.mjs` + `log.mjs` + `move.mjs --status done` + `digest.mjs --epic <parent>` instead
- `note` — unplanned in-scope work (the silent-side-work rule)

Bodies are caveman-terse: one or two lines, links over prose.
