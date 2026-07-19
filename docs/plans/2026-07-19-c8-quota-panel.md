# C8 — Claude Code quota panel

**Ticket:** #79 (board #12) · **Epic:** #56 · **Branch:** `feat/79-quota-panel` · **Spec:** forge-control §3d.

The statusline sees `rate_limits` (5h/7d %) + `cost`; the console doesn't. C8 captures them — an **opt-in** statusline side-effect appends numeric-only samples to `.forge/quota.jsonl` — and reads them into a console **quota panel** (current window usage, trend, cost/day). **Honest limit:** as fresh as the last statusline refresh; no capture → the console is blind (it's in no file it owns). The last of the eight control-plane epics.

## Tasks

- [ ] T1 — `plugin/scripts/lib/quota.mjs`: `QUOTA_RELPATH`/`QUOTA_MARKER`; `captureEnabled(cwd)` (marker present); `appendQuotaSample(cwd, {ts, fiveHour, sevenDay, cost})` (numeric-only, silent-on-error); `readSamples(cwd,{limit})`; pure `summarizeQuota(samples,{now})` → `{count, latest, trend, costByDay}`. **Files:** plugin/scripts/lib/quota.mjs
- [ ] T2 — `plugin/scripts/statusline.mjs`: after extracting rate_limits+cost, `if captureEnabled(cwd)` append a sample. Silent, opt-in (create `.forge/quota.capture`), off by default; never breaks the strip. **Files:** plugin/scripts/statusline.mjs
- [ ] T3 — `console/serve.mjs`: `/api/control/state` gains `quota` aggregated across configured repos (latest 5h/7d; cost/day). Host guard applies; repos without data skipped. **Files:** console/serve.mjs
- [ ] T4 — `console/web/app.js` + `index.html`: quota panel in the control tab — 5h/7d bars + trend arrows + cost-per-day list; no data → an opt-in hint. **Files:** console/web/app.js, console/web/index.html
- [ ] T5 — tests + dogfood: capture opt-in/numeric-only/silent; `summarizeQuota` latest/trend/cost-by-day + degrade; `/api/control/state` quota; panel render + empty hint. Dogfood: enable the marker, run the statusline with a real rate_limits payload, read the panel. **Files:** tests/lib/quota.test.mjs, tests/console/quota-panel.test.mjs

## Acceptance criteria

- AC-C8.1 — capture is opt-in: `appendQuotaSample` writes only with the marker present; numeric-only (no prompt/text); a write failure is silent.
- AC-C8.2 — `summarizeQuota` returns latest 5h/7d + cost, trend (up/down/flat) vs window start, and cost-per-day; empty/partial → `{count:0,…}`, never throws.
- AC-C8.3 — `/api/control/state` includes aggregated `quota`; Host guard applies; repos without data are skipped, not fatal.
- AC-C8.4 — the control tab renders the quota panel; no data → an opt-in hint.

## Out of scope

True push-to-phone (Firebase). Quota freshness bounded by the last statusline refresh — documented.
