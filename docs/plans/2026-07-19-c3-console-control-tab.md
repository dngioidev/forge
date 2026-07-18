# C3 — console control tab

**Ticket:** #66 (board #12) · **Epic:** #56 · **Branch:** `feat/66-console-control-tab` · **Spec:** forge-control §2.

Give the local web console (#37, `console/serve.mjs`) a **control** tab: read-only queue / sessions / audit views plus buttons that POST the C1 allowlisted verbs. Localhost-only, same Host-header rebinding guard. The control plane still cannot push / merge / edit — the tab drives only `runControl`'s vocabulary.

## Tasks

- [ ] T1 — `control/control.mjs`: export `readAudit(base, {limit})` — last N audit records newest-first, tolerant of a missing/partial `audit.jsonl`, already-redacted (audit is written redacted). **Files:** control/control.mjs
- [ ] T2 — `console/serve.mjs`: `GET /api/control/state` → `{queue, sessions, paused, audit}` from `config.controlBase ?? defaultBase()` (reuse `queue.list` / `machine.listSessions` / `machine.isPaused` / `readAudit`); `POST /api/control` → run `{verb, ...}` through `runControl` (allowlist enforced in the shared path; unknown verb → 400 naming the set, never 500). Host guard applies to both. **Files:** console/serve.mjs
- [ ] T3 — `console/web/index.html` + `console/web/app.js`: a Control tab — queue (seq/state/repo/ticket), sessions (state/pid/heartbeat, heat identity), audit feed, and verb buttons POSTing `/api/control`; destructive verbs (kill-all) reuse the existing two-step confirm. **Files:** console/web/index.html, console/web/app.js
- [ ] T4 — tests + dogfood: `readAudit` unit; `/api/control/state` shape + Host-403; `/api/control` verb round-trip + unknown-verb 400; live dogfood driving a real control base through the endpoints. **Files:** tests/console/control-tab.test.mjs

## Acceptance criteria

- AC-C3.1 — `GET /api/control/state` returns queue + sessions + paused + audit tail from the control base, redacted; non-localhost Host → 403.
- AC-C3.2 — `POST /api/control` runs an allowlisted verb via `runControl` and reflects new state; unknown/forbidden verb → 400 naming the allowed set (never 500); push/merge/edit are absent from the vocabulary.
- AC-C3.3 — `readAudit(base, {limit})` returns the last N records newest-first, tolerates a missing/partial file, surfaces no redacted secret.
- AC-C3.4 — the control tab renders queue/sessions/audit and its buttons POST `/api/control`; kill-all requires the two-step confirm.

## Out of scope

Situationgate paused read (C4), end-to-end ticket dogfood (C5), trace/conformance (C6), alerts (C7), quota (C8). No auth beyond the existing localhost + Host guard — single-user local console by design.
