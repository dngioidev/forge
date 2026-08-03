# forge cockpit (`tools/runner-ui/`)

Framework-agnostic **Python cores** for managing the forge local self-hosted
runner **fleet** — the reusable half of the "cockpit"
([ADR-0006](../../docs/decisions/0006-runner-ui.md), epic #262), re-architected as
a local web app in [ADR-0008](../../docs/decisions/0008-cockpit-local-web-app.md).

> **Interim state — no desktop UI (#355).** The native **PySide6 (Qt) desktop
> app** and its **PyInstaller** packaging were **removed** in
> [#355](https://github.com/dngioidev/forge/issues/355), ahead of web-app parity,
> to drop the PySide6 **LGPLv3** dependency so the license check is clean with
> **zero exceptions** before the OSS/MIT flip. **There is no runnable cockpit UI
> right now.** The FastAPI web app
> ([#351](https://github.com/dngioidev/forge/issues/351), cockpit v2 / ADR-0008)
> rebuilds the presentation layer — fleet view, control, usage/cost, and an
> xterm.js terminal over a websocket — on the cores below. This package currently
> ships **only** those cores plus their non-Qt tests.

The cores read service **state** only. Per ADR-0005/0006 they **never** read
`~/.forge/runner.env` and never surface the runner PAT (see Security below).

## What's here — the retained cores

All framework-agnostic (no Qt, no GUI toolkit); they shell out with argv lists
(never `shell=True`) and carry the PAT-free / `runner.env`-never-read invariants:

- **`discovery.py`** — PAT-free fleet discovery across both OS legs
  (`sc`/`Get-Service` on Windows NSSM, `systemctl --user` on Linux, `docker`,
  `gh`), producing a normalized model of every `forge-runner-<owner>-<repo>`
  service, its OS/mechanism, state, and online-runner count (incl. the #260
  mis-target signal).
- **`control.py`** — start / stop / restart a service (per-action UAC elevation
  on Windows NSSM; Linux systemd `--user` needs none).
- **`logs.py`** — read a service's logs (Windows NSSM `service.out/err.log`;
  Linux `journalctl --user`).
- **`provision.py`** — install / uninstall a repo-scoped runner service by
  driving `setup-runner.ps1` / `install-service.sh`. Secret-safe: no token
  handling, guards against clobbering a service targeting a different repo.
- **`usage.py`** — Claude usage / cost / token computation from the local
  per-session JSONL transcripts under `~/.claude/projects/**/*.jsonl` (tokens ×
  published per-model rates; no external API, no fabricated data).
- **`shellout.py`** — argv-list shell-out + `wsl.exe --` two-way interop, PAT-safe
  (refuses any command referencing a `runner.env` path; never `shell=True`).

The PySide6 presentation layer (`app.py`, `__main__.py`, `terminal.py`,
`*_view.py`) and `forge-cockpit.spec` were deleted in #355; the web app (#351)
provides the new UI and launch command.

## Layout

```
tools/runner-ui/
  pyproject.toml        # uv/PEP-621 project; requires-python >=3.12; cores-only deps
  uv.lock               # committed, hash-pinned lockfile (the pinned env)
  forge_cockpit/
    __init__.py         # minimal package init (exposes the cores; no Qt)
    discovery.py        # PAT-free fleet discovery (sc/systemctl/docker/gh)
    control.py          # start/stop/restart (per-action UAC on Windows)
    logs.py             # read service logs
    provision.py        # install / uninstall driving
    usage.py            # Claude usage/cost/tokens from local transcripts
    shellout.py         # argv-list shell-out + `wsl.exe --` interop, PAT-safe
  tests/                # non-Qt pytest suite over the cores
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

## Use the cores

There is **no launch command in the interim** — the cockpit UI and its
`forge cockpit` launcher return with the web app (#351). Until then the cores are
consumed as a library or exercised via the test suite:

```bash
cd tools/runner-ui
uv sync --frozen                 # create .venv from the committed uv.lock
uv run python -c "from forge_cockpit import discovery, control, usage"
```

## Test

The suite is **cores-only** — plain `pytest`, no Qt, no `QT_QPA_PLATFORM`
offscreen dance (the Qt views and their `pytest-qt` tests were removed in #355):

```bash
cd tools/runner-ui
uv sync --frozen                 # create .venv from the committed uv.lock
uv run pytest
```

On Windows PowerShell:

```powershell
cd tools\runner-ui
uv sync --frozen
uv run pytest
```

This is exactly what the `cockpit-python` CI job runs (`uv sync --frozen` + the
cores-only pytest suite).

## Security

The cores read service **state** only. Per ADR-0005/0006 they **never** read
`~/.forge/runner.env` and never surface the PAT — `shellout.run()` refuses any
command that references a `runner.env` path and never uses `shell=True`, and the
provisioning core handles no token (it relies on out-of-band PAT guidance only).
No secret is stored in this repo; the `.venv/` local state is gitignored.
