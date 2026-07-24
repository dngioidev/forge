"""Unit tests for the fleet discovery + status core (ticket #264).

Hermetic by construction: every shell-out seam (``sc query`` / ``systemctl`` /
``docker ps`` / ``gh api``) is replaced with a fake that returns captured, real-
shaped fixture output — no live service, WSL, docker, or network is ever touched.

The fixtures below are trimmed from REAL output captured on the runner host
(2026-07-24/25): ``sc query type= service state= all``, ``wsl.exe -- systemctl
--user list-units 'forge-runner*' ...``, ``wsl.exe -- docker ps --format '{{json
.}}'``, and ``gh api repos/<owner>/<repo>/actions/runners``.

The suite locks in the ACs: name-based target resolution incl. the legacy bare
name (AC2), tolerance when a mechanism is absent (AC1), the gh cross-ref incl. the
error path (AC3), the normalized model (AC4), and — the non-negotiable — that
NOTHING reads the runner env or a secret store.
"""

from __future__ import annotations

import subprocess

import pytest

from forge_cockpit import discovery
from forge_cockpit.discovery import (
    DOCKER,
    NSSM,
    SYSTEMD,
    OnlineStatus,
    Target,
    cross_reference_online,
    discover_docker_runners,
    discover_fleet,
    discover_systemd_units,
    discover_windows_services,
    parse_target,
)
from forge_cockpit.shellout import CommandResult, RunnerEnvAccessError

# --------------------------------------------------------------------------- #
# Captured, real-shaped fixtures.
# --------------------------------------------------------------------------- #
# `sc query type= service state= all` — two repo-scoped services, the legacy bare
# `forge-runner` (STOPPED), and an unrelated service that must be filtered out.
SC_QUERY_OUTPUT = """
SERVICE_NAME: Dhcp
DISPLAY_NAME: DHCP Client
        TYPE               : 20  WIN32_SHARE_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)

SERVICE_NAME: forge-runner
DISPLAY_NAME: forge-runner
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 1  STOPPED
                                (NOT_STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)

SERVICE_NAME: forge-runner-dngioidev-forge
DISPLAY_NAME: forge-runner-dngioidev-forge
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)

SERVICE_NAME: forge-runner-dngioidev-iomanage
DISPLAY_NAME: forge-runner-dngioidev-iomanage
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
"""

# `systemctl --user list-units 'forge-runner*' --type=service --all --no-legend`
SYSTEMD_OUTPUT = (
    "  forge-runner-dngioidev-iomanage.service loaded active running "
    "forge local self-hosted runner supervisor (dngioidev/iomanage)\n"
    "  forge-runner.service                    loaded active running "
    "forge local self-hosted runner supervisor (JIT + ephemeral)\n"
)

# `docker ps --all --no-trunc --format '{{json .}}'` — two ephemeral job
# containers plus an unrelated container that must be filtered out.
DOCKER_OUTPUT = (
    '{"ID":"738781cd78aa","Image":"forge-local-runner:latest",'
    '"Names":"linux-runner-run-ddffb1f3d7f6","State":"running","Status":"Up 20 seconds"}\n'
    '{"ID":"93f9657dfc14","Image":"forge-local-runner:latest",'
    '"Names":"linux-runner-run-fc3b9e484668","State":"exited","Status":"Exited (0) 3 minutes ago"}\n'
    '{"ID":"aaaa1111bbbb","Image":"postgres:16",'
    '"Names":"some-db","State":"running","Status":"Up 2 hours"}\n'
)

# `gh api repos/dngioidev/forge/actions/runners` — 1 online, 2 offline.
GH_RUNNERS_JSON = (
    '{"total_count":3,"runners":['
    '{"id":329,"name":"forge-local-1","os":"linux","status":"online","busy":true},'
    '{"id":309,"name":"forge-local-2","os":"windows","status":"offline","busy":false},'
    '{"id":265,"name":"forge-local-3","os":"windows","status":"offline","busy":false}]}'
)


def _result(argv, *, rc=0, out="", err="") -> CommandResult:
    return CommandResult(argv=tuple(argv), returncode=rc, stdout=out, stderr=err)


class FakeShell:
    """Records every argv and answers by matching the leading tokens to fixtures."""

    def __init__(self, *, sc=SC_QUERY_OUTPUT, systemd=SYSTEMD_OUTPUT, docker=DOCKER_OUTPUT,
                 gh=GH_RUNNERS_JSON, wsl_up=True):
        self.sc, self.systemd, self.docker, self.gh = sc, systemd, docker, gh
        self.wsl_up = wsl_up
        self.calls: list[list[str]] = []

    def wsl_available(self) -> bool:
        return self.wsl_up

    def run(self, argv, **kwargs) -> CommandResult:
        self.calls.append(list(argv))
        if argv[:2] == ["sc", "query"]:
            return _result(argv, out=self.sc)
        if argv[:2] == ["gh", "api"]:
            return _result(argv, out=self.gh)
        if argv[0] == "docker":
            return _result(argv, out=self.docker)
        raise AssertionError(f"unexpected run() argv: {argv!r}")

    def wsl(self, argv, **kwargs) -> CommandResult:
        self.calls.append(["wsl.exe", "--", *argv])
        if argv[0] == "systemctl":
            return _result(argv, out=self.systemd)
        if argv[0] == "docker":
            return _result(argv, out=self.docker)
        raise AssertionError(f"unexpected wsl() argv: {argv!r}")


# --------------------------------------------------------------------------- #
# AC2 — target resolution from the NAME only (incl. the legacy bare name).
# --------------------------------------------------------------------------- #
def test_parse_target_repo_scoped_name():
    t = parse_target("forge-runner-dngioidev-forge")
    assert (t.owner, t.repo) == ("dngioidev", "forge")
    assert t.known and t.slug == "dngioidev/forge"


def test_parse_target_strips_dot_service_suffix():
    t = parse_target("forge-runner-dngioidev-iomanage.service")
    assert (t.owner, t.repo) == ("dngioidev", "iomanage")


@pytest.mark.parametrize("name", ["forge-runner", "forge-runner.service"])
def test_parse_target_legacy_bare_is_unknown(name):
    t = parse_target(name)
    assert not t.known
    assert t.owner is None and t.repo is None
    assert t.slug == "unknown/legacy"


def test_parse_target_hyphenated_repo_keeps_remainder():
    # owner = first token, repo = the rest (so hyphenated repos survive).
    t = parse_target("forge-runner-acme-my-cool-repo")
    assert (t.owner, t.repo) == ("acme", "my-cool-repo")


@pytest.mark.parametrize("name", ["linux-runner-run-ddffb1f3d7f6", "some-db", "forge-runner-"])
def test_parse_target_non_matching_is_unknown(name):
    assert parse_target(name) == Target(None, None)


# --------------------------------------------------------------------------- #
# AC1 — Windows NSSM discovery + tolerance.
# --------------------------------------------------------------------------- #
def test_discover_windows_parses_state_and_filters_non_forge():
    shell = FakeShell()
    entries = discover_windows_services(runner=shell.run)

    names = {e.name for e in entries}
    assert names == {
        "forge-runner",
        "forge-runner-dngioidev-forge",
        "forge-runner-dngioidev-iomanage",
    }  # Dhcp filtered out
    assert all(e.mechanism == NSSM for e in entries)

    by_name = {e.name: e for e in entries}
    assert by_name["forge-runner-dngioidev-forge"].service_state == "running"
    assert by_name["forge-runner"].service_state == "stopped"
    # legacy bare name -> unknown target
    assert by_name["forge-runner"].target.slug == "unknown/legacy"
    assert by_name["forge-runner-dngioidev-iomanage"].target.slug == "dngioidev/iomanage"


def test_discover_windows_absent_sc_yields_empty():
    def missing(argv, **kw):
        raise FileNotFoundError("sc not found")

    assert discover_windows_services(runner=missing) == []


def test_discover_windows_nonzero_yields_empty():
    assert discover_windows_services(runner=lambda a, **k: _result(a, rc=1, err="boom")) == []


# --------------------------------------------------------------------------- #
# AC1 — Linux systemd discovery + tolerance (no WSL).
# --------------------------------------------------------------------------- #
def test_discover_systemd_parses_units():
    shell = FakeShell()
    entries = discover_systemd_units(wsl_runner=shell.wsl, wsl_available=shell.wsl_available)

    by_name = {e.name: e for e in entries}
    assert set(by_name) == {
        "forge-runner-dngioidev-iomanage.service",
        "forge-runner.service",
    }
    assert all(e.mechanism == SYSTEMD for e in entries)
    assert by_name["forge-runner-dngioidev-iomanage.service"].service_state == "running"
    assert by_name["forge-runner-dngioidev-iomanage.service"].target.slug == "dngioidev/iomanage"
    assert by_name["forge-runner.service"].target.slug == "unknown/legacy"


def test_discover_systemd_absent_when_no_wsl_never_shells_out():
    called = False

    def wsl_runner(argv, **kw):
        nonlocal called
        called = True
        raise AssertionError("must not shell out to WSL when it is unavailable")

    entries = discover_systemd_units(wsl_runner=wsl_runner, wsl_available=lambda: False)
    assert entries == []
    assert called is False


def test_discover_systemd_tolerates_shell_error():
    def boom(argv, **kw):
        raise subprocess.SubprocessError("wsl exploded")

    entries = discover_systemd_units(wsl_runner=boom, wsl_available=lambda: True)
    assert entries == []


# --------------------------------------------------------------------------- #
# AC1 — Docker discovery + tolerance.
# --------------------------------------------------------------------------- #
def test_discover_docker_filters_to_runner_containers():
    shell = FakeShell()
    entries = discover_docker_runners(
        runner=shell.run, wsl_runner=shell.wsl, wsl_available=shell.wsl_available
    )

    names = {e.name for e in entries}
    assert names == {"linux-runner-run-ddffb1f3d7f6", "linux-runner-run-fc3b9e484668"}  # db dropped
    assert all(e.mechanism == DOCKER for e in entries)
    assert all(e.target.slug == "unknown/legacy" for e in entries)  # job names carry no owner/repo

    by_name = {e.name: e for e in entries}
    assert by_name["linux-runner-run-ddffb1f3d7f6"].service_state == "running"
    assert by_name["linux-runner-run-fc3b9e484668"].service_state == "exited"


def test_discover_docker_routes_over_wsl_when_present():
    shell = FakeShell(wsl_up=True)
    discover_docker_runners(
        runner=shell.run, wsl_runner=shell.wsl, wsl_available=shell.wsl_available
    )
    assert shell.calls == [["wsl.exe", "--", "docker", "ps", "--all", "--no-trunc", "--format", "{{json .}}"]]


def test_discover_docker_absent_yields_empty():
    def missing(argv, **kw):
        raise FileNotFoundError("docker not found")

    entries = discover_docker_runners(
        runner=missing, wsl_runner=missing, wsl_available=lambda: False
    )
    assert entries == []


# --------------------------------------------------------------------------- #
# AC3 — GitHub online-runner cross-reference incl. the error path.
# --------------------------------------------------------------------------- #
def test_cross_reference_counts_online_offline():
    shell = FakeShell()
    counts = cross_reference_online([Target("dngioidev", "forge")], gh_runner=shell.run)
    status = counts["dngioidev/forge"]
    assert status.known
    assert (status.online, status.offline, status.total) == (1, 2, 3)


def test_cross_reference_gh_error_marks_unknown():
    counts = cross_reference_online(
        [Target("dngioidev", "forge")],
        gh_runner=lambda a, **k: _result(a, rc=1, err="gh: not authenticated"),
    )
    status = counts["dngioidev/forge"]
    assert status.known is False
    assert status.online is None and status.total is None


def test_cross_reference_bad_json_marks_unknown():
    counts = cross_reference_online(
        [Target("dngioidev", "forge")],
        gh_runner=lambda a, **k: _result(a, out="<html>not json</html>"),
    )
    assert counts["dngioidev/forge"] == OnlineStatus.unknown()


def test_cross_reference_skips_unknown_targets_and_dedupes():
    seen: list[list[str]] = []

    def gh(argv, **kw):
        seen.append(list(argv))
        return _result(argv, out=GH_RUNNERS_JSON)

    counts = cross_reference_online(
        [Target("dngioidev", "forge"), Target("dngioidev", "forge"), Target(None, None)],
        gh_runner=gh,
    )
    assert set(counts) == {"dngioidev/forge"}  # unknown target skipped
    assert len(seen) == 1  # queried once despite the duplicate


def test_cross_reference_tolerates_raised_error():
    def boom(argv, **kw):
        raise OSError("gh missing")

    counts = cross_reference_online([Target("dngioidev", "forge")], gh_runner=boom)
    assert counts["dngioidev/forge"] == OnlineStatus.unknown()


# --------------------------------------------------------------------------- #
# AC4 — the normalized fleet model, end to end.
# --------------------------------------------------------------------------- #
def test_discover_fleet_normalizes_and_attaches_counts():
    shell = FakeShell()
    fleet = discover_fleet(
        runner=shell.run,
        wsl_runner=shell.wsl,
        wsl_available=shell.wsl_available,
        gh_runner=shell.run,
    )

    # 3 nssm + 2 systemd + 2 docker = 7 normalized entries.
    assert len(fleet.runners) == 7
    mechanisms = sorted(e.mechanism for e in fleet.runners)
    assert mechanisms == [DOCKER, DOCKER, NSSM, NSSM, NSSM, SYSTEMD, SYSTEMD]

    # Known repos got the gh online count attached (1 online from the fixture)…
    forge_entries = [e for e in fleet.runners if e.repo == "dngioidev/forge"]
    assert forge_entries and all(e.online.known and e.online_count == 1 for e in forge_entries)

    # …docker + legacy (unknown target) stay unknown, never crash.
    unknowns = [e for e in fleet.runners if e.repo == "unknown/legacy"]
    assert unknowns and all(not e.online.known and e.online_count is None for e in unknowns)


def test_discover_fleet_cross_refs_each_repo_once():
    shell = FakeShell()
    discover_fleet(
        runner=shell.run, wsl_runner=shell.wsl,
        wsl_available=shell.wsl_available, gh_runner=shell.run,
    )
    gh_calls = [c for c in shell.calls if c[:2] == ["gh", "api"]]
    # forge appears in nssm+systemd, iomanage in nssm+systemd -> still 2 gh calls.
    assert len(gh_calls) == 2
    repos = sorted(c[2] for c in gh_calls)
    assert repos == [
        "repos/dngioidev/forge/actions/runners?per_page=100",
        "repos/dngioidev/iomanage/actions/runners?per_page=100",
    ]


def test_discover_fleet_fully_tolerant_when_everything_absent():
    def missing(argv, **kw):
        raise FileNotFoundError("nothing installed")

    fleet = discover_fleet(
        runner=missing, wsl_runner=missing, wsl_available=lambda: False, gh_runner=missing
    )
    assert fleet.runners == ()  # empty, not a crash


# --------------------------------------------------------------------------- #
# Security invariant — never reads the PAT / runner.env, never a secret store.
# --------------------------------------------------------------------------- #
def test_no_command_touches_runner_env_or_service_environment():
    shell = FakeShell()
    discover_fleet(
        runner=shell.run, wsl_runner=shell.wsl,
        wsl_available=shell.wsl_available, gh_runner=shell.run,
    )
    assert shell.calls, "expected some commands to have run"

    forbidden = ("runner.env", "environment", "appenvironmentextra", "qc", "cat", "inspect", "show")
    for argv in shell.calls:
        joined = " ".join(argv).lower()
        for needle in forbidden:
            assert needle not in joined, f"command must not reference {needle!r}: {argv!r}"


def test_real_shellout_would_refuse_a_runner_env_argv():
    # Backstop: the shared helper hard-refuses any runner.env path, so even a
    # regression that built such an argv could never actually read the secret.
    from forge_cockpit import shellout

    with pytest.raises(RunnerEnvAccessError):
        shellout.run(["cat", "/home/me/.forge/runner.env"])
