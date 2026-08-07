# Spike — tighten autopilot's routine-vs-grounded decision boundary (#388)

**Date:** 2026-08-06 · **Ticket:** #388 (parent #183) · **Route:** spike (deliverable = this findings doc + a proposed rule change; no code changed).

## Question

`groundgate.mjs` (`plugin/scripts/gates/groundgate.mjs:24-33`) and spec §3/§7 (`docs/specs/2026-07-21-forge-autopilot-crazy-mode.md`) require a cited, grounded source only for **product-direction claims** — behaviour, acceptance criteria, in/out of scope — made by `forge:shape`. Spec §7 names "which approach" explicitly as **routine**, decided with no citation: *"Everything routine (which approach, which UI variant, how to phrase an AC that the docs already imply) the shaper decides."* Owner report (2026-08-05): autopilot auto-decides too much; things that deserve real comparison get bucketed as routine instead. **Is that true in practice, and if so, which specific categories should move — without turning every routine choice into a pause that defeats unattended delivery?**

## Method

Audited real autopilot/delivery output from this repo's history: `.forge/journal.jsonl` (1 escalation on record — #378), `.forge/autopilot/run.json` (51 recorded outcomes, all pre-dating the tickets closed 2026-08-05/06), and `git log --oneline` on `main` plus `gh pr view` on the PRs behind the tickets closed today and yesterday (#307, #378, #379, #383, #385, #386, plus the cockpit epic #350's children #351/#353 for a second architecture-scale data point). For each, the question was: **did the delivering agent pick between two or more genuinely different technical approaches — not a UI variant, not which test to write, not phrasing — with no citation and no comparison shown?**

## Findings

### 1. The one case in the audit that reads as a real gap: #307 / PR #377 (`670ba62`)

`forge init --host agy` was emitting **absolute** paths into `mcp_config.json`/`hooks.json`; `agy plugin install` copies the package elsewhere, breaking those paths. The fix — emit **plugin-root-relative** paths instead — is a genuine architecture fork (alternatives existed: rewrite paths at install time, resolve via an env var indirection, or keep absolute and document the limitation). The PR body's own grounding section is the tell:

> "**mcp_config.json** — relative is the strictly-better bet (absolute is provably broken for the copy flow), but agy's MCP-server subprocess CWD is **not** independently confirmed in the agy docs, and the #174 spike validated MCP only with absolute paths. So the emitter does not overclaim: when `--out` is used it prints a discovery-primary + `agy plugin validate forge` advisory... Live confirmation lands with the #290 dogfood."

This is a technical decision whose correctness depends on an **unconfirmed fact about an external system** (agy's MCP subprocess working directory) — not a stylistic or UI choice. The delivering agent handled it responsibly (self-disclosed the gap, shipped a documented fallback, flagged residual risk to a named follow-up), but that mitigation was **self-graded** — invented and applied by the same agent that made the call, with no external citation and no pause for even a bounded check. Nothing in the current boundary would have required more than what happened. This is the audit's clearest example of "routine" absorbing something that was not routine.

### 2. A case where the boundary already worked: #378 / PR #382 (`5f47251`), spike PR #381 (`5f621b5`)

Ticket #378 (autopilot self-pause near the session usage window) hit a real fork: wall-clock proxy vs. a new statusline-write-to-file poll mechanism. The poll mechanism touched `statusline.mjs`, a file a **signed ADR** (ADR-0003, #95) had explicitly stripped quota-capture from. This tripped an escalation on its own — `.forge/journal.jsonl`: `esc-378-msfttmev`, *"Need an owner decision: (a) spike... (b) ship... (c) defer"* — which produced a proper spike (`docs/spikes/2026-08-05-session-window-detection.md`), an owner-approved option, and only then a delivery PR that cites the decision and the spike explicitly (`PR #382`: *"Owner-approved statusline-poll mechanism... decision on #378, 2026-08-05, `esc-378-msfttmev` option a"*). **This shows the current boundary correctly catches an architecture fork when it collides with a signed ADR** — but that trigger is specific to "touches a file an ADR already ruled on," not "is this a genuine technical fork" in general. #307's fork touched no ADR and so triggered nothing.

### 3. A case that's already well-grounded, just informally: #379 / PR #380 (`b53e7b2`)

Pinning the delivery subagent spawn to `model: sonnet` (vs. leaving it unpinned, or pinning haiku/opus) is a technical-approach decision. It was made with an explicit citation: *"matching every other forge delivery-tier role agent [from] #101 precedent"* and a reproduced failure case (`a #307 delivery ran entirely at Opus rates... purely because the session was on Opus at spawn time`). This is evidence that **grounding-by-precedent already happens informally** in good deliveries — the current boundary doesn't require it, but a careful delivery does it anyway. This case argues for *formalizing* an existing good habit, not inventing a new one.

### 4. A case that's fine to leave routine: #386 / PR #391 (`19b1018`), plan doc `docs/plans/2026-08-06-386-graph-availability-notice.md`

Deciding how to distinguish "never configured" from "deliberately disabled" for the new `graph-availability` doctor check is a genuine implementation fork (candidate signals: an explicit config flag vs. `.forge/graph.db` presence as a proxy for "built the index once"). The plan doc reasons through it inline — *"'missing vs explicit false' in `forge.json` would NOT actually separate never-configured from deliberately-disabled... the cheap, real signal... is `.forge/graph.db` already existing"* — with no external citation, because there is no external source to cite; this is a self-contained, low-stakes, easily-reversible implementation choice inside an already-scoped, single-file bug fix. Requiring a citation or a formal comparison here would add friction with no decision-quality gain. **This is the current boundary working as intended.**

### 5. A structurally bigger fork correctly elevated to a full spike: ADR-0008 / cockpit re-architecture (#344, spike `docs/spikes/2026-08-02-cockpit-rearchitecture.md`), then delivered piecemeal (#351 → `adc5f5c`, #353 → `9ce5f46`, #352 → `fb4fee1`)

The web-app-vs-native-toolkit-vs-comply-with-LGPL fork (options A/B/C) went through a proper spike, an ADR, and owner sign-off before any code landed — because the *ticket itself* was typed as a spike from the start. Inside the approved architecture, smaller "which library" picks (FastAPI vs. Flask/Starlette/stdlib `http.server`; `pywinpty` vs. `node-pty`) were left deliberately open in the spike (*"all MIT/BSD... FastAPI/uvicorn were in ADR-0006's original dep list"*) and settled during delivery without further comparison — reasonable, because the spike had already established they were roughly interchangeable on the axis that mattered (license). **This shows the mechanism forge already has (a full spike) works when a fork is big enough to be recognized as one up front** — the gap is forks that arise *mid-delivery*, inside a ticket nobody flagged as needing a spike, which is exactly #307's shape.

### Summary of the audit

| Ticket | Fork | Handling today | Verdict |
|---|---|---|---|
| #307 (`670ba62`/#377) | relative-path emission; correctness rests on an unconfirmed external CWD behavior | shipped with a self-authored caveat, no citation, no pause | **gap** |
| #378 (`5f47251`/#382) | wall-clock proxy vs. new poll mechanism touching a signed ADR | escalated → spike → owner decision → cited delivery | boundary worked |
| #379 (`b53e7b2`/#380) | which model to pin | cited #101 precedent, informally | boundary worked (by habit, not by rule) |
| #386 (`19b1018`/#391) | which heuristic distinguishes "never configured" vs. "disabled" | reasoned inline in the plan doc, low-stakes | boundary fine as routine |
| #344/ADR-0008 (`adc5f5c`, `9ce5f46`) | web-app vs. native toolkit; then FastAPI/pywinpty picks inside it | full spike + ADR for the big fork; small picks left routine on the spike's own findings | boundary worked |

Out of five audited real forks, **one** shows a genuine gap. The "routine" bucket is not broadly broken — but it has no answer for a fork that (a) arises mid-delivery inside a ticket nobody pre-flagged as spike-worthy, and (b) has a self-admitted unconfirmed assumption underneath it. The owner's report ("things that deserve real comparison get bucketed as routine") is accurate for that specific shape, not for "routine" generally.

## Recommendation

**Move two narrow categories from "routine, no citation" to "requires a lightweight comparison first," modeled on `forge:spike`'s own shape (`plugin/skills/spike/SKILL.md`) but compressed to an inline step — not a new ticket, branch, or PR:**

1. **A correctness-bearing assumption about an external system's behavior that the delivering agent cannot find documented anywhere in the codebase or the external project's own docs.** Trigger: the agent's own reasoning would otherwise contain hedge language ("not independently confirmed," "the strictly-better bet," "unverified," "best-effort," "residual risk") to justify shipping anyway. Required step before merge: either (a) find and cite a real source (file, doc, or a minimal reproducible check run live), or (b) if no source exists, name the assumption explicitly in the PR body under a **required** "Unverified assumption" heading with the fallback/mitigation and a named follow-up ticket — i.e., promote today's already-good but *optional* honesty convention (visible in #377, #382, #391's "Verification (honest)" sections) to a **mandatory, gate-checkable** field when the change's correctness depends on something unconfirmed. This would have caught #307's case without stopping it — it already did almost all the right things, it just wasn't required to.
2. **Introducing a new runtime/dev dependency to solve a problem more than one existing package could solve** (the ticket's own example: "which library/dependency to introduce"). Not every dependency addition — `depguard.mjs` already exists and runs on every new dep for supply-chain safety (`plugin/scripts/gates/depguard.mjs:1-12`) and is a natural place to also require a one-line "why this package, not \<the 1-2 obvious alternatives\>" note, the same shape ADR-0008's spike used for FastAPI-vs-Flask-vs-stdlib (there the answer was "any of them, pick the one already in ADR-0006's dep list" — a valid, fast comparison, not a blocker). This is intentionally **not** "requires a spike" — it's "requires the two-sentence comparison ADR-0008 already modeled, inline in the PR."

**Explicitly do NOT tighten:**
- Model/agent/tool choices already backed by a named precedent (#379's pattern) — already grounded, just needs the citation habit named as a requirement, not new process.
- Implementation-internal heuristics scoped to a single file/ticket with no external system dependency and easy reversibility (#386's pattern) — comparison already happens inline in the plan doc when it matters; mandating a citation here adds a checkbox with no decision-quality gain.
- UI variant, test-selection, AC-phrasing choices — spec §7's original list stands; the audit found no counter-evidence against these staying routine.
- Forks big enough to be recognized as spike-worthy from the ticket's own framing (ADR-0008's pattern) — already correctly routed to a full spike; this recommendation only targets forks that arise *mid-delivery*, inside tickets nobody flagged upfront.

## The tradeoff, explicit

**Over-tightening:** requiring a citation or comparison note for every "which approach" decision would turn most delivery PRs into a pause-and-compare ritual, which is precisely what unattended `forge:autopilot` exists to avoid — the audit's own #386 and the FastAPI/pywinpty picks inside ADR-0008 show routine, uncompared technical choices working fine most of the time; forcing process onto them buys nothing.

**Under-tightening (today's state):** the audit found exactly one real instance (#307) in five, and even that one was substantially self-mitigated by the delivering agent's own honesty convention — the gap is narrow (correctness-critical + unconfirmed + no existing convention that's *mandatory*), not systemic.

**Where the line should sit:** trigger the lightweight comparison only on the two narrow, mechanically-detectable-or-nameable signals above — a new dependency (already has a gate touchpoint in `depguard.mjs` to extend) and self-admitted unconfirmed correctness assumptions (already has an informal convention in PR bodies to make mandatory). Both are cheap: a 2-3 sentence "options + why" note, not a spike ticket, not an escalation, not a human gate. This keeps forks that are genuinely bigger (ADR-scale, or ADR-adjacent per #378's pattern) on the existing spike/escalation path unchanged, and leaves the large majority of "which approach" decisions — implementation heuristics, precedent-backed tool choices, UI variants — exactly as routine as they are today.

## Open question for the owner

Whether requirement (1) — the "Unverified assumption" heading — should be **gate-enforced** (a new lightweight check, e.g. extending `testintent.mjs`'s or a new gate's PR-body scan for hedge language without a paired citation/follow-up ticket reference) or left as a **role-card instruction** to `forge:reviewer`/`forge:security` to flag as a required finding during their adversarial pass. A mechanical gate is more reliable but risks false positives on legitimately-hedged prose that isn't actually correctness-critical; a role-card instruction is softer but relies on the reviewer subagent catching it, the same way it already catches other honesty-convention gaps today. Not resolved here — flagged for the owner to pick before this becomes a plan.

## Sources

- `plugin/scripts/gates/groundgate.mjs` (`isGroundedSource`, lines 24-33) — the existing grounded-source rule.
- `docs/specs/2026-07-21-forge-autopilot-crazy-mode.md` §3, §7 — the current routine/grounded boundary text, including the "which approach... routine" line (§7).
- `plugin/skills/spike/SKILL.md` — `forge:spike`'s existing shape (question → decision, time-boxed, ADR or findings note), used as the model for the compressed inline comparison proposed here.
- `.forge/journal.jsonl` — `esc-378-msfttmev` (the one recorded escalation).
- `.forge/autopilot/run.json` — 51 recorded outcomes (2026-07-22 through 2026-07-24); none postdate the 2026-08-05/06 tickets audited here, confirming this audit had to go to `git log`/`gh pr view` directly for recent evidence.
- `gh pr view 377` (#307, `670ba62`) — the relative-path fix; the "not independently confirmed" grounding gap.
- `gh pr view 382` (#378, `5f47251`) and `docs/spikes/2026-08-05-session-window-detection.md` (#381, `5f621b5`) — the escalate→spike→cited-delivery path that worked.
- `.forge/journal.jsonl` `esc-378-msfttmev` and `docs/decisions/0003-remove-control-console.md` (ADR-0003, #95) — why #378 tripped an escalation.
- `gh pr view 380` (#379, `b53e7b2`) — the #101-precedent-cited model pin.
- `gh pr view 391` (#386, `19b1018`) and `docs/plans/2026-08-06-386-graph-availability-notice.md` — the inline-reasoned, left-routine heuristic pick.
- `docs/decisions/0008-cockpit-local-web-app.md` (ADR-0008, #344) and `docs/spikes/2026-08-02-cockpit-rearchitecture.md` — the properly-elevated architecture-scale fork, and the smaller library picks left open inside it.
- `gh pr view 362` (#351, `adc5f5c`) and `gh pr view 364` (#353, `9ce5f46`) — the FastAPI and PTY-bridge deliveries inside ADR-0008's approved architecture.
- `plugin/scripts/gates/depguard.mjs` (lines 1-12) — the existing new-dependency gate proposed as the mechanical touchpoint for recommendation 2.
