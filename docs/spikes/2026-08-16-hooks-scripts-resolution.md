# Spike — should a forge checkout resolve its own hooks/scripts against the working tree or the cache, and by what mechanism?

**Date:** 2026-08-16 · **Ticket:** #519 (spike, child of #182) · **Feeds:** #484's re-escalation (`esc-484-msrowtoy`) · **Route:** spike (deliverable = this findings doc; **no production-source changes and no live install/hook-wiring changes** — this repo's `.claude/settings.local.json`, the installed plugin cache, and `plugin/hooks/hooks.json` are all untouched by this branch; every experiment below ran in an isolated scratch directory outside the repo and outside the live plugin cache).

## The question and the decision it feeds

`esc-484-msrowtoy` asked whether a forge-repo checkout should resolve its own live `PreToolUse`/`PostToolUse` hooks and `scripts/**` driver invocations against the working tree instead of the installed marketplace plugin cache, and if so, by what mechanism. It offered three options (recommending #1) and noted no ADR/guide states an intended answer. The owner answered "Need more spike" rather than picking one. This spike's job: establish the facts the escalation didn't have, test the named candidate mechanisms against reality, and weigh the real risks — then recommend.

## 1. Facts: what actually governs resolution today

**Both surfaces resolve through the same root mechanism: `${CLAUDE_PLUGIN_ROOT}`, a template Claude Code substitutes against the currently-*installed* plugin location — never the working tree.** This was not just reasoned about; it was verified directly, twice:

- **Hooks** (`plugin/hooks/hooks.json`): `"command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/denylist.mjs\""`. Not a live shell env var — confirmed by checking this session's own Bash subprocess: `echo "CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"` prints empty. Claude Code's own hooks docs confirm it's a path placeholder the harness substitutes and additionally exports as an env var on the *spawned hook process specifically* — not on ordinary Bash tool calls.
- **Scripts** (skill/command markdown, e.g. `plugin/commands/board-status.md`): raw file content reads `node "${CLAUDE_PLUGIN_ROOT}/scripts/board/status.mjs"` — literal, unsubstituted. Invoking that skill via the `Skill` tool live in this session produced instructions containing `node "C:/Users/dngioi/.claude/plugins/cache/forge/forge/1.3.0/scripts/board/status.mjs"` — resolved to the exact user-scope cache version recorded in `installed_plugins.json` (`1.3.0`). So skill-injected script paths are substituted **fresh at skill-load time**, against whatever is currently installed — same target (the cache), different injection point (skill-content templating vs. hook-config templating) than hooks.

This directly confirms what `docs/guides/troubleshooting.md` (§ "Denylist staleness") already stated before this spike: *"The same lag applies to `scripts/**` invoked by the `${CLAUDE_PLUGIN_ROOT}` path."* Root cause: **one mechanism, not two.**

**But the two surfaces genuinely diverge in what can be done about it *without* changing that mechanism**, which is the real substance behind option 3's "narrower" framing:

- **`scripts/**` invocations are literal Bash commands the acting agent/human types.** Nothing stops an agent from ignoring the skill-injected `${CLAUDE_PLUGIN_ROOT}`-resolved path and typing the working-tree-relative path instead — this spike did exactly that (`node plugin/scripts/board/create.mjs ...` from the repo root), and the #484 ticket body describes the autopilot loop doing the same "by hand" after the `ledger.mjs` incident. This is a real, already-in-use, zero-infrastructure workaround — it just isn't documented as a convention or enforced.
- **`hooks.json` invocations are dispatched entirely by Claude Code itself.** The agent has no path-selection lever at the point of use — which command string runs for a given `PreToolUse`/`PostToolUse` event is decided by hook registration, not by anything the agent types. There is no "just use the other path this once" escape hatch for hooks.

So option 3's premise (the two manifestations may warrant different fixes) is coherent — but not for the reason originally guessed. It isn't that resolution differs; it's that the *available levers* differ, and evidence below suggests they warrant genuinely different treatments.

## 2. Empirical test of the candidate mechanisms

All three candidates named or implied by option 1, plus one not named in the original escalation, tested against reality:

### (a) Marketplace `command` source, `mode: "link"` — dead on this platform

Per Claude Code's plugin-marketplace docs (fetched and quoted directly, not from memory): a `command`-sourced plugin entry with `"mode": "link"` is used **in place** rather than copied to cache — the one documented mechanism for true live resolution. It requires Claude Code v2.1.229+; **this environment runs exactly v2.1.229** (`claude --version`). But:

> "Claude Code doesn't support link mode on Windows and refuses to install a link-mode plugin there. Declare `"mode": "copy"` instead."

This environment is win32 (Windows 11). **This candidate is not available here, full stop** — not a tradeoff to weigh, a platform wall.

### (b) Local-path/relative-path marketplace source — real, but doesn't achieve live resolution

`/plugin marketplace add <local-path>` and a marketplace's plugin `source: "./relative-path"` are both real, documented source types (confirmed against the primary docs, not the subagent's paraphrase alone). But the same docs state plugins are copied into the versioned cache **"except for a `command` source in link mode, which is used in place."** A local-path marketplace still copies on install/update; it just removes the GitHub push+pull round-trip, refreshed only by an explicit `/plugin marketplace update`. **This shortens the staleness window, it does not eliminate it** — it's a faster version of the existing reinstall ladder (troubleshooting.md §1), not a different kind of resolution.

### (c) DIY directory junction at the cache-directory location — technically live, but unsupported and carries a real corruption risk

Not named in the escalation, but implied by "something the loader might not actually support" being worth testing. Verified empirically, entirely in isolated scratch directories (never touching the live `~/.claude/plugins/cache/...` or this repo's `settings.local.json`, per this spike's safety constraint):

```
$ cmd /c mklink /J <scratch-cache-dir>\1.3.0 <scratch-worktree-dir>
Junction created ...
$ node <scratch-cache-dir>\1.3.0\scripts\probe.mjs
v1 from working tree
# edited probe.mjs in the "working tree" dir, no re-link step, re-ran the SAME cache-side path:
$ node <scratch-cache-dir>\1.3.0\scripts\probe.mjs
v2 EDITED after junction was created, no reinstall/update step
```

A plain Windows directory junction (`mklink /J`, **no admin/elevation required** — unlike symbolic links) planted at a cache-directory-shaped path gives genuinely live resolution: edits to the target are visible immediately through the junctioned path, with zero reinstall/update/relink step. This works because it operates below Claude Code's plugin-source semantics entirely — it's an OS-level indirection Claude Code doesn't know about and doesn't need to support.

**This was not tested against the real, live cache directory** — doing so is exactly the safety hazard this spike was told to avoid (a live experiment on the resolution machinery this session's own tooling depends on). What follows is a risk *inferred* from the documented update behavior, not itself independently verified: `installed_plugins.json` records a version, hash, and `lastUpdated` per install — a junctioned cache directory would silently diverge from that bookkeeping, which is precisely the kind of drift `forge:doctor`'s `denylist-staleness` check (#447 AC.3) is built to catch, so the check itself would likely need to special-case it. More seriously, given that "copy into the cache location" is the documented default behavior for every source type except link mode: if a future `/plugin update`/marketplace pull **writes into** `~/.claude/plugins/cache/forge/forge/<version>/` while that path is a junction to the developer's working tree, the write would pass through the junction and land on working-tree files instead — either overwriting them in place, or, if the update implementation clears the target directory before writing (a common pattern, and a well-known Windows-junction footgun when paired with a naive recursive delete), deleting them outright. Neither variant was exercised here; both are plausible consequences of the documented copy behavior, not confirmed outcomes, and the more severe (delete-first) variant should not be assumed away just because it wasn't the one tested.

### (d) Project-level hooks composing alongside plugin hooks — not named in the escalation, real, and low-risk for the hooks surface specifically

Claude Code's hooks documentation (fetched and quoted directly) states hook composition explicitly:

> "All matching hooks run in parallel. If you define the same handler in more than one settings file, it runs once. A plugin's or skill's copy of the same handler stays separate."

And separately documents `${CLAUDE_PROJECT_DIR}` (the project root — distinct from `${CLAUDE_PLUGIN_ROOT}`) as a supported placeholder in a **project's own** `.claude/settings.json`, with a worked example of exactly this pattern (`${CLAUDE_PROJECT_DIR}/.claude/hooks/check-style.sh` in `PostToolUse`).

This repo's `.claude/settings.json` (the committed, non-personal settings file — distinct from the gitignored `settings.local.json` this repo already has) does not currently exist (`git ls-files .claude/` shows only `.claude/forge.json` tracked). One could be added, committed, declaring `PreToolUse`/`PostToolUse` hooks pointed at `${CLAUDE_PROJECT_DIR}/plugin/hooks/denylist.mjs` / `capture.mjs` — the **working-tree** copies. Per the composition rule quoted above, this would run **in addition to**, not instead of, the plugin-cache-resolved hook — both fire, and (consistent with how a hook veto works) if either one blocks, the action blocks.

**This was reasoned from the primary docs' explicit composition-semantics statement, not re-verified live in this repo** — deliberately, per the constraint against mutating this repo's live hook wiring as part of the experiment. It is worth being precise about what it would and would not fix if adopted: it closes the more dangerous half of the staleness gap (a **new** rule exists in the working tree but hasn't reached the cache yet — the class of incident that filed #447/#484 in the first place) because the working-tree hook can veto even when the stale cache hook wouldn't. It does **not** close the other half (an **old, buggy** cache rule wrongly blocking something a working-tree fix now permits) — the stale hook still vetoes independently, since parallel hooks don't override each other. It also runs the check twice per Bash call, which is redundant compute but negligible cost for a synchronous denylist scan.

## 3. Risk, with evidence

- **"A broken working tree could break the very hooks you need to fix it"** — real, but the actual failure mode is more precise and less severe than a blanket lockout. `denylist.mjs`'s own hook entrypoint is explicit: `main().then((code) => process.exit(code)).catch(() => process.exit(0)); // fail open` — any runtime exception during rule evaluation degrades to *silently not enforcing the denylist*, not to blocking all Bash calls. **Not established in this time-box:** what happens on a **parse-time** error (a syntax error from a mid-edit, unbalanced brace) — that would throw before Node ever reaches this try/catch, on a different Node exit path, and this spike did not verify how Claude Code's hook runner treats that specific case (block, allow, or something else). This is a genuine open question, not a resolved one.
- **Cache-wins imposes a reinstall/update cycle per hook/script change** — real and already documented in detail (`troubleshooting.md` §1's five-step escalation ladder), and already partially mitigated: the `denylist-staleness` doctor check (#447 AC.3) is shipped today (`plugin/scripts/lib/denylist-checks.mjs`), diagnosing the exact mismatch this spike is about — it just doesn't change which copy executes, by design.
- **Working-tree-wins runs forge against code no consumer runs** — real in principle, but for the hooks surface specifically, option (d) above (additive, not replacing) means the *cache-resolved* behavior a consumer would see keeps running unchanged in parallel — dogfooding gains coverage of new rules without ever losing the consumer-equivalent enforcement floor.

## 4. Recommendation

The evidence does not support picking option 1, 2, or 3 as originally framed, cleanly, for both surfaces at once — and manufacturing a single unified verdict would discard what the evidence actually shows: **the two surfaces share a root cause but not a best fix.**

- **For `hooks/**`:** adopt (d) — an additive, committed `.claude/settings.json` project-level hook pointed at `${CLAUDE_PROJECT_DIR}/plugin/hooks/{denylist,capture}.mjs`, running alongside the existing plugin-cache hook rather than replacing it. This is the best-supported option found: documented Claude Code behavior (not an install-model change), zero dependency on link mode (so it works on Windows, unlike (a)), and it closes the more dangerous half of the staleness gap (new/fixed rules not yet enforced) while leaving the less dangerous half (stale rules over-blocking) as a known, named residual — which is a materially better position than today's status quo. This is closest in spirit to option 3, but the mechanism is different from anything the original escalation named.
- **For `scripts/**`:** no mechanism tested here achieves live resolution without a real cost — (a) is platform-dead, (b) only shortens the window, (c) works but risks silent working-tree corruption on a future auto-update and was correctly left untested against the live cache. The lowest-risk path is a **documented convention**, not a mechanism change: when developing forge-on-forge, invoke driver scripts by their `${CLAUDE_PROJECT_DIR}`-relative (working-tree) path rather than the skill-injected `${CLAUDE_PLUGIN_ROOT}` path. This formalizes what this spike, and the #484 incident narrative before it, both already did ad hoc. It has a real weakness — it depends on the acting agent/human remembering to do it, with no enforcement — which the owner should weigh against the cost of any of the mechanism options above.
- **Option 1's two named mechanisms specifically should be considered closed, not open:** dev-mode local-path marketplace does not achieve live resolution (it only removes a round-trip), and the sibling-working-tree "link" idea maps to Claude Code's real `command`+`link` mode, which is unsupported on Windows — the platform this repo is developed on today.

**What would still need to happen before this is fully settled, if the owner wants more certainty than this time-box could buy:** (1) a real (not scratch-dir) test of (d) — add the project-level `.claude/settings.json` hook block on a disposable branch/session and confirm both hooks actually fire and that a working-tree-only rule is enforced live; (2) resolution of the parse-time-error open question in §3, since it bears on how much of a footgun (d) actually is if a mid-edit `denylist.mjs` briefly has a syntax error; (3) if the team wants (c) seriously considered despite its risk, a scoped, throwaway test against a **disposable second plugin install** (not this session's live one) to see whether an auto-update genuinely writes through a junction or refuses to (untested here, in either direction).
