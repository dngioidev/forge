# Plan: #423 - clarify AGY installation on landing page and install guide

**Ticket:** #423 (board #8) - **Kind:** docs
**Base:** main - **Branch:** docs/423-agy-install

Feedback: installing with Antigravity (`agy`) is not shown on the landing page
(`site/index.html`) and `docs/guides/install.md`'s Step 1 is Claude-Code-only,
so an agy user can't tell how to install forge from either doc. forge's engine
is already host-agnostic (ADR-0007) and the agy adapter is proven end-to-end
(`docs/guides/cross-gai.md`) — the gap is presentation, not capability.

**Owner-approved approach** (decision `esc-423-msnjwjfk`, approved): update both
`site/index.html` and `docs/guides/install.md` to explicitly mention and
separate AGY instructions. Avoid duplicating the `/plugin` slash-command /
terminal-command pair for agy (agy has no slash-command form, so there is
nothing to duplicate against); state AGY as a primary environment with the one
real fallback terminal command it does have, and defer full detail to the
existing Cross-GAI guide rather than re-deriving agy install steps here.

Every agy fact below is grounded in `docs/guides/cross-gai.md` (Steps 1-4,
prerequisites table) — no new AGY installation steps are invented.

## AC map

- **AC-423.1** `site/index.html`'s Install section (`#install`) explicitly
  names Antigravity as an install path alongside Claude Code, with a concrete
  agy command (not just a passing mention), and links to the Cross-GAI guide.
- **AC-423.2** `docs/guides/install.md`'s "Install the plugin" step is split
  into a **Claude Code** subsection (existing content, unchanged) and an
  **Antigravity (agy)** subsection: the grounded emit command
  (`node plugin/scripts/init.mjs --host agy`), the in-place-discovery
  rationale, and a link to `cross-gai.md` for the full walkthrough — without
  duplicating the Claude-Code slash/terminal pair for agy.
- **AC-423.3** the prerequisites table in `docs/guides/install.md` is
  cross-referenced for agy users (same Node/git/gh prerequisites plus the
  `agy` CLI) so the table isn't read as Claude-Code-exclusive.

## Task 1 (docs): surface AGY on the landing page (AC-423.1)

Add a second, labeled install box to the `#install` section's right column
(`site/index.html`) showing the agy emit command
(`node plugin/scripts/init.mjs --host agy`), and extend the prerequisites
paragraph to cross-link `docs/guides/cross-gai.md`. Mirror the existing
`.installbox`/`.top`/`.p` markup idiom exactly — no new CSS.

**Files:** site/index.html

## Task 2 (docs): split Step 1 of the install guide by host (AC-423.2, AC-423.3)

Restructure `docs/guides/install.md` `## 1. Install the plugin` into `### Claude
Code` (existing content) and `### Antigravity (agy)` (new), and add a one-line
cross-reference under the prerequisites table pointing agy users at the new
subsection.

**Files:** docs/guides/install.md

## Task 3 (test): grounding tests for the AGY doc content (AC-423.1, AC-423.2, AC-423.3)

New vitest file that reads both files and asserts the required substrings are
present (mirrors the AC-307.2 doc-content-assertion pattern in
`tests/agy/emit.test.mjs`) — machine evidence for the ac-gate on a docs-only
change.

**Files:** tests/docs/agy-install-docs.test.mjs

## Task 4 (docs): route index (AC-423.2)

Add this plan to the docs route index.

**Files:** docs/README.md
