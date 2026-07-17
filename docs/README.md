# forge — docs route index

One line per doc. Update this file whenever a doc lands, moves, or renames (`forge:ship` checklist item).

## Specs

- [Platform design spec](specs/2026-07-15-forge-platform-design.md) — the whole platform: pipeline skills, agent roster + backends, board automation, team model, escalation, learning loop, graph RAG, console. Start here.

## Plans

- [SP1 — Plugin skeleton](plans/2026-07-16-sp1-plugin-skeleton.md) — tasks T1–T8 for epic #1: manifests, lib, init/doctor, status line, Status-options spike.
- [SP2 — Board automation](plans/2026-07-16-sp2-board-automation.md) — tasks T1–T10 for epic #2: boardctx lib + create/move/comment/receipt/log/digest/status scripts, forge:board skill.
- [SP3 — Ship + triage + escalation](plans/2026-07-16-sp3-ship-triage-escalation.md) — tasks T1–T9 for epic #3: journal, escalate/resolve, situation, denylist hook, CI template, ship/triage/investigate skills.
- [SP4 — Roster + backends](plans/2026-07-16-sp4-roster-backends.md) — tasks T1–T9 for epic #4: 11 role cards, compile, loader allowlist, agy adapter + fallback, pre-send scan, backends sync, forge:review.
- [SP4b — Deploy layer](plans/2026-07-16-sp4b-deploy-layer.md) — tasks T1–T5 for epic #5: node deploy scaffold, env-branch workflows, deploy-readiness gate, smoke script, deploy-init.
- [SP4c — Release](plans/2026-07-16-sp4c-release.md) — tasks T1–T5 for epic #6: bump derivation, changelog, readiness checklist, tag + GitHub Release, image retag.
- [SP5 — Plan + execute](plans/2026-07-16-sp5-plan-execute.md) — tasks T1–T7 for epic #7: ledger, AC gate, plan-drift, dep guard, test-intent gate, plan/execute skills.
- [SP6 — Front of pipeline](plans/2026-07-17-sp6-ideate-brainstorm-spike-design.md) — tasks T1–T6 for epic #8: ideate/brainstorm/spike/design skills, visual-spec template + lint.

## Decisions (ADRs)

- [ADR-0001 — Status field options](decisions/0001-status-field-options.md) — built-in Status options are GraphQL-mutable but replacement mints new IDs; init replaces on fresh (empty) projects only, maps-as-is on live boards.

## Guides

_(none yet — install/init/backends/console runbooks land with their sub-projects)_
