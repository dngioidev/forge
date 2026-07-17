# Console UI v2 — answer-flow fixes + owned identity

**Ticket:** #39 · **Branch:** `feat/39-console-ui-v2` · Findings + ACs live in the ticket body (AC-B6.1…6.6).

Two halves, strictly ordered: **A** (behavior defects in the decision flow — plan/execute) and **B** (visual identity — forge:design round, owner picks a variant via decision comment).

## Tasks

- [ ] T1 — Page logic extracted to `console/web/app.js` (served by serve.mjs static route; still zero external assets): poll pauses while any input is focused or dirty (AC-B6.1); two-step arm→confirm on decision buttons with auto-disarm (AC-B6.2); inline per-card error line, no alert() (AC-B6.3); relative timestamps with ISO in title; tab title carries the worst active situation glyph (AC-B6.6). Pure helpers (relativeTime, worstGlyph, confirm state machine) exported for tests.
- [ ] T2 — A11y floor in `console/web/index.html` (AC-B6.4): aria-live=polite status region, :focus-visible styles, ledger text equivalent, dim-text contrast ≥4.5:1.
- [ ] T3 — Three genuinely distinct identity variants as self-contained mockups in `docs/design/variants-console/` (heat / blueprint / print-ledger — each covering all five situations, the decision card, ledger, journal), then **escalate the pick** on #39.
- [ ] T4 — On the resolved pick: apply the chosen token system to index.html, write the visual spec `docs/design/2026-07-17-console.md` from the template (token delta replaces the borrowed GitHub palette), speclint clean (AC-B6.5).
- [ ] T5 — Tests (pure helpers via import; law-level source assertions for the page), gates, live dogfood, PR.

**Files:** console/web/index.html, console/web/app.js, console/serve.mjs, docs/design/variants-console/heat.html, docs/design/variants-console/blueprint.html, docs/design/variants-console/print-ledger.html, docs/design/2026-07-17-console.md, docs/README.md

## Out of scope

New console features (this is UI of what exists); SP9b command verbs; Figma source mode.
