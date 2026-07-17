---
name: distill
description: Journal → clustered repeats → human-approved lessons (CLAUDE.md rules, role-card edits, guards, memory) → archive. Run after each epic ships or weekly; never auto-run.
---

# forge:distill

The learning loop's second half (spec §8). Capture is automatic (hooks feed `.forge/journal.jsonl`); distill is **permanently human** — it sits above the automation-ladder ceiling with production promote and `terraform apply`. No level of `policy.autoApprove` ever runs it.

## Laws

- **A maintainer approves each proposal individually** before anything is written. "Apply all" is offered, batch-approved silently is not.
- **Applied lessons land as a PR** — in a team they get reviewed like any other change; solo, the owner merges like any other change. Ticket-first applies (one `chore` ticket per distill round).
- **Rejected clusters keep their evidence**: the archive holds everything; only the live journal starts empty.

## Steps

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn/distill.mjs"` — reads the live journal, clusters repeats by kind + signature, proposes per cluster one of: **CLAUDE.md rule** · **role-card edit** · **new lint/hook guard** · **memory entry**. One-offs are listed but get no proposal — no pattern yet.
2. Walk the maintainer through each proposal: the cluster's evidence (count, sample error, journal refs), the proposed lesson, and where it would live. Record yes/no per proposal.
3. Apply the approved ones on a ticketed branch; each applied lesson's commit message cites the journal refs. Open the PR through `forge:ship`.
4. `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn/distill.mjs" --archive` — the journal moves to `.forge/journal-archive/<date>.jsonl` and the live journal starts empty.
5. Trail comment (`--phase note`) on the distill ticket: clusters seen, lessons applied, lessons rejected.

Cadence: after each epic ships, or weekly — whichever comes first. An empty report ("nothing to distill") is a fine outcome; don't invent lessons.
