# C1 — control queue + machine registry + CLI

**Ticket:** #60 (board #12) · **Epic:** #56 · **Branch:** `feat/60-control-queue` · **Spec:** forge-control §2/§4.

The foundation the runner (C2) stands on: file-backed work queue, machine paused flag, sessions registry, and the `control.mjs` CLI whose verbs are an **allowlist enforced in code** (spec §11 guardrail — unknown verbs rejected at parse, never hidden in UI). No spawning yet (C2); no cloud, ever.

## Tasks

- [ ] T1 — `control/lib/queue.mjs`: `enqueue/next/hold/ack/list` over `<base>/queue/*.json`, ordered by sequence; ack archives to `queue-done/`. **Files:** control/lib/queue.mjs
- [ ] T2 — `control/lib/machine.mjs`: paused flag (`isPaused/setPaused/clearPaused` over `<base>/paused`) + sessions registry (`registerSession/updateSession/listSessions/markSession` over `<base>/sessions/*.json`). **Files:** control/lib/machine.mjs
- [ ] T3 — `control/control.mjs`: CLI, `ALLOWED_VERBS` allowlist (enqueue/dequeue/list/pause/resume/kill/kill-all/status), unknown verb refused with the valid set, every verb appended to `<base>/audit.jsonl` (redacted). **Files:** control/control.mjs
- [ ] T4 — tests + dogfood: enqueue→next→ack round-trip, pause gate, session lifecycle, verb allowlist. **Files:** tests/control/control.test.mjs

## Acceptance criteria

- AC-C1.1 — queue enqueue/next/hold/ack round-trips in FIFO order, file-backed; held entries are skipped by `next`; ack archives.
- AC-C1.2 — paused flag: `setPaused` then `isPaused` true with who/when; `clearPaused` → false; missing file → false.
- AC-C1.3 — sessions registry: register → list shows it; update patches; markSession sets state (e.g. killed).
- AC-C1.4 — `control.mjs` rejects an unknown verb naming the allowed set; every accepted verb writes a redacted audit record.

## Out of scope

Spawning `claude -p` (C2), supervision/heartbeat (C2), console control tab (C3), situation gating on paused (C4).
