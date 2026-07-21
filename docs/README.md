# forge — docs route index

One line per doc. Update this file whenever a doc lands, moves, or renames (`forge:ship` checklist item).

## Specs

- [Platform design spec](specs/2026-07-15-forge-platform-design.md) — the whole platform: pipeline skills, agent roster + backends, board automation, team model, escalation, learning loop, graph RAG, console. Start here.
- [forge-control spec](specs/2026-07-18-forge-control.md) — local agent management & control plane (SP9b local-first): orchestration mechanics, guardrails, epics C1–C5 on board #12.
- [forge:autopilot spec](specs/2026-07-21-forge-autopilot.md) — continuous autonomous board-clearing engine (epic #125, v0.9.0): the loop, selection order, the auto-merge bar that replaces the human PR gate, the only-pauses escalation model, run ledger + safety rails.
- [autopilot crazy mode spec](specs/2026-07-21-forge-autopilot-crazy-mode.md) — autonomous backlog shaping (epic #139): the `--shape` front door, `forge:shape`, the grounded-only boundary + ground gate, front-of-pipeline routing (ideate/brainstorm/spike/design).

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
- [Local web console](plans/2026-07-17-local-web-console.md) — tasks T1–T4 for #37: localhost serve, state + decide APIs, self-contained page.
- [Console UI v2](plans/2026-07-17-console-ui-v2.md) — tasks T1–T5 for #39: decision-flow defect fixes, a11y floor, identity variants + owner pick.
- [C1 — Control queue](plans/2026-07-18-c1-control-queue.md) — control queue + machine registry + CLI (forge-control epic; see the forge-control spec).
- [C2 — Control runner](plans/2026-07-19-c2-control-runner.md) — the forge-control runner that spawns + supervises headless sessions.
- [C3 — Console control tab](plans/2026-07-19-c3-console-control-tab.md) — the console's control tab: sessions, queue, command audit.
- [C4 — situationgate paused flag](plans/2026-07-19-c4-situationgate-paused.md) — situationgate reads the machine-level paused flag (global kill switch).
- [C5 — Dogfood end-to-end](plans/2026-07-19-c5-dogfood-end-to-end.md) — one real ticket end-to-end through the control queue.
- [C6 — Trace + conformance](plans/2026-07-19-c6-trace-conformance.md) — agent-work trace + structure-conformance badge.
- [C7 — Alerts](plans/2026-07-19-c7-alerts.md) — alerts on session/queue events.
- [C8 — Quota panel](plans/2026-07-19-c8-quota-panel.md) — Claude Code quota panel in the console.
- [Batch close](plans/2026-07-20-batch-close.md) — tasks for #123: comma-separated `--issue` in `board/close.mjs`.

## Design specs

- [Console — heat identity](design/2026-07-17-console.md) — visual spec for the local web console: situation-as-heat token system, states matrix, a11y contract.

## Decisions (ADRs)

- [ADR-0001 — Status field options](decisions/0001-status-field-options.md) — built-in Status options are GraphQL-mutable but replacement mints new IDs; init replaces on fresh (empty) projects only, maps-as-is on live boards.
- [ADR-0002 — Console/control distribution](decisions/0002-console-control-distribution.md) — *(superseded by ADR-0003)* the console + control plane ship as repo tooling run from a checkout, not in the packaged plugin (#91).
- [ADR-0003 — Remove forge-control + console](decisions/0003-remove-control-console.md) — the local control plane + console are removed (unused for a solo interactive workflow; token/scope reduction). Preserved in the v0.5.0 tag; the pipeline (skills/board/gates/care) is unaffected (#95).
- [ADR-0004 — Remove the multi-backend plane](decisions/0004-remove-multi-backend-plane.md) — the CLI role-swap / multi-backend plane (Plane B) is removed as unwired dead weight; role subagents stay Claude-native. Preserved in the v0.5.0 tag (#99).

## Guides

- [Install](guides/install.md) — forge into any project: prerequisites, marketplace install, init adopt-vs-create, doctor, per-feature wiring, superpowers migration.
- [Handbook](guides/handbook.md) — daily use: the laws, the cockpit, the Build loop, every human interaction point, care/knowledge/scale flows, gates + situations tables.
- [Troubleshooting](guides/troubleshooting.md) — known issues: update-not-visible ladder, statusline wiring overwrites, board drift, hooks, environment.
- [Rollback runbook](guides/rollback-runbook.md) — find the previous digest, redeploy it (one command), verify, record; forward-only-migration exception.
- [Data-recovery runbook](guides/data-recovery-runbook.md) — restore → verify → postmortem; never debug against the only copy.

## Feedback

- [iomanage feedback 0.1.0→0.3.0](feedback/iomanage-feedback-forge-0.3.0.md) — observed usage feedback across the early versions.
- [iomanage feedback ~0.5.0](feedback/iomanage-feedback-forge-0.5.0.md) — session feedback on forge ~0.5.0.
