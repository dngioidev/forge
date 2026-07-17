# SP10 — forge:hotfix + forge:respond + runbooks + incident capture

**Ticket:** #13 · **Branch:** `feat/13-hotfix-respond` · **Spec:** §4 items 8/13/18, §7 situation gating, §8 incident capture, rollout row 10.

The Care lane's emergency half. Two laws drive the design: **only the process ritual is compressed — the deploy path is not** (hotfix), and **containment before code** (respond). Situations must change what's *allowed*, mechanically — not what a skill politely suggests.

## Tasks

- [ ] T1 — Incident mechanics: `plugin/scripts/care/incident.mjs` — `open --ticket --summary` / `close --ticket --postmortem` (journal `incident` events, phase open/closed — exactly what `deriveSituation` already consumes) · `respond-open --reason` / `respond-close --postmortem`. Each command prints the derived situation after writing, so the operator sees the flip.
- [ ] T2 — Situation gate: `plugin/scripts/gates/situationgate.mjs` — `--action ship|release|backend [--branch <name>] [--skill <name>]`. Rules (spec §7): `security-response` ⇒ only respond/investigate skills proceed; ship, release, and CLI backends refused. `incident` ⇒ ship allowed for `hotfix/*` branches only; release refused. Teaching messages name the unlocking command.
- [ ] T3 — Wiring: `runrole.mjs` routes CLI-backend roles to the Claude fallback during `security-response` (journaled — repo content must not reach third-party models during a suspected leak); `readiness.mjs` gains a situation item (release never ready during incident/security-response).
- [ ] T4 — Skills: `plugin/skills/hotfix/SKILL.md` (compressed ritual: one-paragraph scope note replaces the plan doc; security gate + verify stay; env chain + staging smoke stay; incident journal open at start, close at postmortem; **postmortem ticket is mandatory**, rollback-first decision point) · `plugin/skills/respond/SKILL.md` (containment checklist before any code: rotate/revoke, freeze deploys, `respond-open`; forensics from journal + prompt hashes; scrub-and-rotate over history rewrites; disclosure note when users affected; fix hands off to hotfix; `respond-close` only after postmortem) · `forge:ship` gains the situation-gate step.
- [ ] T5 — Runbooks: `docs/guides/rollback-runbook.md` (redeploy the previous image digest — one command, plus how to find the digest) · `docs/guides/data-recovery-runbook.md` (Terraform-owned backup → restore → verify → postmortem).
- [ ] T6 — Tests + live dogfood: open a real incident on this repo, watch `status`/statusline flip to 🔥 and the gate refuse a non-hotfix ship, close it, watch it clear.

**Files:** plugin/scripts/care/incident.mjs, plugin/scripts/gates/situationgate.mjs, plugin/scripts/backends/runrole.mjs, plugin/scripts/release/readiness.mjs, plugin/skills/hotfix/SKILL.md, plugin/skills/respond/SKILL.md, plugin/skills/ship/SKILL.md, docs/guides/rollback-runbook.md, docs/guides/data-recovery-runbook.md, docs/README.md

## Acceptance criteria

- AC-10.1 — `incident open` flips the derived situation to `incident`; `close` (with postmortem ref) clears it; events carry ticket + summary for /distill.
- AC-10.2 — `respond-open` flips to `security-response`, which outranks a simultaneously open incident; `respond-close` clears it.
- AC-10.3 — situation gate: during `incident`, ship passes for `hotfix/*` and refuses other branches and release; during `security-response`, only respond/investigate skills pass; teaching messages name the unlocking command.
- AC-10.4 — `runRole` sends a CLI-pinned role to the Claude fallback during `security-response` and journals why; Claude roles are untouched.
- AC-10.5 — release readiness fails with a `situation` item during incident/security-response and passes once cleared.
- AC-10.6 — skills + runbooks carry the laws verbatim-checkable: mandatory postmortem, containment before code, deploy path not compressed, scrub-and-rotate over history rewrites, restore→verify→postmortem order.

## Out of scope

- Observability alert wiring that *opens* incidents automatically (uptime check → incident event) — needs live cloud infra (SP4b stubs + owner provisioning); the manual `incident open` path is the contract it will call.
- Situation-aware pausing of `degraded`/`paused`/`migrating` — their signals arrive with SP9b (quota/kill-switch) and forge:migrate.
- The postmortem *template* beyond the runbook checklists — /distill already consumes incident events; a doc template can land with forge:docs.
