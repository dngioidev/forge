# forge:autopilot crazy mode — autonomous backlog shaping (Backlog → Ready)

**Status: draft — awaiting owner approval.** Board: project #8. Builds on `docs/specs/2026-07-21-forge-autopilot.md`. Target: a release after v0.10.0.

## 1. What it is

Autopilot today only picks **actionable** tickets — `ready` ones, and `backlog` ones it can *triage* (set fields, confirm the ask is clear). A backlog item that isn't **shaped** — no clear ask, no acceptance criteria — gets escalated-and-skipped, so autopilot stalls on exactly the messy backlog you most want cleared.

**Crazy mode** gives autopilot a more powerful **front-of-pipeline stage**: it runs the shaping skills — `ideate`, `brainstorm`, `spike`, `design` — autonomously to turn not-ready backlog items into **Ready** tickets, then delivers them as usual. The board clears continuously, front to back, from one command.

The power comes with exactly one hard rule (§3): **shape it yourself only from information that already exists; the moment it needs a decision that's the human's, escalate instead of inventing it.**

## 2. Activation — opt-in, safe by default

Crazy mode is a **flag**, not the default: `/forge:autopilot --shape`. Plain `/forge:autopilot` is unchanged (delivers ready/triageable tickets only, escalates the rest). Shaping makes more product judgments than delivering an already-ready ticket, so you opt into it deliberately. `--shape` composes with the existing flags (`--limit`, `--area`, `--dry-run`).

## 3. The grounded-only boundary (the crux)

A ticket may be shaped autonomously **only when every product/business decision the spec must make is already answered** by an available source:

- `docs/product/**` (product notes), a **linked spec / ADR**, the **ticket body** itself, or the **code graph** (how the system already behaves).

The shaper enumerates the **open questions** a Ready ticket must answer (what's the behaviour, what are the acceptance criteria, what's in/out of scope) and, for each, must cite a **grounding source**. An open question with **no grounding** — a scope fork, an unstated requirement, a priority call, a product interpretation — is **not** the engine's to decide: it **escalates** (`escalate.mjs`, decision comment) and moves to the next ticket. The engine never invents product direction to keep moving.

This is enforced mechanically by the **ground gate** (§5.3): the shaper emits a *sources manifest* alongside the shaped spec, and the gate fails if any flagged decision lacks a cited source.

## 4. Orchestration — the loop with the shaping front door

```
select next ticket (autopilot §5)
  ▼
status?
  ├─ ready / triageable ─────────────────▶ deliver (autopilot, unchanged)
  ├─ backlog + NOT shaped + --shape ──────▶ forge:shape ─┐
  │                                                       ├─ shaped (grounded) ─▶ set acceptance + Backlog→Ready ─▶ re-enters queue, delivers
  │                                                       └─ needs a human decision ─▶ ESCALATE + skip, continue
  └─ backlog + NOT shaped + no --shape ───▶ ESCALATE + skip (today's behaviour)
```

Shaping and delivery are the same continuous loop; a shaped ticket becomes `ready` and is picked up by a later iteration and delivered — so one `--shape` run can take a raw backlog item all the way to a merged PR without a human touch, *when the grounding allows*.

## 5. forge:shape — the shaper

A new skill (`plugin/skills/shape/SKILL.md`) invoked per not-ready backlog item. Read-mostly until the final field write; it drives the existing front-of-pipeline skills rather than reinventing them.

### 5.1 Gather the context stack
`docs/product/**` → linked spec/ADR → ticket body → code graph (via the MCP tools). This is the only material the shaper may reason from (§3).

### 5.2 Classify why it isn't ready → route (all grounded-only)
- **bare one-liner, no shape** → `forge:ideate` — raw idea → product note + a shaped ticket.
- **feature-shaped, no spec/AC** → `forge:brainstorm` — approaches → a spec + acceptance criteria.
- **needs investigation first** → `forge:spike` — findings → an ADR → file a **ready** follow-up ticket (no code PR); the original is closed/blocked in favour of the follow-up.
- **UI-flagged** → `forge:design` — token-grounded variants → auto-pick against the visual spec + a11y contract → a ready UI ticket.

### 5.3 Ground gate (the safety spine)
Before promoting to Ready, run `gates/groundgate.mjs`: the shaper's **sources manifest** must cite a source for every product decision in the shaped output. Any ungrounded decision ⇒ **escalate**, do not promote. (Mechanical, fail-closed, testable — a peer of the other gates.)

### 5.4 Promote or escalate
Grounded ⇒ write acceptance criteria onto the ticket, move **Backlog → Ready**, trail `--phase spec`. Ungrounded ⇒ `escalate.mjs` with the specific open question, skip, continue.

## 6. Selection change

`select.mjs` gains a **readiness** notion: a `backlog` ticket with acceptance criteria is `deliver`-able (triage only); one **without** is `shape` (crazy mode) or `escalate` (plain mode). Ready/in-flight selection is unchanged.

## 7. Escalation additions (the new human gate)

On top of autopilot §6: **shaping needs a product decision** — an ungrounded open question the ground gate caught. Escalate with the exact question, park the ticket, continue. Everything else routine (which approach, which UI variant, how to phrase an AC that the docs already imply) the shaper decides.

## 8. Reuse, don't reinvent

Crazy mode is an **orchestrator over the existing shaping skills** — `ideate`, `brainstorm`, `spike`, `design` are unchanged and still usable by a human directly. `forge:shape` only sequences them, adds the grounding discipline, and wires the Backlog→Ready promotion. No new product-reasoning engine.

## 9. Acceptance criteria

- **AC-1 (front door):** `/forge:autopilot --shape` routes a not-ready `backlog` ticket to `forge:shape`; without `--shape` the same ticket is escalated-and-skipped (default unchanged).
- **AC-2 (shape → ready):** a groundable backlog item is shaped (spec + acceptance) and promoted Backlog → Ready, then delivered by the loop.
- **AC-3 (grounded-only):** the ground gate fails when a shaped product decision lacks a cited source; the shaper escalates that ticket instead of promoting it — never invents product direction.
- **AC-4 (routing):** the shaper classifies the not-ready reason and routes to ideate / brainstorm / spike / design; a spike produces an ADR + a ready follow-up, not a code PR.
- **AC-5 (escalate + continue):** an ungrounded ticket parks (one escalation) and the loop continues shaping/delivering others.
- **AC-6 (trail):** shaping is trail-commented (`--phase spec`), and the shaped decisions + their sources are recorded on the ticket.
