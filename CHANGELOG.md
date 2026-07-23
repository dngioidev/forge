# Changelog

## v0.17.0 — 2026-07-23

### Fixes

- give the LocalSystem NSSM service gh on PATH + logging (#258) (#259) ([#258](https://github.com/dngioidev/forge/issues/258) [#259](https://github.com/dngioidev/forge/issues/259))
- -InstallService no longer aborts on a fresh install (#256) (#257) ([#256](https://github.com/dngioidev/forge/issues/256) [#257](https://github.com/dngioidev/forge/issues/257))
- auto-pin current actions/runner version + SHA at scaffold, warn on staleness (#249) ([#249](https://github.com/dngioidev/forge/issues/249))
- distinct concurrency group for verify.runner.yml variant (#248) ([#248](https://github.com/dngioidev/forge/issues/248))
- back off on build/container failure, not just mint (#247) ([#247](https://github.com/dngioidev/forge/issues/247))
- make docker compose build/config succeed without a JIT config (#246) ([#246](https://github.com/dngioidev/forge/issues/246))

### Features

- service-install tooling for the supervisors (systemd --user + NSSM) (#255) ([#255](https://github.com/dngioidev/forge/issues/255))
- add forge:runner-check adoption-readiness preflight (#250) ([#250](https://github.com/dngioidev/forge/issues/250))
- runner-health check (ADR-0005 AC4, #225) (#231) ([#225](https://github.com/dngioidev/forge/issues/225) [#231](https://github.com/dngioidev/forge/issues/231))
- forge.json runner block + validation + docs (#226) (#230) ([#226](https://github.com/dngioidev/forge/issues/226) [#230](https://github.com/dngioidev/forge/issues/230))
- scaffold local self-hosted runner + private-only refusal (#224) (#229) ([#224](https://github.com/dngioidev/forge/issues/224) [#229](https://github.com/dngioidev/forge/issues/229))

### Tests

- raise vitest timeout for the slower self-hosted runner (#251) (#252) ([#251](https://github.com/dngioidev/forge/issues/251) [#252](https://github.com/dngioidev/forge/issues/252))

### Docs

- adoption guide + known-issues runbook (#243) (#244) ([#243](https://github.com/dngioidev/forge/issues/243) [#244](https://github.com/dngioidev/forge/issues/244))
- accept ADR-0005 local self-hosted runner (AC1 sign-off) (#180) (#228) ([#180](https://github.com/dngioidev/forge/issues/180) [#228](https://github.com/dngioidev/forge/issues/228))
- public-facing README + repo description/topics pass (#213) (#218) ([#213](https://github.com/dngioidev/forge/issues/213) [#218](https://github.com/dngioidev/forge/issues/218))
- add OSS community health files (#217) ([#217](https://github.com/dngioidev/forge/issues/217))

### Chores

- OSS gate — full-history secret scan + repeatable tooling (#210) (#216) ([#210](https://github.com/dngioidev/forge/issues/210) [#216](https://github.com/dngioidev/forge/issues/216))

## v0.16.0 — 2026-07-23

### Docs

- re-init is a real fix for bare-node blank bar (§1/§2) (#208) ([#208](https://github.com/dngioidev/forge/issues/208))
- wire SKILL to the forge-ci / forge-decisions monitors (#169) (#196) ([#169](https://github.com/dngioidev/forge/issues/169) [#196](https://github.com/dngioidev/forge/issues/196))
- fix stale skill/role counts and dead shell-windows link (#168) (#195) ([#168](https://github.com/dngioidev/forge/issues/168) [#195](https://github.com/dngioidev/forge/issues/195))
- remove stale Console daemon section (ADR-0003) (#194) ([#194](https://github.com/dngioidev/forge/issues/194))

### Fixes

- verify Status field actually moved after close.mjs mutation (#207) ([#207](https://github.com/dngioidev/forge/issues/207))
- add .catch to isMain entrypoints so real I/O errors exit cleanly (#206) ([#206](https://github.com/dngioidev/forge/issues/206))
- readJson returns null only for ENOENT, propagates real I/O errors (#185) (#205) ([#185](https://github.com/dngioidev/forge/issues/185) [#205](https://github.com/dngioidev/forge/issues/205))
- wire statusline with absolute node path, not bare `node` (#203) ([#203](https://github.com/dngioidev/forge/issues/203))
- verify the Status field actually moved to Done after a done-move (#178) (#200) ([#178](https://github.com/dngioidev/forge/issues/178) [#200](https://github.com/dngioidev/forge/issues/200))
- quote-safe title idempotency lookup — no duplicate on quoted titles (#199) ([#199](https://github.com/dngioidev/forge/issues/199))
- spec kill-switch names the situation gate, not removed forge-control (#193) ([#193](https://github.com/dngioidev/forge/issues/193))
- kill-switch names the real situation gate, not removed forge-control (#191) ([#191](https://github.com/dngioidev/forge/issues/191))
- document in-session merge-authorization requirement + run-start preflight (#179) (#190) ([#179](https://github.com/dngioidev/forge/issues/179) [#190](https://github.com/dngioidev/forge/issues/190))
- delivery-subagent brief must watch CI to green in-run and merge same run (#189) ([#189](https://github.com/dngioidev/forge/issues/189))
- recognize localized (non-English) AC headings in readiness (#176) (#188) ([#176](https://github.com/dngioidev/forge/issues/176) [#188](https://github.com/dngioidev/forge/issues/188))
- exclude umbrella types (program/epic) from selectNext (#187) ([#187](https://github.com/dngioidev/forge/issues/187))
- crash-safe run-ledger — atomic writeJson + guarded reader (#184) ([#184](https://github.com/dngioidev/forge/issues/184))

### Features

- expose statusline/agy/review CLIs; document monitors exclusion (#198) ([#198](https://github.com/dngioidev/forge/issues/198))
- add self-audit documentation for plugin v0.15.0

### Chores

- add MIT LICENSE + license field to manifests (#197) ([#197](https://github.com/dngioidev/forge/issues/197))

### Tests

- cover runRelease mutating path + parseArgs (#165) (#186) ([#165](https://github.com/dngioidev/forge/issues/165) [#186](https://github.com/dngioidev/forge/issues/186))

## v0.15.0 — 2026-07-21

### Features

- inline-output fix + shared core + read-only ask helper + features.agy (#162) (#163) ([#162](https://github.com/dngioidev/forge/issues/162) [#163](https://github.com/dngioidev/forge/issues/163))

## v0.14.0 — 2026-07-21

### Features

- opt-in Gemini second opinion via agy/Antigravity (#160) (#161) ([#160](https://github.com/dngioidev/forge/issues/160) [#161](https://github.com/dngioidev/forge/issues/161))

## v0.13.0 — 2026-07-21

### Features

- quiet output discipline for orchestration runs (#158) (#159) ([#158](https://github.com/dngioidev/forge/issues/158) [#159](https://github.com/dngioidev/forge/issues/159))

## v0.12.1 — 2026-07-21

### Fixes

- orchestrate-only loop + per-ticket delivery subagent + perms allowlist (#156) (#157) ([#156](https://github.com/dngioidev/forge/issues/156) [#157](https://github.com/dngioidev/forge/issues/157))

## v0.12.0 — 2026-07-21

### Features

- bin/forge dispatcher, autopilot monitors, theme + polish (#150, #151, #153) (#155) ([#150](https://github.com/dngioidev/forge/issues/150) [#151](https://github.com/dngioidev/forge/issues/151) [#153](https://github.com/dngioidev/forge/issues/153) [#155](https://github.com/dngioidev/forge/issues/155))
- fulfill missing ticket fields — area (fix --area), labels, milestone (#146) (#147) ([#146](https://github.com/dngioidev/forge/issues/146) [#147](https://github.com/dngioidev/forge/issues/147))

### Fixes

- quote compiled descriptions — unquoted colons dropped all metadata (#149) (#154) ([#149](https://github.com/dngioidev/forge/issues/149) [#154](https://github.com/dngioidev/forge/issues/154))

## v0.11.0 — 2026-07-21

### Features

- crazy mode — grounded autonomous backlog shaping (#140, #141, #142, #143, #144) (#145) ([#140](https://github.com/dngioidev/forge/issues/140) [#141](https://github.com/dngioidev/forge/issues/141) [#142](https://github.com/dngioidev/forge/issues/142) [#143](https://github.com/dngioidev/forge/issues/143) [#144](https://github.com/dngioidev/forge/issues/144) [#145](https://github.com/dngioidev/forge/issues/145))

## v0.10.0 — 2026-07-20

### Features

- docsync gate + autopilot context/cost bounding (#136, #137) (#138) ([#136](https://github.com/dngioidev/forge/issues/136) [#137](https://github.com/dngioidev/forge/issues/137) [#138](https://github.com/dngioidev/forge/issues/138))

### Docs

- add to handbook + route index (#134) (#135) ([#134](https://github.com/dngioidev/forge/issues/134) [#135](https://github.com/dngioidev/forge/issues/135))

## v0.9.0 — 2026-07-20

### Features

- executable engine — selection, merge bar, run ledger, filing (#127, #128, #129, #130, #131) (#133) ([#127](https://github.com/dngioidev/forge/issues/127) [#128](https://github.com/dngioidev/forge/issues/128) [#129](https://github.com/dngioidev/forge/issues/129) [#130](https://github.com/dngioidev/forge/issues/130) [#131](https://github.com/dngioidev/forge/issues/131) [#133](https://github.com/dngioidev/forge/issues/133))
- skill loop, selection, escalation model + spec (#126) (#132) ([#126](https://github.com/dngioidev/forge/issues/126) [#132](https://github.com/dngioidev/forge/issues/132))

## v0.8.0 — 2026-07-20

### Features

- board/close.mjs accepts a comma-separated --issue list (#123) ([#123](https://github.com/dngioidev/forge/issues/123))
- make forge:deliver kind-aware (classify + route + typed tasks) (#121) ([#121](https://github.com/dngioidev/forge/issues/121))
- forge:deliver — plan→execute→ship on subagents, single MR gate (#121) ([#121](https://github.com/dngioidev/forge/issues/121))

### Docs

- batch close for board/close.mjs (#123) ([#123](https://github.com/dngioidev/forge/issues/123))

## v0.7.0 — 2026-07-20

### Features

- forge:execute-agents — subagent fan-out mode for execute (#118) ([#118](https://github.com/dngioidev/forge/issues/118))
- "Won't do" status + board/close.mjs for special-reason closures (#117) ([#117](https://github.com/dngioidev/forge/issues/117))
- findItemByIssue lag-fallback + optional Phase field (#114) ([#114](https://github.com/dngioidev/forge/issues/114))

## v0.6.0 — 2026-07-19

### Features

- board CLI ergonomics + .gitattributes (#108, #109) ([#108](https://github.com/dngioidev/forge/issues/108) [#109](https://github.com/dngioidev/forge/issues/109))
- pin each role to a right-sized model (#101) ([#101](https://github.com/dngioidev/forge/issues/101))
- terser subagent output contracts (#97) ([#97](https://github.com/dngioidev/forge/issues/97))

### Fixes

- plandrift bare-name resolve + acgate multi-results (#106, #107) ([#106](https://github.com/dngioidev/forge/issues/106) [#107](https://github.com/dngioidev/forge/issues/107))
- MCP server re-reads features.graph per call (#105) ([#105](https://github.com/dngioidev/forge/issues/105))
- P0 consumer bugs — gitleaks perms + create.mjs flag handling (#103, #104) ([#103](https://github.com/dngioidev/forge/issues/103) [#104](https://github.com/dngioidev/forge/issues/104))

### Docs

- capture iomanage feedback batch (forge 0.5.0)

### Chores

- remove the unwired multi-backend (CLI role-swap) plane (#99) ([#99](https://github.com/dngioidev/forge/issues/99))
- remove forge-control + local console (#95) ([#95](https://github.com/dngioidev/forge/issues/95))

## v0.5.0 — 2026-07-19

### Fixes

- make deriveSituation machine-state independent via FORGE_CONTROL_BASE (#93) ([#93](https://github.com/dngioidev/forge/issues/93))
- denylist tests per command segment, not whole string (#85) ([#85](https://github.com/dngioidev/forge/issues/85))

### Docs

- adopt Option 2 — console/control ship as repo tooling (#91) ([#91](https://github.com/dngioidev/forge/issues/91))
- add console-control operator guide (#83) ([#83](https://github.com/dngioidev/forge/issues/83))

### Features

- seed Program type + plan-aware secret-scan (#89) ([#89](https://github.com/dngioidev/forge/issues/89))
- batch create (--from) + reparent script (#87) ([#87](https://github.com/dngioidev/forge/issues/87))

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

