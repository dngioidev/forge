# Plan: #462 - ADR-0006/0005 and runner-adoption assert self-hosted CI as current state after #426 flipped it off

**Ticket:** #462 (board #8, parent #182) - **Kind:** docs (p2)
**Base:** main - **Branch:** docs/462-runner-current-state

PR #427 (#426) flipped `.claude/forge.json` `runner.enabled` to `false` — this repo
is public now, CI runs on GitHub-hosted runners (`.github/workflows/verify.yml`,
already accurate, lines 1-11). Self-hosted remains a legitimate design for the
private-fork opt-in case. Three docs still read as if the runner fleet is
currently live: `docs/decisions/0006-runner-ui.md` (lines 7/18/21, present-tense
"shipped"/"already runs"/"is the cockpit's config source of truth"),
`docs/decisions/0005-local-self-hosted-runner.md` (Status line, no post-#426
note), and `docs/guides/runner-adoption.md` (silent on hosted-only, not false).
`docs/README.md`'s route-index lines for both ADRs (99-100) are already accurate
— no edit expected, just a regression pin. This is annotation-only: the ADRs'
historical decision content and reasoning are not rewritten, matching how
ADR-0006 already handles Decision-1's real supersession by ADR-0008 as contrast
(that one was a design change; this is not).

## AC map

- **AC-462.1** `0006-runner-ui.md` no longer asserts in present tense that the
  runner block is enabled or this box runs the runner fleet, OR explicitly
  scopes those statements to the private-fork case.
- **AC-462.2** `0005`'s Status line records #426 superseded it in practice for
  this repo while it remains the design for private-fork opt-in. Decision body
  / reasoning NOT rewritten.
- **AC-462.3** `runner-adoption.md` states near the top that this repo is
  hosted-only since #426 and the guide is for private repos/private forks,
  cross-linking `verify.yml`'s header comment.
- **AC-462.4** `docs/README.md` route-index lines for both ADRs do not
  describe superseded state as live (already true — pin it).
- **AC-462.5** A doc-assertion test pins AC.1-AC.4, content-anchored (`indexOf`),
  not line-numbered.

## Task 1 (test): failing doc-assertion tests for AC.1-AC.4 (AC-462.5)

New `tests/docs/runner-current-state.test.mjs`, following the
`tests/docs/permissions-handbook-home.test.mjs` (#461) pattern — content-anchor
via `indexOf`/`slice`, not raw line numbers. Each assertion fails against the
pre-edit files.

**Files:** tests/docs/runner-current-state.test.mjs

## Task 2 (docs): annotate ADR-0006's present-tense assertions (AC-462.1)

`docs/decisions/0006-runner-ui.md`: insert one inline annotation (not a
rewrite) scoping the present-tense claims, near the top of Context, stating
that as of #426 this repo's CI is hosted-only (`.claude/forge.json`
`runner.enabled: false`); the runner fleet/cockpit described in this ADR is
the design for the **private-fork opt-in** case, not this repo's current CI
state. No other content in the file changes.

**Files:** docs/decisions/0006-runner-ui.md

## Task 3 (docs): ADR-0005 Status-line post-#426 note (AC-462.2)

`docs/decisions/0005-local-self-hosted-runner.md`: append one clause to the
Status line (line 3) noting `#426` superseded it in practice for this repo
(hosted-only CI now) while it remains the accepted design for private-fork
opt-in. Decision body/reasoning (Decisions 1-5, Consequences, Sources) NOT
rewritten.

**Files:** docs/decisions/0005-local-self-hosted-runner.md

## Task 4 (docs): runner-adoption guide hosted-only note (AC-462.3)

`docs/guides/runner-adoption.md`: add a short note after the intro (lines
1-3), before "## When to use it", stating this repo is hosted-only since #426
and this guide applies to private repos/private forks that want the $0
self-hosted opt-in, cross-linking `verify.yml`'s header comment (lines 1-11,
already accurate) which explains the swap-back.

**Files:** docs/guides/runner-adoption.md

## Task 5 (test): verify tests pass + route index (AC-462.5)

Confirm Task 1's tests pass against Tasks 2-4's edits. Add this plan to the
docs route index (`docs/README.md` Plans section).

**Files:** tests/docs/runner-current-state.test.mjs, docs/README.md
