# forge-control — local agent management & control plane (#56)

**Status: draft — awaiting owner approval** (decision on #56). Board: project #12. Code home: top-level `control/` beside `console/`. This is spec §11's control half (SP9b) pulled forward **local-first**: no Firebase, no cloud — the file transport and localhost console we already have, grown a command lane.

## 1. What it is

Mission control for every repo and session on the machine: **see everything the pipeline records, and drive the four things a human may drive remotely** — answer decisions (exists today), enqueue work, pause/resume/kill sessions, and flip the global kill switch. It applies the forge plugin to its own development: every epic below runs through the standard loop on board #12.

## 2. Orchestration — how it works, mechanically

```
[you] enqueue (console UI / control.mjs CLI)      queue entry: {ticket, repo, brief, enqueuedAt}
        ▼  .forge-control/queue/<id>.json (machine-level, ordered)
daemon watch loop picks next  ──▶  situationgate check (incident/security/paused ⇒ hold)
        ▼
spawns headless session: claude -p "<brief>" (cwd = repo)   — one at a time per machine
        ▼
session runs the NORMAL pipeline: ledger, journal, trail, PR — owner still merges
        ▼
daemon supervises: heartbeat from .forge/* mtimes · timeout ⇒ kill + journal ·
escalation ⇒ queue holds, decision card in console · done ⇒ next queue entry
```

- **Kill one session**: daemon tracks spawned PIDs in `.forge-control/sessions/<id>.json`; kill = terminate PID + journal `session-killed` + trail note on the ticket.
- **Global kill switch**: writes `paused: true` to `.forge-control/paused` — the daemon spawns nothing, and (epic C4) situationgate learns to read it so even manual sessions' ship/release hold. Clearing it is a file delete — always human, never automated.
- **Guardrails (§11, enforced in code)**: command verbs are an allowlist in the daemon (`decide`, `enqueue`, `dequeue`, `pause`, `resume`, `kill`, `kill-all`) — unknown verbs rejected at parse, not hidden in UI. The control plane never pushes, merges, or edits files. Every command journaled with who/when.

## 3. View/track everything (the console grows a control tab)

Aggregated per machine: repos (existing heat cards) + **sessions** (alive/idle/dead, current ticket, last heartbeat, elapsed) + **queue** (pending entries, ordered, with hold reason) + **agent activity** (role/backend/fallback events from journals) + command audit tail. All read from files the daemon already owns; the tab's actions POST the allowlisted verbs to serve.mjs, which the daemon consumes from the same queue dir — UI and CLI are the same surface.

### 3a. Agent-work trace — how and where it goes (owner ask)

Per session, a **timeline** reconstructed from files that already exist: plan phase → ledger task → files touched (git diff --name-only on the session's branch) → journal events → the role/backend each step ran on → PR opened. The question "where did the agent go" is answered by the ordered journal + ledger; the trace renders it as a phase strip with the current step lit (the heat identity). No new capture — the pipeline already writes all of it; C6 just reads and orders it.

### 3b. Structure conformance — does it match the forge structure (owner ask)

A per-session **conformance badge** aggregating checks the platform already computes, run live against the session's branch:
- on a valid forge branch (`parseBranch` kind ≠ unknown; not a spike asking to ship)
- its ledger references a committed plan in `plansDir`
- touched files ⊆ the plan's `**Files:**` scope (plandrift, run live not just at ship)
- pipeline phases present in the trail (started → … in order)
Green = conforming; amber = drifting (names the failing check); this is the "is the agent staying inside the lines" signal, surfaced before ship, not at it.

### 3c. Alerts — get told when something goes wrong (owner ask)

The daemon watches each repo's journal tail for **failure-kind events** (`gate-fail`, `cmd-fail`, `blocked-edit`, `backend-fallback`, `incident`, `respond-open`) and a session heartbeat going stale (hung/crashed). On a new one: a red banner in the console control tab + an entry in an alerts feed + **optional OS toast** (Windows: a PowerShell notification via a user-enabled hook — off by default, no dependency). **Honest limit:** true push-to-phone is the Firebase step (unchanged); this is local, best-effort-loud alerting — you must have the console open or the toast enabled.

### 3d. Claude Code quota (owner ask)

The statusline payload already carries `rate_limits` (5h / 7d used %) and `cost` — but only Claude Code sees it, not the daemon. C8 captures it: a tiny statusline side-effect appends `{ts, five_hour%, seven_day%, cost}` to `.forge/quota.jsonl` (opt-in, redacted, no prompt content), which the console reads to show a **quota panel** — current window usage, trend, and cost per day/repo. **Honest limit:** without that capture the daemon is blind to quota (it's not in any file it owns); with it, the panel is as fresh as your last status-line refresh.

## 4. Epics (board #12, in order)

| # | epic | size |
| --- | --- | --- |
| C1 | queue + machine files: `control/lib/queue.mjs` (enqueue/next/hold/ack), paused flag, sessions registry, `control.mjs` CLI (allowlisted verbs) | S |
| C2 | runner: daemon `work` loop — spawn `claude -p`, supervise (heartbeat/timeout/kill), journal + trail integration | M |
| C3 | console control tab: sessions/queue/audit views + verb buttons on serve.mjs (localhost-only, same Host guard) | M |
| C4 | situationgate reads the machine paused flag; `paused` situation lands in deriveSituation | S |
| C5 | dogfood: run one real forge ticket end-to-end through the queue (enqueue → headless session → PR → owner merge) | S |
| C6 | agent-work trace + structure conformance (§3a/§3b): timeline per session + live conformance badge | M |
| C7 | alerts (§3c): daemon journal-failure watcher → console banner + alerts feed + opt-in OS toast | S |
| C8 | quota panel (§3d): opt-in statusline `.forge/quota.jsonl` capture + console quota view | S |

## 5. Out of scope

Firebase/FCM/device app (unchanged owner step; this local plane becomes its backend), multi-machine views (cloud transport's job), parallel sessions per machine (sequential first — correctness before throughput), auto-merge anything.

## 6. Risks, honest

Headless `claude -p` spawn mechanics (flags, session resume, exit codes) are **unverified** — C2 starts with a spike if reality differs from the plan. Timeout kills can orphan branches — the supervisor always trails what it killed so nothing dies silently.
