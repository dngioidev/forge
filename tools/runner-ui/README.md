# forge cockpit (`tools/runner-ui/`)

The forge **cockpit** — a **local web app** that manages the forge local
self-hosted runner **fleet** ([ADR-0006](../../docs/decisions/0006-runner-ui.md),
epic #262), re-architected off the retired PySide6 desktop UI in
[ADR-0008](../../docs/decisions/0008-cockpit-local-web-app.md) (epic #350).

What the cockpit **now is**: a **FastAPI backend bound to `127.0.0.1`** that serves
the framework-agnostic **Python cores** (fleet discovery/control/logs/provision/usage)
as loopback JSON endpoints, **plus a PTY-over-websocket terminal**. The `forge-cockpit`
command launches uvicorn on loopback; you then point a browser at it. This replaces
the native Qt window and its hand-rolled terminal with an all-permissive
(MIT/BSD) stack — no LGPL dependency, nothing to bundle.

> **Interim state — the browser UI is still in progress ([#354](https://github.com/dngioidev/forge/issues/354)).**
> What is **landed on main today** is the *backend*: the FastAPI HTTP surface
> ([#351](https://github.com/dngioidev/forge/issues/351)), its loopback hardening
> ([#352](https://github.com/dngioidev/forge/issues/352)), and the
> PTY-over-websocket terminal bridge ([#353](https://github.com/dngioidev/forge/issues/353)).
> The **browser UI** — the fleet view, usage/cost panels, and the xterm.js
> terminal that consume this surface — is **#354 and is not built yet**. So
> `forge-cockpit` currently starts a working **HTTP + websocket API on loopback**,
> not a finished visual cockpit. The native **PySide6 (Qt) desktop app** and its
> **PyInstaller** packaging were removed in
> [#355](https://github.com/dngioidev/forge/issues/355) — ahead of web-app parity,
> to drop the PySide6 **LGPLv3** dependency so the license check is clean with
> **zero exceptions** before the OSS/MIT flip.

The cores read service **state** only. Per ADR-0005/0006 they **never** read
`~/.forge/runner.env` and never surface the runner PAT (see Security below).

## What's here

### The backend (`server.py`) — the FastAPI surface over the cores

`create_app()` builds a FastAPI app that wires each core to a **thin** loopback
JSON endpoint (decode the request → call the core UNCHANGED → serialize the typed
result). The cores stay framework-agnostic; no business logic lives in the route
layer. It binds **`127.0.0.1` only** (`HOST`, default port **8765**), never
`0.0.0.0`.

| Route | Method | Core | Notes |
| --- | --- | --- | --- |
| `/api/health` | GET | — | liveness probe (the UI polls it) |
| `/api/fleet` | GET | `discovery.discover_fleet` | PAT-free fleet discovery |
| `/api/control` | POST | `control.control` | start/stop/restart — **token-gated** |
| `/api/logs` | GET | `logs.read_logs` | tail a service's own logs |
| `/api/provision` | POST | `provision.provision` | install/uninstall — **token-gated** |
| `/api/usage` | GET | `usage.collect_usage` | usage/cost aggregates (metadata only) |
| `/api/terminal` | WS | `terminal_bridge.serve` | PTY over websocket — **token-gated** |

### The terminal bridge (`terminal_bridge.py`) — PTY over websocket (#353)

The backend half of the Cockpit v2 terminal: it spawns a **PTY-backed shell** and
pumps its **raw bytes** bidirectionally over the `/api/terminal` websocket —
POSIX via the stdlib `pty` (`_PosixPtySession`), Windows via ConPTY through
**pywinpty** (`_WinPtySession`, MIT). A `{"type":"resize","cols":C,"rows":R}`
control message reflows the PTY. There is deliberately **no ANSI parser and no key
map** here — the xterm.js frontend (#354) owns VT emulation, which is the
*architectural* fix for the old #275 typing bug (not a patch). The spawned shell
is plain: no env is injected, so no PAT/token leaks into the child.

### The security layer (`security.py`) — loopback hardening (#352)

See [Security](#security) below. Turns "bound to loopback" into "only *this*
machine's own cockpit UI may drive it".

### The retained cores

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
`*_view.py`) and `forge-cockpit.spec` were deleted in #355; the FastAPI backend
above replaces them, and the browser UI (#354) will replace the Qt panels.

## Layout

```
tools/runner-ui/
  pyproject.toml        # uv/PEP-621 project; requires-python >=3.12
  uv.lock               # committed, hash-pinned lockfile (the pinned env)
  forge_cockpit/
    __init__.py         # minimal package init (exposes the cores; no Qt)
    server.py           # FastAPI app: cores over 127.0.0.1 + `forge-cockpit` entry (#351)
    security.py         # loopback hardening: Host/Origin guard + session token (#352)
    terminal_bridge.py  # PTY-over-websocket bridge; xterm.js owns emulation (#353)
    discovery.py        # PAT-free fleet discovery (sc/systemctl/docker/gh)
    control.py          # start/stop/restart (per-action UAC on Windows)
    logs.py             # read service logs
    provision.py        # install / uninstall driving
    usage.py            # Claude usage/cost/tokens from local transcripts
    shellout.py         # argv-list shell-out + `wsl.exe --` interop, PAT-safe
  tests/                # non-Qt pytest suite over the cores + backend
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

## Run it

`forge-cockpit` (restored by #351, now serving the backend instead of a Qt
window) launches **uvicorn on `127.0.0.1:8765`**, then you open a browser:

```bash
cd tools/runner-ui
uv sync --frozen                 # create .venv from the committed uv.lock
uv run forge-cockpit             # serves the backend on http://127.0.0.1:8765
```

On Windows PowerShell:

```powershell
cd tools\runner-ui
uv sync --frozen
uv run forge-cockpit
```

Until the browser UI (#354) lands, this is an **HTTP + websocket API**, not a
finished page. You can exercise the surface directly — e.g. the liveness probe and
fleet discovery (both safe GETs, no token needed):

```bash
curl http://127.0.0.1:8765/api/health      # {"status":"ok","service":"forge-cockpit"}
curl http://127.0.0.1:8765/api/fleet        # discovered runner fleet
```

The **mutating** routes (`/api/control`, `/api/provision`) and the `/api/terminal`
websocket require the per-session capability token minted at launch — see Security.

The cores can also still be consumed as a plain library:

```bash
uv run python -c "from forge_cockpit import discovery, control, usage"
```

## Test

The suite is plain **`pytest`** — no Qt, no `QT_QPA_PLATFORM` offscreen dance (the
Qt views and their `pytest-qt` tests were removed in #355); it covers the cores,
the FastAPI backend, the security layer, and the terminal-bridge message decoding:

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
pytest suite).

## Security

A loopback endpoint that can start/stop services and open a shell is a
**capability, not a read-only dashboard** — and a loopback *bind* alone does not
make it safe: any web page the user visits can issue requests to
`http://127.0.0.1:<port>` from their browser (DNS-rebinding / CSRF). ADR-0008
required this surface be hardened deliberately; `security.py` (#352) is that
hardening, layered ahead of every route as `LoopbackGuardMiddleware`:

- **Loopback bind** — the server binds `127.0.0.1` only (`HOST`), never
  `0.0.0.0`, so the surface is reachable from this machine alone.
- **Host / DNS-rebinding guard** — the `Host` header must name a **loopback
  literal** (`127.0.0.1` / `localhost` / `::1`) on the bound port; a forged
  `Host` (a rebinding attacker's `evil.example` that resolves to 127.0.0.1) is
  rejected **403**.
- **Origin / CSRF guard** — when an `Origin` is present it must be an allowed
  loopback origin, else **403** (browsers omit it on same-origin GETs).
- **Per-session capability token** — minted at launch with
  `secrets.token_urlsafe(32)` and required on every **state-changing** route
  (`/api/control`, `/api/provision`) via the `X-Forge-Session` header, compared
  in constant time. The UI (#354) is handed the token at load; a drive-by request
  that cannot read it (blocked by the Host/Origin checks) cannot mutate. Safe
  GETs (health/fleet/logs/usage) need no token.
- **Websocket token gate (#353)** — Starlette's HTTP middleware never sees the
  websocket scope, so `/api/terminal` enforces the same defenses itself
  (`authorize_websocket`) **before** accepting the upgrade: loopback `Host` +
  loopback `Origin` (a websocket handshake always carries one, so a
  missing/foreign Origin is rejected) + the capability token. Browsers cannot set
  custom headers on a ws handshake, so the token travels as the `token` query
  parameter. A tokenless or cross-origin upgrade is closed with a
  policy-violation before any shell is spawned.

The ADR-0006 invariants are untouched underneath all of this: the cores read
service **state** only, **never** read `~/.forge/runner.env`, and never surface
the PAT — `shellout.run()` refuses any command that references a `runner.env` path
and never uses `shell=True`, the provisioning core handles no token, and the
spawned terminal shell inherits the ordinary environment with **no** injected env.
No secret is stored in this repo; the `.venv/` local state is gitignored.
