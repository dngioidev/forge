# C6 — agent-work trace + structure conformance

**Ticket:** #74 (board #12) · **Epic:** #56 · **Branch:** `feat/74-trace-conformance` · **Spec:** forge-control §3a/§3b.

Answer *"where did the agent go"* (§3a trace) and *"does it match the forge structure"* (§3b conformance) by **reading and ordering files the pipeline already writes** — journal, ledger, plan, branch, git diff, PR. No new capture. Conformance is advisory (a badge), not a merge gate.

## Tasks

- [ ] T1 — `plugin/scripts/lib/trace.mjs`: pure `buildTrace({branch, ledgerTasks, ledgerPlan, touchedFiles, journalEvents, prNumber})` → ordered timeline (plan → tasks → files → journal events → PR) with the current step marked; `conformance({branch, ledgerText, planExists, touchedFiles, planFiles, phasesSeen})` → `{level, checks:[{name,pass,why}]}` reusing `parseBranch` + plandrift `isAllowed`/`DEFAULT_ALLOW`. Everything external injected; partial inputs degrade, never throw. **Files:** plugin/scripts/lib/trace.mjs
- [ ] T2 — `plugin/scripts/trace.mjs`: CLI for the current repo — read ledger/journal, extract the ledger `Plan:` ref + its `**Files:**`, run the real `git diff --name-only main...HEAD`, print the timeline + green/amber badge; exit 0 green / 1 amber (informal before-ship check). **Files:** plugin/scripts/trace.mjs
- [ ] T3 — `console/lib/collect.mjs`: attach `conformance` + a compact `trace` to each repo snapshot (inject a `diff` fn, default git, graceful `[]` when git absent). **Files:** console/lib/collect.mjs
- [ ] T4 — `console/web/app.js` + `index.html`: render the phase strip + conformance badge (green/amber, names failing check) on the repo card, heat identity. **Files:** console/web/app.js, console/web/index.html
- [ ] T5 — tests: `buildTrace` ordering/degradation; each `conformance` check + green/amber aggregation; CLI exit codes; collector graceful-degrade; card render. **Files:** tests/lib/trace.test.mjs, tests/console/trace-card.test.mjs

## Acceptance criteria

- AC-C6.1 — `buildTrace` returns an ordered timeline (plan → tasks → files → journal events → PR) with the current step marked, from injected inputs; empty/partial inputs degrade, never throw.
- AC-C6.2 — `conformance` returns `{level: green|amber, checks:[…]}`; green iff all checks pass; amber names the first failing check; each check (valid-branch, ledger-plan, files-in-scope, phases-in-order) is individually correct.
- AC-C6.3 — the trace CLI prints timeline + badge for the current repo and exits 0 (green) / 1 (amber).
- AC-C6.4 — the console repo card renders the phase strip + conformance badge; the collector degrades gracefully when git diff is unavailable.

## Out of scope

Alerts (C7), quota (C8). Conformance is advisory — the mechanical gates at ship remain the enforcement.
