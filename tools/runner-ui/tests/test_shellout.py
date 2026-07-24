"""Unit tests for the shell-out + WSL interop helper (ADR-0006 Decision 4).

These lock in the security invariants: argv is always a list, ``shell=True`` is
never used, WSL calls are prefixed with ``wsl.exe --``, and nothing the helper
runs ever touches the ``runner.env`` PAT store.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from forge_cockpit import shellout
from forge_cockpit.shellout import (
    CommandResult,
    RunnerEnvAccessError,
    run,
    wsl,
)


@pytest.fixture
def capture_subprocess(monkeypatch):
    """Replace ``subprocess.run`` with a spy that records the call and returns a stub."""
    calls: list[dict] = []

    def fake_run(argv, **kwargs):
        calls.append({"argv": argv, "kwargs": kwargs})
        return SimpleNamespace(returncode=0, stdout="out", stderr="err")

    monkeypatch.setattr(shellout.subprocess, "run", fake_run)
    return calls


def test_run_passes_argv_as_list_never_shell(capture_subprocess):
    result = run(["sc", "query", "forge-runner-dngioidev-forge"])

    assert isinstance(result, CommandResult)
    assert result.ok and result.returncode == 0
    assert result.stdout == "out" and result.stderr == "err"

    (call,) = capture_subprocess
    # argv reaches subprocess as the exact list we passed…
    assert call["argv"] == ["sc", "query", "forge-runner-dngioidev-forge"]
    assert isinstance(call["argv"], list)
    # …and shell=False is explicit — never shell=True.
    assert call["kwargs"]["shell"] is False


def test_run_rejects_string_argv():
    with pytest.raises(TypeError):
        run("sc query forge-runner")  # type: ignore[arg-type]


def test_run_rejects_empty_argv():
    with pytest.raises(TypeError):
        run([])


def test_wsl_prefixes_wslexe_and_dashes(capture_subprocess):
    wsl(["systemctl", "--user", "status", "forge-runner-dngioidev-forge"])

    (call,) = capture_subprocess
    assert call["argv"] == [
        "wsl.exe",
        "--",
        "systemctl",
        "--user",
        "status",
        "forge-runner-dngioidev-forge",
    ]
    assert call["kwargs"]["shell"] is False


def test_wsl_with_distro_inserts_d_flag(capture_subprocess):
    wsl(["docker", "ps"], distro="Ubuntu")

    (call,) = capture_subprocess
    assert call["argv"][:4] == ["wsl.exe", "-d", "Ubuntu", "--"]
    assert call["argv"][4:] == ["docker", "ps"]


@pytest.mark.parametrize(
    "bad",
    [
        ["cat", "/home/me/.forge/runner.env"],
        ["type", r"C:\Users\me\.forge\runner.env"],
        ["cat", "prod.runner.env"],
        ["cat", "~/.forge/runner.env"],
    ],
)
def test_run_refuses_to_touch_runner_env(bad, capture_subprocess):
    with pytest.raises(RunnerEnvAccessError):
        run(bad)
    # And it never reached subprocess.
    assert capture_subprocess == []


def test_wsl_also_refuses_runner_env(capture_subprocess):
    with pytest.raises(RunnerEnvAccessError):
        wsl(["cat", "/home/me/.forge/runner.env"])
    assert capture_subprocess == []


def test_run_never_opens_a_file(monkeypatch, capture_subprocess):
    """The helper must not itself read files — it only spawns the subprocess.

    A regression that made the helper slurp ``runner.env`` (or any file) would
    trip this: ``open`` is booby-trapped to fail the test.
    """
    import builtins

    def boom(*args, **kwargs):  # pragma: no cover - only fires on regression
        raise AssertionError(f"shellout must not open files directly: {args!r}")

    monkeypatch.setattr(builtins, "open", boom)
    run(["sc", "query", "forge-runner"])  # must not raise


def test_timeout_is_forwarded(capture_subprocess):
    run(["sc", "query"], timeout=5.0)
    (call,) = capture_subprocess
    assert call["kwargs"]["timeout"] == 5.0
    assert call["kwargs"]["capture_output"] is True
    assert call["kwargs"]["text"] is True


def test_result_ok_false_on_nonzero(monkeypatch):
    monkeypatch.setattr(
        shellout.subprocess,
        "run",
        lambda argv, **kw: SimpleNamespace(returncode=1, stdout="", stderr="nope"),
    )
    result = run(["sc", "query", "missing"])
    assert not result.ok
    assert result.returncode == 1
