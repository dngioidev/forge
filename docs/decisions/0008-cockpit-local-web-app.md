# ADR-0008 — Cockpit re-architecture: a permissive local web app (localhost backend + browser UI + xterm.js terminal)

**Date:** 2026-08-02 — **Status:** **Proposed** (awaiting owner Accept/Reject) — **Ticket:** #344 (spike; parent epic #182) — **Route:** spike (deliverable = [findings doc](../spikes/2026-08-02-cockpit-rearchitecture.md) + this ADR). **Supersedes:** ADR-0006 **Decision 1 (UI approach) only** if accepted — the rest of ADR-0006 (charter, control strategy, security invariants, code home) stands.

## Context

The forge cockpit (`tools/runner-ui/`, ADR-0006) is a native **PySide6 (Qt) desktop app**. Its logic is sound and shipped (fleet control #265–#267, usage/cost from local transcripts #273/#274, embedded terminal #275). Two problems with its *foundation* surface now, as forge prepares to flip to public **MIT** (epic #209):

1. **License.** PySide6 is **LGPLv3** — the only non-permissive license in an otherwise MIT/permissive repo. It is declared in `pyproject.toml` (`LGPL-3.0-or-later`), and the committed `forge-cockpit.spec` bundles Qt into a distributable ~100 MB PyInstaller binary, which is precisely what triggers LGPL combined-work obligations. The repo's own license gate (`license.mjs`) inspects only the JS dependency tree and cannot see this Python dependency.
2. **Terminal typing (#275).** `forge_cockpit/terminal.py` is **not** a VT emulator: it strips ANSI and hand-maps keys into a `QPlainTextEdit`. That is structurally unable to host cursor-addressed/TUI programs and is a standing source of input glitches; ConPTY buffer/window-size mismatch adds more.

Both problems live entirely in the **presentation layer** (`app.py`, `*_view.py`, `terminal.py`). The cockpit's real work — `discovery.py`, `control.py`, `logs.py`, `provision.py`, `usage.py`, `shellout.py` — is framework-agnostic Python that shells out, carrying the PAT-free / `runner.env`-never-read / usage-metadata-only invariants. A re-architecture is a **presentation-layer swap, not a rewrite.** (ADR-0006's own spike originally recommended a localhost web app; the owner overrode it to a native window. This ADR revisits that call with two reasons that did not exist in July.)

## Options considered

- **A — Keep PySide6, comply with LGPL + fix the terminal.** LGPLv3 §4 permits a closed/bundled Qt app if the user can substitute/relink a modified Qt (move PyInstaller `--onefile` → `--onedir` or exclude-and-copy PySide6), plus LGPL/GPL notices and an offer of source for Qt itself. Routine but *ongoing* per-release compliance, and it never removes the LGPL dependency. The terminal fix is the weakest and costliest: hand-roll a VT emulator or add another (often GPL/LGPL) Qt terminal widget.
- **B — Port to a permissive native toolkit (Tauri / Wails / Electron).** All MIT, so the license is solved, and all render a web UI (so the terminal is xterm.js). But the working core is **Python**; Tauri/Wails require rewriting it in Rust/Go or bundling a Python sidecar, and Electron means a JS rewrite plus a ~150 MB Chromium bundle. You adopt Option C's web UI regardless, then pay a native-shell tax.
- **C — Local web app (recommended).** A localhost server exposes the existing Python core over `127.0.0.1` (HTTP for fleet/usage/control; a websocket for the terminal); the UI is a browser page; the terminal is **xterm.js** over the websocket to a backend PTY. All-permissive (Python + MIT/BSD web framework + MIT xterm.js), **nothing to bundle**, and the hand-rolled VT layer is deleted in favor of the emulator that powers VS Code.

See the [findings doc](../spikes/2026-08-02-cockpit-rearchitecture.md) for the full matrix.

## Decision (proposed — the owner decides)

**Adopt Option C.** Re-architect the cockpit as a **permissive local web app**: the existing Python cores served over `127.0.0.1`, a browser UI, and an **xterm.js terminal over a websocket** to a backend ConPTY/PTY bridge. This supersedes only ADR-0006 Decision 1 (UI approach = native PySide6 window). Every other ADR-0006 decision — the cockpit charter, shell-out-only + WSL2 interop control strategy, the PAT-free/`runner.env`/usage-metadata-only security invariants, and the in-repo `tools/runner-ui/` home — is unchanged and inherited by the new UI.

**Rationale (three reasons):**
1. **Removes the license problem at the root** — an all-MIT/BSD stack with *no distributed binary* leaves forge with zero non-permissive dependencies at the public flip. Option A only manages LGPL forever; B removes it but taxes the core.
2. **Deletes, not patches, the terminal defect** — xterm.js is the VS Code-grade emulator; VT rendering/input leaves the fragile `terminal.py` layer entirely (the direct #275 fix). B reaches the same terminal only by *also* becoming a web app.
3. **Maximum reuse, minimum rewrite** — the Python cores port as-is behind route handlers; only the LGPL/terminal presentation layer is discarded.

**The one decision reserved for the owner:** Option C trades away the **native window** the owner deliberately chose in ADR-0006 (browser tab, not an app window). If preserving that native experience outranks the MIT-purity and terminal goals, **Option A is the legitimate fallback** and this ADR should be Rejected in favor of an A-scoped compliance+terminal ticket. If a native window is wanted *later*, Option C is still the prerequisite: its web UI drops unchanged into permissive Tauri/Wails.

## Consequences

**If Accepted:**
- forge reaches **all-permissive**: PySide6 (LGPL) and `forge-cockpit.spec` (PyInstaller onefile) are retired; the LGPL declaration leaves `pyproject.toml`. No binary is distributed, so no LGPL obligation remains.
- #275 is resolved by construction — xterm.js owns emulation; the backend PTY shrinks to spawn-and-pipe (`pywinpty`, still permissive Apache-2.0, or `node-pty`).
- **A new attack surface must be hardened deliberately.** A loopback endpoint that can start/stop services and open a shell is a DNS-rebinding/CSRF target: bind `127.0.0.1` only, validate the `Host` header, require a launch-minted capability token, set `SameSite=Strict`, and check `Origin` on the websocket upgrade. This is mandatory, not optional, and is its own ticket.
- **The native window is given up** for a browser tab — the explicit reversal of ADR-0006 Decision 1.
- Distribution simplifies to `forge cockpit` (serve localhost + open browser); one codebase reaches Windows, WSL/Linux, and macOS with no per-OS packaging.
- **Follow-up:** open a **new epic under #182** ("cockpit v2 — local web app"); **do not reopen #262** (its Waves 1–3 shipped). Children: (1) localhost backend, (2) loopback hardening, (3) PTY-over-websocket bridge, (4) browser UI (fleet/usage/xterm.js), (5) launch command + retire PySide6/PyInstaller, (6) docs. On landing, this ADR moves to **Accepted** and ADR-0006 Decision 1 is marked superseded.

**If Rejected (stay on Option A):** file a ticket to (a) make the PyInstaller build LGPL-compliant (onedir/exclude-and-copy + notices + offer-of-source, no signing lock-in) and (b) replace the hand-rolled terminal with a real emulator; accept the standing LGPL dependency and its per-release compliance duty as the price of the native window.

## Sources

- This repo — `tools/runner-ui/` (`pyproject.toml`, `forge_cockpit/terminal.py`, the reusable `*.py` cores, `forge-cockpit.spec`), `docs/decisions/0006-runner-ui.md`, `plugin/scripts/gates/license.mjs`.
- [LGPLv3 §4 — GNU](https://www.gnu.org/licenses/lgpl-3.0.en.html); [LGPL-3.0 summary — TLDRLegal](https://www.tldrlegal.com/license/gnu-lesser-general-public-license-v3-lgpl-3); [PyInstaller licensing discussion #5499](https://github.com/orgs/pyinstaller/discussions/5499); [PyQt vs PySide licensing](https://www.pythonguis.com/faq/pyqt-vs-pyside/).
- [xterm.js](https://xtermjs.org/); [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js); [pywinpty](https://github.com/andfoy/pywinpty).
- [Desktop stack comparison 2026 — Tauri/Wails/Electron](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026).
- Localhost security — [GitHub: CORS & DNS rebinding on localhost](https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/); [Oligo: 0.0.0.0-day](https://www.oligo.security/blog/0-0-0-0-day-exploiting-localhost-apis-from-the-browser).
</content>
