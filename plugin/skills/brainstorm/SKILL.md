---
name: brainstorm
description: Ticketed feature → design spec with self-review and the owner approval gate. Use before planning any non-trivial feature; the approved spec feeds forge:plan.
---

# forge:brainstorm

Ticketed feature → approved design spec (spec §4 item 3). The spec is the thinking; the plan is the contract; don't blur them.

## Steps

1. **Decomposition-first** for multi-system asks: if the ticket spans systems, split the spec into sub-designs with explicit seams before designing any one part.
2. **Explore before committing**: consider ≥2 approaches; record the losing one and why in one paragraph (future-you's ADR material). Genuinely open questions → a `forge:spike` first, not guesses.
3. **Write the spec** into `conventions.specsDir` (`<date>-<slug>.md`): problem, constraints, chosen design, alternatives considered, risks, out-of-scope. Terse over thorough-looking.
4. **Self-review pass** before the gate: internal contradictions, unstated assumptions, missing failure modes, "why is this needed at all". Fix what you find; note what you fixed.
5. **Approval gate** — a spec approval is a scheduled decision comment (spec §7), same mechanism as every human decision:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board/escalate.mjs" --issue <n> --reason "spec approval: <spec link>" --options "approve|request changes" --recommend approve --context "<3-line summary>"
```

6. **Wait for the resolved answer** (`escalate.mjs --check --issue <n>`): "approve" → move the ticket back to `inProgress`, commit the spec (`docs(spec): … (#n)`), update the route index, trail `--phase spec`, hand to `forge:plan`. "request changes" → address, update the same decision thread, repeat.

Never start planning from an unapproved spec — the gate is the point.
