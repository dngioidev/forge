"""Tests for runner log reading + tailing (ticket #266, AC2).

Hermetic: the Windows path reads files from a tmp dir (never the real
``runner/windows/logs``); the Linux path uses a fake WSL runner. Locks:

* Windows NSSM -> reads ``service.out.log`` / ``service.err.log`` from the log dir
  and returns the tail (last N lines).
* Linux systemd -> issues ``journalctl --user -u <unit> -n N`` over ``wsl.exe --``
  and returns its output.
* Missing logs / journalctl errors are surfaced (``ok=False``), never raised.
"""

from __future__ import annotations

from pathlib import Path

from forge_cockpit.discovery import (
    DOCKER,
    NSSM,
    SYSTEMD,
    OnlineStatus,
    RunnerEntry,
    Target,
    UNKNOWN_TARGET,
)
from forge_cockpit.logs import DEFAULT_WINDOWS_LOG_DIR, WINDOWS_LOG_FILES, read_logs
from forge_cockpit.shellout import CommandResult


def _entry(mechanism: str, name: str = "forge-runner-acme-widgets") -> RunnerEntry:
    return RunnerEntry(
        name=name,
        mechanism=mechanism,
        service_state="running",
        target=Target("acme", "widgets") if mechanism != DOCKER else UNKNOWN_TARGET,
        online=OnlineStatus.unknown(),
    )


def _cmd(argv, rc=0, out="", err="") -> CommandResult:
    return CommandResult(argv=tuple(argv), returncode=rc, stdout=out, stderr=err)


# --------------------------------------------------------------------------- #
# Windows NSSM logs (files).
# --------------------------------------------------------------------------- #
def test_windows_reads_both_log_files_and_tails(tmp_path: Path):
    (tmp_path / "service.out.log").write_text(
        "\n".join(f"out {i}" for i in range(100)), encoding="utf-8"
    )
    (tmp_path / "service.err.log").write_text("err line 1\nerr line 2\n", encoding="utf-8")

    res = read_logs(_entry(NSSM), lines=5, windows_log_dir=tmp_path)

    assert res.ok is True
    assert res.source == str(tmp_path)
    # Both files appear, labelled.
    assert "service.out.log" in res.text and "service.err.log" in res.text
    # Only the last 5 stdout lines are kept (tail), so line 94 is out, 95 is in.
    assert "out 99" in res.text and "out 95" in res.text
    assert "out 94" not in res.text
    assert "err line 2" in res.text


def test_windows_missing_logs_is_surfaced_not_raised(tmp_path: Path):
    res = read_logs(_entry(NSSM), windows_log_dir=tmp_path)
    assert res.ok is False
    assert "No service log files" in res.text
    for fname in WINDOWS_LOG_FILES:
        assert fname in res.text


def test_windows_reads_when_only_one_file_present(tmp_path: Path):
    (tmp_path / "service.out.log").write_text("only stdout\n", encoding="utf-8")
    res = read_logs(_entry(NSSM), windows_log_dir=tmp_path)
    assert res.ok is True
    assert "only stdout" in res.text


def test_default_windows_log_dir_points_at_repo_runner_logs():
    # Sanity: the default resolves to runner/windows/logs (never runner.env).
    assert DEFAULT_WINDOWS_LOG_DIR.parts[-3:] == ("runner", "windows", "logs")


# --------------------------------------------------------------------------- #
# Linux systemd logs (journalctl over WSL).
# --------------------------------------------------------------------------- #
def test_linux_issues_journalctl_user_over_wsl():
    calls: list[list[str]] = []

    def fake_wsl(argv, **_kw) -> CommandResult:
        calls.append(list(argv))
        return _cmd(argv, 0, out="Jul 25 runner started\nJul 25 job done\n")

    res = read_logs(
        _entry(SYSTEMD, "forge-runner-acme-tools"), lines=50, wsl_runner=fake_wsl
    )

    assert calls == [
        ["journalctl", "--user", "-u", "forge-runner-acme-tools", "-n", "50", "--no-pager"]
    ]
    assert res.ok is True
    assert "runner started" in res.text
    assert "journalctl" in res.source


def test_linux_journalctl_error_is_surfaced():
    def fake_wsl(argv, **_kw) -> CommandResult:
        return _cmd(argv, rc=1, err="Failed to get journal: unit not found")

    res = read_logs(_entry(SYSTEMD), wsl_runner=fake_wsl)
    assert res.ok is False
    assert "unit not found" in res.text


# --------------------------------------------------------------------------- #
# Docker — no persistent service log source.
# --------------------------------------------------------------------------- #
def test_docker_has_no_service_log_source():
    res = read_logs(_entry(DOCKER, "runner-run-abc123"))
    assert res.ok is False
    assert "docker" in res.text.lower()
