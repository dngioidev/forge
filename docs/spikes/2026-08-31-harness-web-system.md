# Spike — what the forge harness web system becomes: the state substrate across a repo boundary, and the ADR-0003 observe+drive reversal

**Date:** 2026-08-31 · **Ticket:** #574 (parent epic #573) · **Route:** spike (time-boxed research; deliverable = this findings doc + proposed [ADR-0009](../decisions/0009-harness-web-system.md)). **No harness code exists, no repo was created, and this spike branch never merges.**

## The question and the decision it feeds

**Question:** the forge harness web system is to live in its **own repo** and to **observe *and* drive** agents. Both were owner decisions taken before the spike opened, so they are inputs. What remains genuinely open is: **where does a standalone repo get live agent state from, and what can "drive" actually mean given ADR-0003 deleted exactly this and given how Claude Code's authorization works?**

**Decision it feeds:** the owner's, at one gate — approve or reject ADR-0009, which fixes (a) the harness↔forge state seam, (b) the scope of the ADR-0003 partial reversal, and (c) whether the harness absorbs, wraps, or leaves alone the existing cockpit. Nothing in epic #573 starts before that.

**Time box:** half a day. Held.

## Grounding methodology

Every claim below is checked against real state on this machine: the Claude Code transcript tree under `~/.claude/projects/` was enumerated and parsed programmatically (counts quoted are measured, not estimated); `plugin/scripts/monitors/agents-watch.mjs`, `plugin/scripts/autopilot/ledger.mjs`, `plugin/hooks/hooks.json`, `plugin/monitors/monitors.json`, `tools/runner-ui/forge_cockpit/{server,security,usage}.py` were read directly; ADR-0003/0006/0008 and the #508 parallel-wave spike were read in full. Where a detail could **not** be established inside the time box, it is labelled as such rather than smoothed over — §2.3 and §7 carry the honest gaps.

---

## 1. The bar this has to clear: what ADR-0003 actually said

ADR-0003 (2026-07-19, #95) removed `forge-control` and the local web console outright. Its reasoning, verbatim: the console *"largely **duplicates the status line + `board status`** for single-repo interactive work"*, and the runner's value *"only pays off for **unattended / multi-repo** operation the owner doesn't do."*

That is not a rejection of web UIs. It is a rejection of a web UI **for a workflow that did not exist yet** — and it names its own reversal condition explicitly: *"Re-introduce by reverting to the tag if the unattended-runner workflow is ever wanted."*

That workflow now exists and is the centre of gravity:

- `forge:autopilot` runs unattended for hours (the #508 spike measured one real run: 14 iterations, 11 outcomes, ~20.5 hours, 8 merged tickets).
- ADR-0003 has already been narrowly amended once for it (2026-08-05, owner-signed, #378 — `statusline.mjs` writing `rate_limits` to `.forge/autopilot/usage.json`).
- `forge:execute-agents` fans each plan task out to real subagents; the reviewer and security passes already run concurrently (#475).
- The failure mode that motivated the agent-liveness monitor (#505) was **a delivery subagent that died silently and cost 5.3 hours of a 6.6-hour ticket before a human noticed.**

**Finding 1.** The reversal condition ADR-0003 wrote for itself is satisfied. The honest framing for ADR-0009 is therefore *not* "we changed our minds" but "the named precondition arrived." What stays removed still matters and is stated in §6.

---

## 2. Q1 + Q2 — the state substrate, and what "an agent" is

This is the load-bearing finding of the spike, and it landed differently than expected.

### 2.1 The problem a standalone repo has

Every forge signal today lives in **a target checkout's `.forge/`** — `journal.jsonl` (115 entries here), `autopilot/run.json` (the ledger), `agents/` (liveness heartbeats), `decisions/`, `shape/`, `status-snapshot.json`, `graph.db`. A standalone repo has no `.forge/` of its own, and pointing it at someone else's is a per-checkout, single-machine arrangement that also makes the harness a **second writer** into files with a known unlocked read-modify-write path (§5).

### 2.2 What was actually found: a machine-global agent tree that nobody is reading

Claude Code writes a transcript tree at `~/.claude/projects/` with this verified layout:

```
~/.claude/projects/<slugified-cwd>/
    <sessionId>.jsonl                              ← the root session
    <sessionId>/subagents/agent-<agentId>.jsonl    ← one file per subagent
```

Measured on this machine right now:

| Measure | Value |
| --- | --- |
| transcript files | **1,275** |
| total JSONL lines | **213,936** |
| lines marked `isSidechain` | **170,274** (79.6%) |
| `agent-*.jsonl` subagent files | **1,244** across **17** `subagents/` dirs |
| distinct project roots | ≥5 (`C--mywp-forge`, `C--mywp-cms`, `C--mywp-Tasky-AI`, `C--mywp-Sovra`, `C--mywp-iomanage`) |

Per-line fields observed include: `sessionId`, `agentId`, `uuid`, `parentUuid`, `isSidechain`, `sessionKind`, `type`, `timestamp`, **`cwd`**, **`gitBranch`**, `version`, `entrypoint`, `permissionMode`, `effort`, **`attributionSkill`**, `attributionPlugin`, `message`, `toolUseResult`, `sourceToolAssistantUUID` (2,505 such links in the forge project alone). A sampled subagent file's first line, verbatim in shape:

```json
{"type":"user","agentId":"a0264dc9e0cd43d83","sessionId":"8ce3ec9e-…-a17698e076b3",
 "parentUuid":null,"cwd":"C:\\mywp\\forge","gitBranch":"ci/upgrade-pnpm-action-setup-uv-555",
 "timestamp":"2026-08-23T18:50:03.443Z"}
```

`attributionSkill` values observed in this repo's transcripts are forge's own skills: `forge:autopilot`, `forge:triage`, `forge:distill`, `forge:design`, `forge:brainstorm`, `forge:board`, `forge:doctor`, `forge:statusline`, `forge:docsync-check`, `forge:init`, plus non-forge (`insights`, `artifact-design`, `frontend-design:frontend-design`).

**Finding 2 — this substrate answers Q1 outright, and it answers it *better* for a standalone repo than for an in-repo tool.** It is **machine-global, not per-checkout**: one watcher sees every session across every project. Each line self-attributes to a checkout (`cwd`) and a branch (`gitBranch`), so **the harness learns which repo an agent is working in without knowing anything about that repo, without being installed in it, and without reading its `.forge/`.** The "standalone repo can't see forge state" problem largely dissolves — not by solving the cross-repo seam, but by discovering that the interesting signal was never per-repo to begin with.

**Finding 3 — agent identity and lifecycle are reconstructable cooperation-free.** Identity: `agentId` for a subagent, `sessionId` for a root. Parenting: a subagent file's `sessionId` is its parent's; within a file the DAG is `parentUuid`; `sourceToolAssistantUUID` links back to the spawning tool call. Lifecycle maps onto file events with no cooperation from the agent: **spawned** = file appears, **running** = file appends, **returned** = final line + the parent's `tool_result`, **stalled** = no append for N minutes.

That last one is worth stating plainly, because the repo already has a documented complaint about it. `agents-watch.mjs`'s own docblock says of its heartbeat approach:

> *"a heartbeat written BY the subagent is briefing-dependent… There is no documented, stable, harness-side output/transcript path discoverable from a monitor process in this repo today, so the cooperation-free mtime approach that diagnosed #457 by hand is not buildable here. A subagent wedged badly enough to never execute its own heartbeat-write call is invisible to this monitor exactly as it was invisible before."*

**That constraint is a property of being a short-lived monitor poll inside the harness, not a property of the data.** A separate, long-lived process outside the session can tail this tree — and the cockpit's `usage.py` already proves the pattern works out-of-process in production code (it walks `~/.claude/projects/**/*.jsonl` for the cost panel, ADR-0006). So the harness can observe exactly what the monitor was structurally unable to: **a subagent that dies without ever writing its own heartbeat still stops appending to its transcript file.**

This is the single strongest technical argument for the project existing at all, and it is specific rather than aspirational.

### 2.3 Honest limits on this substrate

- **Undocumented and version-coupled.** This is a private on-disk format with no stability guarantee. Every line carries a `version`; the harness must parse tolerantly and version-adaptively, exactly as `usage.py` does today (unknown shapes skipped, never fatal). A Claude Code release can change it. This is a real, ongoing maintenance liability and must be written into ADR-0009's consequences, not discovered later.
- **Subagent *role* was not found.** Scanning all 1,275 files for `Task` tool-use blocks carrying `subagent_type` returned **zero hits**. So "this is a `forge:implementer`, that is a `forge:reviewer`" is **not** directly available from the fields inspected. It is probably recoverable from the agent file's first user message (the briefing text), but that is inference, not a field, and it was not verified in the time box. **Treat role labelling as an open v1 detail, not a solved one.**
- **`sessionKind` was empty** on the sampled subagent file, and although `agent-name` appears in the global line-type list, it was absent from the sampled file's first 400 lines. The type vocabulary observed globally is: `user`, `assistant`, `ai-title`, `agent-name`, `mode`, `permission-mode`, `file-history-snapshot`, `attachment`, `last-prompt`, `queue-operation`, `system`, `pr-link`, `bridge-session`, `frame-link`, `file-history-delta`. **Partially characterized; a v1 slice needs one more pass over this vocabulary.**
- **Observation is not attribution to a ticket.** `gitBranch` gives `feat/574-…`, and forge's branch convention encodes the issue number (`parseBranch` in `plugin/scripts/lib/ticket.mjs` already does this) — so ticket attribution is derivable for branch-following work, but not for work on `main`.

### 2.4 Alternatives considered for Q1, and why they lost

| Seam | Why it lost |
| --- | --- |
| **Watch registered `.forge/` dirs** | Per-checkout and per-machine; the harness must be told about every repo; contains **no agent tree at all** (only self-reported heartbeats, §2.2); makes the harness a second writer into #569's unlocked path. Kept as a *secondary, read-only* enrichment source — the ledger and escalations are genuinely useful and live nowhere else. |
| **Forge-side emitter (hooks/monitors push to the harness)** | Requires changing `plugin/` (a new hook or monitor per signal), couples the two repos' release cycles, and is **the same briefing-/cooperation-dependent fragility class** `agents-watch.mjs` already documented — a wedged agent doesn't emit. Also re-litigates ADR-0003's "plugin tendrils" complaint. |
| **The GitHub board as the bus** | Wrong granularity (ticket, not agent), minutes of latency, and it spends the shared 5,000 pt/hr GraphQL bucket that the #508 spike found to be **the binding throughput constraint** on autopilot. Actively harmful as a polling substrate. |

---

## 3. Q3 — what "drive" can actually mean

This is where the design has to be honest, because the obvious mental model is wrong.

**Constraint (verified, not assumed):** Claude Code's auto-mode classifier evaluates authorization **per attempt, not once per session** (#397, documented from real production runs; #398's spike confirmed a denial is **not detectable in-process at all** — it blocks the tool call before any script runs, so there is no exit code or stderr to key off). Separately, unattended auto-merge is blocked in auto-mode and needs a **headless `bypassPermissions` relaunch**.

**Finding 4.** Therefore: **a web button cannot reach into a running interactive session and make it do something.** There is no supported control channel into an attached session, and even if a command could be injected, its authorization is re-decided per attempt by a classifier the harness cannot see or predict. Any design premised on "click stop on the agent I'm watching" is premised on a mechanism that does not exist.

"Drive" therefore has to be modelled as **process lifecycle over runs the harness itself owns**, plus **writes to the artefacts a running agent reads**:

| Drive action | Mechanism that actually exists | ADR-0003 duplication test |
| --- | --- | --- |
| **Launch a headless run** (autopilot / deliver on ticket N) | The harness spawns the process (`claude -p …`, `bypassPermissions`) and owns its handle, stdout, and exit | Not duplicated — the status line cannot start anything |
| **Stop / restart a harness-owned run** | Kill the process the harness spawned | Not duplicated |
| **Answer a pending escalation** | Write the decision through the existing escalation path (`escalate.mjs` / `.forge/decisions`, which `decisions-watch.mjs` already polls) — a **file/board write the agent picks up**, not a command sent to a session | Not duplicated — today this needs a terminal and a script invocation |
| **See a stalled subagent and act** | Detection is §2.2's transcript tailing; the action is re-spawn (#474's scope), not resume-in-place | Not duplicated — invisible today by construction |
| **Attach to / steer an interactive session** | **Does not exist.** Out of scope, and must be said out loud in ADR-0009 so it is not quietly assumed into v1 | — |

**Finding 5.** The drive half is legitimate but narrower than "control the agents." It is *launch, stop, and answer* — and every one of those clears ADR-0003's duplication bar, because the status line and `board status` are both strictly read-only and strictly single-checkout.

---

## 4. Q4 — the cockpit relationship

The cockpit is not a sketch; it shipped. Verified in `tools/runner-ui/forge_cockpit/`:

- `server.py` — FastAPI on `127.0.0.1:8765`: `/api/health`, `/api/fleet`, `/api/control`, `/api/logs`, `/api/provision`, `/api/usage`, `/api/machine`, and the `/api/terminal` websocket.
- `security.py` — `LoopbackGuardMiddleware` (Host-header/DNS-rebinding + Origin/CSRF checks) ahead of every route, `mint_session_token`, `require_session_token` on mutating routes, `authorize_websocket` before any shell is spawned.
- `web/index.html` + vendored `xterm.js` — the browser UI; `terminal_bridge.py` — the PTY bridge.

Its **scope is runner/machine/usage**; it has no notion of an agent. But its **hardening is exactly what a second loopback server would otherwise have to re-derive** — and re-deriving loopback auth for a surface that spawns processes is the highest-consequence duplicate work available in this project.

| Option | Cost |
| --- | --- |
| **Absorb** (port the cockpit into the new repo) | A Python→whatever port that regresses shipped, tested code (the whole #350 child chain: #351–#356, #395); leaves a dead `tools/runner-ui/` in the forge repo; largest v1 scope. |
| **Wrap** (harness proxies the cockpit's loopback API) | Two processes, two ports, cross-origin ceremony, and **two languages** if the harness is not Python. But zero regression risk, and the fleet/usage/terminal panels arrive for the cost of a proxy. |
| **Coexist** (two unrelated apps) | Cheapest now; guarantees two loopback servers, two auth models, two UIs the owner must keep straight. Worst end state. |

**Recommendation: wrap for v1, decide absorb-vs-keep later on evidence.** The two-language cost is real and should be recorded as the price of not regressing #350.

---

## 5. Q5 — prerequisites before anything write-capable ships

**#569 is real and verified unwired.** `plugin/scripts/lib/lock.mjs` exists (built for #414's outbox), but grepping `ledger.mjs` for it returns **three hits, all unrelated comment text** (`blocked`, `AV-lock`) — no `acquireLock`, no import. So `run.json`'s read-modify-write remains unlocked, exactly as #387 found on 2026-08-06 and as #569 still records. A second writer corrupts it deterministically.

**The v1 design sidesteps this rather than waiting on it.** If the harness **never writes `.forge/`** — observing from the transcript tree (§2.2) and driving via process spawn + the existing escalation path (§3) — then #569 is not a blocker for v1. It remains a real bug worth fixing on its own merits, and it becomes a hard blocker the moment any harness feature wants to write the ledger.

Minimum prerequisite set for v1:

1. **No `.forge/` writes from the harness** (design constraint, above).
2. **A tolerant, versioned transcript adapter** with an explicit "unknown shape → skip, never crash" contract (`usage.py`'s existing discipline).
3. **Loopback hardening not weaker than the cockpit's** — Host + Origin checks and a per-session capability token before any route that spawns a process. Satisfied by §4's wrap only for the proxied routes; the harness's own spawn routes need their own.
4. **Secret discipline** — transcripts contain full prompts, tool output, and file contents. The harness renders them, so it inherits the journal's redaction obligation (spec §13). This is a genuinely new exposure surface: `runner.env` is refused by `shellout.py` today, but nothing stops a *transcript* from containing a secret someone pasted.

---

## 6. Q6 — the v1 slice, and what the first screen shows

**The screen:** one live view of every Claude Code session on this machine, grouped by checkout (`cwd`) and branch (`gitBranch`), each root session expanding to its subagent tree, each node coloured by liveness (appending / quiet-for-N / finished) and labelled by `attributionSkill`, click-through to a tailed transcript. Beside it: a **run rail** (autopilot ledger — iterations, outcomes, budget readings, read-only) and an **escalation inbox** (pending decisions, answerable). One control: **launch / stop a headless run**.

That is the whole v1. It is deliberately the observe half plus the three drive actions from §3 that clear the ADR-0003 bar, and nothing else.

**Stack recommendation: Node/TypeScript**, server + SSE/websocket + web UI. Reasons: the substrate is JSONL (no parsing advantage to any language); it matches `plugin/`'s JS so ticket/branch helpers like `parseBranch` port directly; and the forge-facing logic stays in one language. **Rejected — Python/FastAPI:** would match the cockpit and let the harness absorb it cheaply, but splits the forge-facing logic away from `plugin/`'s JS libs and duplicates the branch/ticket vocabulary. **Rejected — Go/Rust:** the fastest file tailer by a wide margin, and irrelevant, because 1,275 files is not a performance problem; it buys nothing and reuses nothing.

**What stays removed from ADR-0003** (so the reversal is partial and legible): the job **queue**, the allowlisted-CLI remote execution layer, the **kill switch** and `paused`/situationgate gating, `trace.mjs`, `quota.mjs`, and the quota/alerts/audit console panels. None of them return. The harness observes and launches; it is not a job scheduler.

---

## 7. What this spike did not settle

- **Subagent role labelling** (§2.3) — no `subagent_type` found anywhere; inference from the briefing text is untested.
- **Transcript format stability** — no way to assess how often it changes without watching it across releases. The versioned-adapter mitigation is a bet, not a guarantee.
- **Multi-machine.** Everything here is single-machine (`~/.claude/projects` is local). The epic's "fleet" ambition needs a second spike; the cockpit's own fleet discovery is a separate, PAT-free mechanism that does not carry agent state.
- **Whether the owner wants the cockpit absorbed eventually** — §4 recommends deferring, which is itself a decision to revisit.

## Follow-ups (file if ADR-0009 is approved)

1. Repo creation + naming + board setup for epic #573's new home.
2. Transcript-format adapter spike: full line-type vocabulary, `sessionKind`/`agent-name` semantics, role inference.
3. #569 — wire `lib/lock.mjs` into `ledger.mjs` (independent value; hard blocker for any later write-capable harness feature).
4. Multi-machine spike (deferred from §7).
