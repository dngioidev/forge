"""Loopback hardening for the Cockpit v2 backend (ticket #352, ADR-0008).

The #351 backend can start/stop services and (with #353) open a shell, so its
``127.0.0.1`` surface is a capability, not a read-only dashboard. A loopback bind
alone does **not** make it safe: any web page the user visits can issue requests
to ``http://127.0.0.1:<port>`` from their browser. This module is the hardening
half of ADR-0008 — the defenses that turn "bound to loopback" into "only *this*
machine's own cockpit UI may drive it":

* **DNS-rebinding / Host defense** — a malicious site can point its own domain
  (``evil.example``) at ``127.0.0.1`` so the browser's same-origin policy is
  fooled, but the browser still sends ``Host: evil.example``. We validate that
  the ``Host`` header names a **loopback literal** (``127.0.0.1`` / ``localhost``
  / ``::1``) and matches the bound port; a forged Host is rejected (403).
* **Origin / CSRF defense** — a cross-site ``fetch``/form carries an ``Origin``
  that is not our loopback origin; when an ``Origin`` is present it MUST be an
  allowed loopback origin or the request is rejected (403).
* **Per-session capability token** — a token minted with :func:`mint_session_token`
  at launch (``secrets.token_urlsafe``) is required on every **state-changing**
  endpoint (``/api/control``, ``/api/provision``). The cockpit UI (#354) is handed
  the token at load; a drive-by request that cannot read it (blocked by the same
  Host/Origin checks) cannot mutate. This is the CSRF token *and* the local
  auth: a request without a valid token is rejected (403), one with it passes.

These are stdlib/FastAPI-native mechanisms only (``secrets`` + header checks) —
no new dependency, so the license gate stays green (#352 design guidance). The
ADR-0006 invariants are untouched: this layer never reads ``runner.env`` and
never handles the PAT; it only gates *who* may reach the unchanged cores.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlsplit

from fastapi import Header, HTTPException, Request, status
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

#: Header carrying the per-session capability token on mutating requests (AC.2/AC.3).
#: FastAPI maps the ``x_forge_session`` dependency parameter to this header name.
CSRF_HEADER = "X-Forge-Session"

#: Hostnames accepted in the ``Host`` / ``Origin`` headers — loopback literals ONLY.
#: A DNS-rebinding attacker's domain (``evil.example``) is never in this set even
#: when it resolves to 127.0.0.1, which is the whole point (AC.1).
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

#: Schemes an ``Origin`` may use. A ``null`` / opaque origin (sandboxed iframe,
#: ``file://``) has no scheme here and is therefore rejected.
ALLOWED_ORIGIN_SCHEMES = frozenset({"http", "https"})

#: HTTP methods that never mutate — the Host/Origin guard still applies, but the
#: capability token is not required so the UI can poll fleet/logs/usage/health.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def mint_session_token() -> str:
    """Mint a fresh per-session capability token (AC.3).

    ``secrets.token_urlsafe(32)`` yields 256 bits of URL-safe entropy — plenty to
    make the token unguessable by an off-origin attacker who cannot read it.
    """
    return secrets.token_urlsafe(32)


def _parse_host_header(host: str) -> tuple[str, int | None]:
    """Split a ``Host`` header into ``(hostname, port)``.

    Handles the bare host (``localhost``), host:port (``127.0.0.1:8765``) and the
    bracketed IPv6 forms (``[::1]`` / ``[::1]:8765``). A malformed port is dropped
    (treated as absent) rather than raising — the hostname check does the gating.
    """
    host = host.strip()
    if host.startswith("["):  # IPv6 literal, optionally with :port
        end = host.find("]")
        if end == -1:
            return host, None
        hostname = host[1:end]
        rest = host[end + 1 :]
        if rest.startswith(":") and rest[1:].isdigit():
            return hostname, int(rest[1:])
        return hostname, None
    if host.count(":") == 1:
        name, _, port = host.partition(":")
        return name, int(port) if port.isdigit() else None
    return host, None


def host_is_allowed(host_header: str | None, expected_port: int | None) -> bool:
    """True iff ``Host`` names a loopback literal (and the bound port, if present).

    The hostname check is the DNS-rebinding defense (AC.1); the optional port
    check tightens it to the port we actually bound. A missing ``Host`` header is
    never allowed.
    """
    if not host_header:
        return False
    hostname, port = _parse_host_header(host_header)
    if hostname.lower() not in LOOPBACK_HOSTS:
        return False
    if expected_port is not None and port is not None and port != expected_port:
        return False
    return True


def origin_is_allowed(origin: str | None, expected_port: int | None) -> bool:
    """True iff ``Origin`` is an ``http(s)`` loopback origin on the bound port (AC.1/AC.2).

    Only meaningful when an ``Origin`` header is present; a request without one is
    handled by the caller (browsers omit it on same-origin navigations/GETs).
    """
    if not origin:
        return False
    parts = urlsplit(origin)
    if parts.scheme not in ALLOWED_ORIGIN_SCHEMES:
        return False
    hostname = parts.hostname  # unbrackets [::1] -> ::1
    if hostname is None or hostname.lower() not in LOOPBACK_HOSTS:
        return False
    try:
        port = parts.port
    except ValueError:
        return False
    if expected_port is not None and port is not None and port != expected_port:
        return False
    return True


class LoopbackGuardMiddleware(BaseHTTPMiddleware):
    """Reject any request whose ``Host``/``Origin`` is not an allowed loopback value.

    Runs ahead of the routes (AC.1): a forged-Host DNS-rebinding request and a
    cross-origin request are turned away with 403 *before* they can reach a core.
    A request from the real loopback UI — loopback ``Host`` and (when the browser
    sends one) a loopback ``Origin`` — passes through untouched. The capability
    token for *mutations* is enforced separately by :func:`require_session_token`.
    """

    def __init__(self, app, *, expected_port: int | None = None) -> None:
        super().__init__(app)
        self._expected_port = expected_port

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if not host_is_allowed(request.headers.get("host"), self._expected_port):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "forbidden: non-loopback Host header (DNS-rebinding guard)"},
            )
        origin = request.headers.get("origin")
        # An Origin is only sent cross-navigations; when present it MUST be ours.
        # Its absence is fine — the capability token guards state-changing routes.
        if origin is not None and not origin_is_allowed(origin, self._expected_port):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "forbidden: cross-origin request rejected"},
            )
        return await call_next(request)


def require_session_token(
    request: Request,
    x_forge_session: str | None = Header(default=None),
) -> None:
    """FastAPI dependency: require the per-session capability token (AC.2/AC.3).

    Attached to the mutating routes only. The expected token lives on
    ``app.state.session_token`` (minted at :func:`~forge_cockpit.server.create_app`
    time). Compared in constant time so the check leaks no timing signal. A
    missing or wrong token is a 403; the correct token lets the request proceed.
    """
    expected = getattr(request.app.state, "session_token", None)
    if (
        not x_forge_session
        or not expected
        or not secrets.compare_digest(x_forge_session, expected)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="missing or invalid session token",
        )
