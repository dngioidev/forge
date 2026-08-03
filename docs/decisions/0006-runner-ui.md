# ADR-0006 - Runner fleet management UI: UI approach, Python stack, cross-platform control, code home

**Date:** 2026-07-24 - **Status:** **Accepted** (owner-signed 2026-07-24) - **Ticket:** #263 (AC1 of epic #262) - **Route:** spike (deliverable = this decision record + a throwaway cross-platform proof; the spike branch `spike/263-runner-ui-adr` never merges, and its throwaway `tools/runner-ui/spike/` code is not carried onto main)

## Context

Epic #262 proposes a **Python** UI to manage the local self-hosted runner **fleet** that ADR-0005 (#180) shipped. AC1 is the gate: a spike must resolve four questions with a concrete recommendation grounded in the real scaffold, and the owner must approve before AC2+ (build). This ADR is that spike's deliverable, now with the owner's sign-off recorded.

The four questions: (1) UI approach - desktop GUI vs local web app vs terminal UI; (2) Python stack + deps and how they are pinned/run cross-platform; (3) control strategy - how the tool discovers and controls services without reimplementing them; (4) home for the code - in-repo `tools/runner-ui/` vs a sibling repo.

The owner's decision on Q1 **overrides the spike's original recommendation** (a localhost web app): the charter is expanded from a narrow runner UI into a native Python **desktop "cockpit"** built on PySide6/Qt. The grounded facts and the cross-platform proof below are unchanged and still bind every decision.

### Grounded facts from the existing runner scaffold (ADR-0005 + code)

These are the REAL constraints every decision below is anchored to:

- **Two service managers, two OS contexts, one physical box.** Windows legs run as an **NSSM** service `forge-runner-<owner>-<repo>` (LocalSystem, `SERVICE_AUTO_START`, restart-on-exit) registered by `runner/windows/setup-runner.ps1`. Linux legs run as a **systemd `--user`** unit `forge-runner-<owner>-<repo>.service` installed by `runner/linux/install-service.sh`, which drives **`docker compose run --rm`** ephemeral job containers via `runner/linux/supervisor.mjs`. The owner's box is Windows 11 hosting a native Windows runner PLUS a WSL2 Ubuntu Linux runner (confirmed live below).
- **Repo-scoped, multi-repo names.** The service/unit name is repo-derived (`forge-runner-<owner>-<repo>`), so ONE host durably serves several private repos at once. This box already runs `forge-runner-dngioidev-forge` and `forge-runner-dngioidev-iomanage` - the UI is genuinely a *fleet* view, not a single-service toggle.
- **The one secret is off-limits to this UI.** The Administration-only PAT lives ONLY in the gitignored, chmod-600 `~/.forge/runner.env` (Linux) or the service environment / NSSM `AppEnvironmentExtra` (Windows). ADR-0005 forbids it on argv, in `forge.json`, in logs, or in any committed file. **The cockpit must never read `runner.env` or surface the PAT** - it reads service *state* only.
- **Managers are already the API.** The scaffold itself only ever shells out - `gh api`, `sc`/NSSM, `systemctl --user`, `docker compose`. It reimplements nothing. `gh` is already a hard dependency. The runner is **private-repo-only** (fork-PR RCE guard).
- **`.claude/forge.json` `runner` block is committed** and machine-readable: `{ enabled, labels:[self-hosted,linux,forge-local], sharing:"repo", windows:"native" }`. That is the cockpit's config source of truth for what to expect.
- **Read-only status needs no privilege.** `Get-Service`/`sc query`, `systemctl --user status`, and `docker ps` all return state unprivileged. Only *mutating* a Windows NSSM service (start/stop/reinstall) needs Windows admin; systemd `--user` needs no root at all.
- **Claude usage data is a real local file source.** Claude Code writes per-session JSONL transcripts under `~/.claude/projects/**/*.jsonl`, and each assistant turn records its `usage` (input / output / cache-read / cache-creation tokens). Cost is therefore computable **entirely from local files** as tokens x published per-model rates - no external API call, no invented data. This is the same local basis `/cost` and ccusage-style tools read, and it is the grounded source for the cockpit's usage/pricing/token panels.

## Decisions (owner-signed 2026-07-24)

### Decision 1 - UI approach -> **a native Python DESKTOP app using PySide6 (Qt).**

> **Superseded by [ADR-0008](0008-cockpit-local-web-app.md) (owner-signed 2026-08-02):** the cockpit is being re-architected as a permissive local web app (localhost backend + browser UI + xterm.js terminal) to remove the PySide6 **LGPL** dependency before the MIT public flip and to replace the hand-rolled terminal (#275) with xterm.js. Only this UI-approach decision changes; every other ADR-0006 decision below still stands.
>
> **Removed ahead of parity ([#355](https://github.com/dngioidev/forge/issues/355), owner-signed 2026-08-03):** per the owner's decision, the PySide6 (LGPLv3) desktop UI and its PyInstaller packaging were deleted **now**, ahead of web-app parity, so the license check is clean with **zero exceptions** before the OSS flip. `PySide6`/`pywinpty`/`pytest-qt`/`PyInstaller` are gone from `tools/runner-ui/pyproject.toml` and `uv.lock` (`pywinpty` later returned via #353 as the MIT ConPTY backend for the new terminal, no longer PyInstaller-bundled). The stack (Decision 3), embedded-terminal (Decision 2/phasing Wave 3), and QtCharts references below therefore describe the retired PySide6 design, not the current tree.
>
> **Web-app backend delivered (2026-08-03, epic #350):** the FastAPI web app now rebuilds the presentation layer on the retained, framework-agnostic cores (`control`, `discovery`, `logs`, `provision`, `shellout`, `usage`). Landed: the localhost backend ([#351](https://github.com/dngioidev/forge/issues/351) — cores over `127.0.0.1`), loopback hardening ([#352](https://github.com/dngioidev/forge/issues/352) — Host/Origin DNS-rebinding guard + per-session capability token), the PTY-over-websocket terminal ([#353](https://github.com/dngioidev/forge/issues/353) — xterm.js owns emulation, retiring the #275 typing bug), and the restored `forge-cockpit` launch command (serves uvicorn on loopback). **Remaining:** the browser UI ([#354](https://github.com/dngioidev/forge/issues/354)) — the interim `forge-cockpit` exposes the HTTP/ws API, not a finished visual cockpit. See [ADR-0008](0008-cockpit-local-web-app.md) and `tools/runner-ui/README.md`.

The web-app recommendation from the spike is **REJECTED**. The owner wants a real Windows application window (a "cockpit"), not a browser tab.

- **Why PySide6/Qt:** it is the only option that cleanly delivers, in ONE native window, both rich **native charts** (QtCharts) for the usage/cost panels AND an **embedded real terminal** (ConPTY via `pywinpty`). Neither the localhost web app nor a Textual TUI gives a native windowed cockpit with those two capabilities together.
- **Accepted trade-offs (eyes open):** heavier install (a PyInstaller onefile bundle on the order of ~100MB); more code than the web/TUI options; and PySide6 is **LGPL** (fine to use). These costs are accepted in exchange for the native cockpit experience.
- **Cross-OS reach is preserved.** A Windows-native app still reaches the WSL2 Linux runner via `wsl.exe -- systemctl --user ...` interop (the proof below demonstrated exactly this boundary crossing, in reverse - a WSL process reading Windows services). So choosing a Windows-native shell does not cost the two-OS fleet view.

### Decision 2 - Charter -> **EXPANDED to a Claude Code "cockpit," not just a runner UI.**

The app is no longer scoped to runner fleet control alone. In addition to **runner fleet control**, the cockpit monitors:

- an **embedded terminal** (a real ConPTY session hosted inside the Qt window via `pywinpty`);
- live **monitoring** of the fleet (service/container state, refreshing);
- **Claude usage / pricing / tokens-consumed** panels.

The usage feature is grounded, not invented: it reads the per-session JSONL transcripts under `~/.claude/projects/**/*.jsonl`, sums each assistant turn's recorded `usage` token counts, and multiplies by published per-model rates to compute cost - all from local files, with **no external API calls and no fabricated data** (see the grounded fact above). The security invariant is unchanged: usage data comes from transcripts, never from any secret store.

### Decision 3 - Python stack + deps, pinned and run cross-platform -> **CPython >= 3.12, dependencies pinned with `uv` (committed `uv.lock`); deps = PySide6, pywinpty, psutil (+ stdlib `subprocess`).**

- **`uv`** gives a committed, hash-pinned `uv.lock` that resolves the same way each build, is fast, and can even bootstrap the interpreter. This matters directly because **Python is not installed on the Windows host** (only the Windows Store alias stub is present; see Evidence). Provisioning Python on Windows is therefore a documented **build prerequisite**: `winget install Python.Python.3.12`.
- **Dep list** (updated from the spike): **`PySide6`** (the Qt GUI + QtCharts), **`pywinpty`** (the embedded ConPTY terminal), **`psutil`** (process/resource monitoring). **Dropped:** `fastapi` / `uvicorn` - those existed only for the now-rejected web app. **Kept:** stdlib **`subprocess`** for all service control (no service-manager libraries; `sc`/`systemctl`/`docker` are already the API).
- **Run** via `uv run` against a CPython >= 3.12 interpreter (the spike's cross-platform proof ran under Python 3.14.4 in WSL, so >= 3.12 is safely available on the Linux side; the Windows interpreter is provisioned per the prerequisite above).

### Decision 4 - Control strategy -> **shell-out only + WSL2 two-way interop + PAT-free read-only default (UNCHANGED - proven below); per-action UAC elevation for Windows mutations.**

This is the load-bearing decision and it is fully proven below; it is accepted as recommended.

- **Discover + control by shelling out**, exactly as the scaffold does: Windows via `sc query` / `Get-Service` (and `nssm start|stop` / `setup-runner.ps1` for lifecycle), Linux via `systemctl --user`, containers via `docker ps` / `docker compose`. The default cockpit stays **PAT-free** by reading local service state only and never touching `runner.env`.
- **One process reaches both OSes** on a single box via WSL2 two-way interop: from Windows, Linux services are reachable through `wsl.exe -- systemctl --user ...` and `wsl.exe -- docker ...`; from WSL, Windows services are reachable through `sc.exe` / `powershell.exe` on PATH. No SSH agent or per-OS daemon is needed in the solo/single-box topology. (A future multi-host fleet would add a thin per-host agent - out of scope for #262.)
- **Mutation privilege UX (accepted default):** read-only status stays **unprivileged** on both OSes (proven below). Mutating a Windows NSSM service (start/stop/reinstall) triggers an **explicit per-action UAC elevation** via a `ShellExecute` "runas" helper - the user sees a clear elevation prompt for that action, and read-only status never elevates. systemd `--user` mutations need no root. The owner may refine the exact elevation UX during the Wave-1 build.
- **Security invariant (non-negotiable):** never pass the PAT on argv, never read `~/.forge/runner.env`, never log service env that could contain it. The cockpit reads service state only; usage data comes from transcripts, not from any secret store.

### Decision 5 - Home for the code -> **in-repo `tools/runner-ui/` (accepted as recommended).**

A first-class tools directory, sibling to `runner/`, depending on the scaffold by *convention* (reads the `.claude/forge.json` runner block + the `forge-runner-<owner>-<repo>` naming), not by importing runner code.

- **In-repo:** versions in lockstep with the scaffold it drives, shares the committed `forge.json` runner block and the documented PAT/private-only rules, one CI, immediately discoverable. It reads config + service names rather than importing `supervisor.mjs`, so it stays loosely coupled. Placed at `tools/runner-ui/` (not under `runner/`, which is the runtime asset) to keep "the thing that runs jobs" separate from "the thing that watches the fleet".
- A **sibling repo** was considered and rejected for now: it would duplicate forge's conventions, add a second repo to maintain (which would itself want a runner), and complicate the private-only story. Revisit only if the cockpit graduates to managing runners for repos that do not vendor forge.

### Accepted build phasing (owner-approved)

The cockpit ships in three waves so epic #262's children map cleanly onto it:

- **Wave 1** - app shell + runner fleet control (the PySide6 window, service discovery/status, start/stop with per-action elevation).
- **Wave 2** - Claude usage / cost / token monitor (the transcript-reader + QtCharts panels).
- **Wave 3** - embedded terminal (the ConPTY session via `pywinpty`, hosted in the window).

## Evidence - AC2 throwaway proof (real service state, cross-platform, no PAT)

A disposable `probe.py` (Python, shell-out only, marked throwaway; it lived under `tools/runner-ui/spike/` on the spike branch and is not carried onto main) was run to prove the chosen stack lists at least one REAL service's state cross-platform. **Note:** Python is not installed on the Windows host (only the Store alias stub), so the proof was run under **Python 3.14.4 inside WSL2** - which, via interop, listed BOTH the Linux services (native) and the Windows services (`sc.exe`), from ONE process. This both proves AC2 and validates the Decision-4 single-process cross-boundary control model (and, in reverse, that a Windows-native cockpit can drive the WSL Linux runner).

Verbatim output (2026-07-24):

```
forge runner-ui spike probe (#263 AC2) -- read-only service state, no PAT
host: Linux 6.18.33.2-microsoft-standard-WSL2  python 3.14.4

== Windows services (forge-runner*) via sc.exe ==
  forge-runner                           1  STOPPED
  forge-runner-dngioidev-forge           4  RUNNING
  forge-runner-dngioidev-iomanage        4  RUNNING

== Linux systemd --user units (forge-runner*) ==
  forge-runner-dngioidev-iomanage.service    active/running
  forge-runner.service                       active/running

== Docker ephemeral job containers (*runner-run*) ==
  linux-runner-run-cfde4124dcd6	Up 31 seconds
  linux-runner-run-9f262b1230f1	Up 4 hours

(done -- throwaway proof; never reads runner.env, never prints the PAT)
```

The Windows side was also confirmed standalone from PowerShell (`Get-Service forge-runner*` -> `forge-runner-dngioidev-forge` Running), so the tool works whether launched from Windows or from WSL once Python is provisioned on the Windows side. The probe shells out with argv lists (never `shell=True`), reads only service state, and never opens `runner.env`.

## Owner sign-off (received 2026-07-24)

Per AC1, build (epic #262 AC2+) was blocked until the owner approved. The owner has now signed off; the six decisions below are **Accepted** (final, not recommendations):

1. **UI approach** - APPROVED: native Python **desktop app on PySide6 (Qt)**. The localhost web-app recommendation is rejected in favor of a real native cockpit window (QtCharts + embedded terminal in one window).
2. **Charter** - APPROVED expanded: a Claude Code **cockpit** - runner fleet control PLUS embedded terminal, live monitoring, and Claude usage/pricing/tokens (from local `~/.claude/projects/**/*.jsonl` transcripts).
3. **Python stack + deps** - APPROVED: **CPython >= 3.12 + `uv` (committed `uv.lock`)**; deps **PySide6, pywinpty, psutil** (+ stdlib `subprocess`); `fastapi`/`uvicorn` dropped. Provisioning Python on the Windows host (`winget install Python.Python.3.12`) is an approved build prerequisite.
4. **Control strategy / privilege UX** - APPROVED: **shell-out-only + WSL2 two-way interop + PAT-free read-only default** (proven), with **per-action UAC elevation via a ShellExecute "runas" helper** for Windows NSSM mutations; systemd `--user` needs no root. Exact elevation UX may be refined during Wave-1.
5. **Code home** - APPROVED: **in-repo `tools/runner-ui/`**.
6. **Phasing** - APPROVED: **Wave 1** app shell + runner fleet control; **Wave 2** Claude usage/cost/token monitor; **Wave 3** embedded terminal.

The real tool is now built fresh via plan/execute under `tools/runner-ui/`; the throwaway `spike/` proof and the `spike/263-runner-ui-adr` branch are discarded (spike branches never merge).

## Consequences

- **AC1 is signed off.** This ADR resolves all four questions with grounded, owner-approved decisions and a working cross-platform proof. Build (epic #262 AC2+) is now authorized against the accepted phasing.
- **Charter widened.** #262's scope grows from "runner UI" to "Claude Code cockpit" (fleet control + terminal + monitoring + usage/cost). Epic children should map to the three approved waves.
- **New build prerequisite.** Python must be provisioned on the Windows host (`winget install Python.Python.3.12`) before Wave 1, since only the Store stub is present today.
- **Accepted costs.** A native PySide6 app means a larger install (~100MB onefile), more code than a web/TUI tool, and an LGPL dependency (acceptable). These are the deliberate price of the native cockpit.
- **Security posture unchanged.** The cockpit reads service state only, never reads `~/.forge/runner.env`, never surfaces the PAT; usage data comes from local transcripts, not from any secret store.
- **Throwaway / recovery:** the spike branch and its `tools/runner-ui/spike/` proof are discarded; nothing there merges. This ADR is the only artifact that lands on `main`, alongside ADR-0001..0005. Any code sketched in the spike is re-implemented properly through plan/execute, never cherry-picked.

## Sources (grounded)

- This repo - ADR-0005 (`docs/decisions/0005-local-self-hosted-runner.md`): PAT/secret model, JIT+ephemeral, private-only guard, repo-derived service names.
- This repo - `runner/README.md`, `runner/windows/setup-runner.ps1` (NSSM service, LocalSystem, admin-gated install), `runner/linux/install-service.sh` (systemd `--user`, no root), `runner/linux/supervisor.mjs` (shell-out to `gh`/`docker`, PAT never on argv/never logged).
- This repo - `.claude/forge.json` `runner` block: `{ enabled, labels, sharing:"repo", windows:"native" }`.
- Live host (2026-07-24): `Get-Service forge-runner*` and the WSL2 probe run captured above - real `forge-runner-dngioidev-forge` / `-iomanage` services + systemd `--user` units + docker job containers.
- WSL2 two-way interop (Windows binaries on the WSL PATH; `wsl.exe` from Windows) - the basis for single-process cross-OS control on one box, and the path a Windows-native cockpit uses to drive the WSL Linux runner.
- Local Claude usage data - per-session JSONL transcripts under `~/.claude/projects/**/*.jsonl`, each assistant turn's recorded `usage` token counts x published per-model rates - the grounded, API-free basis for the cockpit's usage/pricing/token panels (the same source `/cost` and ccusage-style tools read).
