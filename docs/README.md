# forge — docs route index

One line per doc. Update this file whenever a doc lands, moves, or renames (`forge:ship` checklist item).

## Specs

- [Platform design spec](specs/2026-07-15-forge-platform-design.md) — the whole platform: pipeline skills, agent roster + backends, board automation, team model, escalation, learning loop, graph RAG, console. Start here.

## Plans

- [SP1 — Plugin skeleton](plans/2026-07-16-sp1-plugin-skeleton.md) — tasks T1–T8 for epic #1: manifests, lib, init/doctor, status line, Status-options spike.

## Decisions (ADRs)

- [ADR-0001 — Status field options](decisions/0001-status-field-options.md) — built-in Status options are GraphQL-mutable but replacement mints new IDs; init replaces on fresh (empty) projects only, maps-as-is on live boards.

## Guides

_(none yet — install/init/backends/console runbooks land with their sub-projects)_
