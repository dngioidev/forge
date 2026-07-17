---
name: maintain
description: Dependency cadence + CVE triage — patch/minor batched into one PR, majors bundled into one coordinated ticket, advisories on an SLA. Run on demand or as a scheduled routine.
---

# forge:maintain

The cms #70 lesson as platform law (spec §4 item 9): dependencies are **batched routine work, not a PR queue**. Twenty Dependabot PRs is a process failure, not diligence.

## Cadence ritual

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/care/maintain.mjs" plan` — outdated scan, classified patch/minor/major.
2. **Patch + minor → one batch**: ticket (type `chore`) → branch `chore/<issue#>-dep-batch-<date>` → apply every bump → verify green → **one PR** through the normal ship gates (depguard sees version changes, not new deps; testintent guards the suite). Auto-verified means the suite decides, not optimism — a bump that breaks verify drops out of the batch and gets its own line in the ticket.
3. **Majors → ONE coordinated upgrade ticket, never merged individually**: the plan output lists each major with its changelog link; triage them into a single ticket that names the order, the breaking changes, and the verify evidence each step needs. A major upgrade is planned work (forge:plan), not a checkbox.
4. Trail comments on the ticket at every step, delivery-log row on merge — routine work is still ticket-first.

## CVE triage (SLA is the law)

`node "${CLAUDE_PLUGIN_ROOT}/scripts/care/maintain.mjs" advisories` — open Dependabot alerts, SLA-stamped from each alert's own createdAt:

| severity | SLA |
| --- | --- |
| critical | 24h — treat as forge:hotfix input; if exploitation is suspected, forge:respond first |
| high | 72h |
| medium | 7 days |
| low | next maintain run |

Every open advisory becomes a ticket via forge:triage with its deadline in the body; ⏰ OVERDUE lines are the first thing the next session handles. Alerts disabled ⇒ the script says how to enable them — that setting is part of doctor's secret-scanning family of owner steps.

## Scheduling

On demand is the floor. For a routine: a consumer repo adds one cron workflow step calling `maintain.mjs plan --json` and opening/refreshing the batch ticket (spec row 11: pull earlier if Dependabot pain returns). forge itself runs on demand.
