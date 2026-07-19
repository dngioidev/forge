# Console control — operator guide

The **console control** is forge-control's local cockpit: a browser view of the work queue, the
running agent sessions, the audit trail, alerts, quota, and a per-repo work trace + conformance
badge — plus buttons to pause, resume, and kill work. It's how you *see and steer* the agents
running on your machine.

> **Read this first — where it lives.** The console and control plane are **repo-level tooling**
> (`console/` and `control/` in the forge repo). They are **not packaged in the installed plugin**
> today, and the plugin is still tagged **0.3.0** (the C1–C8 control-plane work is merged to `main`
> but unreleased). So you run the console control **from a forge checkout**, not from
> `~/.claude/plugins/…`. Until a release packages them, `/plugin update` will not give you these
> features. See [Limits & status](#limits--status).

---

## 1. Prerequisites

- **Node 22+** on `PATH` (`node --version`).
- **A checkout of the forge repo** — clone it or use your existing one:
  ```sh
  git clone https://github.com/dngioidev/forge && cd forge
  ```
- **`gh` CLI** authenticated (`gh auth status`) — only needed if you want session trails posted to
  GitHub issues; the console itself works offline.
- The repos you want to watch should each be forge-initialised (they have a `.forge/` directory —
  journal, decisions, ledger). That's what the console reads.

All commands below are run from the root of your forge checkout.

---

## 2. Launch the console

```sh
# 1. register the machine + tell it which repos to watch (run once per repo, from that repo's dir)
cd /path/to/your/project && node /path/to/forge/console/daemon.mjs register
cd /path/to/another/project && node /path/to/forge/console/daemon.mjs register

# 2. start the console
cd /path/to/forge
node console/daemon.mjs serve            # → http://127.0.0.1:7433
node console/daemon.mjs serve --port 8080  # a different port
```

Open **http://127.0.0.1:7433**. It binds `127.0.0.1` only and rejects non-localhost `Host` headers
(a DNS-rebinding guard) — it is a single-user local console by design, with no auth beyond that.

`register` writes `~/.forge/daemon.json` (machine id + repo list). Re-running it in a new repo adds
that repo; it's idempotent.

---

## 3. The control tab

The page shows one card per registered repo (situation glyph, branch/ticket, ledger progress,
decisions, and — from C6 — a **trace strip** + **conformance badge**). Below the repo cards sits the
**forge-control** panel:

| Section | What it shows |
|---|---|
| **queue** | pending/held work entries — seq, state, repo, ticket |
| **sessions** | spawned agent sessions — id, state (alive/idle/dead/killed), pid, last heartbeat |
| **audit** | recent control commands (redacted) |
| **alerts** | a red banner + feed when something fails (gate-fail, cmd-fail, blocked-edit, backend-fallback, incident, respond-open) or a session heartbeat goes stale |
| **quota** | Claude Code 5h / 7d usage bars + trend + cost-per-day (opt-in, see §6) |

**Buttons** (the safe subset of the allowlist): **pause**, **resume**, **kill-all**. `kill-all`
requires a **two-step confirm** (click once to arm, again to fire) because it stops every session
and engages the kill switch.

Per-repo, the **conformance badge** is 🟢 green when the branch is a valid forge branch, its work
maps to a committed plan, and touched files stay in that plan's scope; 🟡 amber names the first
failing check. The **trace strip** lights the current pipeline step (plan → tasks → files → PR).

---

## 4. Putting work through the plane (CLI)

The control plane's full vocabulary is the `control.mjs` CLI. It is an **allowlist enforced in
code** — it can `enqueue`/`dequeue`/`list`/`status`/`pause`/`resume`/`kill`/`kill-all` and **nothing
else**. It can never push, merge, or edit files.

```sh
# queue a ticket for an agent to work (repo = filesystem path; add --repo-slug for GitHub trails)
node control/control.mjs enqueue --repo /path/to/project --ticket 42 --brief "implement X per the plan"

# see what's queued / running
node control/control.mjs list
node control/control.mjs status

# the kill switch — stop everything (clearing is human-only, see §5)
node control/control.mjs pause  --reason "stepping away"
node control/control.mjs resume
node control/control.mjs kill --id <sessionId>
node control/control.mjs kill-all
```

State lives under `~/.forge/control/` (`queue/`, `sessions/`, `paused`, `audit.jsonl`). The console
tab reads exactly this.

---

## 5. The runner — how queued work actually runs

Enqueuing does not spawn anything by itself. The **runner** drains the queue:

```sh
node control/runner.mjs           # drain the queue once through, then exit
node control/runner.mjs --once    # run exactly one entry
```

For each entry it mints a session id, spawns a headless `claude -p` session in the entry's repo,
supervises it (heartbeat + timeout kill), records the outcome to the control journal + the ticket
trail, and acks the entry. **The control plane never merges** — the spawned session runs the normal
forge pipeline and opens a PR; **you** merge it.

**The kill switch is binding.** While paused (`~/.forge/control/paused` present):
- the runner spawns nothing;
- the situationgate refuses **ship** and **release** even for manual work — a hotfix during an
  incident still waits on the machine.

Clearing the switch is **always a human action** (`resume`, or delete the file) — never automated.

---

## 6. Optional extras (off by default)

- **Quota panel capture.** The quota panel is blank until you opt in *per repo*:
  ```sh
  touch /path/to/project/.forge/quota.capture
  ```
  With the marker present, each status-line refresh appends a **numbers-only** sample
  (`{ts, fiveHour%, sevenDay%, cost}` — no prompt content) to `.forge/quota.jsonl`, which the panel
  summarises. Freshness is bounded by your last status-line refresh.
- **OS toast on alerts.** Alerts always show in the console; a desktop toast (Windows, dependency-free
  PowerShell balloon) is opt-in and off by default. It fires only when the server is configured with
  `toastEnabled` (there is no `serve` flag for it yet — a candidate enhancement).

---

## 7. Safety model (why this is safe to run)

- **Allowlist in code** — the control vocabulary is a fixed set; `push`/`merge`/`edit` aren't in it.
- **Owner merges** — the plane opens PRs; a human merges every one.
- **Kill switch** — one `pause` holds all spawning *and* manual ship/release; human-only to clear.
- **Local only** — 127.0.0.1 bind + Host-header guard; nothing leaves the machine (true
  push-to-phone is a separate, unbuilt Firebase step).
- **Redacted** — the audit log and quota samples never carry secrets or prompt content.

---

## 8. Limits & status

- **Not in the plugin yet.** `console/` + `control/` ship as repo tooling, not in the packaged
  plugin, and no release since 0.3.0 includes the C1–C8 work. To use the console control you need a
  forge **checkout**. Packaging them (and cutting a release) is the follow-up that makes
  `/plugin update` deliver this.
- **Best-effort-loud, not push.** Alerts/toast require the console open or the toast enabled; there
  is no phone push without Firebase.
- **Quota is as fresh as your last status-line refresh**, and cost-per-day is approximate (derived
  from the running session cost).

---

## 9. Quick reference

```sh
node console/daemon.mjs register     # add the current repo to the watch list
node console/daemon.mjs serve        # open the console at http://127.0.0.1:7433
node control/control.mjs enqueue --repo <path> --ticket <n> --brief "..."
node control/control.mjs list | status | pause | resume | kill --id <s> | kill-all
node control/runner.mjs [--once]     # drain the queue (spawn + supervise sessions)
touch <repo>/.forge/quota.capture    # opt in to the quota panel for that repo
```
