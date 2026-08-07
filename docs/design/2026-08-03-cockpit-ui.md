# Visual spec — cockpit browser UI (#354)

<!-- forge visual-spec template (spec §4 item 11). Every section below is
mandatory — speclint.mjs enforces their presence; design-reviewer validates
the implementation against their content. -->

## Summary
The runner-fleet **cockpit browser UI** — the web front-end that renders the
FastAPI cores landed in #351–#353 (fleet discovery/control, usage/cost, logs,
and the PTY-over-websocket terminal). It lives in `tools/runner-ui/`, served by
the `forge-cockpit` launcher over `127.0.0.1` (loopback-only, session-token
gated per #352), and replaces the retired PySide6 desktop app (ADR-0008,
supersedes ADR-0006 Decision 1). Chosen variant: **C — split cockpit** (owner
pick, `docs/design/variants-354/variant-c.html`). Rationale: a persistent,
always-visible fleet sidebar (mini status cards + inline start/stop/restart
controls) sits beside a main pane that toggles between Usage / Terminal / Logs
with **Terminal as the default view**. The "mission control" feel — fleet
health is never out of sight (glance-away, not a navigation away), and the
terminal is one click from anywhere (the mode bar, or a mini-card's own
actions). The tradeoff accepted: the main content column is the narrowest of
the three variants because the fleet sidebar is permanent chrome; at 375px the
sidebar flattens into a horizontal-scroll strip above the main pane so the
terminal and chart reclaim full width. Dark-only, drawing exclusively on the
existing smithy token vocabulary (see Token delta) — zero new tokens.

**#395 extension (2026-08-08) — terminal fix, fleet declutter, live machine
metrics.** Three grounded problems surfaced from live use: the terminal never
actually initialized in the browser (the vendored xterm.js/fit-addon scripts
were never `<script>`-loaded — a gap in the original #354 landing, now fixed
with a regression test locking the load order); offline runners accumulated
indefinitely with no way to declutter (discovery never forgets a registration);
and there were no machine-resource metrics. This extension adds: a **4th mode
tab, Machine**, showing live CPU/mem/disk as heat-bar strips on the *existing*
heat scale (signature element — real hardware load reads as literal heat, cool
iron to alarm-red, the same vocabulary already mapped onto fleet health, not a
new metaphor); a **closed-by-default offline disclosure** in the fleet sidebar
(native `<details>`/`<summary>`, every entry stays reachable, none deleted);
and terminal **reconnect with capped exponential backoff** (a dropped
connection no longer requires a full page reload). Zero new tokens — see Token
delta.

## States matrix
Three representative surfaces: the **fleet mini-card**, a **control button**
(start / stop / restart — every mutating control requires the session token),
and the **usage panel**. #395 adds two more: the **offline disclosure** and the
**machine heat-row**.

| state (#395) | normal content | long content | extreme content |
| --- | --- | --- | --- |
| default | offline disclosure: closed, dashed border, "N offline" summary in `ink.smoke`, ▸ marker; heat-row: label + `N% · <label>` value colored by `heatLevel()`, a filled bar | — | 0 offline: the disclosure element is omitted entirely (not rendered empty) |
| hover | disclosure summary text brightens to `ink.ash`; the ▸ marker itself has no hover state | — | — |
| focus | 2px `heat.ember` outline on the summary (native `<details>` focus target) | — | — |
| active | expanded: ▾ marker (rotated ▸), offline cards render identically to online ones inside | — | — |
| disabled | n/a — the disclosure and heat-rows have no disabled state | — | — |
| loading | machine tab: `aria-busy="true"` + "reading…" placeholder before the first `/api/machine` response | — | — |
| empty | machine tab with the endpoint unreachable: falls to the error row below, never a blank panel | — | — |
| error | machine panel: `role=alert` banner ("machine metrics unreadable — …") in `error`, same pattern as the usage panel | error text wraps inside the banner | repeated poll failures keep the last good render (same fleet/usage precedent) |

| state | normal content | long content | extreme content |
| --- | --- | --- | --- |
| default | mini-card: `iron.bg` plate, `iron.seam` border, `heat.*`-mapped left edge (online→`success`, offline→`heat.cool`, mis-target→`heat.alarm`) + a text status label (never color-only); control button: quiet `ink.ash` on transparent, `iron.seam` border, ≥24px hit height; usage panel: token chart + per-model breakdown with real figures | long repo/platform names truncate with ellipsis; the card grows to fit its status/meta lines; breakdown figures stay `tabular-nums` right-aligned | 12+ runners: the sidebar list scrolls vertically (`overflow-y:auto`), cards keep fixed width; usage breakdown adds rows, panel scrolls |
| hover | control button: border + label shift to `heat.ember`; mode-bar tab: label brightens to `ink.ash` | button label wraps inside its box rather than overflowing | — (non-interactive card body has no hover) |
| focus | 2px `heat.ember` outline, 2px offset (`:focus-visible`) on every control, mode-bar tab, and the terminal surface | same | same |
| active | control button `:active`: faint `heat.ember` wash (rgba); selected mode-bar tab carries a `claude` bottom border + `ink.ash` label | pressed label ellipsizes, `title` carries the full action | rapid toggling never loses the aria-selected single-source-of-truth |
| disabled | control that can't apply is `disabled` + dimmed (start-when-online, stop-when-offline) with a `title` explaining why; not focusable | disabled label truncates, `title` carries full reason | all controls on a card disabled mid-transition until the next fleet poll settles |
| loading | a card mid-restart shows a spinner glyph + "restarting…" on the control in `heat.spark`; its sibling controls disable; the fleet stamp reads "updated HH:MM:SS" via `aria-live=polite` | "re-provisioning…" long label stays on one line, ellipsizes | many concurrent transitions: each card owns its own spinner, no global blocker |
| empty | sidebar with no runners for the repo: a labeled dashed placeholder card "no runners for this repo"; usage panel with no transcripts: "no usage recorded yet" in `ink.smoke` | — | — |
| error | mis-target card: `heat.alarm` left edge + an inline `role=alert` line ("reports as <other-repo>") + a lock-glyph re-provision control; usage panel: `role=alert` banner ("transcripts unreadable — check `~/.claude/projects` permissions") in `error`; control failure: inline errline on the card, actionable, never an `alert()` | error text wraps inside the card/banner | repeated poll/control failures keep the last good render and never steal focus |

## Breakpoints
Rendered at three widths (CSS `@media`, no JS layout switching):
- **375 (mobile):** `body` switches to `flex-direction:column`; the sidebar
  becomes a full-width horizontal-scroll strip above the main pane
  (`fleet-list` → `flex-direction:row`, `overflow-x:auto`), mini-cards get a
  min-width and scroll sideways; the session-token footer pill is hidden to
  save height; mode-bar tab labels shrink, terminal pane caps to ~44vh so both
  fleet and terminal stay usable.
- **768 (tablet):** the split persists — sidebar narrows (~200px) and mode-bar
  tabs drop their long text labels to glyph-only to fit; main pane holds the
  active view full-height.
- **1280 (desktop):** the reference layout — ~270px persistent sidebar, full
  mode bar with text labels, main pane at comfortable width; the usage chart
  and terminal render at the intended (narrower-than-full-page) column the
  split trades for permanent fleet visibility.

## Themes
Dark-only, deliberately — inherited from the console precedent
(`docs/design/2026-07-17-console.md`) and the smithy **heat metaphor**: runner
health glows (edge + wash) read only on a dark ground, and the cockpit is a
glanceable ops surface. A light theme is **out of scope**; if a real need ever
appears it enters as a token-delta finding (a light-mode mapping of the
`iron.*` / `ink.*` / `heat.*` scales), not an ad-hoc restyle. Token-driven
differences only — no theme-specific one-off values.

## A11y contract
- **Focus order:** wordmark/stamp → fleet mini-cards in list order → the
  offline disclosure summary (if present) → within a card its control buttons
  left-to-right (start/stop/restart/re-provision) → main mode bar (Usage /
  Terminal / Logs / Machine tabs) → the active mode view's interactive surface
  (the terminal, or usage/log/machine scroll region) → session pill.
  Reordering the fleet never traps focus. The offline disclosure sits after
  every prominent card, before the mode bar — it never interrupts the online
  card sequence.
- **Roles / accessible names:** sidebar `aria-label="Fleet health"`; fleet list
  `role=list`, each card `role=listitem`; the update stamp
  `role=status aria-live=polite`; mode bar `role=tablist` with `role=tab` +
  `aria-selected` buttons controlling `role=tabpanel` views; the mis-target
  message, usage error banner, and machine error banner `role=alert`; the
  token chart `role=img` with a text `aria-label` summarizing the trend; each
  machine heat-bar `role=img` with a text `aria-label` stating the metric,
  percentage, and heat label (never color-only); the terminal surface labeled
  and keyboard-reachable. The offline disclosure is a native `<details>`/
  `<summary>` — expand/collapse, focus, and Enter/Space activation are the
  browser's built-in semantics, not re-implemented.
- **Contrast pairs (token references):** `ink.ash` on `iron.plate` / `iron.bg`
  (body + terminal text) ≥ 7:1; `ink.smoke` on `iron.plate` (secondary/meta)
  ≥ 4.5:1; `success` / `heat.spark` / `heat.alarm` / `error` status labels on
  `iron.bg` ≥ 4.5:1; `ink.steel` links on `iron.plate` ≥ 4.5:1.
- **Target sizes:** every control (mini-card buttons, mode-bar tabs) ≥ 24px hit
  height (`min-height:24px` + padding); at 375 the strip's controls keep the
  same floor. The offline disclosure summary is a full-width click/tap target
  (`padding:8px 10px`), comfortably above the floor.
- **Non-color-only status:** fleet online / offline / mis-target never rely on
  the edge color alone — each carries a text label ("online" / "offline" /
  "mis-target") and mis-target adds a `role=alert` glyph line; log levels carry
  an uppercase text level beside their color. Machine heat-rows carry the same
  discipline: every bar's value text reads "N% · idle/moderate/busy/high/
  saturated" (`heatLabel()`), never a bare colored bar.
- **Reduced motion behavior:** under `prefers-reduced-motion:reduce` the
  restart spinner and the terminal cursor blink both stop (static glyph /
  steady cursor); the pane-toggle and card-hover transitions are removed; the
  offline-disclosure marker rotation and the heat-bar fill width transition
  are both removed (instant, no animated fill-in).

## Motion
| element | property | duration token | easing token | reduced-motion |
| --- | --- | --- | --- | --- |
| mode view (Usage/Terminal/Logs toggle) | opacity/visibility swap | `motion.calm` (250ms) | default ease | instant swap (transition removed) |
| control button (hover/active) | border-color, color, background | `motion.calm` (250ms) | default ease | none (transition removed) |
| mini-card control spinner (loading) | rotate | 900ms linear loop | linear | animation none — static glyph |
| terminal cursor | blink (opacity) | 1s step | step-start | animation none — steady cursor at reduced opacity |
| offline-disclosure marker (#395) | rotate (▸→▾) | `motion.calm` (250ms) | default ease | none (transition removed) |
| machine heat-bar fill (#395) | width | `motion.calm` (250ms) | default ease | none (transition removed) |

## Token delta
- **Tokens used:** the smithy vocabulary only —
  `iron.bg` · `iron.plate` · `iron.seam` · `iron.pit` (grounds);
  `ink.ash` · `ink.smoke` · `ink.steel` (text/links);
  `heat.cool` · `heat.warm` · `heat.spark` · `heat.ember` · `heat.alarm`
  (the heat scale); the semantic `success` · `error` · `claude` overrides from
  `plugin/themes/forge.json`; `motion.calm` (250ms); and the display
  (Bahnschrift/DIN) + mono (Consolas/Cascadia) type roles. All defined by the
  console spec (`docs/design/2026-07-17-console.md`) and `plugin/themes/forge.json`.
- **New tokens proposed (#368):** one — `iron.pit` (`#0d0b09`), the terminal
  ground: a near-black well deeper than `iron.bg` (`#161310`) so the live-shell
  pane reads as a recessed pit set into the plate. Carried from the variant-c
  mockup as a raw hex, it is now a first-class `iron.*` ground token, defined once
  in the cockpit `:root` (`--iron-pit`) and consumed by `.term-pane` and the
  xterm theme (read from the same custom property, since xterm takes concrete
  colour strings not `var()`). It extends the `iron.*` ground scale rather than
  restyling; no other surface consumes it yet.
- **Documented exception — SVG presentation attributes (#368):** the usage-chart
  gradient stops (`app.mjs`) reference `--claude` via an inline
  `style="stop-color:var(--claude)"` rather than the `stop-color` presentation
  attribute, because SVG presentation attributes cannot consume `var()`. This is
  the sanctioned single-sourcing path for SVG fills, not a one-off value.
- **Reuse decision (recorded as a deliberate precedent, not a one-off):** fleet
  binary health is mapped onto the heat vocabulary — online→`success`,
  offline→`heat.cool` ("cold iron", no fire), mis-target→`heat.alarm` + `error`
  (a real misconfiguration, styled like the console's `lockdown` severity).
  This makes the cockpit a **second consumer** of `heat.cool`/`heat.alarm`
  beyond the console's situation-urgency metaphor — health, not situation. It
  is intentional reuse; if the two surfaces ever need independent scales this
  mapping must be revisited explicitly rather than forked silently.
- **Reuse decision, #395 — the full heat scale for machine load:** `heatLevel()`
  (`format.mjs`) maps a 0-100 load percentage onto all five heat steps —
  `heat.cool` (idle) → `heat.warm` (moderate) → `heat.spark` (busy) →
  `heat.ember` (high) → `heat.alarm` (saturated). This is a **third consumer**
  of the heat vocabulary (after the console's situation-urgency and the
  fleet's binary health), and the first to use the full five-step gradient
  rather than a 2-3-way mapping — deliberate: CPU/mem/disk load is genuinely
  continuous, unlike fleet health's online/offline/mis-target discretes. No
  new tokens; thresholds (30/60/80/92%) are a presentation judgment in
  `heatLevel()`, not a token concern.
- **New tokens proposed:** none. Zero new tokens for the #395 extension —
  the offline disclosure and machine panel are built entirely from
  `iron.*`/`ink.*`/`heat.*`/`motion.calm` already in the vocabulary above.
- **One-off values:** none (by definition — a one-off is a finding). Edge and
  hover washes are rgba() of the `heat.*` tokens at low alpha, not new colors.

## Graph ripple
New component, no consumers yet. (The cockpit UI is the top of its own tree —
it consumes the #351–#353 FastAPI/websocket endpoints but nothing in the repo
consumes the UI; features.graph is off for this non-TS surface.)
