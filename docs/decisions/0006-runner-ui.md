# ADR-0006 - Runner fleet management UI: UI approach, Python stack, cross-platform control, code home

**Date:** 2026-07-24 - **Status:** **Proposed** (AC1 gate; needs OWNER sign-off before any build) - **Ticket:** #263 (AC1 of epic #262) - **Route:** spike (deliverable = this decision record + the throwaway proof under `tools/runner-ui/spike/`; the spike branch `spike/263-runner-ui-adr` never merges)

## Context

Epic #262 proposes a **Python** UI to manage the local self-hosted runner **fleet** that ADR-0005 (#180) shipped. AC1 is the gate: a spike must resolve four questions with a concrete recommendation grounded in the real scaffold, and the owner must approve before AC2+ (build). This ADR is that spike's deliverable.

The four questions: (1) UI approach - desktop GUI vs local web app vs terminal UI; (2) Python stack + deps and how they are pinned/run cross-platform; (3) control strategy - how the tool discovers and controls services without reimplementing them; (4) home for the code - in-repo `tools/runner-ui/` vs a sibling repo.

### Grounded facts from the existing runner scaffold (ADR-0005 + code)

These are the REAL constraints every recommendation below is anchored to:

- **Two service managers, two OS contexts, one physical box.** Windows legs run as an **NSSM** service `forge-runner-<owner>-<repo>` (LocalSystem, `SERVICE_AUTO_START`, restart-on-exit) registered by `runner/windows/setup-runner.ps1`. Linux legs run as a **systemd `--user`** unit `forge-runner-<owner>-<repo>.service` installed by `runner/linux/install-service.sh`, which drives **`docker compose run --rm`** ephemeral job containers via `runner/linux/supervisor.mjs`. The owner's box is Windows 11 hosting a native Windows runner PLUS a WSL2 Ubuntu Linux runner (confirmed live below).
- **Repo-scoped, multi-repo names.** The service/unit name is repo-derived (`forge-runner-<owner>-<repo>`), so ONE host durably serves several private repos at once. This box already runs `forge-runner-dngioidev-forge` and `forge-runner-dngioidev-iomanage` - the UI is genuinely a *fleet* view, not a single-service toggle.
- **The one secret is off-limits to this UI.** The Administration-only PAT lives ONLY in the gitignored, chmod-600 `~/.forge/runner.env` (Linux) or the service environment / NSSM `AppEnvironmentExtra` (Windows). ADR-0005 forbids it on argv, in `forge.json`, in logs, or in any committed file. **The UI must never read `runner.env` or surface the PAT** - it reads service *state* only.
- **Managers are already the API.** The scaffold itself only ever shells out - `gh api`, `sc`/NSSM, `systemctl --user`, `docker compose`. It reimplements nothing. `gh` is already a hard dependency. The runner is **private-repo-only** (fork-PR RCE guard).
- **`.claude/forge.json` `runner` block is committed** and machine-readable: `{ enabled, labels:[self-hosted,linux,forge-local], sharing:"repo", windows:"native" }`. That is the UI's config source of truth for what to expect.
- **Read-only status needs no privilege.** `Get-Service`/`sc query`, `systemctl --user status`, and `docker ps` all return state unprivileged. Only *mutating* a Windows NSSM service (start/stop/reinstall) needs Windows admin; systemd `--user` needs no root at all.

## Decisions (recommendations - the owner decides Q1/Q2/Q3-privilege/Q4)

### Decision 1 - UI approach -> **RECOMMEND: a local web app (FastAPI + a static localhost browser page), bound to 127.0.0.1 only. Second choice: a Textual TUI.**

Rationale, grounded in the two-OS-context constraint:

- The renderer must work identically on Windows and inside WSL2, with near-zero packaging. A **browser page served by a localhost FastAPI process** is the lowest-friction cross-platform view: no GUI toolkit to install per OS, no PyInstaller-per-OS packaging, and the same page renders on either side. Control actions map cleanly to a small JSON API (`GET /services`, `POST /services/{name}/{start|stop}`).
- It also fits the **fleet** shape: a table of N repo runners across both OSes, auto-refreshing, is a natural web view and trivially extended later (still localhost-only) without a native-window rewrite.
- Binding **127.0.0.1 only** keeps it private by default - consistent with ADR-0005's private-only posture. No auth surface is exposed to the network.

Rejected options and their real trade-offs:

- **Desktop GUI - Tkinter:** ships with CPython (zero extra dep) but dated/limited widgets and still needs a display; awkward inside headless WSL2. Weak fit for a fleet table.
- **Desktop GUI - PyQt/PySide:** heavy dependency, GPL/commercial licensing to reason about, and painful per-OS packaging (large PyInstaller bundles). Overkill for a solo ops tool.
- **Textual TUI:** genuinely strong - single dep (`textual`), runs in any terminal including over SSH/WSL, no browser, and the runner is already a terminal-adjacent asset. It is the recommended **fallback** if the owner prefers a pure-terminal tool with the smallest dependency set. Its only downside vs the web app is a slightly higher build effort for rich tables/refresh and no trivial "open in browser" share path. Both are acceptable; the pick is the owner's.

### Decision 2 - Python stack + deps, pinned and run cross-platform -> **RECOMMEND: CPython >= 3.12, dependencies managed and pinned with `uv` (lockfile committed), one venv per OS context; deps limited to `fastapi` + `uvicorn` (+ stdlib `subprocess`). Nothing that reimplements a service manager.**

Rationale:

- **`uv`** gives a committed, hash-pinned `uv.lock` that resolves identically on Windows and Linux, is fast, and can even bootstrap the interpreter - directly relevant because **Python is not currently installed on the Windows host** (only the Windows Store alias stub is present; see Evidence). Provisioning Python is therefore a documented prerequisite: `winget install Python.Python.3.12` on Windows, `apt install python3 python3-venv` (or distro equivalent) in WSL. `uv` also runs cleanly with `pipx`/`pip` as the fallback if the owner prefers `requirements.txt` compiled by pip-tools.
- **Minimal deps** keeps faith with the runner's zero-runtime-dependency ethos: `fastapi`+`uvicorn` for the local web app (or just `textual` for the TUI fallback), and **stdlib `subprocess`** for all control. No `pywin32`/service-manager libraries - those would reimplement what `sc`/`systemctl`/`docker` already expose.
- **Run cross-platform** via `uv run python -m runner_ui` (a `.venv` per OS context: one under Windows, one inside WSL). The proof already ran under Python 3.14.4 in WSL, so >= 3.12 is safely available there; the Windows venv is provisioned at enable time.

### Decision 3 - Control strategy -> **RECOMMEND: shell out to the existing managers only (never reimplement); cross the Windows<->WSL2 boundary with native two-way interop; read-only + unprivileged by default, mutating actions explicitly elevated.**

This is the load-bearing decision and it is fully proven below.

- **Discover + control by shelling out**, exactly as the scaffold does: Windows via `sc query` / `Get-Service` (and `nssm start|stop` / `setup-runner.ps1` for lifecycle), Linux via `systemctl --user`, containers via `docker ps` / `docker compose`. `gh` only if live GitHub *registration* state is wanted later - and that path needs the PAT, so **the default UI stays PAT-free by reading local service state only** and never touches `runner.env`.
- **One process reaches both OSes** on a single box via WSL2 two-way interop: from WSL, Windows services are reachable through `sc.exe` / `powershell.exe` on PATH; from Windows, Linux services are reachable through `wsl.exe -- systemctl --user ...` and `wsl.exe -- docker ...`. This removes any need for SSH agents or a per-OS daemon in the solo/single-box topology. (A future multi-host fleet would add a thin per-host agent, but that is out of scope for #262.)
- **Privilege handling:** read-only status is unprivileged on both OSes (proven below - the probe read Windows NSSM state from inside WSL with no elevation). Mutating a Windows NSSM service needs admin, so start/stop/reinstall actions must trigger an explicit elevation (a UAC-elevated helper invocation) and must degrade with a clear "run elevated" message rather than silently failing. systemd `--user` mutations need no root. **Exact privilege UX (auto-elevate per action vs "launch elevated" banner) is an owner call.**
- **Security invariant (non-negotiable):** never pass the PAT on argv, never read `~/.forge/runner.env`, never log service env that could contain it. The probe demonstrates status-only reads that never touch the secret store.

### Decision 4 - Home for the code -> **RECOMMEND: in-repo `tools/runner-ui/` (a first-class tools directory, sibling to `runner/`), depending on the scaffold by *convention* (reads `.claude/forge.json` runner block + the `forge-runner-<owner>-<repo>` naming), not by importing runner code.**

Rationale and trade-offs:

- **In-repo (recommended):** versions in lockstep with the scaffold it drives, shares the committed `forge.json` runner block and the documented PAT/private-only rules, one CI, immediately discoverable. It reads config + service names rather than importing `supervisor.mjs`, so it stays loosely coupled. Placed at `tools/runner-ui/` (not under `runner/`, which is the runtime asset) to keep "the thing that runs jobs" separate from "the thing that watches the fleet".
- **Sibling repo (rejected for now):** cleaner "one fleet tool, many repos" story and an independent release cadence, but it would duplicate forge's conventions, add a second repo to maintain (which would itself want a runner), and complicate the private-only story. Revisit only if the UI graduates to managing runners for repos that do not vendor forge.

## Evidence - AC2 throwaway proof (real service state, cross-platform, no PAT)

A disposable `tools/runner-ui/spike/probe.py` (Python, shell-out only, marked throwaway) was run to prove the chosen stack lists at least one REAL service's state cross-platform. **Note:** Python is not installed on the Windows host (only the Store alias stub), so the proof was run under **Python 3.14.4 inside WSL2** - which, via interop, listed BOTH the Linux services (native) and the Windows services (`sc.exe`), from ONE process. This both proves AC2 and validates the Decision-3 single-process cross-boundary control model.

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

## Owner decisions required before build (AC1 sign-off)

Per AC1, build (AC2+ productionization / epic #262 AC2+) is blocked until the owner approves these four picks. Recommendations restated so the owner can approve or amend each:

1. **UI approach** - approve **local web app (FastAPI, localhost-only)**, or choose the **Textual TUI** fallback (or a desktop GUI, not recommended).
2. **Python stack + deps** - approve **CPython >= 3.12 + `uv` (committed lockfile) + minimal deps (`fastapi`/`uvicorn`, or `textual`)**, and approve **provisioning Python on the Windows host** (currently absent) as a prerequisite. Fallback: pip-tools `requirements.txt`.
3. **Control strategy / privilege UX** - approve **shell-out-only + WSL2 two-way interop + PAT-free read-only default**; decide the **mutation privilege UX** on Windows (auto-elevate per action vs launch-elevated banner). The shell-out and PAT-free invariants are proven and not in question; only the elevation UX needs the owner's call.
4. **Code home** - approve **in-repo `tools/runner-ui/`**, or direct a **sibling repo**.

Once approved, the real tool is built fresh via plan/execute under `tools/runner-ui/`; the `spike/` directory and the `spike/263-runner-ui-adr` branch are discarded (spike branches never merge).

## Consequences

- **AC1 pending owner sign-off.** This ADR resolves all four questions with grounded recommendations and a working cross-platform proof; it does not authorize build until the owner approves the four picks above (escalated on #263).
- **Throwaway / recovery:** the spike branch is deleted after write-up; nothing there merges. This ADR lands on `main` alongside ADR-0001..0005. Any code sketched in `spike/` is re-implemented properly through plan/execute, never cherry-picked.

## Sources (grounded)

- This repo - ADR-0005 (`docs/decisions/0005-local-self-hosted-runner.md`): PAT/secret model, JIT+ephemeral, private-only guard, repo-derived service names.
- This repo - `runner/README.md`, `runner/windows/setup-runner.ps1` (NSSM service, LocalSystem, admin-gated install), `runner/linux/install-service.sh` (systemd `--user`, no root), `runner/linux/supervisor.mjs` (shell-out to `gh`/`docker`, PAT never on argv/never logged).
- This repo - `.claude/forge.json` `runner` block: `{ enabled, labels, sharing:"repo", windows:"native" }`.
- Live host (2026-07-24): `Get-Service forge-runner*` and the WSL2 probe run captured above - real `forge-runner-dngioidev-forge` / `-iomanage` services + systemd `--user` units + docker job containers.
- WSL2 two-way interop (Windows binaries on the WSL PATH; `wsl.exe` from Windows) - the basis for single-process cross-OS control on one box.
