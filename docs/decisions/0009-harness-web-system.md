# ADR-0009 — The forge harness web system: a standalone repo, observing the Claude Code transcript tree, driving by process ownership

**Date:** 2026-08-31 — **Status:** **Accepted** (owner-signed 2026-09-01, decision `esc-574-mtharb9s`) — **Ticket:** #574 (spike; parent epic #573) — **Route:** spike (deliverable = [findings doc](../spikes/2026-08-31-harness-web-system.md) + this ADR). **Partially supersedes:** ADR-0003 (see § The ADR-0003 relationship). **Does not supersede:** ADR-0008 / the cockpit.

## Context

Epic #573 proposes a web harness system for forge: handle and visualize agents in a browser. Two framing decisions were taken by the owner up front — it lives in a **new standalone repo**, and it **observes and drives** rather than only watching.

That immediately collides with three pieces of existing, load-bearing history:

1. **ADR-0003** removed `forge-control` and the local web console because the console *"largely duplicates the status line + `board status`"* and the runner only pays off for *"unattended / multi-repo operation the owner doesn't do."*
2. **ADR-0008 / epic #350** already built a permissive local web app — the **cockpit** (FastAPI on loopback, `LoopbackGuardMiddleware` + capability token, PTY-over-websocket, xterm.js UI). Its scope is runner/machine/usage, not agents.
3. Every forge signal lives in a **per-checkout `.forge/`**, which a standalone repo does not have.

The spike investigated all three plus the mechanics of what "drive" can mean. See the findings doc for measurements and grounding.

## Decision

### 1. The reversal condition ADR-0003 wrote for itself has arrived

ADR-0003 named its own re-introduction condition: *"if the unattended-runner workflow is ever wanted."* `forge:autopilot` is that workflow, it is now central, and ADR-0003 has already been amended once for it (#378, owner-signed). The motivating failure — a delivery subagent that died silently and cost **5.3 hours of a 6.6-hour ticket** before a human noticed (#505/#457) — is precisely a thing no status line can show.

**Adopt a partial reversal, scoped exactly as § The ADR-0003 relationship below.**

### 2. The state substrate is the Claude Code transcript tree, not `.forge/`

The harness observes `~/.claude/projects/` — verified on this machine as **1,275 files / 213,936 lines / 1,244 `agent-*.jsonl` subagent files**, laid out as `<slugified-cwd>/<sessionId>.jsonl` plus `<sessionId>/subagents/agent-<agentId>.jsonl`. It is **machine-global**, and every line self-attributes via `cwd` and `gitBranch`.

This is what makes a standalone repo work: **the harness learns which repo an agent is working in without being installed in that repo and without reading its `.forge/`.** Agent identity (`agentId`/`sessionId`), parenting (`sessionId`, `parentUuid`, `sourceToolAssistantUUID`), and lifecycle (file created / appending / quiet / final line) are all reconstructable **without cooperation from the agent** — which is exactly the capability `agents-watch.mjs`'s docblock records as unavailable to an in-session monitor. `.forge/` remains a **secondary, read-only** source for the ledger and escalations.

Alternatives rejected: watching registered `.forge/` dirs (per-checkout, contains no agent tree, makes the harness a second writer); a forge-side hook/monitor emitter (couples release cycles, and shares the cooperation-dependent fragility that a wedged agent doesn't emit); the GitHub board as the bus (wrong granularity, and it spends the 5,000 pt/hr GraphQL bucket that #508 found binding).

### 3. "Drive" means process ownership + artefact writes — never session remote-control

Claude Code's auto-mode classifier authorizes **per attempt** (#397), a denial is **not detectable in-process** (#398), and unattended merge needs a headless `bypassPermissions` relaunch. **There is no control channel into a running interactive session.** Drive is therefore defined as, and limited to:

- **launch** a headless run the harness spawns and owns;
- **stop/restart** a harness-owned run;
- **answer a pending escalation** by writing through the existing escalation path (which `decisions-watch.mjs` already polls);
- **re-spawn** a detected-stalled subagent (#474's mechanism).

**Explicitly out of scope: attaching to or steering an interactive session.** Named here so it is not quietly assumed into v1.

### 4. The cockpit is wrapped, not absorbed

The harness proxies the cockpit's loopback API for fleet/machine/usage/terminal rather than porting it. Rationale: the cockpit's hardening is exactly what a second loopback server would otherwise re-derive, and re-deriving loopback auth in front of process spawning is the highest-consequence duplicate work in this project. **Accepted cost: two processes, two ports, and two languages** (harness in Node/TS, cockpit in Python). Absorb-vs-keep is revisited later on evidence, not now.

### 5. Stack and v1 slice

**Node/TypeScript** — the substrate is JSONL (no language advantage), it matches `plugin/`'s JS so branch/ticket helpers port directly, and the forge-facing logic stays in one language. Rejected: Python/FastAPI (would match the cockpit but splits forge-facing logic from `plugin/`); Go/Rust (fastest tailer, reuses nothing, and 1,275 files is not a performance problem).

**v1 is one screen plus one control:** a live agent tree grouped by checkout and branch, subagents nested, coloured by liveness, labelled by `attributionSkill`, click-through to a tailed transcript — beside a read-only autopilot run rail and an answerable escalation inbox; and launch/stop for a headless run. Nothing else.

## The ADR-0003 relationship (what returns, what stays dead)

**Returns:** a local web UI, now with a specific job ADR-0003's console did not have — showing unattended, multi-agent, multi-checkout execution that is genuinely invisible to the status line and `board status`, both of which are read-only and single-checkout.

**Stays removed, permanently:** the job **queue**; the allowlisted-CLI remote execution layer; the **kill switch** and `paused`/situationgate gating; `trace.mjs`; `quota.mjs`; and the quota/alerts/audit console panels. **The harness observes and launches. It is not a job scheduler and not a remote-execution plane.**

## Consequences

- **New, ongoing liability: the transcript format is private, undocumented, and version-coupled.** The harness must parse tolerantly and version-adaptively (`usage.py`'s existing "unknown shape → skip, never crash" discipline). A Claude Code release can break the reader. This is accepted knowingly, not discovered later.
- **New exposure surface: transcripts contain full prompts, tool output, and file contents.** Rendering them inherits the journal's redaction obligation (spec §13). `runner.env` refusal protects the cockpit's shell-out path; nothing protects against a secret someone pasted into a session.
- **v1 writes nothing to `.forge/`**, which keeps **#569** (`ledger.mjs`'s unlocked read-modify-write — verified still unwired despite `lib/lock.mjs` existing) out of the critical path. #569 stays worth fixing on its own merits and becomes a hard blocker for any later write-capable feature.
- **Loopback hardening is mandatory for the harness's own spawn routes**, not inherited from the proxy: Host + Origin checks and a per-session capability token before anything that starts a process.
- **Two repos, two boards.** Cross-repo ticket trails become a standing cost; forge's OSS flip (#209) and the harness's licensing are now separate questions.
- **Single-machine only.** `~/.claude/projects` is local; the "fleet" ambition needs its own spike.
- **Open detail carried into build:** subagent *role* labelling (`forge:implementer` vs `forge:reviewer`) — no `subagent_type` was found in any of the 1,275 files; inference from briefing text is plausible but untested.

## The fallback that was not taken (recorded)

Had this been rejected, the fallback was **observe-only in the existing cockpit**: add an agent-tree panel to `tools/runner-ui/` reading the same transcript tree, no new repo, no drive half, no ADR-0003 reversal. That captures the strongest finding of the spike (§2 of the findings doc) at a fraction of the scope, and forfeits launch/stop/answer.
