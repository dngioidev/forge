---
name: spike
description: Time-boxed research — throwaway exploration on a spike branch that never merges; the deliverable is a findings doc or ADR. Use for "which library", "is X possible", "prototype this" questions.
---

# forge:spike

Finding out, not building (spec §4 item 12). Opposite rules from the Build lane, on purpose.

**Optional Gemini offload (opt-in):** a spike is exploratory and non-gating, so when `features.agy` is on it's a natural place to spend the shared Gemini quota — `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy/ask.mjs" --question "…"` for read-only codebase Q&A, or the second-opinion helper for a cross-model take. Advisory; the ADR still records *your* verified findings, not the model's raw output.

## Rules

- **Time-boxed**: agree the box up front (default: half a day). When it expires, write up what you have — "inconclusive, here's what we learned" is a legitimate finding.
- **Branch**: `spike/<issue#>-<slug>`. It **never merges** — forge:ship refuses spike branches; the branch is deleted after the write-up. Code quality rules don't apply here; TDD doesn't apply here.
- **Ticket-first still applies**: spikes have tickets (type `item`, the question as the title, "decision recorded" as the AC).

## Steps

1. State the question and the decision it feeds in one sentence each — a spike without a decision attached is procrastination.
2. Explore on the spike branch: prototype, measure, read source, try the API. Optimize for information per hour.
3. Write the finding as a numbered ADR in `docs/decisions/` (next number; context → finding → decision → consequences) or, when it's purely informational, a findings note the brainstorm spec links to.
4. Route index + trail comment (`--phase note`, link the ADR) + close or hand the ticket to its consumer (brainstorm/plan).
5. Delete the spike branch: `git branch -D spike/<…>` — anything worth keeping is *re-implemented properly* through plan/execute, never cherry-picked.

Escalate when the finding invalidates an approved spec or implies spend (paid services, new infra) — that's a decision, not a finding.
