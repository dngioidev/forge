---
description: Quick ticket create — issue + board placement + fields in one step
---

Create a ticket on the forge board from the user's description.

1. Derive from the request (ask only for what's genuinely ambiguous): title (imperative, concise), body (1–3 sentence description + acceptance criteria bullets when clear), type (`item`/`bug`/`epic`/`test`), priority (`p0` urgent / `p1` normal / `p2` later), size (`xs`–`xl`), parent epic number if the user names one.
2. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board/create.mjs" --title "<title>" --body "<body>" --type <type> --priority <p> --size <s> --status backlog [--parent <epic#>] [--assignee <login>]
```

3. Report the created issue number + link. The script is idempotent — an existing issue with the same title is reused, never duplicated.

This is the create-wrapper only; judgment-heavy triage (dedup search, AC quality, correct typing of vague reports) is `forge:triage` (SP3).
