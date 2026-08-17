---
name: triage
description: One incoming bug/idea → correctly-typed ticket with acceptance criteria and board placement. Use for any new piece of work that isn't already ticketed (single items; whole feature areas go to forge:ideate).
---

# forge:triage

One incoming item → a well-formed ticket. Ticket-first is law: no work starts without one.

## Steps

1. **Dedup first** (spec §4): search open items — `gh issue list --search "<keywords> in:title"` and check the board — before creating anything. Probable match → comment the new information onto the existing ticket and link it to the requester; do NOT create a duplicate.
2. **Classify**:
   - `bug` — something built is wrong. Reproduce or note "unconfirmed" in the body; unknown-cause bugs get a `forge:investigate` pass before sizing.
   - `item` — new work. `test` — test-only work. `epic` — decomposable (route whole feature areas to `forge:ideate` instead).
3. **Priority map**: p0 = production broken / security / data loss (consider `forge:hotfix` instead of the normal flow). p1 = current-epic work, real-user pain. p2 = everything that can wait.
4. **Acceptance criteria**: 2–5 verifiable bullets, each testable — they become AC-IDs at plan time (spec §13). A bug's first AC is always "regression test reproducing the report passes." Write the section under a heading `isShaped()` recognises (`plugin/scripts/autopilot/readiness.mjs`) so autopilot's readiness gate classifies the ticket shaped instead of escalating it for a spelling reason (#491): a heading containing "Acceptance" — optionally with one qualifier word ahead of it ("Suggested acceptance criteria", "Draft acceptance criteria") or trailing qualifiers after it ("Acceptance criteria (this ticket's scope)") — and AC ids spelled `AC-1`, `AC1`, or `AC.1`. A project's `forge.json` can extend the heading list (`readiness.acHeadings`) for a fully custom or localized heading string.
5. **Create** via the board script (never raw GraphQL):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board/create.mjs" --title "…" --body "…" --type <t> --priority <p> --size <s> --status backlog [--parent <epic#>] [--assignee <login>]
```

6. Report the ticket link + one-line summary of type/priority/size reasoning.

Vague reports: ask at most one clarifying round; otherwise ticket what is known, mark the gaps in the body, and let investigate fill them.

## Report contract

When run as a spawned subagent (`autopilot/SKILL.md` § Orchestration, `action: triage`), end with the terminal JSON the orchestrator consumes: `{"issue":<n>,"verdict":"pass|fail","outcome":"ready|escalated|skipped","sequencedBehind":<n>|null,"reason":<string>|null}`.

`verdict` and `outcome` are not independent axes for triage — three pairings occur:

- **`verdict:"pass"` → `outcome:"ready"`** — the ticket is now correctly typed with acceptance criteria and board placement, confirmed deliverable now. The orchestrator records it via `ledger.mjs` `applyOutcome` with `stage:"triage"` and the ticket re-enters the autopilot queue as `deliver` on the next iteration — the same re-entry mechanics `autopilot/SKILL.md` documents for `shape`'s `outcome:"ready"`.
- **`verdict:"pass"` → `outcome:"skipped"`** (#487) — the ticket is well-specified and WOULD be deliverable, but triage deliberately declines to promote it because it is genuinely sequenced behind another open ticket (`sequencedBehind: <N>`, `reason` naming why — e.g. "sequenced behind #457: the schema #457 introduces is a hard prerequisite"). This is a work-ordering call, not a product decision, so it is triage's own to make — never escalate merely because a ticket isn't first in line. Before reporting this outcome, verify `sequencedBehind` names a real, currently OPEN issue (`gh issue view <N> --json state,title` — the same sanity check § Steps 1's dedup search already does, extended here) — a typo'd or already-closed number parks the ticket with nothing to ever clear it (`resolveDependencies` only clears on an observed `CLOSED` transition). Board status stays `backlog`; the orchestrator additionally records the verdict — `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/dependencies.mjs" record --issue <n> --depends-on <sequencedBehind> --reason "<reason>"` (`lib/dependencies.mjs` `recordDependency`, `autopilot/SKILL.md` § Selection) — so the ticket has a durable resting place and is not re-selected — and re-triaged from scratch — on every subsequent pass. It becomes selectable again automatically once `sequencedBehind` closes (`resolveDependencies`, checked every `select.mjs` invocation) — no re-triage needed.
- **`verdict:"fail"` → `outcome:"escalated"`** — the ask or acceptance criteria can't be pinned down without a product decision. Escalate-and-skip via the auto-triage front door (`autopilot/SKILL.md` § Auto-triage front door): the ticket is parked, the loop moves to the next one.

There is no `verdict:"pass"` paired with `outcome:"escalated"`, nor `verdict:"fail"` paired with `outcome:"ready"`/`"skipped"` — an escalation is always a fail, and both `ready` and `skipped` are always a pass (the difference between them is ORDERING, not READINESS — `skipped` still means "correctly specified," just "not yet, and here's the durable reason why not").

**Never use `outcome:"skipped"` for anything other than a genuine work-ordering dependency on another OPEN ticket number.** A ticket that's merely low-priority, or blocked on something with no issue number to watch (an environment/tooling gap, a pending human decision), is a different case — `escalated`/pending-decision or a size/priority call, not `skipped`. `skipped` exists specifically so a `dependsOn` issue can be polled for closure; using it for anything unpollable leaves the ticket parked with no path back into the queue (`autopilot/SKILL.md` § Selection notes this gap honestly for the environment-dependency case, which `skipped` does not cover).
