# Spike — session usage-window detection for autopilot self-pause (#378)

**Date:** 2026-08-05 · **Ticket:** #378 (parent #183) · **Decision:** `esc-378-msfttmev`, option (a) spike, owner-approved 2026-08-05 · **Route:** spike (deliverable = this findings doc; no code changed).

## Question

Ticket #378 wants `forge:autopilot` to self-pause near Claude Code's 5-hour session usage window and auto-continue after, instead of running until cut off mid-ticket. The open question blocking AC.1: **is there any real, grounded way for autopilot's orchestrator loop to know how close it is to that limit?**

## Findings

1. **A real harness signal exists, but is push-only.** The statusline hook contract (`plugin/scripts/statusline.mjs` `renderLimits()`) already reads `rate_limits.five_hour.used_percentage` from the JSON payload Claude Code pipes to the statusline script over stdin. Confirmed conditions (`docs/guides/troubleshooting.md` §2): **Pro/Max subscriptions only**, and **only after the first response** in a session. Critically, this is the harness calling *out* to the script on its own UI-refresh cadence — the script has no way to call back in and ask "what's my usage right now."
2. **No pull-based API exists.** Externally verified (Claude Code documentation review, 2026-08-05): no CLI flag, slash command with machine-readable output, environment variable, hook event, or MCP resource exposes on-demand session-usage state. `/usage` is interactive-terminal-only. Hook payloads (`session_id`, `prompt_id`, `cwd`, `permission_mode`, etc.) carry no rate-limit fields, including the `StopFailure` event (which fires only *after* a limit blocks, not proactively). This is a confirmed, documented gap in Claude Code itself, not a research miss.
3. **The wall-clock proxy remains what the ticket already flagged.** `run.json`'s `startedAt` (via `plugin/scripts/autopilot/ledger.mjs`) gives elapsed time since the *autopilot run* started — not since the *session* started. A resumed session, or a run started partway into an existing session's window, breaks the assumption. Still true; not eliminated by this spike.
4. **A real middle option: reuse the statusline hook's own refresh cadence as a poll.** Claude Code lets the statusline command specify a `refreshInterval`. If `statusline.mjs` writes the `rate_limits` payload it already receives to a small local file (e.g. `.forge/autopilot/usage.json`) on every invocation, autopilot's orchestrator loop can read that file between tickets — turning the push into a de-facto poll, at whatever cadence the refresh interval is set to. No undocumented API, no new Claude Code capability needed — just closing a loop between two things forge already has.

## The catch — this touches a signed ADR

Option 4 means **re-adding a form of quota-capture to `statusline.mjs`** — the exact file ADR-0003 (#95, 2026-07-19) explicitly stripped quota-capture from, as part of removing the unused forge-control/console apparatus. ADR-0003's own text is notable here: it justified removal partly because *"the runner's value... only pays off for unattended/multi-repo operation the owner doesn't do"* — but `forge:autopilot` **is now exactly that unattended, long-running workflow**, built after ADR-0003 landed. The ADR even names its own recovery path: *"re-introduce by reverting to the tag if the unattended-runner workflow is ever wanted."*

This is materially narrower than a full ADR-0003 reversal — the console, control queue, kill switch, and `trace.mjs` all stay removed; only a thin, best-effort, Pro/Max-only usage-percentage capture would return to a file ADR-0003 already keeps in a different, stripped form. But it is still a conscious re-opening of a signed architectural decision, not a routine feature build — the ground-gate discipline that blocked #378 in the first place applies here too: this is the engine's information, not the engine's call.

## Recommendation

**Adopt the statusline-refresh-poll approach (finding 4)** as AC.1's mechanism, **contingent on an explicit owner sign-off** to touch `statusline.mjs` this way, given ADR-0003's history with that exact file. If declined, the only remaining option is the wall-clock proxy (ticket's original option b), shipped with its limitation documented, or deferral (option c).

## Sources

- `plugin/scripts/statusline.mjs` (`renderLimits`, stdin payload parsing, `rate_limits` field).
- `docs/guides/troubleshooting.md` §2 (Pro/Max-only, post-first-response condition).
- `docs/decisions/0003-remove-control-console.md` (ADR-0003, #95) — full text reviewed.
- `plugin/scripts/autopilot/ledger.mjs` (`run.json` `startedAt`, the existing wall-clock proxy source).
- External: Claude Code documentation review (statusline hook contract, hook event payload shapes, `/usage` command, OpenTelemetry export) — no on-demand/pull usage-query mechanism found; confirmed as a genuine product gap, not a missed feature.
