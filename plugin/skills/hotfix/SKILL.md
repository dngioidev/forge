---
name: hotfix
description: Expedited production-incident path — compressed ritual, uncompressed deploy chain, mandatory postmortem. Use when production is broken and the fix can't wait for the normal plan cycle.
---

# forge:hotfix

The law (spec §4 item 8): **only the process ritual is compressed — the deploy path is not.** A hotfix skips the plan doc, not staging smoke.

## Steps

1. **Open the incident first**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/care/incident.mjs" open --ticket <n> --summary "<what production symptom>"` — the ticket (create via forge:triage if none exists, type bug, p0). The situation flips to 🔥 incident; ship/release now refuse non-hotfix branches mechanically (situation gate).
2. **Rollback-first decision**: can redeploying the previous image digest stop the bleeding now? If yes, run the [rollback runbook](../../../docs/guides/rollback-runbook.md) *before* writing any code — a rolled-back production buys the fix time. Data corruption → [data-recovery runbook](../../../docs/guides/data-recovery-runbook.md).
3. **Scope note replaces the plan**: one paragraph on the ticket (trail `--phase plan`) — symptom, suspected cause, intended change, blast radius. That's the whole planning ritual.
4. Branch `hotfix/<issue#>-<slug>` — the only branch kind the situation gate ships during an incident.
5. **What stays**: verify green locally · security pass on the diff · regression test with the fix (investigate first if the cause is unknown — forge:investigate) · honest verification in the PR.
6. **What the deploy keeps**: the full environment chain — merge → staging deploy → smoke → promote. It's minutes, not hours; a hotfix that skips staging is how one incident becomes two.
7. **Close = postmortem**: create the postmortem ticket (mandatory — close refuses without it), then `incident.mjs close --ticket <n> --postmortem "#<postmortem>"`. The incident event pair is what `/distill` learns production lessons from.

Trail comments at every step (started/plan/pr/ci-green/merged) — an incident is the last place for silent work.
