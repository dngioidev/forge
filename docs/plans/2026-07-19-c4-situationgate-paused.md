# C4 — situationgate reads the machine paused flag

**Ticket:** #68 (board #12) · **Epic:** #56 · **Branch:** `feat/68-situationgate-paused` · **Spec:** forge-control §2/§7.

The C1 kill switch (`~/.forge/control/paused`) only stops the daemon from spawning today. C4 teaches the **situationgate** to read it so **even manual sessions' ship/release hold** while paused, and surfaces a `paused` situation for the statusline/console. The plugin must NOT import the inner control project — it reads the shared paused file directly (file contract only).

## Tasks

- [ ] T1 — `situation.mjs`: add `paused` to `SITUATIONS` (glyph ⏸); add `machinePaused(base = ~/.forge/control)` reading `<base>/paused` directly (no `control/lib` import); `deriveSituation(cwd, board, {paused?})` surfaces `paused` (priority security-response > incident > paused > awaiting-decision > building > idle) and returns a `paused` boolean alongside `key`. **Files:** plugin/scripts/lib/situation.mjs
- [ ] T2 — `situationgate.mjs`: `evaluate(key, action, {branch, skill, paused})` short-circuits — `paused` + (`ship`|`release`) → refused for any key, naming the resume unlock; `backend`/`skill` unaffected. `runGate` passes the real `deriveSituation().paused` through. **Files:** plugin/scripts/gates/situationgate.mjs
- [ ] T3 — tests + dogfood: `machinePaused` present/absent; `deriveSituation` paused key + paused-under-incident boolean; `evaluate` refuses ship/release under paused across keys, allows respond skills; `runGate` end-to-end refuse→clear→proceed. Live dogfood: engage the real kill switch, run the gate, clear it. **Files:** tests/gates/situationgate-paused.test.mjs

## Acceptance criteria

- AC-C4.1 — `machinePaused(base)` true when `<base>/paused` exists, false when absent/unreadable; reads the file directly (no `control/lib` import).
- AC-C4.2 — `deriveSituation` returns `key='paused'` (⏸) when paused and no higher care-situation is active; a higher care-situation still wins `key` but the result still reports `paused:true`.
- AC-C4.3 — `evaluate(..., {paused:true})` refuses `ship` and `release` for any situation key, naming the resume unlock; does NOT refuse `backend`/`skill`; `respond`/`investigate` during security-response still proceed.
- AC-C4.4 — `runGate` wires the real flag: ship/release under a paused machine exits refused (1); clearing the flag lets it proceed.

## Out of scope

End-to-end ticket dogfood (C5), trace/conformance (C6), alerts (C7), quota (C8). Daemon-spawn gating on paused already shipped in C2 (`runOnce` skips when paused); C4 covers the manual ship/release path + display.
