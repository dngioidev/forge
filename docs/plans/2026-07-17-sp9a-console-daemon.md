# SP9a — Console: transport-abstracted daemon + escalation inbox + monitoring basics

**Ticket:** #11 · **Branch:** `feat/11-console-daemon` · **Spec:** §11, rollout row 9a.
**Owner decision (recorded on #11):** option 2 — transport-abstracted daemon first. File transport is fully live/dogfoodable; the Firestore adapter is structural until the owner provisions Firebase (follow-up owner step). Console graduates to `forge-console` after this epic — everything lands in a top-level `console/` directory so graduation is a directory lift, not a rewrite.

## Shape

```
session ──.forge/{journal,decisions,progress}──▶ daemon (collect → sanitize → publish)
                                                   │ transport (pluggable)
                                        file:  .forge-console/<machineId>/… (local, live today)
                                        firestore: REST adapter (structural until provisioned)
                                                   │ inbox poll
                                        decision reply ──▶ .forge/decisions/<id>.json resolved
```

Design invariants enforced daemon-side (spec §11 guardrails): **metadata only** leaves the machine — ticket refs, phase names, counts, ages, option labels; code/diffs/prompts never enter telemetry (sanitizer + tests, not convention). The daemon is outbound-only. 9a is read-only + decision replies; command verbs are SP9b.

## Tasks

- [ ] T1 — Collectors: `console/lib/collect.mjs` — per-repo snapshot from data that already exists: situation (`situation.mjs`), ticket/branch (git HEAD + `parseBranch`), ledger progress (`ledger.mjs` counts), pending decisions with age, journal tail (last N kind/ts/ticket entries), board counts skipped (gh-dependent; digest owns those).
- [ ] T2 — Sanitizer: `console/lib/sanitize.mjs` — allowlist-of-fields (not denylist) telemetry schema; strings capped; journal entries reduced to {ts, kind, ticket, gate/rule name}; anything unrecognized dropped. A telemetry doc that fails the schema never publishes.
- [ ] T3 — Transports: `console/lib/transport.mjs` (interface + registry) · `console/transports/file.mjs` (outbox = `<dir>/<machineId>/telemetry.jsonl` + `escalations.jsonl`, inbox = `<dir>/<machineId>/decisions/*.json`) · `console/transports/firestore.mjs` (REST: PATCH telemetry doc, POST escalation, LIST inbox; service-account path + project id from machine config; **structural tests only** — no live Firebase).
- [ ] T4 — Daemon: `console/daemon.mjs` — machine config `~/.forge/daemon.json` (machineId, repos[], transport, intervalSec; `register` subcommand creates it), `once` (collect → publish → inbox → write-back), `watch` (interval loop), heartbeat in every publish. Inbox write-back: a decision reply doc `{id, answer, by}` resolves `.forge/decisions/<id>.json` (same shape `escalate.mjs --check` leaves) and posts the answer as a trail-style comment via gh when available — GitHub stays the record.
- [ ] T5 — Docs + guide: `docs/guides/console-daemon.md` (run it, file transport layout, what Firebase provisioning will add), route index.
- [ ] T6 — Tests + live dogfood: file-transport round-trip on this repo — real escalate → daemon `once` publishes the escalation → drop a reply doc in the inbox → daemon `once` resolves the decision file; verify `escalate.mjs --check`-compatible state.

**Files:** console/lib/collect.mjs, console/lib/sanitize.mjs, console/lib/transport.mjs, console/transports/file.mjs, console/transports/firestore.mjs, console/daemon.mjs, docs/guides/console-daemon.md, docs/README.md

## Acceptance criteria

- AC-9.1 — collect produces a per-repo snapshot (situation, ticket, branch, ledger counts, pending decisions with age, journal tail) from fixture dirs.
- AC-9.2 — sanitize enforces metadata-only by allowlist: unknown fields dropped, strings capped, code/diff/prompt-bearing fields never pass; a non-conforming doc refuses to publish.
- AC-9.3 — file transport round-trips: publish writes machine-scoped outbox files; inbox decision docs are consumed exactly once.
- AC-9.4 — daemon `once` resolves a pending decision from an inbox reply into `.forge/decisions/<id>.json` with the same resolved shape `escalate.mjs --check` produces, and `--check` then reports no pending decisions.
- AC-9.5 — firestore adapter builds correct REST requests (URLs, auth header wiring, field mapping) — verified structurally with an injected fetch; no live calls.
- AC-9.6 — `register` writes machine config with a stable machineId; re-run keeps the id (idempotent).
- AC-9.7 — heartbeat: every publish carries machineId + ts; a `status` subcommand prints last-publish age per repo.

## Out of scope (→ SP9b or owner steps)

- Command verbs, work queue, kill switch, runner admin — SP9b, on the graduated repo.
- Live Firebase (project provisioning, Auth, FCM, device app) — owner step; the adapter's contract is ready for it.
- Daemon-spawned headless sessions (`claude -p --resume`) — SP9b (it's a command, not telemetry).
- Windows service/autostart packaging — guide documents manual start; packaging belongs to forge-console.
