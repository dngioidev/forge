# Changelog

## v1.4.1 — 2026-08-22

### Fixes

- create the kind field as "Kind", not the now-reserved "Type" (#552) ([#552](https://github.com/dngioidev/forge/issues/552))

## v1.4.0 — 2026-08-17

### Docs

- index both unlinked plan docs (#448, #472) in the route index (#547) ([#448](https://github.com/dngioidev/forge/issues/448) [#472](https://github.com/dngioidev/forge/issues/472) [#547](https://github.com/dngioidev/forge/issues/547))
- synchronous adversarial passes vs spawn-and-await (#475) (#541) ([#475](https://github.com/dngioidev/forge/issues/475) [#541](https://github.com/dngioidev/forge/issues/541))
- add Report contract section for {issue,verdict,outcome} (#536) ([#536](https://github.com/dngioidev/forge/issues/536))
- hooks/scripts resolution — working tree vs cache (#519) (#520) ([#519](https://github.com/dngioidev/forge/issues/519) [#520](https://github.com/dngioidev/forge/issues/520))
- annotate ADR-0006/0005 and runner-adoption as hosted-only since #426 (#518) ([#426](https://github.com/dngioidev/forge/issues/426) [#518](https://github.com/dngioidev/forge/issues/518))
- brace-expansion guard direction findings (#515) (#516) ([#515](https://github.com/dngioidev/forge/issues/515) [#516](https://github.com/dngioidev/forge/issues/516))
- redact the live #459 bypass payload from the route index (#511) ([#459](https://github.com/dngioidev/forge/issues/459) [#511](https://github.com/dngioidev/forge/issues/511))
- give the permission model a Claude-facing home (#510) ([#510](https://github.com/dngioidev/forge/issues/510))
- agy file-write gating — matcher widening evidence, not a fix (#436) (#479) ([#436](https://github.com/dngioidev/forge/issues/436) [#479](https://github.com/dngioidev/forge/issues/479))
- tokenize-then-judge argv model for the denylist hook (#451) (#458) ([#451](https://github.com/dngioidev/forge/issues/451) [#458](https://github.com/dngioidev/forge/issues/458))
- surface the allowlist outside autopilot, verify #429's AC.1/2/4 (#443) ([#429](https://github.com/dngioidev/forge/issues/429) [#443](https://github.com/dngioidev/forge/issues/443))
- give agy-only adopters a complete install + update path (#433) (#441) ([#433](https://github.com/dngioidev/forge/issues/433) [#441](https://github.com/dngioidev/forge/issues/441))
- confirm agy's PreToolUse allow decision auto-approves (#428) (#435) ([#428](https://github.com/dngioidev/forge/issues/428) [#435](https://github.com/dngioidev/forge/issues/435))
- surface Antigravity (agy) alongside Claude Code (#423) (#424) ([#423](https://github.com/dngioidev/forge/issues/423) [#424](https://github.com/dngioidev/forge/issues/424))

### Fixes

- give a sequenced-behind triage verdict a resting board state (#545) ([#545](https://github.com/dngioidev/forge/issues/545))
- assert absolute ceilings, not a ratio, in denylist's perf test (#486) (#543) ([#486](https://github.com/dngioidev/forge/issues/486) [#543](https://github.com/dngioidev/forge/issues/543))
- close a TOCTOU race in lock.mjs's stale-lock reclaim (#482) (#542) ([#482](https://github.com/dngioidev/forge/issues/482) [#542](https://github.com/dngioidev/forge/issues/542))
- watchdog relays held review verdicts to a stalled subagent automatically (#540) ([#540](https://github.com/dngioidev/forge/issues/540))
- judge a NUL-fused safe-word/dash continuation instead of filtering it as a flag (#472) (#539) ([#472](https://github.com/dngioidev/forge/issues/472) [#539](https://github.com/dngioidev/forge/issues/539))
- detect brace-expansion syntax that can complete a hidden flag (#448) (#534) ([#448](https://github.com/dngioidev/forge/issues/448) [#534](https://github.com/dngioidev/forge/issues/534))
- derive ticket kind from the board type field, not a title prefix (#532) ([#532](https://github.com/dngioidev/forge/issues/532))
- gate the rate-budget check on the next ticket's kind, not the run's worst case (#526) (#529) ([#526](https://github.com/dngioidev/forge/issues/526) [#529](https://github.com/dngioidev/forge/issues/529))
- relocate SKILL.md lookup content to reference docs (#527) ([#527](https://github.com/dngioidev/forge/issues/527))
- classify blocked-edit clusters by guard-testing vs unclassified (#525) ([#525](https://github.com/dngioidev/forge/issues/525))
- watchdog escalates a malformed report with no PR instead of blindly respawning (#522) (#523) ([#522](https://github.com/dngioidev/forge/issues/522) [#523](https://github.com/dngioidev/forge/issues/523))
- calibrate ratebudget low-water from recent deltas (#517) (#521) ([#517](https://github.com/dngioidev/forge/issues/517) [#521](https://github.com/dngioidev/forge/issues/521))
- narrow node <path> guard to the workspace (#438) (#514) ([#438](https://github.com/dngioidev/forge/issues/438) [#514](https://github.com/dngioidev/forge/issues/514))
- environment preflight — the third RUN START gate (#504) (#512) ([#504](https://github.com/dngioidev/forge/issues/504) [#512](https://github.com/dngioidev/forge/issues/512))
- selection consults pending decisions, not just board status (#499) (#500) ([#499](https://github.com/dngioidev/forge/issues/499) [#500](https://github.com/dngioidev/forge/issues/500))
- recursive-delete rm-boundary + POSIX -- end-of-options (#454, absorbs #456) (#496) ([#454](https://github.com/dngioidev/forge/issues/454) [#456](https://github.com/dngioidev/forge/issues/456) [#496](https://github.com/dngioidev/forge/issues/496))
- readiness gate honors qualified headings and dot-separated AC ids (#491) (#494) ([#491](https://github.com/dngioidev/forge/issues/491) [#494](https://github.com/dngioidev/forge/issues/494))
- mechanically verify fork-PR approval policy on self-hosted-runner-registered public repos (#489) (#493) ([#489](https://github.com/dngioidev/forge/issues/489) [#493](https://github.com/dngioidev/forge/issues/493))
- anchor the runaway backstop to run-start board size (#488) (#492) ([#488](https://github.com/dngioidev/forge/issues/488) [#492](https://github.com/dngioidev/forge/issues/492))
- allowlist git add with a positive-model argument guard (#483) ([#483](https://github.com/dngioidev/forge/issues/483))
- drop hooks.json command quoting that broke Windows module resolution (#478) (#481) ([#478](https://github.com/dngioidev/forge/issues/478) [#481](https://github.com/dngioidev/forge/issues/481))
- watchdog classifies the stalled-before-PR return shape (#464) (#476) ([#464](https://github.com/dngioidev/forge/issues/464) [#476](https://github.com/dngioidev/forge/issues/476))
- close the NUL-in-flag-cluster bypass across four rules (#452) (#473) ([#452](https://github.com/dngioidev/forge/issues/452) [#473](https://github.com/dngioidev/forge/issues/473))
- orchestrate-only for every stage, not just deliver (#466) (#468) ([#466](https://github.com/dngioidev/forge/issues/466) [#468](https://github.com/dngioidev/forge/issues/468))
- correct agy install command, framing, and gate count (#460) (#463) ([#460](https://github.com/dngioidev/forge/issues/460) [#463](https://github.com/dngioidev/forge/issues/463))
- honor POSIX -- end-of-options in recursive-delete targets (#455) ([#455](https://github.com/dngioidev/forge/issues/455))
- anchor SAFE_RM_TARGETS to path components and judge each rm target on its own (#446) (#453) ([#446](https://github.com/dngioidev/forge/issues/446) [#453](https://github.com/dngioidev/forge/issues/453))
- close reordered/bundled/short-flag spellings in hard-reset and env-branch-delete (#445) ([#445](https://github.com/dngioidev/forge/issues/445))
- stop the emitted agy package telling agents to write a Claude-only settings file (#430) (#440) ([#430](https://github.com/dngioidev/forge/issues/430) [#440](https://github.com/dngioidev/forge/issues/440))
- flip the PreToolUse hook default from allow to ask (#429) (#439) ([#429](https://github.com/dngioidev/forge/issues/429) [#439](https://github.com/dngioidev/forge/issues/439))
- stop hardcoding pnpm/action-setup's pinned SHA in AC-343.1 (#421) ([#421](https://github.com/dngioidev/forge/issues/421))

### Features

- agent-liveness detection — a subagent that never returns is now visible (#505) (#513) ([#505](https://github.com/dngioidev/forge/issues/505) [#513](https://github.com/dngioidev/forge/issues/513))
- argv tokenizer, Phase 1 of tokenize-then-judge (#457) (#498) ([#457](https://github.com/dngioidev/forge/issues/457) [#498](https://github.com/dngioidev/forge/issues/498))
- denylist-staleness diagnostic check + docs (#447) (#485) ([#447](https://github.com/dngioidev/forge/issues/447) [#485](https://github.com/dngioidev/forge/issues/485))
- teach forge:doctor to check the emitted agy adapter (#442) ([#442](https://github.com/dngioidev/forge/issues/442))

### Chores

- reconcile stale self-hosted runner block with hosted-CI reality (#427) ([#427](https://github.com/dngioidev/forge/issues/427))
- migrate to vitest 4 (#339) (#425) ([#339](https://github.com/dngioidev/forge/issues/339) [#425](https://github.com/dngioidev/forge/issues/425))

## v1.3.0 — 2026-08-08

### Fixes

- key the repo/field cache by cwd, not just the gh instance (#419) ([#419](https://github.com/dngioidev/forge/issues/419))
- bind ciGreen's fresh-transition shortcut to the PR's head SHA (#411) (#417) ([#411](https://github.com/dngioidev/forge/issues/411) [#417](https://github.com/dngioidev/forge/issues/417))
- board_status calls the shared runStatus instead of reimplementing it (#399) (#403) ([#399](https://github.com/dngioidev/forge/issues/399) [#403](https://github.com/dngioidev/forge/issues/403))
- correct false 'grant holds all session' merge-auth claim (#402) ([#402](https://github.com/dngioidev/forge/issues/402))
- terminal load bug, offline-runner clutter, live machine metrics (#396) ([#396](https://github.com/dngioidev/forge/issues/396))

### Features

- local GitHub outbox for deferrable board writes (#414) (#418) ([#414](https://github.com/dngioidev/forge/issues/414) [#418](https://github.com/dngioidev/forge/issues/418))
- detect + auto-recover from GitHub Actions platform outages (#408) (#412) ([#408](https://github.com/dngioidev/forge/issues/408) [#412](https://github.com/dngioidev/forge/issues/412))
- wire the dead rate-budget preflight + cut GraphQL call volume (#407) (#410) ([#407](https://github.com/dngioidev/forge/issues/407) [#410](https://github.com/dngioidev/forge/issues/410))
- expose receipt/log/digest/reparent/close as forge-core MCP tools (#406) ([#406](https://github.com/dngioidev/forge/issues/406))

### Docs

- local GitHub outbox design for deferrable writes (#409) (#413) ([#409](https://github.com/dngioidev/forge/issues/409) [#413](https://github.com/dngioidev/forge/issues/413))
- GitHub resilience — rate-limit demand reduction + outage recovery (#407) ([#407](https://github.com/dngioidev/forge/issues/407))
- characterize + investigate the harness classifier's merge-denial pattern (#398) (#405) ([#398](https://github.com/dngioidev/forge/issues/398) [#405](https://github.com/dngioidev/forge/issues/405))
- annotate removed forge-control/console lines in route index (#404) ([#404](https://github.com/dngioidev/forge/issues/404))

## v1.2.0 — 2026-08-07

### Docs

- groundgate routine-vs-grounded boundary audit (#388) (#393) ([#388](https://github.com/dngioidev/forge/issues/388) [#393](https://github.com/dngioidev/forge/issues/393))
- autopilot concurrent-run safety + parallel-mode feasibility (#387) (#392) ([#387](https://github.com/dngioidev/forge/issues/387) [#392](https://github.com/dngioidev/forge/issues/392))
- runner-tool failures + machine monitoring research (#383) (#384) ([#383](https://github.com/dngioidev/forge/issues/383) [#384](https://github.com/dngioidev/forge/issues/384))

### Features

- seed a baseline docs/ structure + document the route-index rule (#394) ([#394](https://github.com/dngioidev/forge/issues/394))
- advise when graph-RAG is available but off (#386) (#391) ([#386](https://github.com/dngioidev/forge/issues/386) [#391](https://github.com/dngioidev/forge/issues/391))
- add /forge:docsync-check (expose docsync.mjs as a command) (#390) ([#390](https://github.com/dngioidev/forge/issues/390))

## v1.1.0 — 2026-08-05

### Docs

- session usage-window detection for autopilot self-pause (#378) (#381) ([#378](https://github.com/dngioidev/forge/issues/378) [#381](https://github.com/dngioidev/forge/issues/381))

### Features

- self-pause + auto-continue near the 5h session usage window (#378) (#382) ([#378](https://github.com/dngioidev/forge/issues/378) [#382](https://github.com/dngioidev/forge/issues/382))

### Fixes

- pin the delivery subagent spawn to model: sonnet (#380) ([#380](https://github.com/dngioidev/forge/issues/380))
- emit plugin-root-relative paths so the emitted package is relocatable (#307) (#377) ([#307](https://github.com/dngioidev/forge/issues/307) [#377](https://github.com/dngioidev/forge/issues/377))

## v1.0.0 — 2026-08-04

**The open-source flip.** forge is now public under the MIT License — a portable AI delivery pipeline that installs into Claude Code: 20 pipeline skills across 5 lanes, a 12-role agent roster, GitHub Projects board automation with a ticket-trail law, mechanical ship gates, a learning loop, and a graph-RAG index. Built entirely by its own pipeline across the 0.x line, and license-clean — npm *and* Python, zero non-permissive dependencies, enforced by a gate in CI. See the [release notes](https://github.com/dngioidev/forge/releases/tag/v1.0.0) for the full announcement.

### Features

- GitHub Pages landing page to introduce forge (#371) (#372) ([#371](https://github.com/dngioidev/forge/issues/371) [#372](https://github.com/dngioidev/forge/issues/372))

## v0.20.0 — 2026-08-04

### Fixes

- alias raw-hex UI values to smithy tokens (#368) (#370) ([#368](https://github.com/dngioidev/forge/issues/368) [#370](https://github.com/dngioidev/forge/issues/370))
- back off + retry on GitHub GraphQL rate limits (#360) (#366) ([#360](https://github.com/dngioidev/forge/issues/360) [#366](https://github.com/dngioidev/forge/issues/366))
- teach the license gate to see the Python dep tree (#349) (#357) ([#349](https://github.com/dngioidev/forge/issues/349) [#357](https://github.com/dngioidev/forge/issues/357))
- bump the README version badge in lockstep with the release (#341) ([#341](https://github.com/dngioidev/forge/issues/341))

### Features

- browser UI — split cockpit (#354) (#369) ([#354](https://github.com/dngioidev/forge/issues/354) [#369](https://github.com/dngioidev/forge/issues/369))
- PTY-over-websocket terminal bridge (#353) (#364) ([#353](https://github.com/dngioidev/forge/issues/353) [#364](https://github.com/dngioidev/forge/issues/364))
- harden the loopback backend (DNS-rebinding / CSRF / origin) (#352) (#363) ([#352](https://github.com/dngioidev/forge/issues/352) [#363](https://github.com/dngioidev/forge/issues/363))
- serve the Python cores over a 127.0.0.1 FastAPI backend (#351) (#362) ([#351](https://github.com/dngioidev/forge/issues/351) [#362](https://github.com/dngioidev/forge/issues/362))
- retire PySide6/PyInstaller — remove the LGPL artifact ahead of the web-app rebuild (#355) (#359) ([#355](https://github.com/dngioidev/forge/issues/355) [#359](https://github.com/dngioidev/forge/issues/359))
- add a license-compliance gate (SPDX allowlist) and register it (#345) ([#345](https://github.com/dngioidev/forge/issues/345))

### Docs

- cockpit UI split-cockpit visual spec (#354) (#367) ([#354](https://github.com/dngioidev/forge/issues/354) [#367](https://github.com/dngioidev/forge/issues/367))
- document the local-web-app model + reconcile ADR cross-refs (#356) (#365) ([#356](https://github.com/dngioidev/forge/issues/356) [#365](https://github.com/dngioidev/forge/issues/365))
- teach the denylist escalation path in role cards + delivery brief (#358) ([#358](https://github.com/dngioidev/forge/issues/358))
- cockpit re-architecture findings + ADR-0008 (#344) (#348) ([#344](https://github.com/dngioidev/forge/issues/344) [#348](https://github.com/dngioidev/forge/issues/348))

## v0.19.0 — 2026-08-02

### Features

- add --date override for the changelog/release date (#340) ([#340](https://github.com/dngioidev/forge/issues/340))
- reject empty/garbage commit subjects in a conventions gate (#310) (#328) ([#310](https://github.com/dngioidev/forge/issues/310) [#328](https://github.com/dngioidev/forge/issues/328))
- guard README version-badge drift in the docsync gate (#327) ([#327](https://github.com/dngioidev/forge/issues/327))
- harden forge-core transport — line cap, arg bounds, config teaching (#296) (#299) ([#296](https://github.com/dngioidev/forge/issues/296) [#299](https://github.com/dngioidev/forge/issues/299))
- forge-core MCP server + factored rpc.mjs transport (#288) (#295) ([#288](https://github.com/dngioidev/forge/issues/288) [#295](https://github.com/dngioidev/forge/issues/295))
- forge init --host agy emits the proven agy plugin package (#289) (#293) ([#289](https://github.com/dngioidev/forge/issues/289) [#293](https://github.com/dngioidev/forge/issues/293))

### Tests

- cover issues.mjs error + upsertMarkedComment idempotency (#322) (#337) ([#322](https://github.com/dngioidev/forge/issues/322) [#337](https://github.com/dngioidev/forge/issues/337))
- contract-test agy safety shims (agy-deny + agy-capture) (#313) (#325) ([#313](https://github.com/dngioidev/forge/issues/313) [#325](https://github.com/dngioidev/forge/issues/325))

### Refactoring

- single-source the denylist escalate message (#321) (#336) ([#321](https://github.com/dngioidev/forge/issues/321) [#336](https://github.com/dngioidev/forge/issues/336))
- single shared shell-segment splitter (#320) (#335) ([#320](https://github.com/dngioidev/forge/issues/320) [#335](https://github.com/dngioidev/forge/issues/335))

### Docs

- narrow denylist header comment to its actual scope (#334) ([#334](https://github.com/dngioidev/forge/issues/334))

### Fixes

- watchdog for the return-then-resume stall (#333) ([#333](https://github.com/dngioidev/forge/issues/333))
- surface persistent poll failures instead of silent catch (#332) ([#332](https://github.com/dngioidev/forge/issues/332))
- wire the runaway backstop (guardTripped) into the loop (#331) ([#331](https://github.com/dngioidev/forge/issues/331))
- enforce the in-session merge-auth preflight in code (#330) ([#330](https://github.com/dngioidev/forge/issues/330))
- gate the live merge through the tested merge bar (#329) ([#329](https://github.com/dngioidev/forge/issues/329))
- sync README version badge to package.json + guard test (#308) (#326) ([#308](https://github.com/dngioidev/forge/issues/308) [#326](https://github.com/dngioidev/forge/issues/326))
- block rm long flags (--recursive --force) in denylist (#324) ([#324](https://github.com/dngioidev/forge/issues/324))
- block pipe-to-shell / eval RCE in denylist (#311) (#323) ([#311](https://github.com/dngioidev/forge/issues/311) [#323](https://github.com/dngioidev/forge/issues/323))
- make forge dispatcher test bash-path portable (#302 dogfood) (#306) ([#302](https://github.com/dngioidev/forge/issues/302) [#306](https://github.com/dngioidev/forge/issues/306))
- board_escalate options bypass + escape decision-comment markdown (#300) (#301) ([#300](https://github.com/dngioidev/forge/issues/300) [#301](https://github.com/dngioidev/forge/issues/301))
- resolve ${CLAUDE_PLUGIN_ROOT} in emitted agy skills/commands (#294) (#298) ([#294](https://github.com/dngioidev/forge/issues/294) [#298](https://github.com/dngioidev/forge/issues/298))

## v0.18.0 — 2026-07-24

### Features

- embedded pywinpty terminal + WSL session (#275) (#287) ([#275](https://github.com/dngioidev/forge/issues/275) [#287](https://github.com/dngioidev/forge/issues/287))
- usage/cost/token QtCharts panel (#274) (#286) ([#274](https://github.com/dngioidev/forge/issues/274) [#286](https://github.com/dngioidev/forge/issues/286))
- Claude usage/cost/token data core (#273) (#285) ([#273](https://github.com/dngioidev/forge/issues/273) [#285](https://github.com/dngioidev/forge/issues/285))
- packaging + cross-platform run docs (#268) (#284) ([#268](https://github.com/dngioidev/forge/issues/268) [#284](https://github.com/dngioidev/forge/issues/284))
- install/uninstall a runner service from the UI, secret-safe (#267) (#283) ([#267](https://github.com/dngioidev/forge/issues/267) [#283](https://github.com/dngioidev/forge/issues/283))
- runner control actions + log viewing (#266) (#282) ([#266](https://github.com/dngioidev/forge/issues/266) [#282](https://github.com/dngioidev/forge/issues/282))
- fleet overview screen with mis-target flags (#265) (#281) ([#265](https://github.com/dngioidev/forge/issues/265) [#281](https://github.com/dngioidev/forge/issues/281))
- fleet discovery + status core (#264) (#277) ([#264](https://github.com/dngioidev/forge/issues/264) [#277](https://github.com/dngioidev/forge/issues/277))
- PySide6 app shell + uv scaffold + interop helper (#272) (#276) ([#272](https://github.com/dngioidev/forge/issues/272) [#276](https://github.com/dngioidev/forge/issues/276))

### Fixes

- make test-windows PATH-self-sufficient on the stripped self-hosted runner env (#278) (#279) ([#278](https://github.com/dngioidev/forge/issues/278) [#279](https://github.com/dngioidev/forge/issues/279))

### Docs

- ADR-0006 accepted — PySide6 desktop cockpit, phased (#263) (#271) ([#263](https://github.com/dngioidev/forge/issues/263) [#271](https://github.com/dngioidev/forge/issues/271))
- managing-the-service cheat-sheet (#269) (#270) ([#269](https://github.com/dngioidev/forge/issues/269) [#270](https://github.com/dngioidev/forge/issues/270))

## v0.17.1 — 2026-07-24

### Fixes

- repo-scoped service name + explicit target so one host serves many repos (#260) (#261) ([#260](https://github.com/dngioidev/forge/issues/260) [#261](https://github.com/dngioidev/forge/issues/261))

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

