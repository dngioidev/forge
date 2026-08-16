# Plan: #519 - spike: forge checkout — working tree vs cache resolution for hooks/scripts

**Ticket:** #519 (board #8, parent #182, spike for #484) - **Kind:** spike - **Base:** main - **Exploration:** no throwaway repo branch — every empirical probe ran in an isolated scratch directory outside this repo (`C:/Users/dngioi/AppData/Local/Temp/claude/.../scratchpad/symlink-test/`), never committed, per the spike's explicit safety constraint against mutating this repo's live hook/plugin resolution - **Delivery branch (this doc's own PR):** docs/519-hooks-scripts-resolution-findings

`esc-484-msrowtoy` asked whether a forge-repo checkout should resolve its own live hooks and `scripts/**` driver invocations against the working tree instead of the installed marketplace plugin cache, offering three options (recommending #1). The owner answered "Need more spike" rather than picking one directly. This spike establishes the resolution facts, tests every named/implied candidate mechanism against reality, and recommends — it does not implement an install-model change; no plugin, hook, or install-config source is touched by this branch.

## AC map

- **AC-519.1** the doc establishes, with direct evidence (not inference), whether `hooks.json`/`CLAUDE_PLUGIN_ROOT` and `scripts/**` driver invocation share one resolution mechanism or two, and whether the two surfaces genuinely warrant different treatment.
- **AC-519.2** each candidate mechanism implied by `esc-484-msrowtoy`'s option 1 (dev-mode local-path marketplace; a working-tree-preferring override) is tested against this harness, with a verdict grounded in the actual Claude Code plugin-marketplace/hooks documentation and, where safe, a live empirical probe.
- **AC-519.3** the real risk of working-tree-wins vs. cache-wins is stated with evidence (not assumed), including what the denylist hook's own fail-open behavior does and does not protect against.
- **AC-519.4** a recommendation is given, honestly stating what the evidence settles and what it leaves for the owner.

**Post-merge step (not test-mapped — sequenced after this PR, tracked on the board/issue, not a claim this doc's content can assert about itself):** #484 is re-escalated citing the merged findings doc.

## Task 1 (docs): establish resolution facts + test candidate mechanisms + write the findings doc (AC-519.1, AC-519.2, AC-519.3, AC-519.4)

Read `plugin/hooks/hooks.json`, skill/command markdown (`plugin/commands/board-status.md` et al.), this repo's own `.claude/settings.local.json`, and `~/.claude/plugins/{installed_plugins.json,known_marketplaces.json}` to establish today's actual resolution mechanism for both surfaces; confirm empirically via a live `Skill` tool invocation and this session's own (empty) `CLAUDE_PLUGIN_ROOT` shell env var. Fetch and quote Claude Code's primary plugin-marketplace and hooks documentation directly (not from memory) for source types, `command`+`link` mode, and hook composition semantics. Run an isolated, non-live empirical test of a DIY cache-directory junction in a scratch directory outside the repo. Write up the findings and a weighed recommendation.

**Files:** docs/spikes/2026-08-16-hooks-scripts-resolution.md

## Task 2 (test): grounding tests for the spike doc content (AC-519.1 through AC-519.4)

New vitest file that reads the spike doc and the route index and asserts the required content is present — machine evidence for the ac-gate on a docs-only change (mirrors the #515/#451 doc-content-assertion pattern, `tests/docs/brace-guard-direction.test.mjs`). Also pins that no plugin/hook/install-config source under `plugin/` was touched by this branch, so a future branch cannot quietly slip an install-model change into this spike's scope.

**Files:** tests/docs/hooks-scripts-resolution.test.mjs

## Task 3 (docs): route index

Add the spike doc and this plan to the docs route index.

**Files:** docs/README.md
