# forge cockpit (`tools/runner-ui/`)

A native **PySide6 (Qt) desktop app** to manage the forge local self-hosted
runner **fleet** and monitor Claude Code usage — the "cockpit" decided in
[ADR-0006](../../docs/decisions/0006-runner-ui.md) (epic #262).

This is the **Wave-1 foundation** (ticket #272): the app shell + Python/uv
toolchain + the shell-out/WSL2 interop helper. Later waves add runner fleet
control, the usage/cost monitor, and the embedded terminal.

## Layout

```
tools/runner-ui/
  pyproject.toml        # uv/PEP-621 project: forge-cockpit, requires-python >=3.12
  uv.lock               # committed, hash-pinned lockfile
  forge_cockpit/
    __main__.py         # `python -m forge_cockpit` launches the window
    app.py              # CockpitWindow — QMainWindow + QTabWidget shell
    shellout.py         # argv-list shell-out + `wsl.exe --` interop, PAT-safe
  tests/
    test_app_smoke.py   # headless (offscreen) smoke test — window + 3 tabs
    test_shellout.py    # argv-list / no-shell / wsl-prefix / never-reads-runner.env
```

## Prerequisites

Python is **not** part of this repo; it is a host prerequisite (ADR-0006
Decision 3). On Windows, provision it machine-wide so the CI runner service
(LocalSystem) sees it:

```powershell
winget install --scope machine -e --id Python.Python.3.12
```

Then install [`uv`](https://docs.astral.sh/uv/) (`pip install uv` or the official
installer). On WSL/Linux, any CPython >= 3.12 + `uv` works.

## Run & test

```bash
cd tools/runner-ui
uv sync                          # create .venv from the committed uv.lock
uv run python -m forge_cockpit   # launch the cockpit window (Windows or WSL)
uv run pytest                    # run the suite
```

Tests run **headless** via the Qt `offscreen` platform
(`QT_QPA_PLATFORM=offscreen`, set in `tests/conftest.py`), so the smoke test
passes on the runner without a desktop session.

## Security

The cockpit reads service **state** only. Per ADR-0005/0006 it **never** reads
`~/.forge/runner.env` and never surfaces the PAT — `shellout.run()` refuses any
command that references a `runner.env` path and never uses `shell=True`.
