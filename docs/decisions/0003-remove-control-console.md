# ADR-0003 — Remove forge-control and the local console

**Date:** 2026-07-19 · **Status:** accepted · **Ticket:** #95 · **Supersedes:** ADR-0002

## Context

forge-control (C1–C8: queue, allowlisted CLI, kill switch, headless-session runner, trace/conformance, alerts, quota) and the local web console (SP9a/9b) were built and shipped in v0.5.0. In review with the owner they proved to be **unused for a solo, interactive workflow**:

- the runner's value (queue → autonomous `claude -p` session → PR) only pays off for *unattended / multi-repo* operation the owner doesn't do;
- the console (queue/sessions/audit/alerts/quota/trace panels) largely **duplicates the status line + `board status`** for single-repo interactive work;
- the kill switch + situationgate `paused` gating are only meaningful when autonomous sessions are running.

They also carry ongoing cost: test-suite time, maintenance, and a `paused`/quota footprint in core plugin files. ADR-0002 kept them as repo tooling; this supersedes that — they're removed entirely.

## Decision

Remove forge-control + the console and their plugin tendrils:

- delete `console/`, `control/`, and their tests;
- delete the plugin libs used only by them (`trace.mjs`, `quota.mjs`, `trace` CLI);
- revert the plugin tendrils to pre-C4/C8: `situation.mjs` (no `paused` situation / `machinePaused` / `controlBase`), `situationgate.mjs` (no paused gating), `statusline.mjs` (no quota capture);
- remove the operator guides that documented removed tooling.

## Consequences

- The pipeline plugin — skills, agent roster, board automation, gates, care flows, learning loop, graph, deploy, release — is **unaffected**; the suite drops from 353 to 261 tests, all green.
- **Kept** (not control/console): the board-scripting ergonomics from the iomanage feedback — batch create (`--from`), `reparent.mjs`, the `Program` type, and doctor's plan-aware secret-scan.
- **Recovery:** everything is preserved in the **v0.5.0** tag; the historical `docs/specs/2026-07-18-forge-control.md`, the SP9a/console plans, and the console design spec remain as the record. Re-introduce by reverting to the tag if the unattended-runner workflow is ever wanted.
- **Narrow exception (2026-08-05, owner-signed, #378):** `forge:autopilot` is now exactly the unattended, long-running workflow this ADR anticipated ("re-introduce... if the unattended-runner workflow is ever wanted") — and a long run can be cut off mid-ticket by Claude Code's 5-hour session usage window with no self-awareness of the remaining budget. A spike (`docs/spikes/2026-08-05-session-window-detection.md`, PR #381) confirmed no pull-based API exists for session-window state; the only real signal is `statusline.mjs`'s existing `rate_limits` payload, which is push-only. The owner approved (decision on #378, `esc-378-msfttmev` option a) a narrow, best-effort exception: `statusline.mjs` writes that payload to `.forge/autopilot/usage.json` on every invocation, so autopilot's self-pause feature (`autopilot/sessionpause.mjs`) can poll it between tickets. This is **not** a reversal — `trace.mjs`, `control/`, `console/`, the queue, and the kill switch all stay removed; only this one thin, opt-in-config-gated read-back of data the script already parses returns.
