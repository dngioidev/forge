---
description: Check the forge status bar wiring and fix it — diagnose settings, paths, script health, and payload fields, then re-wire if broken.
---

Diagnose and repair the status line (it fails silent by design — this command makes the failure visible). Run the checks in order, stop at the first failure, apply its fix, then re-verify.

## 1. Is it wired?

Read `.claude/settings.local.json` and `.claude/settings.json` for a `statusLine` key (local wins). Report which file, and the exact command string.
- **Missing everywhere** → fix: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --project <n> --statusline` (re-init is idempotent; `--statusline` overwrites only the statusLine key in settings.local.json, wiring the **absolute** node binary `process.execPath` — #181).
- **Present in shared settings.json** → warn: machine-specific paths break teammates; move it to settings.local.json (delete there, re-run the fix above).

## 2. Do the paths exist?

From the wired command string, verify the `node` executable and the script path both exist on disk.
- **Either missing** (moved checkout, moved portable node) → same fix as §1: the re-wire writes current correct paths.
- **Wired to a bare `node`** (the command is `node …` with no absolute path) → the node-not-on-PATH → blank-bar cause: Claude Code may spawn the status line without `node` on PATH, so it exits 127 and the bar renders silently blank. Same fix as §1 — since #181 `init --statusline` wires the **absolute** node binary (`process.execPath`), re-init genuinely heals this (before #181 it rewrote the same bare `node`, a no-op for this failure mode).

## 3. Does the script run?

Pipe a minimal payload through the exact wired command:

```
echo {"workspace":{"current_dir":"<repo>"}} | <wired command>
```

- **Non-zero exit or stderr** → report verbatim; the silent-by-design wrapper is hiding this in live use.
- **Empty output** → the directory isn't a git repo, or git isn't on the user PATH for spawned processes.

## 4. Are the rich segments arriving?

Ask the user what their live strip shows. Missing segments map to payload gaps, not bugs (troubleshooting guide §2):
- No context bar → Claude Code build predates `context_window` (~v2.1.13x): update Claude Code.
- No rate limits → Pro/Max only, and only after the first API response.
- No effort/model → older build; harmless.
- Everything missing but the glyph+branch → payload JSON never parsed; check §3 output with the full documented payload shape from code.claude.com/docs/en/statusline.md.

## 5. Verify

Re-run §3 with a full payload (context_window.total_input_tokens + context_window_size, model.display_name, effort.level, rate_limits, cost) and confirm the complete strip renders: `glyph project · #ticket branch · ▓▓░░ % · model · effort:level · 5h n% / 7d n% · $cost`. Report the rendered line to the user.

Never edit settings by hand-crafting JSON in this command — the init script owns the write (no-clobber merge). If all five checks pass but the live bar still misbehaves, capture the real payload (temporarily wire `node -e "process.stdin.pipe(require('fs').createWriteStream('.forge/statusline-payload.json'))"`, wait one refresh, restore wiring) and file a bug ticket with it.
