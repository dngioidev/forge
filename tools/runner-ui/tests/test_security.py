"""Tests for the Cockpit v2 loopback hardening (ticket #352, ADR-0008).

These lock the defenses that make the #351 backend safe to expose on loopback
(AC.4): a forged ``Host`` (DNS-rebinding) is rejected, a cross-origin request is
rejected, a state-changing request without the per-session capability token is
rejected, and a genuine loopback request carrying a valid token is accepted —
while read-only endpoints stay usable from the loopback UI. The bind stays
``127.0.0.1`` only (never ``0.0.0.0``) and a token is minted per session (AC.3).

Hermetic: no core is invoked except through the guarded route (control is
monkeypatched so the accepted-mutation test never shells out).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from forge_cockpit import security, server
from forge_cockpit.control import ActionResult
from forge_cockpit.discovery import NSSM, RunnerEntry

PORT = server.DEFAULT_PORT
LOOPBACK = f"http://127.0.0.1:{PORT}"
TOKEN_HEADERS = {security.CSRF_HEADER: server.app.state.session_token}


@pytest.fixture
def loopback_client() -> TestClient:
    """A client that connects with a genuine loopback Host + Origin (no token)."""
    c = TestClient(server.app, base_url=LOOPBACK)
    c.headers.update({"Origin": LOOPBACK})
    return c


# --------------------------------------------------------------------------- #
# AC.3 — bind is 127.0.0.1 only, and a per-session token is minted.
# --------------------------------------------------------------------------- #
def test_bind_is_loopback_never_all_interfaces():
    assert server.HOST == "127.0.0.1"
    assert server.build_config().host == "127.0.0.1"
    assert server.build_config().host != "0.0.0.0"


def test_session_token_is_minted_and_unique():
    assert isinstance(server.app.state.session_token, str)
    assert len(server.app.state.session_token) >= 32
    # A fresh app mints its own distinct token — tokens are per session.
    other = server.create_app()
    assert other.state.session_token != server.app.state.session_token


# --------------------------------------------------------------------------- #
# AC.1 — DNS-rebinding / Host defense.
# --------------------------------------------------------------------------- #
def test_forged_host_is_rejected():
    """A DNS-rebinding site sends its own domain as Host even when it resolves to
    127.0.0.1 — the loopback-literal check turns it away (403)."""
    forged = TestClient(server.app, base_url="http://evil.example")
    res = forged.get("/api/health")
    assert res.status_code == 403
    assert "Host" in res.json()["detail"]


def test_valid_loopback_host_passes(loopback_client):
    res = loopback_client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "forge-cockpit"}


def test_localhost_host_is_accepted():
    c = TestClient(server.app, base_url=f"http://localhost:{PORT}")
    assert c.get("/api/health").status_code == 200


def test_wrong_port_host_is_rejected():
    """The Host guard pins the bound port — a loopback host on the wrong port is
    not our surface."""
    c = TestClient(server.app, base_url="http://127.0.0.1:1")
    assert c.get("/api/health").status_code == 403


# --------------------------------------------------------------------------- #
# AC.1 / AC.2 — Origin / cross-origin defense.
# --------------------------------------------------------------------------- #
def test_cross_origin_request_is_rejected():
    """Valid loopback Host but a cross-site Origin (the CSRF/attacker case)."""
    c = TestClient(server.app, base_url=LOOPBACK)
    res = c.get("/api/health", headers={"Origin": "http://evil.example"})
    assert res.status_code == 403
    assert "origin" in res.json()["detail"].lower()


def test_valid_origin_get_is_usable(loopback_client, monkeypatch):
    """AC.2: read-only endpoints stay usable — a GET with a valid loopback Origin
    (and no token) is fine."""
    from forge_cockpit.discovery import Fleet

    monkeypatch.setattr(server.discovery, "discover_fleet", lambda: Fleet(runners=()))
    res = loopback_client.get("/api/fleet")
    assert res.status_code == 200
    assert res.json() == {"runners": []}


# --------------------------------------------------------------------------- #
# AC.2 / AC.3 — CSRF / per-session token on the mutating endpoints.
# --------------------------------------------------------------------------- #
def test_mutation_without_token_is_rejected(loopback_client):
    """Genuine loopback Host+Origin but no capability token — a drive-by that
    guessed the origin still cannot mutate."""
    res = loopback_client.post(
        "/api/control",
        json={"name": "forge-runner-a-b", "mechanism": NSSM, "action": "restart"},
    )
    assert res.status_code == 403
    assert "token" in res.json()["detail"].lower()


def test_mutation_with_wrong_token_is_rejected(loopback_client):
    res = loopback_client.post(
        "/api/control",
        headers={security.CSRF_HEADER: "not-the-real-token"},
        json={"name": "forge-runner-a-b", "mechanism": NSSM, "action": "restart"},
    )
    assert res.status_code == 403


def test_mutation_with_valid_token_is_accepted(loopback_client, monkeypatch):
    """The happy path: loopback Host+Origin AND the valid per-session token — the
    request reaches the (monkeypatched) core."""
    called: dict = {}

    def fake_control(entry: RunnerEntry, action: str):
        called["action"] = action
        return ActionResult(
            action=action,
            name=entry.name,
            mechanism=entry.mechanism,
            ok=True,
            elevated=False,
            message="ok",
        )

    monkeypatch.setattr(server, "control", fake_control)
    res = loopback_client.post(
        "/api/control",
        headers=TOKEN_HEADERS,
        json={"name": "forge-runner-a-b", "mechanism": NSSM, "action": "restart"},
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert called["action"] == "restart"


def test_provision_mutation_requires_token(loopback_client):
    res = loopback_client.post(
        "/api/provision",
        json={"action": "install", "owner": "o", "repo": "r"},
    )
    assert res.status_code == 403


# --------------------------------------------------------------------------- #
# Unit coverage of the pure host/origin helpers.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "host,ok",
    [
        ("127.0.0.1:8765", True),
        ("localhost:8765", True),
        ("[::1]:8765", True),
        ("127.0.0.1", True),  # no port -> hostname check still passes
        ("evil.example", False),
        ("evil.example:8765", False),
        ("127.0.0.1:9999", False),  # wrong port
        ("", False),
        (None, False),
    ],
)
def test_host_is_allowed(host, ok):
    assert security.host_is_allowed(host, 8765) is ok


@pytest.mark.parametrize(
    "origin,ok",
    [
        ("http://127.0.0.1:8765", True),
        ("http://localhost:8765", True),
        ("https://127.0.0.1:8765", True),
        ("http://[::1]:8765", True),
        ("http://evil.example", False),
        ("http://127.0.0.1:9999", False),
        ("null", False),
        ("file://", False),
        ("", False),
        (None, False),
    ],
)
def test_origin_is_allowed(origin, ok):
    assert security.origin_is_allowed(origin, 8765) is ok


def test_mint_session_token_is_unguessable_and_unique():
    a, b = security.mint_session_token(), security.mint_session_token()
    assert a != b
    assert len(a) >= 32
