"""Tests for runner control actions (ticket #266, AC1 + AC3).

Hermetic: every shell-out / elevation seam is a fake, so no service, WSL, or UAC
prompt is touched. The suite locks:

* AC1 — start/stop/restart issue the correct argv per mechanism (``nssm ...`` for a
  Windows NSSM service, ``systemctl --user ...`` over WSL for a Linux unit) and
  surface BOTH success and failure.
* AC3 — an NSSM mutation while NOT elevated routes through the explicit UAC
  elevation seam (never the direct runner); a declined/failed elevation yields a
  clear "run elevated" message, never a silent no-op. systemd needs no elevation.
"""

from __future__ import annotations

import pytest

from forge_cockpit import control
from forge_cockpit.control import ActionResult, control as run_control, elevate_run, is_elevated
from forge_cockpit.discovery import (
    DOCKER,
    NSSM,
    SYSTEMD,
    OnlineStatus,
    RunnerEntry,
    Target,
    UNKNOWN_TARGET,
)
from forge_cockpit.shellout import CommandResult


def _entry(mechanism: str, name: str = "forge-runner-acme-widgets") -> RunnerEntry:
    return RunnerEntry(
        name=name,
        mechanism=mechanism,
        service_state="running",
        target=Target("acme", "widgets") if mechanism != DOCKER else UNKNOWN_TARGET,
        online=OnlineStatus.unknown(),
    )


def _result(argv, rc=0, out="", err="") -> CommandResult:
    return CommandResult(argv=tuple(argv), returncode=rc, stdout=out, stderr=err)


class _Recorder:
    """A fake runner/elevator that records argv and returns a canned result."""

    def __init__(self, rc: int = 0, out: str = "", err: str = "") -> None:
        self.calls: list[list[str]] = []
        self._rc, self._out, self._err = rc, out, err

    def __call__(self, argv, **_kw) -> CommandResult:
        self.calls.append(list(argv))
        return _result(argv, self._rc, self._out, self._err)


# --------------------------------------------------------------------------- #
# systemd --user (AC1 Linux, no elevation).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("action", [control.START, control.STOP, control.RESTART])
def test_systemd_issues_systemctl_user_argv_over_wsl(action):
    wsl = _Recorder(rc=0)
    admin = _Recorder()  # should never run for systemd
    res = run_control(
        _entry(SYSTEMD, "forge-runner-acme-tools"),
        action,
        runner=admin,
        wsl_runner=wsl,
        is_admin=lambda: False,
        elevate=admin,
    )
    assert wsl.calls == [["systemctl", "--user", action, "forge-runner-acme-tools"]]
    assert admin.calls == []  # no elevation, no direct windows runner
    assert res.ok is True and res.elevated is False
    assert res.mechanism == SYSTEMD


def test_systemd_failure_is_surfaced_not_raised():
    wsl = _Recorder(rc=1, err="Failed to start unit: not loaded")
    res = run_control(
        _entry(SYSTEMD),
        control.START,
        wsl_runner=wsl,
        is_admin=lambda: True,
    )
    assert res.ok is False
    assert "not loaded" in res.message
    assert res.action == control.START


# --------------------------------------------------------------------------- #
# NSSM while ALREADY admin (AC1 Windows, direct — no elevation).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("action", [control.START, control.STOP, control.RESTART])
def test_nssm_admin_runs_directly_without_elevation(action):
    runner = _Recorder(rc=0)
    elevate = _Recorder(rc=0)
    res = run_control(
        _entry(NSSM),
        action,
        runner=runner,
        is_admin=lambda: True,
        elevate=elevate,
    )
    assert runner.calls == [["nssm", action, "forge-runner-acme-widgets"]]
    assert elevate.calls == []  # already admin -> never elevates
    assert res.ok is True and res.elevated is False


def test_nssm_admin_failure_surfaces_detail():
    runner = _Recorder(rc=2, err="Can't open service!")
    res = run_control(_entry(NSSM), control.STOP, runner=runner, is_admin=lambda: True)
    assert res.ok is False
    assert "Can't open service!" in res.message


# --------------------------------------------------------------------------- #
# NSSM while NOT admin (AC3 — explicit elevation, never a silent no-op).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("action", [control.START, control.STOP, control.RESTART])
def test_nssm_non_admin_routes_through_elevation(action):
    runner = _Recorder(rc=0)  # must NOT be used
    elevate = _Recorder(rc=0)
    res = run_control(
        _entry(NSSM),
        action,
        runner=runner,
        is_admin=lambda: False,
        elevate=elevate,
    )
    assert runner.calls == []  # never runs the mutation un-elevated
    assert elevate.calls == [["nssm", action, "forge-runner-acme-widgets"]]
    assert res.ok is True and res.elevated is True
    assert "elevated" in res.message.lower()


def test_nssm_declined_elevation_gives_clear_message_not_silent_noop():
    runner = _Recorder(rc=0)
    # 1223 == ERROR_CANCELLED: the UAC prompt was declined.
    elevate = _Recorder(rc=1223)
    res = run_control(
        _entry(NSSM),
        control.RESTART,
        runner=runner,
        is_admin=lambda: False,
        elevate=elevate,
    )
    assert runner.calls == []
    assert elevate.calls == [["nssm", "restart", "forge-runner-acme-widgets"]]
    # Failure surfaced with an explicit "run elevated" message — never a no-op.
    assert res.ok is False and res.elevated is True
    assert res.message  # non-empty
    assert "administrator" in res.message.lower()
    assert "1223" in res.message


# --------------------------------------------------------------------------- #
# Docker + bad action.
# --------------------------------------------------------------------------- #
def test_docker_job_container_is_unsupported_with_clear_message():
    runner = _Recorder()
    res = run_control(_entry(DOCKER, "runner-run-abc123"), control.START, runner=runner)
    assert res.ok is False
    assert "docker" in res.message.lower()
    assert runner.calls == []  # nothing shelled out


def test_unknown_action_raises():
    with pytest.raises(ValueError):
        run_control(_entry(NSSM), "pause")


# --------------------------------------------------------------------------- #
# elevate_run helper — builds a UAC 'runas' PowerShell launcher (AC3).
# --------------------------------------------------------------------------- #
def test_elevate_run_builds_runas_powershell():
    captured: list[list[str]] = []

    def fake_runner(argv, **_kw) -> CommandResult:
        captured.append(list(argv))
        return _result(argv, 0)

    elevate_run(["nssm", "start", "forge-runner-acme-widgets"], runner=fake_runner)

    (argv,) = captured
    assert argv[0] == "powershell"
    script = argv[-1]
    assert "Start-Process" in script
    assert "-Verb RunAs" in script
    assert "-Wait" in script and "-PassThru" in script
    # The service name is passed as an argument, single-quoted.
    assert "'forge-runner-acme-widgets'" in script
    # A declined prompt maps to the cancelled exit code.
    assert "1223" in script


def test_elevate_run_rejects_empty_argv():
    with pytest.raises(ValueError):
        elevate_run([])


def test_is_elevated_true_off_windows(monkeypatch):
    monkeypatch.setattr(control.os, "name", "posix")
    assert is_elevated() is True
