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
- [SP7 — Learning loop](plans/2026-07-17-sp7-learning-loop.md) — tasks T1–T6 for epic #9: capture hooks, /distill skill + mechanics, digest flow metrics.
- [SP8 — Graph RAG MCP](plans/2026-07-17-sp8-graph-rag.md) — tasks T1–T7 for epic #10: SQLite structural index, ts-morph indexer, MCP stdio tools, incremental reindex + ticket edges.
- [SP9a — Console daemon](plans/2026-07-17-sp9a-console-daemon.md) — tasks T1–T6 for epic #11: collectors, metadata-only sanitizer, file/Firestore transports, daemon once/watch + decision write-back.
- [SP10 — Hotfix + respond](plans/2026-07-17-sp10-hotfix-respond.md) — tasks T1–T6 for epic #13: incident mechanics, situation gate, backend freeze, hotfix/respond skills, rollback + data-recovery runbooks.
- [SP11 — Maintain](plans/2026-07-17-sp11-maintain.md) — tasks T1–T5 for epic #14: outdated scan, patch/minor batch plan, majors bundled, CVE triage with SLA.

## Decisions (ADRs)

- [ADR-0001 — Status field options](decisions/0001-status-field-options.md) — built-in Status options are GraphQL-mutable but replacement mints new IDs; init replaces on fresh (empty) projects only, maps-as-is on live boards.

## Guides

- [Console daemon](guides/console-daemon.md) — register/once/watch/status, file-transport layout, metadata-only guardrail, the Firebase follow-up step.
- [Rollback runbook](guides/rollback-runbook.md) — find the previous digest, redeploy it (one command), verify, record; forward-only-migration exception.
- [Data-recovery runbook](guides/data-recovery-runbook.md) — restore → verify → postmortem; never debug against the only copy.
