---
name: design
description: UI ticket → token-grounded mockup variants → human pick → committed visual spec. Use for UI-flagged tickets before forge:plan (NEW-component mode; iterate/system modes arrive with the graph).
---

# forge:design

Ticketed UI feature → approved visual spec in `docs/design/` (spec §4 item 11). **NEW mode only until SP8** — iterating an existing component or changing tokens system-wide needs the graph's `who_uses`; until then those route through a spike + owner decision.

## Steps

1. **Load the real tokens** (the repo's design-token source). Every visual decision references them; a value that isn't a token goes in the token-delta proposal, never inline.
2. **Generate 2–3 genuinely distinct variants** (designer role card): different layout/interaction approaches, each as working HTML/component code, each covering the states matrix, ≥3 widths, all configured themes, with the a11y contract designed in.
3. **Present variants** for the human pick via the decision mechanism (spec §7):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board/escalate.mjs" --issue <n> --reason "design pick: <component>" --options "variant A — <one-liner>|variant B — <one-liner>|variant C — <one-liner>" --context "<where to view them>"
```

4. **On the resolved pick** (`escalate.mjs --check`): move the ticket back to `inProgress`, graduate the chosen variant into `docs/design/<date>-<component>.md` using the template (`plugin/templates/visual-spec.md` — every section filled, including the token delta with any proposed new tokens).
5. **Lint before committing**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/design/speclint.mjs" docs/design/<file>.md` — missing sections or one-off values are not committable.
6. Commit (`docs(design): … (#n)`), route index, trail `--phase spec` with the link. The spec now feeds `forge:plan`; `design-reviewer` validates the implementation against it at execute/ship.

**Token governance:** new tokens enter only through this spec's approval. Mockup code is design-lane output — it reaches production only through plan → execute with tests, never copied straight in.
