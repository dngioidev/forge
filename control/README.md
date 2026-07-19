# forge-control — operator guide (#56)

forge-control is a **local control plane**: one command surface for enqueueing, watching, and stopping headless agent work on this machine. It never pushes, merges, or edits files — its entire vocabulary is an allowlist of verbs enforced in code, not hidden in a UI. Everything below is file-backed under `~/.forge/control`.

## CLI verbs

```
node control/control.mjs enqueue --repo C:/mywp/forge --ticket 71 --brief "..."
node control/control.mjs dequeue --id <queue-id>
node control/control.mjs list
node control/control.mjs status
node control/control.mjs pause --reason "..."
node control/control.mjs resume
node control/control.mjs kill --id <session-id>
node control/control.mjs kill-all
```

An unknown verb is refused at parse — it never reaches the queue or machine files. Every accepted command is appended to a redacted audit log at `~/.forge/control/audit.jsonl`.

## The kill switch

`~/.forge/control/paused` — presence engages it, absence clears it. `pause`/`kill-all` write it; `resume` deletes it. **Clearing it is always a human file delete, never automated.**

Both halves of the pipeline honor it: the **runner** (below) checks it before spawning anything and spawns nothing while it's set, and **situationgate** (`plugin/scripts/lib/situation.mjs`) reads the same flag so `paused` reports as the machine's situation and manual sessions' ship/release gates hold too — not just queued work.

## The runner

```
node control/runner.mjs [--once]
```

Started by the owner, not a control verb — the runner is the thing being controlled, and the allowlist above can't spawn anything itself. Each pass takes the next pending queue entry, spawns a headless `claude -p "<brief>"` session (cwd = the entry's repo), and supervises it: tracks the PID in `~/.forge/control/sessions/<id>.json`, watches `.forge/*` mtimes for a heartbeat, kills + journals on timeout, and moves to the next entry when the session's normal pipeline (ledger, journal, trail, PR) finishes. `--once` runs exactly one entry then exits; with no flag it drains the whole queue once.

## Console control tab (localhost only)

```
GET  /api/control/state    # queue + sessions + paused, read-only snapshot
POST /api/control          # body selects a verb; runs through the same allowlist as the CLI
```

Served by `console/serve.mjs`, bound to `127.0.0.1` with the same foreign-`Host` rejection as the rest of the console — no auth because localhost *is* the machine owner. The CLI and the tab are the same surface: both call `runControl` against the same queue and machine files.
