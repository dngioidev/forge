---
name: shape
description: Autonomously shape a not-ready Backlog ticket into a Ready one — gather the product context, classify why it isn't ready, run the right front-of-pipeline skill (ideate/brainstorm/spike/design), and promote Backlog→Ready — but ONLY from information that already exists. The moment a decision needs the human, it escalates instead of inventing product direction. The engine behind forge:autopilot --shape (crazy mode).
---

# forge:shape

Turn a not-ready Backlog ticket into a Ready one — a spec with acceptance criteria — **without a human**, *when the answer already exists*. `shape` is the front-of-pipeline stage crazy mode (`forge:autopilot --shape`) runs before delivery. It **orchestrates the existing shaping skills**; it invents no new product-reasoning engine and no new product direction.

Spec: `docs/specs/2026-07-21-forge-autopilot-crazy-mode.md`.

## The one hard rule (grounded-only)

**Shape only from information that already exists.** Every product/business decision the shaped spec makes must trace to a real source: `docs/product/**`, a linked spec/ADR, the ticket body, or the code graph. An open question with **no grounding** — a scope fork, an unstated requirement, a priority call, a product interpretation — is **not yours to answer**: escalate it. Never guess to keep the board moving. This is enforced mechanically by the **ground gate** (below), not left to good intentions.

## 1. Gather the context stack

Read, in this order, and reason only from what you find:
- `docs/product/**` (product notes) · the ticket's **linked spec / ADR** · the **ticket body** · the **code graph** (MCP `find_component`/`who_uses`/`code_for_ticket` for how the system already behaves).

If the stack is thin (e.g. `docs/product/` is empty and the ticket is a bare line), expect to escalate more — that is correct, not a failure.

## 2. Classify why it isn't ready → route

Pick the front-of-pipeline skill that fits, and run it **grounded-only**:

- **bare one-liner, no shape** → `forge:ideate` — raw idea → a product note + a shaped ticket.
- **feature-shaped, no spec/AC** → `forge:brainstorm` — explore approaches grounded in the context → a spec + acceptance criteria.
- **needs investigation first** → `forge:spike` — investigate on a spike branch → findings as an **ADR** → file a **ready follow-up** ticket (`board/create.mjs`, linking the ADR). **No code PR.** The original is closed/blocked in favour of the follow-up.
- **UI-flagged** → `forge:design` — token-grounded, a11y-first variants → **auto-pick** against the visual spec + design tokens + a11y contract → a ready UI ticket.

## 3. Emit the sources manifest

As you make each product decision, record it: write `.forge/shape/<issue>.sources.json`:

```json
{ "ticket": 140, "decisions": [
  { "claim": "behaviour X on empty input", "source": "docs/product/rules.md#empty" },
  { "claim": "priority stays p2", "source": "#139" }
] }
```

A `source` is grounded when it points at something real — a repo file that exists (with an optional `#anchor`), a ticket ref (`#123`), a `graph:` ref, or `ticket-body`. Anything uncited or pointing at a non-existent file is **not** grounded.

## 4. Ground gate — promote or escalate

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gates/groundgate.mjs" --manifest .forge/shape/<issue>.sources.json`:

- **clean** → write the acceptance criteria onto the ticket, move **Backlog → Ready** (`board/move.mjs --status ready`), trail `--phase spec` with the shaped summary + the sources. The ticket re-enters the autopilot queue and is delivered.
- **ungrounded** → `escalate.mjs` with the **exact** open question the gate flagged (and the recommended options if you have grounded ones), then **skip** — the loop continues with the next ticket. Do **not** promote.

## Guardrails

- The shaper is **read-mostly** until the final field write; it never writes code (that's delivery) and never merges anything.
- A spike **never** ships code — findings are an ADR + a follow-up ticket (spec §4 item 12).
- One escalation parks **one** ticket; it does not stop the run.
- Everything routine — which approach, which UI variant, how to phrase an AC the docs already imply — the shaper decides. Only genuinely ungrounded product decisions escalate.

## Report contract

End with the terminal JSON the orchestrator consumes: `{"verdict":"pass|fail","outcome":"ready|escalated","issue":<n>,"followUp":<n|null>,"sources":<count>}`. `"Unknown" is a valid answer` — an honest escalation beats an invented spec.
