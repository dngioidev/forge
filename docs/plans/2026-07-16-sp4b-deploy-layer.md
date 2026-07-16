# SP4b — Deploy layer — Implementation Plan

**Epic:** #5 · **Spec:** [platform design v3.7](../specs/2026-07-15-forge-platform-design.md) §10 §13
**Branch:** `feat/5-deploy-layer` · **Verify:** `pnpm verify` · **Date:** 2026-07-16

## Acceptance criteria

- **AC-4b.1** — `/forge:deploy-init`: copies the node-stack scaffold (digest-pinned non-root Dockerfile, `.dockerignore`, compose, terraform env dirs, three workflows, smoke script), substitutes app name / healthcheck / registry, writes the `deploy` block + `features.deploy: true` into forge.json; idempotent — existing files are never overwritten, only missing pieces land.
- **AC-4b.2** — Environment-branch workflows: push to `staging` builds the image (SHA-tagged), pushes to ghcr, deploys, smoke-tests; push to `production` **re-deploys the digest recorded for that commit** (build-once law — builds only when no staging build exists, i.e. single-env chains); both SHA-pinned, deploy step is an explicitly-marked per-cloud insert point with a Cloud Run reference example.
- **AC-4b.3** — Deploy-readiness gate workflow: path-filtered (Dockerfile/lockfile/src → image build + healthcheck boot; `infra/**` → terraform fmt/validate + plan dry-run).
- **AC-4b.4** — Smoke script: polls the healthcheck with retries/timeout, distinct exit codes; used by both deploy workflows and runnable locally.
- **AC-4b.5** — Doctor: when `features.deploy` is on, checks Dockerfile/compose/terraform/workflow presence with fix hints.
- **AC-4b.6** — Suite green on win+linux CI.

## Tasks

- **T1 — scaffold templates** (`plugin/templates/deploy/node/*`): Dockerfile (multi-stage, non-root `app` user, `node:22-alpine@sha256:b74031e5…` digest pin, HEALTHCHECK), `.dockerignore`, `docker-compose.yml` (local run), `infra/` skeleton (per-env dirs with gcs backend placeholder + observability module stub: uptime check, error alert, budget alert), workflows (deploy-staging / deploy-production / deploy-readiness), placeholders `{{APP}}` `{{HEALTHCHECK}}` `{{REGISTRY}}` `{{VERIFY}}`.
- **T2 — smoke script** (`plugin/scripts/deploy/smoke.mjs` + tests): `--url … --retries … --timeout …`; healthcheck polling, exit codes (0 healthy / 1 unhealthy / 2 bad args).
- **T3 — deploy-init** (`plugin/scripts/deploy/init.mjs`, `plugin/commands/deploy-init.md` + tests): stack detect (node v1), copy-missing-only, substitution, forge.json deploy block merge, gitignore additions (`.terraform/`), prints the environment-branch setup steps (create `staging` branch + protect it — human acts).
- **T4 — doctor deploy checks** (+ tests): behind `features.deploy`.
- **T5 — ship**: PR, trail, ritual. Honest note: no docker/terraform runtime on this machine — templates are structurally tested (placeholder substitution, YAML/HCL well-formedness by parse-lite checks), not executed; first real container build happens on a deploy-enabled consumer repo.

## Out of scope

Cloud-provider auth wiring (workload identity — consumer-repo one-time setup, documented in the workflow insert point) · migrations tooling (`deploy.migrations` consumers arrive later) · preview environments (backlog) · release retagging (SP4c).
