"""Cockpit v2 localhost backend (ticket #351, ADR-0008) — the Python cores over HTTP.

ADR-0008 re-architected the cockpit from a native PySide6 window into a local
**web app**: the existing framework-agnostic Python cores served over
``127.0.0.1``, a browser UI, and an xterm.js terminal over a websocket. This
module is the **HTTP backend + endpoint surface** half of that: a FastAPI (ASGI)
app, served by uvicorn, that exposes each core as a loopback JSON endpoint —

* ``GET  /api/health``    — liveness probe.
* ``GET  /api/fleet``     — :func:`forge_cockpit.discovery.discover_fleet`.
* ``POST /api/control``   — :func:`forge_cockpit.control.control` (start/stop/restart).
* ``GET  /api/logs``      — :func:`forge_cockpit.logs.read_logs`.
* ``POST /api/provision`` — :func:`forge_cockpit.provision.provision` (install/uninstall).
* ``GET  /api/usage``     — :func:`forge_cockpit.usage.collect_usage` (+ aggregates).

It is a **thin route layer**: it decodes the request, calls the matching core
UNCHANGED, and serializes the core's typed result to JSON. No business logic
lives here — the cores remain framework-agnostic (they know nothing of HTTP).

Security (ADR-0005 + ADR-0006, inherited unchanged — AC.2):

* The server binds **127.0.0.1 only** (:data:`HOST`) — never ``0.0.0.0`` — so the
  surface is reachable from this machine alone.
* The invariants carried by the cores hold end to end: **PAT-free**,
  ``~/.forge/runner.env`` is **never read** (``shellout`` refuses any argv that
  references it), and usage is **metadata only** (no prompt/response content).
  No endpoint here adds a field that could carry a secret or the PAT.

Loopback hardening (#352, ADR-0008) — ``Host``-header/DNS-rebinding validation,
``Origin``/CSRF checks, and a launch-minted per-session capability token required
by the mutating routes — is layered on in :mod:`forge_cockpit.security` and wired
in :func:`create_app`. Remaining ADR-0008 children: the PTY-over-websocket
terminal is **#353** and the browser UI is **#354**.
"""

from __future__ import annotations

import dataclasses

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from forge_cockpit import discovery, usage
from forge_cockpit.security import (
    LoopbackGuardMiddleware,
    mint_session_token,
    require_session_token,
)
from forge_cockpit.control import ACTIONS as CONTROL_ACTIONS
from forge_cockpit.control import control
from forge_cockpit.discovery import (
    UNKNOWN_TARGET,
    Fleet,
    OnlineStatus,
    RunnerEntry,
)
from forge_cockpit.logs import DEFAULT_TAIL_LINES, read_logs
from forge_cockpit.provision import ACTIONS as PROVISION_ACTIONS
from forge_cockpit.provision import PLATFORMS, provision
from forge_cockpit.usage import (
    UsageAggregate,
    UsageRecord,
    aggregate_by_day,
    aggregate_by_model,
    aggregate_by_session,
    collect_usage,
)

#: Loopback-only bind address (ADR-0008 — AC.1). NEVER ``0.0.0.0``: the cockpit
#: backend is reachable from this machine alone. Loopback hardening beyond the
#: bind (Host header / Origin / capability token) is #352.
HOST = "127.0.0.1"

#: Default port for the local cockpit backend.
DEFAULT_PORT = 8765


# --------------------------------------------------------------------------- #
# Request models (pydantic) — validated bodies for the mutating endpoints.
# --------------------------------------------------------------------------- #
class ControlRequest(BaseModel):
    """Body for ``POST /api/control`` — which service and which verb."""

    name: str = Field(..., min_length=1, description="The service/unit NAME (name-derived, #264).")
    mechanism: str = Field(..., description="nssm | systemd | docker.")
    action: str = Field(..., description="start | stop | restart.")


class ProvisionRequest(BaseModel):
    """Body for ``POST /api/provision`` — install/uninstall a repo-scoped service."""

    action: str = Field(..., description="install | uninstall.")
    owner: str = Field(..., min_length=1)
    repo: str = Field(..., min_length=1)
    platform: str | None = Field(default=None, description="windows | linux (defaults to host).")
    force: bool = Field(default=False, description="Bypass the clobber/mis-target guard.")


# --------------------------------------------------------------------------- #
# Serializers — typed core dataclasses -> plain JSON-able dicts.
#
# Explicit (not blanket ``asdict``) so derived fields the UI needs (target slug,
# online_count, total_tokens) travel too, and so nothing outside the cores' typed
# fields is ever leaked (a secret has nowhere to hide — AC.2).
# --------------------------------------------------------------------------- #
def _serialize_target(target: discovery.Target) -> dict:
    return {
        "owner": target.owner,
        "repo": target.repo,
        "known": target.known,
        "slug": target.slug,
    }


def _serialize_online(online: OnlineStatus) -> dict:
    return {
        "online": online.online,
        "offline": online.offline,
        "total": online.total,
        "known": online.known,
    }


def _serialize_entry(entry: RunnerEntry) -> dict:
    return {
        "name": entry.name,
        "mechanism": entry.mechanism,
        "service_state": entry.service_state,
        "target": _serialize_target(entry.target),
        "online": _serialize_online(entry.online),
        "repo": entry.repo,
        "online_count": entry.online_count,
    }


def _serialize_fleet(fleet: Fleet) -> dict:
    return {"runners": [_serialize_entry(e) for e in fleet.runners]}


def _serialize_usage_record(record: UsageRecord) -> dict:
    return {
        "session_id": record.session_id,
        "model": record.model,
        "timestamp": record.timestamp.isoformat() if record.timestamp is not None else None,
        "input_tokens": record.input_tokens,
        "output_tokens": record.output_tokens,
        "cache_read_tokens": record.cache_read_tokens,
        "cache_creation_tokens": record.cache_creation_tokens,
        "total_tokens": record.total_tokens,
    }


def _serialize_aggregate(agg: UsageAggregate) -> dict:
    return {
        "key": agg.key,
        "turns": agg.turns,
        "input_tokens": agg.input_tokens,
        "output_tokens": agg.output_tokens,
        "cache_read_tokens": agg.cache_read_tokens,
        "cache_creation_tokens": agg.cache_creation_tokens,
        "total_tokens": agg.total_tokens,
        "cost_input": agg.cost_input,
        "cost_output": agg.cost_output,
        "cost_cache_read": agg.cost_cache_read,
        "cost_cache_creation": agg.cost_cache_creation,
        "total_cost": agg.total_cost,
        "unpriced_turns": agg.unpriced_turns,
        "unpriced_models": sorted(agg.unpriced_models),
    }


def _serialize_aggregates(aggs: dict[str, UsageAggregate]) -> dict:
    return {key: _serialize_aggregate(agg) for key, agg in aggs.items()}


# --------------------------------------------------------------------------- #
# App factory + routes (thin — decode, call the core, serialize).
# --------------------------------------------------------------------------- #
def create_app(*, port: int = DEFAULT_PORT, session_token: str | None = None) -> FastAPI:
    """Build the FastAPI app wiring each core to a loopback JSON endpoint (AC.1).

    A factory (not a module-global app) so tests can build a fresh instance and
    the console entry point can serve one, without import-time side effects.

    Loopback hardening (#352, ADR-0008): the app mounts
    :class:`~forge_cockpit.security.LoopbackGuardMiddleware` (Host/Origin /
    DNS-rebinding defense) and mints a per-session capability token stored on
    ``app.state.session_token`` — required by the mutating routes and handed to
    the UI (#354) at load. ``port`` is the bound port the Host/Origin checks
    pin to; pass it so a non-default bind still validates correctly.
    """
    token = session_token or mint_session_token()
    app = FastAPI(
        title="Forge cockpit backend",
        summary="Local (127.0.0.1) HTTP surface over the framework-agnostic runner cores.",
        version="2.0.0",
    )
    #: The per-session capability token (AC.3) and the bound port the Host/Origin
    #: guard pins to (AC.1). ``session_token`` is what ``require_session_token``
    #: compares against and what the UI (#354) reads to authorize its mutations.
    app.state.session_token = token
    app.state.bound_port = port
    # DNS-rebinding / cross-origin guard runs ahead of every route (AC.1).
    app.add_middleware(LoopbackGuardMiddleware, expected_port=port)

    @app.get("/api/health")
    def health() -> dict:
        """Liveness probe — the UI polls this to know the backend is up."""
        return {"status": "ok", "service": "forge-cockpit"}

    @app.get("/api/fleet")
    def get_fleet() -> dict:
        """Discover the runner fleet (:func:`discover_fleet`) — AC.1."""
        return _serialize_fleet(discovery.discover_fleet())

    @app.post("/api/control", dependencies=[Depends(require_session_token)])
    def post_control(req: ControlRequest) -> dict:
        """Start / stop / restart a service (:func:`control`) — AC.1.

        State-changing: guarded by the per-session capability token (#352 AC.2/AC.3)
        via :func:`require_session_token` — a request without a valid token is 403.

        The core reads only the entry's NAME and mechanism (never its env), so a
        minimal :class:`RunnerEntry` reconstructed from the request is sufficient
        and keeps this a thin wrapper.
        """
        if req.action not in CONTROL_ACTIONS:
            raise HTTPException(
                status_code=422,
                detail=f"unknown action {req.action!r}; expected one of {list(CONTROL_ACTIONS)}",
            )
        entry = RunnerEntry(
            name=req.name,
            mechanism=req.mechanism,
            service_state="unknown",
            target=UNKNOWN_TARGET,
            online=OnlineStatus.unknown(),
        )
        return dataclasses.asdict(control(entry, req.action))

    @app.get("/api/logs")
    def get_logs(
        name: str = Query(..., min_length=1, description="The service/unit NAME."),
        mechanism: str = Query(..., description="nssm | systemd | docker."),
        lines: int = Query(default=DEFAULT_TAIL_LINES, ge=1, le=10000),
    ) -> dict:
        """Read the tail of a service's own logs (:func:`read_logs`) — AC.1."""
        entry = RunnerEntry(
            name=name,
            mechanism=mechanism,
            service_state="unknown",
            target=UNKNOWN_TARGET,
            online=OnlineStatus.unknown(),
        )
        return dataclasses.asdict(read_logs(entry, lines=lines))

    @app.post("/api/provision", dependencies=[Depends(require_session_token)])
    def post_provision(req: ProvisionRequest) -> dict:
        """Install / uninstall a repo-scoped runner service (:func:`provision`) — AC.1.

        State-changing: guarded by the per-session capability token (#352 AC.2/AC.3)
        via :func:`require_session_token` — a request without a valid token is 403.

        Never handles the PAT (AC.2/AC.3 of the core): the token is out of band.
        The clobber/mis-target guard cross-references the live fleet in the UI
        layer (#354) — the HTTP surface passes ``force`` straight through.
        """
        if req.action not in PROVISION_ACTIONS:
            raise HTTPException(
                status_code=422,
                detail=f"unknown action {req.action!r}; expected one of {list(PROVISION_ACTIONS)}",
            )
        if req.platform is not None and req.platform not in PLATFORMS:
            raise HTTPException(
                status_code=422,
                detail=f"unknown platform {req.platform!r}; expected one of {list(PLATFORMS)}",
            )
        result = provision(
            req.action,
            req.owner,
            req.repo,
            platform=req.platform,
            force=req.force,
        )
        return dataclasses.asdict(result)

    @app.get("/api/usage")
    def get_usage() -> dict:
        """Claude usage/cost from local transcripts (:func:`collect_usage`) — AC.1.

        Metadata only — token counts, model ids, timestamps, and derived cost.
        No prompt/response content is read or returned (ADR-0006 — AC.2).
        """
        records = collect_usage()
        return {
            "records": [_serialize_usage_record(r) for r in records],
            "by_session": _serialize_aggregates(aggregate_by_session(records)),
            "by_day": _serialize_aggregates(aggregate_by_day(records)),
            "by_model": _serialize_aggregates(aggregate_by_model(records)),
        }

    return app


#: Module-level ASGI app (``uvicorn forge_cockpit.server:app``) — built once.
app = create_app()


def build_config(*, host: str = HOST, port: int = DEFAULT_PORT) -> uvicorn.Config:
    """The uvicorn config for serving the app — bound to loopback by default (AC.1/AC.4).

    Factored out so a test can assert the bind host is ``127.0.0.1`` and never
    ``0.0.0.0`` without standing a real socket up. When a non-default ``port`` is
    requested a fresh app is built for it so the Host/Origin guard (#352) pins the
    actually-bound port rather than the module default.
    """
    application = app if port == DEFAULT_PORT else create_app(port=port)
    return uvicorn.Config(application, host=host, port=port, log_level="info")


def main() -> None:
    """Console entry point (``forge-cockpit``): serve the backend on 127.0.0.1.

    Restores the ``forge-cockpit`` launch command #355 removed with the desktop
    UI — now serving the FastAPI backend instead of opening a Qt window. Binds
    loopback only; the browser UI (#354) will connect to it.
    """
    uvicorn.Server(build_config()).run()


if __name__ == "__main__":  # pragma: no cover - manual launch path
    main()
