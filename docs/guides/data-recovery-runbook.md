# Data-recovery runbook — restore → verify → postmortem

**When:** the incident is data corruption or loss — bad migration, destructive bug, fat-fingered production query. **Order is law: restore → verify → postmortem.** Never debug against the only copy.

## 0. Stop the bleeding

- Freeze writes if the corruption is ongoing (maintenance mode / scale writers to zero). A growing blast radius beats any downtime cost.
- Note the **corruption window**: last-known-good timestamp → detection timestamp. Everything after last-known-good is suspect.

## 1. Restore

- Backups are **Terraform-owned per environment** (spec §10 data lifecycle) — the backup schedule and retention live in `infra/envs/<env>`; the restore target is a **new instance**, never in-place over the evidence.
- Restore the latest snapshot from *before* the corruption window.
- Point a **staging copy** of the app at the restored instance first — never production straight onto an unverified restore.

## 2. Verify

- Smoke against the staging copy: `node scripts/forge-smoke.mjs <staging-url>`.
- Domain checks: row counts vs the last-known-good metric, spot-check the records the incident report named, run the migration-status table against the app version.
- Only then swing production to the restored instance (this is a deploy-approval action — `team.policy.approvals.deploy`).
- **Data loss in the window is a disclosure decision**, not a technical detail: anything users wrote between snapshot and freeze is gone — escalate the disclosure note (forge:respond §3 applies even when the cause isn't security).

## 3. Postmortem (mandatory — the incident cannot close without it)

- Root cause, the window, what was lost, what the verify checks were, and **the guard that makes this class impossible** (migration test, constraint, backup-restore drill cadence).
- `node plugin/scripts/care/incident.mjs close --ticket <n> --postmortem "#<postmortem-ticket>"` — the journal pair is what `/distill` learns from.

**Standing discipline** (declared in spec §10 before the first schema change): migrations forward-only with a tested rollback story; CI runs them against a disposable instance; staging runs them before production. If this runbook is running because one of those was skipped, that goes in the postmortem too.
