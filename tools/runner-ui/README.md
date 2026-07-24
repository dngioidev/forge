# forge cockpit (`tools/runner-ui/`)

A native **PySide6 (Qt) desktop app** to manage the forge local self-hosted
runner **fleet** — the "cockpit" decided in
[ADR-0006](../../docs/decisions/0006-runner-ui.md) (epic #262). It is the visual,
one-window version of the manual runbook in the
[runner adoption guide](../../docs/guides/runner-adoption.md#the-cockpit-toolsrunner-ui-262).

The cockpit reads service **state** only. Per ADR-0005/0006 it **never** reads
`~/.forge/runner.env` and never surfaces the runner PAT (see Security below).

## What it shows / does

- **Fleet view (#265)** — one table over the normalized discovery model listing
  every `forge-runner-<owner>-<repo>` service across both OS legs: its target
  repo, OS/mechanism (Windows NSSM / Linux systemd `--user` / Docker), service
  state, and the count of online runners. Refreshes on demand and on an interval
  without freezing the window (discovery shells out on a worker thread).
- **Mis-target flags (#265)** — a service that is *running* yet whose configured
  repo shows **0** online runners is flagged with a warning icon, a highlighted
  row, and an explanatory tooltip — the #260 mis-target class made visible.
- **Control actions (#266)** — start / stop / restart a selected service.
  Windows NSSM mutations trigger a per-action UAC elevation; Linux systemd
  `--user` needs no elevation. Actions run off the GUI thread.
- **Logs (#266)** — tail a service's logs in-window (Windows NSSM
  `service.out/err.log`; Linux `journalctl --user`).
- **Install / uninstall (#267)** — a secret-safe modal to stand a repo-scoped
  runner service up or down by driving `setup-runner.ps1` / `install-service.sh`.
  It shows read-only PAT *guidance* only — **no token field** — and guards
  against clobbering a service that targets a different repo.

The "Usage / cost" and "Terminal" tabs are Wave-2/Wave-3 placeholders (ADR-0006).

## Layout

```
tools/runner-ui/
  pyproject.toml        # uv/PEP-621 project; requires-python >=3.12
  uv.lock               # committed, hash-pinned lockfile (the pinned env)
  forge-cockpit.spec    # hand-written PyInstaller spec (optional onefile build)
  forge_cockpit/
    __main__.py         # `main()` — the forge-cockpit console-script entry point
    app.py              # CockpitWindow — QMainWindow + QTabWidget shell
    discovery.py        # PAT-free fleet discovery (sc/systemctl/docker/gh)
    fleet_view.py       # the fleet table + mis-target flags
    control.py          # start/stop/restart (per-action UAC on Windows)
    logs.py / log_view.py       # tail service logs in-window
    provision.py / provision_view.py  # install / uninstall dialog
    shellout.py         # argv-list shell-out + `wsl.exe --` interop, PAT-safe
  tests/                # headless (offscreen) pytest suite
```

## Prerequisites

Python is **not** part of this repo; it is a host prerequisite (ADR-0006
Decision 3). Provision **Python 3.12** and [`uv`](https://docs.astral.sh/uv/):

- **Windows** — install Python machine-wide so the CI runner service
  (LocalSystem) sees it, then install `uv`:
  ```powershell
  winget install --scope machine -e --id Python.Python.3.12
  winget install -e --id astral-sh.uv
  ```
- **WSL / Linux** — any CPython >= 3.12 plus `uv`:
  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh   # or: pipx install uv
  ```

`uv` resolves/provisions the interpreter from the committed `uv.lock`, so you do
not call bare `python`.

## Launch (one command, Windows + WSL/Linux)

From `tools/runner-ui/`, `uv` creates the pinned `.venv` on first run and then
launches the cockpit window via the `forge-cockpit` console-script entry point:

- **Windows (PowerShell):**
  ```powershell
  cd tools\runner-ui
  uv run forge-cockpit
  ```
- **WSL / Linux:**
  ```bash
  cd tools/runner-ui
  uv run forge-cockpit
  ```

`uv run forge-cockpit` is equivalent to `uv run python -m forge_cockpit`; both
sync the environment from `uv.lock` first, so a plain checkout launches with no
extra install step.

## Test

```bash
cd tools/runner-ui
uv sync --frozen                 # create .venv from the committed uv.lock
QT_QPA_PLATFORM=offscreen uv run pytest
```

On Windows PowerShell set the platform first:

```powershell
cd tools\runner-ui
uv sync --frozen
$env:QT_QPA_PLATFORM = 'offscreen'
uv run pytest
```

Tests run **headless** via the Qt `offscreen` platform (set in
`tests/conftest.py`), so the suite — including the smoke test and the packaging
entry-point test — passes on the runner without a desktop session. This is
exactly what the `cockpit-python` CI job runs.

## Optional: standalone binary (PyInstaller)

For an adopter who does not want to provision a Python toolchain, build a
single-file desktop binary from the committed spec. This is **not** run in CI
(packaging is heavy and host-specific; CI only runs the pytest suite):

```bash
cd tools/runner-ui
uv run --with pyinstaller pyinstaller forge-cockpit.spec
```

Output lands at `dist/forge-cockpit` — a `~100MB` onefile bundle, the accepted
trade-off recorded in ADR-0006. `--with pyinstaller` keeps PyInstaller out of the
committed `uv.lock` (it is a build-time-only tool). The generated `build/` and
`dist/` trees are gitignored; the hand-written `forge-cockpit.spec` is committed.

## Security

The cockpit reads service **state** only. Per ADR-0005/0006 it **never** reads
`~/.forge/runner.env` and never surfaces the PAT — `shellout.run()` refuses any
command that references a `runner.env` path and never uses `shell=True`, and the
install dialog has no token field (it shows out-of-band PAT guidance only). No
secret is stored in this repo; the `.venv/`, `build/`, and `dist/` local state
are gitignored.
