# Rollback runbook — redeploy the previous image digest

**When:** production is broken and the last deploy is the suspect. Rollback first, diagnose second — a rolled-back production buys the fix time (forge:hotfix step 2).

**Principle:** production runs **digests, not branches** (spec §10, build-once). Rolling back = pointing the service at the digest that was running before. No build, no merge, no code.

## 1. Find the previous digest

Every promotion is recorded; check in this order:

1. The **delivery log** issue / release notes — each release body names the promoted digest.
2. The registry: the previous release's semver tag (`v<prev>`), or the staging SHA tag that release retagged.
3. The running service's own history (e.g. `gcloud run revisions list` / `docker service ps` — the platform keeps prior revisions).

## 2. Redeploy it — one command

The production deploy workflow deploys a named digest; give it the previous one:

```
gh workflow run deploy-production.yml -f digest=<registry>/<app>@sha256:<previous>
```

(or the platform-native one-liner, e.g. `gcloud run services update-traffic <app> --to-revisions <prev-revision>=100` — whatever the repo's `deploy` block names as the promote command.)

**This is a production action — `team.policy.approvals.deploy` applies.** The decision comment approving the rollback *is* the authorization; don't wait for a "cleaner" moment.

## 3. Verify

- Smoke: `node scripts/forge-smoke.mjs <production-url>` — exit 0 required.
- The incident symptom is gone (check the alert/report that opened the incident).

## 4. Record

- Trail note on the incident ticket: previous digest, rolled-back-at, verified-by.
- The **incident stays open** — rollback is containment, not the fix. The fix ships via forge:hotfix; the postmortem closes the incident.

**Forward-only exception:** if the bad deploy ran **irreversible migrations** (spec §10 data lifecycle), plain rollback can crash the old code against the new schema — switch to the [data-recovery runbook](data-recovery-runbook.md) decision tree first.
