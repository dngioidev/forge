# Spike — cockpit re-architecture: permissive stack + a terminal that actually types

**Date:** 2026-08-02 — **Ticket:** #344 (parent epic #182; the cockpit is epic #262 / ADR-0006) — **Route:** spike (time-boxed research; deliverable = this findings doc + proposed [ADR-0008](../decisions/0008-cockpit-local-web-app.md)). The decision is the owner's; this spike recommends, it does not implement.

## Why we are re-opening a shipped decision

The forge cockpit (`tools/runner-ui/`, ADR-0006) is a native **PySide6 (Qt) desktop app**. It works — fleet control (#265/#266/#267), a Claude usage/cost panel reading `~/.claude/projects/**/*.jsonl` (#273/#274), and an embedded ConPTY terminal (#275) all shipped. Two real problems now make its *foundation* worth re-examining before forge goes open-source:

1. **License.** PySide6 is dual-licensed **LGPLv3 / commercial**. It is declared in `tools/runner-ui/pyproject.toml` as `LGPL-3.0-or-later` and is the **only non-permissive license in an otherwise MIT/permissive project**. forge is about to flip to public MIT (epic #209). A committed `forge-cockpit.spec` bundles Qt into a distributable ~100 MB PyInstaller binary — which is exactly the act that triggers LGPL combined-work obligations. Worth noting: the repo's own enforcing license gate (`plugin/scripts/gates/license.mjs`, #342/#343) inspects only the **JS `package.json` dependency tree** and the plugin's own MIT declaration — it has **no visibility into the Python `pyproject.toml`**, so the one genuine license risk in the repo is invisible to the gate that exists to catch exactly this.
2. **Terminal typing.** The embedded terminal (#275) still has input troubles. Reading `forge_cockpit/terminal.py` shows why this is structural, not a bug to patch: it is **not a terminal emulator**. `render_output()` *strips* all ANSI CSI/OSC sequences and re-flows text into a `QPlainTextEdit`; `key_to_bytes()` hand-maps a fixed dictionary of keys to control bytes. That approach cannot correctly host cursor-addressed / colored / full-screen TUI programs (vim, tmux, `claude` itself), and hand-rolled key mapping is a perennial source of the exact input glitches #275 reports. On Windows, ConPTY additionally garbles input when the console buffer/window size disagrees with what the client negotiated — a class of bug you inherit unless a real emulator owns the VT layer.

Both problems point at the same seam: **the UI shell and its terminal**. The cockpit's *logic* (discovery, control, usage parsing, PAT-safe shell-out) is clean, well-tested Python and is not in question.

## What the cockpit actually is (so we know what a port must preserve)

Read from `tools/runner-ui/forge_cockpit/`:

| Module | Responsibility | UI-coupled? |
| --- | --- | --- |
| `discovery.py` | PAT-free fleet discovery (`sc`/`systemctl`/`docker`/`gh`, `wsl.exe` interop) | No — pure shell-out + data model |
| `control.py` | start/stop/restart, per-action UAC on Windows | No — pure shell-out |
| `shellout.py` | argv-list shell-out, `runner.env` refusal, no `shell=True` | No — the security spine |
| `logs.py` | tail NSSM `*.log` / `journalctl --user` | No |
| `provision.py` | install/uninstall via `setup-runner.ps1` / `install-service.sh` | No |
| `usage.py` | transcript discovery, tolerant JSONL parse, pinned pricing, aggregation | No — pure data layer |
| `terminal.py` | ConPTY pty session + **hand-rolled** VT rendering + key mapping | Partly — pty is reusable, the renderer is the problem |
| `*_view.py`, `app.py` | PySide6/QtCharts widgets + the `QMainWindow` shell | **Yes — this is the LGPL surface** |

**Key insight: the LGPL dependency and the terminal problem both live entirely in the `*_view.py` / `app.py` / `terminal.py` presentation layer.** Every `.py` that does real work is framework-agnostic Python that shells out. A re-architecture is a **presentation-layer swap**, not a rewrite of the cockpit's substance — and the security invariants (PAT-free, `runner.env` never read, usage-metadata-only) live in the reusable core, so they carry over unchanged.

One more piece of history that matters: **ADR-0006's own spike originally recommended a localhost web app, and the owner explicitly overrode it in favor of a native PySide6 window** ("a real Windows application window, not a browser tab"). So Option C below is not a novel idea — it is the spike's original recommendation, now with two concrete reasons (LGPL + terminal) that did not weigh on the table in July.

---

## Option A — keep PySide6, comply with LGPL + fix the terminal

**License — what LGPLv3 actually requires for a PyInstaller-bundled Qt app.** PySide6 links Qt *dynamically* (Python loads the Qt shared libraries at runtime via shiboken), so the strict copyleft of the GPL does not reach your application code. LGPLv3 §4 ("Combined Works") lets you ship a closed-source app **if** you satisfy, in essence:

- **§4d — user replaceability of the Library.** Either (i) use a shared-library mechanism so the user can substitute a modified, interface-compatible Qt at runtime, **or** (ii) ship the "Minimal Corresponding Source" plus your application in object/relinkable form so a user can *recombine/relink* against a modified Qt. For a Python+Qt app, path (i) is the natural one — but a **PyInstaller `--onefile` bundle packs every Qt DLL inside one opaque executable, defeating substitution.** Compliance therefore means moving to **`--onedir`** (Qt DLLs sit beside the exe as replaceable files) or explicitly excluding PySide6/shiboken6 from the archive and copying them as loose `DATA` the user can swap.
- **§4 notices.** Display a prominent copyright notice for Qt/PySide6, include a copy of the **LGPLv3 and GPLv3** license texts, and state that the app uses the library under LGPL.
- **Offer of source for the Library itself.** Provide (or offer) the corresponding source for the *version of Qt/PySide6 you shipped* — not your app, just the library.
- **No anti-relink restrictions** (e.g. code-signing that would block a relinked binary from running).

This is **well-trodden paperwork + a packaging change**, not a blocker. Effort: retire `--onefile` for `--onedir`, add a `licenses/` bundle + NOTICE, add an "offer of source" line, verify no signing lock-in. Perhaps a day of work plus review. **But it does not remove the LGPL dependency** — an all-MIT OSS project still carries one LGPL corner, which is a real perception/friction cost at the public flip and an ongoing compliance obligation on every future release artifact.

**Terminal fix path.** The honest fix is *not* to keep patching `render_output()`/`key_to_bytes()` — it is to stop hand-rolling VT and embed a real emulator. Qt has no first-class terminal widget; the realistic routes are a third-party `QTermWidget`-style component (adds another native, often GPL/LGPL, dependency — worse for the license goal) or a substantial in-house VT100 emulator. Plus the ConPTY buffer/window-size negotiation must be handled to stop the input garbling. This is the **highest-effort terminal path of the three options and the one least likely to fully resolve #275.**

**Verdict:** viable and lowest-disruption if the owner wants to keep the native window, but it fixes the license only by adding compliance overhead (never removing the dependency) and offers the weakest, most expensive terminal fix.

## Option B — port to a permissive desktop toolkit

Realistic MIT/permissive native shells (all **MIT-licensed**, so the license problem disappears):

| Toolkit | License | Backend lang | Bundle | Webview | Terminal |
| --- | --- | --- | --- | --- | --- |
| **Tauri v2** | MIT / Apache-2.0 | Rust | ~3–10 MB (system webview) | OS-native | xterm.js in the webview |
| **Wails** | MIT | Go | ~5–15 MB (system webview) | OS-native | xterm.js in the webview |
| **Electron** | MIT | Node/JS | **150–200 MB (bundles Chromium)** | bundled Chromium | xterm.js (its native home — VS Code) |

All three render a web UI, so the terminal in every case is **xterm.js** — the mature path (see Option C). The license box is ticked. **The cost is the port.** The cockpit's working core is **Python** (`usage.py`, `discovery.py`, `control.py`, `shellout.py`). Tauri/Wails put a **Rust/Go** process in charge — you either rewrite that Python logic in Rust/Go or run Python as a bundled sidecar the native shell shells out to (re-introducing a Python runtime to bundle, partly defeating the small-binary win). Electron keeps you in JS but *also* means rewriting the Python core in Node **and** bundling Chromium (heavy, and philosophically the same "ship a browser" cost as Option C without Option C's zero-bundle upside). No permissive **Python-native** GUI toolkit offers the QtCharts+embedded-terminal combination that motivated PySide6 in the first place — so "stay in Python, just swap the toolkit" is not actually on the menu.

**Verdict:** solves the license and (via xterm.js) the terminal, but at the price of a **language rewrite of the working core or an awkward sidecar**, and — for Electron — the very Chromium bundle Option C avoids. You take Option C's web UI anyway, plus a native-shell tax.

## Option C — local web app (localhost backend + browser UI, xterm.js terminal over a websocket)

A small **localhost server** exposes the cockpit's existing Python core over `127.0.0.1` (HTTP for fleet/usage/control JSON, a **websocket** for the terminal), and the UI is a **browser page**. The terminal is **xterm.js** in the page, wired over the websocket to a backend PTY.

- **License — solved outright.** The whole stack is permissive: the Python backend + a permissive web framework (FastAPI/Starlette/Flask or even stdlib `http.server` — all MIT/BSD; note FastAPI/uvicorn were in ADR-0006's *original* dep list before the desktop pivot dropped them), and **xterm.js is MIT**. **Zero LGPL.** Nothing to bundle, so no PyInstaller, no ~100 MB onefile, and no LGPL combined-work obligation at all — the artifact is source you run, not a distributed binary.
- **Terminal — the mature, well-trodden fix.** xterm.js is *the* in-browser terminal: it powers **VS Code, Hyper, and Theia**, ships a GPU-accelerated renderer, and correctly hosts bash/vim/tmux/curses apps and mouse events. It is a **real VT emulator**, so the entire hand-rolled `render_output()`/`key_to_bytes()` layer — the source of #275 — is *deleted*, not patched. The backend keeps only the PTY (a ConPTY bridge via `pywinpty` on Windows, or `node-pty`), and xterm.js owns all VT rendering and input, which is exactly the part that was fragile.
- **Porting effort — the lowest of the three.** The Python cores port **as-is** behind thin route handlers (`discovery.discover_fleet()` → `GET /fleet`, `usage.collect_usage()` → `GET /usage`, `control.*` → `POST /control`, `logs` → stream). The charts move from QtCharts to any permissive JS chart lib. The PAT-free / `runner.env`-refusal / usage-metadata-only invariants live in the reusable core and carry over untouched. What's thrown away is precisely the LGPL/terminal-problem layer.
- **Distribution & cross-platform — best of the three.** No binary to build, sign, or ship. `forge cockpit` starts the localhost server and opens the default browser. It runs anywhere a browser and Python do — Windows, WSL/Linux, macOS — with **one** codebase and no per-OS packaging.

**Honest downsides:**
- **You lose the native window.** It's a browser tab, not an app window — the *exact* thing the owner rejected in ADR-0006. This is the central trade the owner must weigh. (Mitigation if a "real window" is wanted later: the same web UI drops into Tauri/Wails/Electron with no backend change — Option C is a strict prerequisite for those anyway.)
- **Localhost security must be done deliberately.** Services on `127.0.0.1` are reachable from the browser and are a known target for **DNS-rebinding and CSRF** (an attacker page can hit your loopback API). Because this endpoint can **start/stop services and open a shell**, hardening is mandatory, not optional: bind `127.0.0.1` only (never `0.0.0.0`), **validate the `Host` header** (anti-rebinding), require a **loopback capability token** minted at launch and handed to the opened browser URL, set `SameSite=Strict` cookies, and check `Origin` on the websocket upgrade. All standard, but it is real work and a real new attack surface a desktop app didn't have.
- **PTY doesn't vanish.** A ConPTY bridge is still needed on the backend (`pywinpty` — still Windows-only native, still permissive Apache-2.0 — or `node-pty`). The win is that xterm.js owns emulation; the PTY layer shrinks to "spawn + pipe bytes."

**Verdict:** the strongest all-permissive answer and the only option that *deletes* the terminal problem rather than re-solving it, at the cost of the native-window experience and a deliberate localhost-hardening task.

---

## The matrix

| Criterion | A — PySide6 + comply | B — permissive toolkit (Tauri/Wails/Electron) | C — local web app |
| --- | --- | --- | --- |
| **License** | LGPL **stays**; compliance = onedir + notices + offer-of-source (ongoing per-release duty) | **MIT** — solved | **MIT/BSD end to end** — solved, and *nothing to distribute* |
| **Terminal-input reliability** | Weakest — hand-rolled VT or add a (L)GPL Qt term widget; ConPTY size bugs remain | **Strong — xterm.js** (web UI) | **Strong — xterm.js** (VS Code-grade), hand-rolled layer deleted |
| **Packaging / distribution** | Change onefile→onedir; still a ~100 MB signed binary per OS | Small native binary (Tauri/Wails) or ~150 MB Electron; per-OS build | **No binary** — `forge cockpit` serves localhost + opens browser |
| **Porting effort** | Lowest to license-comply; **highest** to fix terminal | **High** — rewrite Python core in Rust/Go, or Python sidecar; Electron = JS rewrite + Chromium | **Lowest** — Python cores reused behind routes; drop only the view layer |
| **Cross-platform reach** | Windows + WSL/Linux (Qt), per-OS bundles | Depends on webview per OS; per-OS bundles | **Broadest** — any browser + Python, one codebase |
| **New downside introduced** | Compliance overhead forever; weak terminal | Language rewrite / sidecar; Electron bundles Chromium | Loses native window; must harden loopback (rebinding/CSRF) |

## Recommendation — **Option C (local web app), with an explicit owner call on the native-window trade**

Adopt the **localhost backend + browser UI + xterm.js-over-websocket** architecture. Three reasons:

1. **It removes the license problem at the root, not with paperwork.** An all-MIT/BSD stack leaves forge with *zero* non-permissive dependencies right as it flips to public MIT — and there is no distributed binary to carry LGPL obligations at all. Option A only ever *manages* the LGPL dependency; B removes it but taxes you elsewhere.
2. **It is the only option that deletes the terminal problem.** xterm.js is the same battle-tested emulator VS Code ships; moving VT rendering and input off the hand-rolled `terminal.py` layer is the direct, well-trodden fix for #275 — and B gets there *only by also becoming a web app*.
3. **It reuses the most and rewrites the least.** The cockpit's real work is framework-agnostic Python that shells out; C keeps all of it and throws away exactly the LGPL/terminal layer. B demands a Rust/Go/JS rewrite of that same working core.

**Be honest about what it costs:** the owner deliberately chose a native window in ADR-0006, and Option C gives that up for a browser tab. That is the one decision only the owner can make. If a native window is later judged essential, the recommended sequence still starts here — Option C's web UI is the prerequisite that drops unchanged into Tauri/Wails (permissive) if it is ever wrapped. And localhost hardening (bind-loopback, Host-header check, launch token, SameSite, WS Origin check) is a real, mandatory task because this surface can start services and open a shell.

I did **not** rubber-stamp C: if the owner's priority is preserving the exact native cockpit and the terminal can be lived with, **Option A is a legitimate, lower-disruption choice** — LGPL compliance for a dynamically-linked Qt app is genuinely routine. The recommendation for C rests on forge's stated MIT open-source goal plus the standing #275 defect; both push the same direction.

## Follow-up outline (if the owner accepts ADR-0008)

**Do not reopen #262** — its Waves 1–3 shipped and it is done. Open a **new epic under #182: "cockpit v2 — local web app re-architecture,"** which *supersedes ADR-0006 Decision 1 (UI approach)* only. Proposed children:

1. **Localhost backend server** — expose the existing Python core (`discovery`/`control`/`logs`/`provision`/`usage`) over `127.0.0.1` HTTP JSON; preserve every PAT-free / `runner.env`-refusal / usage-metadata-only invariant. (permissive web framework)
2. **Loopback security hardening** — bind 127.0.0.1, `Host`-header validation, launch-minted capability token, `SameSite=Strict`, websocket `Origin` check. (gate: no start/stop/shell endpoint reachable cross-origin)
3. **PTY-over-websocket bridge** — backend spawn (`pywinpty`/`node-pty`) piped to a websocket; no VT logic on the server.
4. **Browser UI** — fleet table (+ mis-target flags), usage/cost charts (permissive JS chart lib), and the **xterm.js** terminal pane; port the three panels from `*_view.py`.
5. **Launch + retire the old shell** — `forge cockpit` serves localhost and opens the browser; delete `forge-cockpit.spec`, the PySide6/pywinpty-view deps, and the LGPL declaration from `pyproject.toml`.
6. **Docs** — update the runner-adoption guide + `tools/runner-ui/README.md`; ADR-0008 moves to **Accepted**.

## Sources

- This repo — `tools/runner-ui/` (`pyproject.toml` LGPL declaration, `forge_cockpit/terminal.py` hand-rolled VT layer, `usage.py`/`discovery.py`/`control.py`/`shellout.py` reusable cores, `forge-cockpit.spec` PyInstaller onefile), `docs/decisions/0006-runner-ui.md` (owner override to native PySide6), `plugin/scripts/gates/license.mjs` (JS-only license gate — no Python visibility).
- [LGPLv3 §4 Combined Works — GNU](https://www.gnu.org/licenses/lgpl-3.0.en.html) and the [LGPL-3.0 plain-English summary](https://www.tldrlegal.com/license/gnu-lesser-general-public-license-v3-lgpl-3) — user-replaceability / relink / notices / offer-of-source obligations.
- [PyInstaller licensing discussion #5499](https://github.com/orgs/pyinstaller/discussions/5499) and [PyQt vs PySide licensing](https://www.pythonguis.com/faq/pyqt-vs-pyside/) — onefile defeats substitution; exclude-and-copy / onedir compliance path; "only changes to the library must be released."
- [xterm.js](https://xtermjs.org/) and [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) — MIT, VS Code/Hyper/Theia, GPU renderer, real VT emulation; [pywinpty](https://github.com/andfoy/pywinpty) and the ConPTY buffer/window-size garbling class.
- [Desktop stack comparison 2026 (Tauri/Wails/Electron)](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) — all MIT; bundle sizes; Electron bundles Chromium.
- Localhost security: [GitHub — CORS and DNS rebinding on localhost](https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/), [Oligo — 0.0.0.0-day localhost APIs](https://www.oligo.security/blog/0-0-0-0-day-exploiting-localhost-apis-from-the-browser) — bind-loopback, Host-header validation, token, SameSite.
</content>
</invoke>
