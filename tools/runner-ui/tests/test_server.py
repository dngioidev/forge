"""Tests for the Cockpit v2 localhost backend (ticket #351, ADR-0008).

These lock the HTTP surface to its contract (AC.4): each endpoint calls its core
UNCHANGED and returns that core's data, the server binds **127.0.0.1 only** (never
``0.0.0.0``), and the ADR-0006 security invariants survive the HTTP layer
(PAT-free, ``runner.env`` never read, usage metadata-only — AC.2).

Hermetic + headless: the cores are monkeypatched at the server module boundary to
return canned typed results, so no test shells out (``sc``/``gh``/``wsl``) or
reads the real ``~/.claude`` transcripts. The one seam left real is the usage
aggregation, exercised on canned records to prove the endpoint wires it up.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from forge_cockpit import security, server
from forge_cockpit.control import ActionResult
from forge_cockpit.discovery import (
    DOCKER,
    NSSM,
    SYSTEMD,
    Fleet,
    OnlineStatus,
    RunnerEntry,
    Target,
)
from forge_cockpit.logs import LogRead
from forge_cockpit.machine import MachineSnapshot
from forge_cockpit.provision import ProvisionResult
from forge_cockpit.usage import UsageRecord


@pytest.fixture
def client() -> TestClient:
    """A TestClient that speaks from the real loopback origin with a valid token.

    #352 hardened the surface: requests now need a loopback ``Host``/``Origin`` and
    mutations need the per-session capability token. Baking those defaults into the
    fixture lets the #351 endpoint-contract tests below keep asserting exactly what
    they asserted before — the hardening is exercised on its own in test_security.py.
    """
    base = f"http://127.0.0.1:{server.DEFAULT_PORT}"
    c = TestClient(server.app, base_url=base)
    c.headers.update(
        {
            "Origin": base,
            security.CSRF_HEADER: server.app.state.session_token,
        }
    )
    return c


# --------------------------------------------------------------------------- #
# AC.4 / AC.1 — the loopback bind (never 0.0.0.0).
# --------------------------------------------------------------------------- #
def test_host_constant_is_loopback_only():
    assert server.HOST == "127.0.0.1"
    assert server.HOST != "0.0.0.0"


def test_build_config_binds_loopback_not_all_interfaces():
    config = server.build_config()
    assert config.host == "127.0.0.1"
    # The whole point of AC.1: NEVER bound to every interface.
    assert config.host != "0.0.0.0"


def test_build_config_host_is_not_overridable_to_all_interfaces_by_default():
    # Default call never yields a world-reachable bind; an explicit override is a
    # caller's choice, but the default that main() uses is loopback.
    assert server.build_config(port=9999).host == "127.0.0.1"


# --------------------------------------------------------------------------- #
# AC.1 — /api/health liveness.
# --------------------------------------------------------------------------- #
def test_health_ok(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "forge-cockpit"}


# --------------------------------------------------------------------------- #
# AC.1 — /api/fleet returns discover_fleet()'s data.
# --------------------------------------------------------------------------- #
def test_fleet_endpoint_returns_discovery_data(client, monkeypatch):
    fleet = Fleet(
        runners=(
            RunnerEntry(
                name="forge-runner-dngioidev-forge",
                mechanism=NSSM,
                service_state="running",
                target=Target(owner="dngioidev", repo="forge"),
                online=OnlineStatus(online=2, offline=0, total=2, known=True),
            ),
            RunnerEntry(
                name="runner-run-abc",
                mechanism=DOCKER,
                service_state="exited",
                target=Target(owner=None, repo=None),
                online=OnlineStatus.unknown(),
            ),
        )
    )
    monkeypatch.setattr(server.discovery, "discover_fleet", lambda: fleet)

    body = client.get("/api/fleet").json()
    assert [r["name"] for r in body["runners"]] == [
        "forge-runner-dngioidev-forge",
        "runner-run-abc",
    ]
    first = body["runners"][0]
    assert first["mechanism"] == "nssm"
    assert first["service_state"] == "running"
    assert first["target"] == {
        "owner": "dngioidev",
        "repo": "forge",
        "known": True,
        "slug": "dngioidev/forge",
    }
    assert first["online"] == {"online": 2, "offline": 0, "total": 2, "known": True}
    assert first["online_count"] == 2
    assert first["repo"] == "dngioidev/forge"
    # The docker job entry keeps the unknown target/online sentinels.
    assert body["runners"][1]["repo"] == "unknown/legacy"
    assert body["runners"][1]["online"]["known"] is False


# --------------------------------------------------------------------------- #
# AC.1 — /api/control drives control() (start/stop/restart).
# --------------------------------------------------------------------------- #
def test_control_endpoint_returns_action_result(client, monkeypatch):
    captured: dict = {}

    def fake_control(entry: RunnerEntry, action: str):
        captured["name"] = entry.name
        captured["mechanism"] = entry.mechanism
        captured["action"] = action
        return ActionResult(
            action=action,
            name=entry.name,
            mechanism=entry.mechanism,
            ok=True,
            elevated=False,
            message="Restart succeeded for systemd --user unit.",
        )

    monkeypatch.setattr(server, "control", fake_control)

    res = client.post(
        "/api/control",
        json={"name": "forge-runner-a-b", "mechanism": SYSTEMD, "action": "restart"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["action"] == "restart"
    assert body["message"].startswith("Restart succeeded")
    # The core was called with the request's name/mechanism/action.
    assert captured == {"name": "forge-runner-a-b", "mechanism": "systemd", "action": "restart"}


def test_control_rejects_unknown_action(client):
    res = client.post(
        "/api/control",
        json={"name": "forge-runner-a-b", "mechanism": NSSM, "action": "obliterate"},
    )
    assert res.status_code == 422


# --------------------------------------------------------------------------- #
# AC.1 — /api/logs drives read_logs().
# --------------------------------------------------------------------------- #
def test_logs_endpoint_returns_logread(client, monkeypatch):
    captured: dict = {}

    def fake_read_logs(entry: RunnerEntry, *, lines: int):
        captured["name"] = entry.name
        captured["mechanism"] = entry.mechanism
        captured["lines"] = lines
        return LogRead(ok=True, text="line1\nline2", source="journalctl --user -u forge-runner-a-b")

    monkeypatch.setattr(server, "read_logs", fake_read_logs)

    res = client.get(
        "/api/logs",
        params={"name": "forge-runner-a-b", "mechanism": SYSTEMD, "lines": 50},
    )
    assert res.status_code == 200
    body = res.json()
    assert body == {
        "ok": True,
        "text": "line1\nline2",
        "source": "journalctl --user -u forge-runner-a-b",
    }
    assert captured == {"name": "forge-runner-a-b", "mechanism": "systemd", "lines": 50}


def test_logs_default_lines(client, monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(
        server,
        "read_logs",
        lambda entry, *, lines: seen.update(lines=lines)
        or LogRead(ok=True, text="", source="s"),
    )
    client.get("/api/logs", params={"name": "n", "mechanism": NSSM})
    assert seen["lines"] == server.DEFAULT_TAIL_LINES


# --------------------------------------------------------------------------- #
# AC.1 — /api/provision drives provision(); AC.2/AC.3 — never handles the PAT.
# --------------------------------------------------------------------------- #
def test_provision_endpoint_returns_result(client, monkeypatch):
    captured: dict = {}

    def fake_provision(action, owner, repo, *, platform=None, force=False, **kwargs):
        captured.update(action=action, owner=owner, repo=repo, platform=platform, force=force)
        return ProvisionResult(
            action=action,
            platform=platform or "linux",
            name=f"forge-runner-{owner}-{repo}",
            owner=owner,
            repo=repo,
            ok=True,
            elevated=False,
            message="Install succeeded.",
        )

    monkeypatch.setattr(server, "provision", fake_provision)

    res = client.post(
        "/api/provision",
        json={"action": "install", "owner": "dngioidev", "repo": "forge", "platform": "linux"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["name"] == "forge-runner-dngioidev-forge"
    assert captured == {
        "action": "install",
        "owner": "dngioidev",
        "repo": "forge",
        "platform": "linux",
        "force": False,
    }


def test_provision_rejects_unknown_action(client):
    res = client.post(
        "/api/provision",
        json={"action": "nuke", "owner": "o", "repo": "r"},
    )
    assert res.status_code == 422


def test_provision_rejects_unknown_platform(client):
    res = client.post(
        "/api/provision",
        json={"action": "install", "owner": "o", "repo": "r", "platform": "solaris"},
    )
    assert res.status_code == 422


def test_provision_request_never_accepts_a_token_field(client, monkeypatch):
    """AC.2/AC.3: the PAT is out of band. Even if a client tries to smuggle a
    token in the body, it is ignored — it never reaches the core."""
    captured: dict = {}
    monkeypatch.setattr(
        server,
        "provision",
        lambda action, owner, repo, **kw: captured.update(kw=kw)
        or ProvisionResult(action, "linux", "n", owner, repo, True, False, "ok"),
    )
    client.post(
        "/api/provision",
        json={
            "action": "install",
            "owner": "o",
            "repo": "r",
            "token": "ghp_SHOULD_BE_IGNORED",  # not a model field
        },
    )
    # The unknown 'token' field never becomes a provision() kwarg.
    assert "token" not in captured["kw"]


# --------------------------------------------------------------------------- #
# AC.1 — /api/usage drives collect_usage(); AC.2 — metadata only, no content.
# --------------------------------------------------------------------------- #
def test_usage_endpoint_returns_records_and_aggregates(client, monkeypatch):
    records = [
        UsageRecord(
            session_id="s1",
            model="claude-opus-4-8",
            timestamp=datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc),
            input_tokens=1_000_000,
            output_tokens=500_000,
            cache_read_tokens=0,
            cache_creation_tokens=0,
        ),
    ]
    monkeypatch.setattr(server, "collect_usage", lambda: records)

    body = client.get("/api/usage").json()

    assert len(body["records"]) == 1
    rec = body["records"][0]
    assert rec["session_id"] == "s1"
    assert rec["model"] == "claude-opus-4-8"
    assert rec["input_tokens"] == 1_000_000
    assert rec["total_tokens"] == 1_500_000
    assert rec["timestamp"] == "2026-08-03T12:00:00+00:00"

    # Aggregations are wired up and priced (opus: $5 in / $25 out per 1M).
    by_model = body["by_model"]["claude-opus-4-8"]
    assert by_model["turns"] == 1
    assert by_model["total_cost"] == pytest.approx(5.0 + 12.5)  # 1M*$5 + 0.5M*$25
    assert body["by_session"]["s1"]["turns"] == 1
    assert body["by_day"]["2026-08-03"]["turns"] == 1


def test_machine_endpoint_returns_snapshot(client, monkeypatch):
    """#395 — GET /api/machine wires :func:`machine.snapshot` unchanged to JSON."""
    snap = MachineSnapshot(
        cpu_percent=42.5,
        memory_percent=61.0,
        memory_used_bytes=8_000_000_000,
        memory_total_bytes=16_000_000_000,
        disk_percent=73.2,
        disk_used_bytes=300_000_000_000,
        disk_total_bytes=500_000_000_000,
    )
    monkeypatch.setattr(server.machine, "snapshot", lambda: snap)

    body = client.get("/api/machine").json()

    assert body == {
        "cpu_percent": 42.5,
        "memory_percent": 61.0,
        "memory_used_bytes": 8_000_000_000,
        "memory_total_bytes": 16_000_000_000,
        "disk_percent": 73.2,
        "disk_used_bytes": 300_000_000_000,
        "disk_total_bytes": 500_000_000_000,
    }


def test_usage_response_is_metadata_only_no_content_fields(client, monkeypatch):
    """AC.2: the usage surface exposes token/cost metadata only — there is nowhere
    for prompt/response CONTENT to appear (ADR-0006 privacy invariant)."""
    records = [
        UsageRecord(
            session_id="s1",
            model="claude-opus-4-8",
            timestamp=None,
            input_tokens=10,
            output_tokens=20,
            cache_read_tokens=0,
            cache_creation_tokens=0,
        ),
    ]
    monkeypatch.setattr(server, "collect_usage", lambda: records)

    rec = client.get("/api/usage").json()["records"][0]
    allowed = {
        "session_id",
        "model",
        "timestamp",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "total_tokens",
    }
    assert set(rec) == allowed
    # No content-bearing keys leaked into the surface.
    for banned in ("content", "message", "text", "prompt", "response"):
        assert banned not in rec


# --------------------------------------------------------------------------- #
# AC.2 — no endpoint carries a PAT / secret field anywhere in its response.
# --------------------------------------------------------------------------- #
def test_no_endpoint_response_mentions_a_pat_or_secret(client, monkeypatch):
    monkeypatch.setattr(server.discovery, "discover_fleet", lambda: Fleet(runners=()))
    monkeypatch.setattr(server, "collect_usage", lambda: [])

    for path in ("/api/health", "/api/fleet", "/api/usage"):
        text = client.get(path).text.lower()
        for banned in ("runner.env", "ghp_", "github_pat", "forge_runner_pat"):
            assert banned not in text
