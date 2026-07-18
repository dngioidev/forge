# C2 — forge-control runner

**Ticket:** #62 (board #12) · **Epic:** #56 · **Branch:** `feat/62-control-runner` · **Spec:** forge-control §2/§12.

The daemon `work` loop that C1 was built to feed: take the next runnable queue entry, spawn a headless `claude -p` session, supervise it (heartbeat / timeout / kill), and record the outcome to the journal + ticket trail. The control plane still never merges — the spawned session runs the normal pipeline and the owner merges the PR. No cloud, ever.

## Spike (done first — spec §12 flagged headless mechanics as unverified)

Verified on this machine (Claude Code 2.1.207) against real `claude -p` runs:

- success → exit `0`, envelope `subtype:success`, `is_error:false`;
- `--session-id <uuid>` round-trips exactly → runner mints the id and tracks/kills/resumes by it;
- resume `-r <sid>` retains context;
- failure (bad model) → exit `1` but **still valid JSON on stdout** (`is_error:true`, `api_error_status`, `terminal_reason`) → always parse stdout JSON, classify via `is_error`/`terminal_reason` + exit code;
- per-session `total_cost_usd`/`usage` in the envelope → feeds C8 quota.

Verified spawn shape: `claude -p "<brief>" --session-id <uuid> --output-format json --model <m> --permission-mode <mode> --add-dir <repo>`.

## Tasks

- [ ] T1 — `control/lib/spawn.mjs`: `buildArgs({brief, sessionId, repo, model, permissionMode})` → the exact verified flag array; `classify(exitCode, envelope)` → `success|api_error|timeout|killed`; `spawnSession(opts)` real spawner (node `child_process`) returning `{sessionId, pid, kill(), done}` where `done` resolves to the parsed stdout envelope. **Files:** control/lib/spawn.mjs
- [ ] T2 — `control/lib/runner.mjs`: `runOnce(base, {spawn, timeoutMs, trail, journal, now})` — if paused → no spawn (C1 kill switch); else `queue.next` → `registerSession` → spawn → supervise (timeout kills by PID, heartbeat updates `lastHeartbeat`) → classify → `ack` entry + `markSession` with terminal reason. Spawner + trail + journal are injected so the loop is testable without real `claude`. **Files:** control/lib/runner.mjs
- [ ] T3 — `control/runner.mjs`: thin daemon entrypoint (`isMain` guard) — `work(base)` loop calling `runOnce` sequentially (one session per machine, spec §2), stopping when paused or the queue drains. Default `trail` posts a gh issue comment; default `journal` appends via the shared journal lib. **Files:** control/runner.mjs
- [ ] T4 — tests + dogfood: fake spawn (success / api_error / timeout) injected; assert paused→no-spawn, queue ack + session terminal state agree, timeout kill is journaled AND trailed. Dogfood: enqueue a real entry and drive `runOnce` with the real spawner in `plan` mode (no writes). **Files:** tests/control/runner.test.mjs

## Acceptance criteria

- AC-C2.1 — `runOnce` respects paused (no spawn); otherwise takes `queue.next`, registers a session, spawns, and on completion acks the entry + marks the session `dead`/`killed` with its terminal reason. Queue and session records agree.
- AC-C2.2 — a spawn exceeding `timeoutMs` is killed by PID; the kill is journaled AND trailed on the driving ticket (nothing dies silently — spec §12); heartbeat updates `lastHeartbeat` while alive.
- AC-C2.3 — the spawner is injectable; the real spawner builds the verified flag array and parses the JSON envelope for both the success and error shapes captured in the spike.
- AC-C2.4 — terminal outcome is classified (`success|api_error|timeout|killed`) from exit code + envelope; a trail line is posted for the outcome.

## Out of scope

Console control tab (C3), situationgate reading paused (C4), real end-to-end ticket dogfood (C5), agent-work trace (C6), quota panel (C8). This epic delivers the loop mechanism + supervision only.
