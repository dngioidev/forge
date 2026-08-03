# Variants — cockpit browser UI (#354, epic #350, ADR-0008)

Three self-contained HTML mockups for the FastAPI-backed cockpit web app: fleet
(`/api/fleet`, `/api/control`), usage/cost (`/api/usage`), a terminal
(`/api/terminal` websocket, mocked here as a static styled pane — production
wires it to xterm.js), and logs (`/api/logs`). All dark-only, all on the smithy
token vocabulary from `docs/design/2026-07-17-console.md` +
`plugin/themes/forge.json`. Mock fleet: `dngioidev/forge` (both legs online),
`dngioidev/iomanage` (windows leg offline, wsl2 leg mis-targeted).

## Variant A — single-pane ops dashboard (`variant-a.html`)
Everything on one scroll: fleet cards top, usage/cost band middle, a
terminal+logs dock pinned to the bottom (tab-switched, not page-navigated).
Glanceable — the whole cockpit's state is visible without a click.
**Tradeoff:** the busiest of the three; the terminal dock competes for
vertical space with the chart band on short viewports, so it's capped to a
fixed height rather than filling the screen.

## Variant B — tabbed workspace (`variant-b.html`)
A left icon+label rail (Fleet · Usage · Terminal · Logs, collapsing to a
bottom tab bar at 375px) shows one full-height view at a time. The calmest
variant — no competing panels, most screen real estate per surface (a real
xterm.js pane wants room).
**Tradeoff:** the terminal is a full navigation away from the fleet sidebar,
so glancing at fleet health while typing in the terminal needs a tab switch.

## Variant C — split cockpit (`variant-c.html`)
A persistent, always-visible fleet sidebar (mini status cards + inline
controls) plus a main pane that toggles between Usage / Terminal / Logs,
terminal set as the default main view. The "mission control" feel: fleet
health is never out of sight, and the terminal is one click from anywhere.
**Tradeoff:** narrowest main content column of the three (fleet sidebar is
permanent chrome), so the usage chart and terminal both render in a
comparatively tighter width — mitigated at 375px by flattening the sidebar to
a horizontal scroll strip above the main pane.

## Token deltas
None. All three variants draw exclusively from the existing smithy
vocabulary (`iron.*`, `ink.*`, `heat.*`, `motion.calm`, Bahnschrift/Consolas)
plus the semantic `success`/`error`/`claude` tokens already declared in
`plugin/themes/forge.json`. One reuse decision worth flagging as a
precedent, not a delta: fleet online/offline/mis-target status is mapped onto
`success` (online), `heat.cool` (offline — "cold iron", no fire) and
`heat.alarm`/`error` (mis-target — a real misconfiguration, styled like the
console's `lockdown` severity) rather than inventing a new status scale —
this is a second consumer of `heat.cool`/`heat.alarm` beyond the console's
situation metaphor, so if the two surfaces ever want independent scales this
mapping should be revisited explicitly.

## States matrix coverage (all three)
- **Fleet card:** default (online/offline), hover/focus (real CSS on control
  buttons), active (`:active` press), disabled (start-when-running,
  stop-when-stopped), loading (a card mid-restart, spinner), error
  (mis-target card with an inline `role="alert"` banner), empty (a labeled
  reference card/strip).
- **Control button:** default/hover/focus/active are live CSS — try tabbing
  and clicking; disabled and loading are rendered in place; every mutating
  button carries a lock glyph + title noting it needs the session token.
- **Usage panel:** default (chart + breakdown with real numbers), loading/
  empty/error documented inline (a labeled banner in A/B/C rather than
  faked skeleton states, since a static mock can't show a real transient).

## Responsive + a11y notes (all three)
Rendered via CSS at 375 / 768 / 1280 (see each file's `@media` blocks — no
JS-based layout switching). Focus rings are 2px `heat.ember`, 2px offset, on
every interactive element (`:focus-visible`). Figures use
`font-variant-numeric: tabular-nums`. The terminal cursor blink and the
restart spinner both collapse under `prefers-reduced-motion: reduce`. Status
is never color-only — every pill/card carries a text label alongside its
color.
