---
name: ideate
description: Whole feature area → decomposed epic + child tickets with ACs and board placement. Use for feature areas and product ideas; single items go to forge:triage instead.
---

# forge:ideate

Raw idea / feature area → the ticket tree, so work starts ticket-first (spec §4 item 1).

## Steps

1. **Ground in product context**: read `docs/product/` (vision, roadmap, PRDs) when present — proposals must serve the recorded direction, not drift from it. No product docs → say so and proceed from the request alone.
2. **Feature brainstorm**: enumerate what the area could include; mark each item in/out with one line of reasoning. Divergent first, then cut hard — an epic with 12 children is a planning failure, aim for 3–7.
3. **Dedup** (spec §4): search open items and the board before creating anything; overlaps get linked, not duplicated.
4. **Decompose**: each child independently shippable where possible; explicit dependency notes where not (build order = dependency order).
5. **Per child**: title (imperative), 2–5 verifiable ACs, type/size/priority, UI-flag note when it needs the design lane.
6. **Create the tree** via the board scripts — epic first, then children with `--parent`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board/create.mjs" --title "…" --type epic --priority p1 --size l --status backlog
node "${CLAUDE_PLUGIN_ROOT}/scripts/board/create.mjs" --title "…" --type item --parent <epic#> --priority p1 --size m --status backlog [--assignee <per team policy>]
```

7. Refresh the epic digest (`digest.mjs --epic <n>`), trail-comment the epic with the decomposition rationale, and report the tree with links.

Escalate (decision comment) when the area implies a direction change from `docs/product/` — that's the owner's call, not ideation's.
