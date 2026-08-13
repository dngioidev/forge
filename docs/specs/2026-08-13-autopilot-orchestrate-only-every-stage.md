# autopilot: orchestrate-only for *every* stage — stop `--shape` filling the main window

**Status: draft — awaiting owner approval.** Ticket: #466 (child of #183). Amends `docs/specs/2026-07-21-forge-autopilot.md` §11 and `docs/specs/2026-07-21-forge-autopilot-crazy-mode.md` §4.

## 1. Problem

A long `/forge:autopilot --shape` run drives the **orchestrator's own context to 100%**, every time — burning tokens, forcing a mid-run auto-compaction, and leaving a loop that afterwards misremembers its own run.

This directly contradicts autopilot's stated invariant: *"main context unchanged — ~O(1) per ticket"* (§ The loop) and *"a 5-ticket and a 50-ticket run cost the same orchestration overhead"* (§ Cost & context). Under `--shape` the invariant is false.

## 2. Root cause — four actions, one spawn rule

`plugin/scripts/autopilot/select.mjs` `actionFor()` returns **four** loop actions:

```
resume · deliver · triage · shape
```

The orchestrate-only mandate covers exactly **one** of them. Commit history shows why:

| commit | what landed |
|---|---|
| `b926e27` | crazy mode — the `shape` action (#140–#144) |
| `d71f0f9` | orchestrate-only loop + per-ticket **delivery** subagent (#156) |

`#156` landed **after** crazy mode and fixed inline execution for the `deliver` route only. The two documents then drifted into a direct conflict about where shaping runs:

- `SKILL.md` § Orchestration mandates a spawn for the **`deliver`** action, and mentions shape only *inside that delivery brief* — `"the route (deliver, or shape-first under --shape)"`. By construction that clause applies **only when the selected action is `deliver`**.
- But `select.mjs` returns **`shape` as its own action**, distinct from `deliver`, and `crazy-mode.md` §4 draws `forge:shape` **at loop level** — a sibling branch that does *not* flow into delivery, but promotes Backlog→Ready and lets the ticket re-enter the queue on a later iteration.
- `grep -rn "shape subagent\|triage subagent" plugin/` → **nothing**.

So on the path selection actually hands the orchestrator (`action: 'shape'`), **there is no spawn rule at all** — the only shape-spawn language lives in a brief that this action never reaches. The loop runs `forge:shape` **inline in the main window**, and shape is the heaviest context consumer forge has. Per unshaped backlog ticket it ingests: all of `docs/product/**`, the linked spec/ADR, the ticket body, code-graph MCP payloads (`find_component`/`who_uses`/`code_for_ticket`), then a **nested** `ideate`/`brainstorm`/`spike`/`design` run that reads code and drafts a spec — none of it ever released. A handful of unshaped tickets exhausts the window. That is the leak.

**The corroborating detail:** `forge:shape` already ends with *"the terminal JSON the orchestrator consumes"* — `{verdict,outcome,issue,followUp,sources}`. It was **designed** as a subagent return value. Only the spawn was never written. This spec closes a gap; it invents no mechanism.

### 2.1 Code-level proof — the loop cannot even *record* a shape

The prose conflict above is confirmed mechanically. `ledger.mjs`:

```js
export const OUTCOMES = ['merged', 'escalated', 'skipped', 'awaiting-human'];
// applyOutcome():
if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome '${outcome}' — valid: ...`);
```

`forge:shape`'s specified terminal outcome is **`ready`**. It is not in `OUTCOMES` — so `applyOutcome(run, {issue, outcome:'ready'})` **throws**. And `watchdog.mjs` `resolveReturnedTicket` passes every non-`awaiting-merge` outcome straight through as `action:'continue'` — *"already a resolved state — record it and continue"* — handing `ready` to the ledger that rejects it.

**A successful shape is unrepresentable in `run.json` by construction.** The loop's only options are to drop it silently or mislabel it `skipped`. This is why the current `run.json` shows 18 iterations and **zero** shape entries. The shape stage was never wired into the loop as a first-class action — which is precisely the gap that leaves it running inline.

### 2.2 Secondary — the loop trusts its window

Nothing re-anchors the loop from `run.json` after a **mid-run auto-compaction**. The resume protocol (§ Resume) is written for a *fresh session* only. So compaction — the very thing 100% context triggers — silently degrades the loop into continuing from a lossy summary. That is the "missed knowledge / hallucinate" half of the report.

## 3. Chosen design

### 3.1 One spawn rule, every action

Generalize § Orchestration from *"the main loop never delivers inline"* to:

> **The main loop never runs a skill inline.** Every action `select.mjs` returns is executed in a spawned subagent. The loop's own tools are only: `select.mjs`, the ledger, `watchdog.mjs`, the merge bar, trail/escalation surfacing, and the Task tool.

| action | subagent | brief runs | terminal report |
|---|---|---|---|
| `shape` | shape subagent | `forge:shape` | `{verdict,outcome,issue,followUp,sources}` *(already specified)* |
| `triage` | triage subagent | `forge:triage` | `{issue,verdict,outcome}` |
| `deliver` / `resume` | delivery subagent *(unchanged)* | `forge:deliver` | `{issue,outcome,pr,notes}` |

Each spawn pins its model explicitly (the #379/#101 discipline — an unpinned `general-purpose` inherits the orchestrator's tier). Loop semantics are unchanged: a shape subagent that promotes Backlog→Ready returns `outcome: ready`, the loop records it, and the ticket **re-enters the queue** as `deliver` on a later iteration — exactly what `crazy-mode.md` §4 already describes. Only *where the work runs* changes.

### 3.2 No fused shape-then-deliver route

Delete the `"shape-first under --shape"` clause from the delivery brief. It is the ambiguity that lets an orchestrator treat shaping as a delivery-brief concern, and fusing is worse on its own terms: the shape context (product docs, code graph, a drafted spec) would ride along as dead weight through the entire implementation, producing one very large context instead of two bounded ones.

**One action, one spawn, one discardable context.** Two spawns per shaped ticket is the intended cost.

### 3.3 Re-read, don't remember

Rather than detecting compaction, make it harmless:

- The loop **re-reads `run.json` at the top of every iteration** before selecting. It is a ~5KB file read at zero model cost; the window is never the source of truth for run state.
- **Invariant:** the loop holds no un-checkpointed state. Everything needed to continue lives in `run.json`, the board, and `.forge/decisions`.
- The resume protocol is restated as *"fresh session **or after any compaction**"*.
- **Explicitly documented failure mode:** `mergeMode` in `run.json` is a *record of a past grant, not a recoverable grant*. Re-anchoring must not create the belief that merge authority was restored — the harness classifier re-evaluates per attempt regardless (#397/#398).

### 3.4 Give the ledger a vocabulary for shaping

Per §2.1 this is not cosmetic — today a successful shape either throws or is mislabelled. Two changes to `ledger.mjs`:

- **`ready` joins `OUTCOMES`**, so a promoted ticket is a first-class recorded outcome. `renderReport` maps `OUTCOMES` to lines, so the run report gains a truthful `ready: N` line — a `--shape` run finally reports the shaping it did, not just the merges.
- **Outcome entries carry the producing `stage`** (`shape`/`triage`/`deliver`), so a shape wave and a delegation regression are both visible in `run.json` instead of invisible until a human notices their context bar.

`watchdog.mjs` needs no new branch: `ready` is a genuinely resolved terminal state and its existing pass-through (`action:'continue'`) is already correct — it just needs a ledger that accepts what it passes through.

## 4. Alternatives considered

**Budget the inline shaper** — cap `docs/product/**` reads, forbid code-graph calls in the loop, summarize between tickets. Rejected: it treats a structural leak as a budgeting problem. Grounding *requires* reading sources, so this degrades shape's core quality to protect a window that should never have held those sources; and the leak returns the moment the backlog grows.

**Drive the loop from the Workflow/orchestrate harness** — a deterministic script fanning out over the ticket queue. Closest to the owner's phrasing, and genuinely attractive for shaping, which is embarrassingly parallel. Rejected **as the loop**, for three reasons: (1) the queue is *dynamic* — delivery subagents file new work mid-run and shaped tickets re-enter as `ready`, so there is no fixed work-list to fan out over; (2) a workflow agent cannot hold the **in-session merge authorization** — the harness classifier requires a live user turn (ADR-0007, #397), so a workflow-driven loop could never merge; (3) escalations need a human in the live session. Autopilot's loop must stay a live orchestrator. **Partially adopted:** a parallel *shape wave* over the current unshaped backlog is a legitimate follow-on, and this spec unblocks it — after §3.1, every shape already runs in its own context.

**Split the 49KB `autopilot/SKILL.md`** — at ~12k tokens it is 3× the next-largest skill and a real fixed cost, but ~6% of the window, not the cause of 100%. Deferred to **#467**, which must land *after* this spec (§3.1 adds prose to the same file).

## 5. Risks

- **A shape subagent's reasoning dies with its context.** An escalation must be written in full to the decision comment by the subagent itself (`escalate.mjs`) *before* it returns; the terminal report carries only `outcome: escalated` + the decision ref. Same discipline delivery already has.
- **Return-then-resume stall (#319) on a new axis.** A shape subagent must never return "spec drafted, awaiting approval" expecting re-invocation — nothing re-invokes it. Under autopilot, shape is grounded-only: it promotes, or escalates-and-skips. The brief states this, and shape outcomes route through `watchdog.mjs` like every other report. **Interaction:** #464 is an open live bug that the watchdog misses a stalled return shape — this spec must not silently assume the watchdog is complete; it requires routing, and #464 fixes the routing's coverage.
- **Two spawns per shaped ticket.** Accepted: two bounded contexts beat one unbounded main window.
- **Mostly a prose fix.** Only §3.4 is code; the delegation mandate itself is orchestrator prose, so its enforcement is prose + a conformance test — the repo's existing pattern (#156 was pinned exactly this way). The test *is* the mechanism, and §2.1 is the reminder that a prose rule with no ledger support silently rots.

## 6. Acceptance criteria

- **AC-1 (universal delegation):** `SKILL.md` § Orchestration mandates a spawned subagent for **every** `select.mjs` action — `resume`/`deliver`/`triage`/`shape` — and states the prohibition as *"the main loop never runs a skill inline"*.
- **AC-2 (shape spawn):** the `--shape` route spawns a **shape subagent** with a self-contained brief and consumes only its terminal JSON; `crazy-mode.md` §4's diagram is corrected to show the spawn.
- **AC-3 (no fused route):** the delivery brief no longer carries a `shape-first` route — one action, one spawn.
- **AC-4 (escalate-before-return):** the shape brief mandates writing the escalation via `escalate.mjs` before returning and forbids returning awaiting re-invocation; its outcome passes through `watchdog.mjs`.
- **AC-5 (re-read, don't remember):** the loop re-reads `run.json` at the top of every iteration; the resume protocol covers *"fresh session or after compaction"*; `mergeMode` is documented as a record, not a recoverable grant.
- **AC-6 (the ledger can record a shape):** `ledger.mjs` accepts `ready` as an outcome and outcome entries carry the producing `stage`; `renderReport` emits a `ready:` line. A test asserts `applyOutcome(run, {issue, outcome:'ready', stage:'shape'})` round-trips — it **throws** today (§2.1).
- **AC-7 (mechanical, docs):** `tests/skills/autopilot.test.mjs` extends the #156 orchestrate-only test to `shape`/`triage`; `tests/skills/shape.test.mjs` pins the spawn + escalate-before-return contract. Both fail against today's docs.

## 7. Out of scope

- Parallel shape wave (§4, alternative 2 — follow-up, unblocked by this spec).
- Splitting `autopilot/SKILL.md` (§4, alternative 3 — **#467**, sequenced after this).
- #464's watchdog coverage gap (separate open bug; this spec only requires shape outcomes be *routed* through it).
- Any change to the grounded-only rule or the ground gate.
