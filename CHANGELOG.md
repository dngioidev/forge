# Changelog

## v0.4.0 — 2026-07-19

### Docs

- record iomanage 0.3.0 field feedback
- C8 quota panel (#79) ([#79](https://github.com/dngioidev/forge/issues/79))
- C7 alerts (#77) ([#77](https://github.com/dngioidev/forge/issues/77))
- C6 agent-work trace + structure conformance (#74) ([#74](https://github.com/dngioidev/forge/issues/74))
- add control/README.md operator guide (#71) ([#71](https://github.com/dngioidev/forge/issues/71))
- C5 dogfood one real ticket end-to-end (#70) ([#70](https://github.com/dngioidev/forge/issues/70))
- C4 situationgate reads paused flag (#68) ([#68](https://github.com/dngioidev/forge/issues/68))
- C3 console control tab (#66) ([#66](https://github.com/dngioidev/forge/issues/66))
- C2 forge-control runner — spawn + supervise (#62) ([#62](https://github.com/dngioidev/forge/issues/62))
- C1 control queue + registry + CLI (#60) ([#60](https://github.com/dngioidev/forge/issues/60))
- forge-control v2 — agent trace, conformance, alerts, quota (#56) ([#56](https://github.com/dngioidev/forge/issues/56))
- forge-control — local control plane draft (#56) ([#56](https://github.com/dngioidev/forge/issues/56))

### Fixes

- conformance falls back to the ticket's plan doc when no ledger (#76) ([#76](https://github.com/dngioidev/forge/issues/76))
- split entry.repo into spawn-path + trail-slug (#73) ([#73](https://github.com/dngioidev/forge/issues/73))
- link the new board to the repo after create (#64) ([#64](https://github.com/dngioidev/forge/issues/64))
- offer + scaffold a CLI-backend roster (agy/gemini) (#58) ([#58](https://github.com/dngioidev/forge/issues/58))
- createSingleSelectField uses inline-literal mutation (#55) ([#55](https://github.com/dngioidev/forge/issues/55))

### Features

- C8 Claude Code quota panel (#79) ([#79](https://github.com/dngioidev/forge/issues/79))
- C7 alerts — journal-failure + stale-session watcher (#77) ([#77](https://github.com/dngioidev/forge/issues/77))
- C6 agent-work trace + conformance badge (#74) ([#74](https://github.com/dngioidev/forge/issues/74))
- C4 situationgate reads the machine paused flag (#68) ([#68](https://github.com/dngioidev/forge/issues/68))
- C3 console control tab — queue/sessions/audit + verbs (#66) ([#66](https://github.com/dngioidev/forge/issues/66))
- C2 runner — spawn claude -p + supervise (#62) ([#62](https://github.com/dngioidev/forge/issues/62))
- C1 — work queue, machine registry, allowlisted CLI (#60) ([#60](https://github.com/dngioidev/forge/issues/60))

## v0.3.0 — 2026-07-18

### Features

- /forge:statusline — check and fix the status bar (#53) ([#53](https://github.com/dngioidev/forge/issues/53))

## v0.2.0 — 2026-07-18

### Fixes

- bump package.json + plugin manifest versions in the release commit (#51) ([#51](https://github.com/dngioidev/forge/issues/51))
- read the documented context_window payload shape (#45) ([#45](https://github.com/dngioidev/forge/issues/45))
- replaceStatusOptions builds inline-literal mutation (#35) ([#35](https://github.com/dngioidev/forge/issues/35))
- escalate degrades gracefully without a 'blocked' option (#27) ([#27](https://github.com/dngioidev/forge/issues/27))
- replace stray NUL byte in cluster key with '|' (#9) ([#9](https://github.com/dngioidev/forge/issues/9))

### Docs

- troubleshooting — known issues + recovery ladders (#49) ([#49](https://github.com/dngioidev/forge/issues/49))
- the forge handbook — every flow, every interaction (#41) ([#41](https://github.com/dngioidev/forge/issues/41))
- three console identity variants for the pick (#39) ([#39](https://github.com/dngioidev/forge/issues/39))
- console UI v2 — answer-flow fixes + identity round (#39) ([#39](https://github.com/dngioidev/forge/issues/39))
- local web console — serve, state, decide (#37) ([#37](https://github.com/dngioidev/forge/issues/37))
- consumer install guide + root README front door (#33) ([#33](https://github.com/dngioidev/forge/issues/33))
- SP11 maintain — dep cadence + CVE SLA (#14) ([#14](https://github.com/dngioidev/forge/issues/14))
- SP10 hotfix + respond — incident mechanics, situation gate (#13) ([#13](https://github.com/dngioidev/forge/issues/13))
- SP9a console daemon — transports, sanitizer, inbox (#11) ([#11](https://github.com/dngioidev/forge/issues/11))
- SP8 graph RAG MCP — index, tools, incremental (#10) ([#10](https://github.com/dngioidev/forge/issues/10))
- SP7 learning loop — capture hooks, /distill, flow metrics (#9) ([#9](https://github.com/dngioidev/forge/issues/9))
- SP6 ideate+brainstorm+spike+design plan (#8) ([#8](https://github.com/dngioidev/forge/issues/8))
- SP5 plan+execute implementation plan (#7) ([#7](https://github.com/dngioidev/forge/issues/7))
- SP4c release management plan (#6) ([#6](https://github.com/dngioidev/forge/issues/6))
- SP4b deploy layer implementation plan (#5) ([#5](https://github.com/dngioidev/forge/issues/5))
- SP4 roster + backends implementation plan (#4) ([#4](https://github.com/dngioidev/forge/issues/4))
- SP3 ship+triage+investigate+escalation plan (#3) ([#3](https://github.com/dngioidev/forge/issues/3))
- SP2 board automation implementation plan (#2) ([#2](https://github.com/dngioidev/forge/issues/2))

### Features

- effort + rate-limit segments (#47) ([#47](https://github.com/dngioidev/forge/issues/47))
- v2 strip — glyph always, project, context bar, model, cost (#43) ([#43](https://github.com/dngioidev/forge/issues/43))
- heat identity — situation as metal temperature (#39) ([#39](https://github.com/dngioidev/forge/issues/39))
- decision-flow fixes + a11y floor for the web console (#39) ([#39](https://github.com/dngioidev/forge/issues/39))
- local web console — monitor + decide, zero cloud (#37) ([#37](https://github.com/dngioidev/forge/issues/37))
- forge:maintain — dep cadence batch plan + CVE SLA triage (#14) ([#14](https://github.com/dngioidev/forge/issues/14))
- hotfix + respond — incident mechanics, situation gating (#13) ([#13](https://github.com/dngioidev/forge/issues/13))
- transport-abstracted daemon + inbox + telemetry (#11) ([#11](https://github.com/dngioidev/forge/issues/11))
- graphctl CLI + ticket edges + doctor checks (#10) ([#10](https://github.com/dngioidev/forge/issues/10))
- MCP stdio server, schema-validated + root-locked (#10) ([#10](https://github.com/dngioidev/forge/issues/10))
- sqlite store + ts-morph indexer + queries (#10) ([#10](https://github.com/dngioidev/forge/issues/10))
- digest flow metrics from board + journal data (#9) ([#9](https://github.com/dngioidev/forge/issues/9))
- distill cluster/report/archive + /distill skill (#9) ([#9](https://github.com/dngioidev/forge/issues/9))
- PostToolUse capture + denylist blocked-edit journaling (#9) ([#9](https://github.com/dngioidev/forge/issues/9))
- ideate/brainstorm/spike/design skills + visual-spec template + speclint (#8) ([#8](https://github.com/dngioidev/forge/issues/8))
- ledger, AC gate, plan-drift, dep guard, test-intent + plan/execute skills (#7) ([#7](https://github.com/dngioidev/forge/issues/7))
- forge:release — bump, changelog, readiness, tag, GitHub Release (#6) ([#6](https://github.com/dngioidev/forge/issues/6))
- node scaffold, env-branch workflows, deploy-readiness gate, smoke, deploy-init (#5) ([#5](https://github.com/dngioidev/forge/issues/5))
- 11 role cards, loader allowlist, agy adapter, presend scan, sync (#4) ([#4](https://github.com/dngioidev/forge/issues/4))
- escalation, journal, situation, denylist hook, CI template, three skills (#3) ([#3](https://github.com/dngioidev/forge/issues/3))
- scripts + forge:board skill — create/move/comment/receipt/log/digest/status (#2) ([#2](https://github.com/dngioidev/forge/issues/2))

### Tests

- board 8 fixture carries the migrated six-status field (#32) ([#32](https://github.com/dngioidev/forge/issues/32))
- drive-letter traversal assertion is win32-only (#10) ([#10](https://github.com/dngioidev/forge/issues/10))

### Chores

- map the forge 6-status set after field migration (#32) ([#32](https://github.com/dngioidev/forge/issues/32))

