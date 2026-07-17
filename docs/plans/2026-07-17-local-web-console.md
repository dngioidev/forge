# Local web console — monitor + decide from the browser, zero cloud

**Ticket:** #37 · **Branch:** `feat/37-local-web-console` · **Spec anchor:** §11 (console mission), delivered as the local rung under SP9b.

`node console/daemon.mjs serve` → `http://127.0.0.1:7433` — live per-repo monitoring (situation, ticket/branch, ledger progress, pending decisions with age, journal tail) and **tap-to-answer escalations**: an answer button writes the exact resolved decision file the daemon inbox produces, so a halted pipeline resumes identically. Zero dependencies, localhost-only, no cloud; SP9b later reuses this page as the app's skeleton.

## Tasks

- [ ] T1 — Server: `console/serve.mjs` — node:http on 127.0.0.1 only; `GET /` (page), `GET /api/state` (live `collectRepo` per configured repo — fresher than outbox files), `POST /api/decide` (delegates to the daemon's `resolveReply`). Host-header allowlist (localhost/127.0.0.1/[::1]) as the DNS-rebinding guard; no-store caching.
- [ ] T2 — Page: `console/web/index.html` — fully self-contained (inline CSS/JS, no CDN); situation glyph per repo, ticket/branch, ledger bar, decision cards with one button per option + free-text answer, journal tail; polls /api/state every 5s.
- [ ] T3 — Wiring: `console/daemon.mjs` gains the `serve` subcommand (`--port`, default 7433); guide section in `docs/guides/console-daemon.md`.
- [ ] T4 — Tests + live dogfood: real http round-trips on an ephemeral port against fixture repos; then serve this machine's real config and hit /api/state live.

**Files:** console/serve.mjs, console/web/index.html, console/daemon.mjs, docs/guides/console-daemon.md, docs/README.md

## Acceptance criteria

AC-B5.1 state API live snapshots · AC-B5.2 decide == daemon-inbox resolution, unknown id 404 · AC-B5.3 localhost-only + Host guard · AC-B5.4 self-contained page · AC-B5.5 live serve on this machine.

## Out of scope

Command verbs beyond decisions, auth (localhost = the machine owner; multi-user auth is SP9b/Firebase), HTTPS, cross-machine views (that's the cloud transport's job).
