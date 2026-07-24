"""Runner log reading + tailing (ticket #266, AC2).

Reads the *selected* service's own logs and returns the tail (last N lines):

* **Windows NSSM service** — the runner's own stdout/stderr, which
  ``setup-runner.ps1`` points NSSM at: ``runner/windows/logs/service.out.log`` and
  ``service.err.log`` (NSSM ``AppStdout`` / ``AppStderr``).
* **Linux systemd ``--user`` unit** — ``journalctl --user -u <unit>`` run over
  ``wsl.exe --`` interop.

Returning the last N lines (rather than a blocking ``tail -f`` / ``journalctl
-f``) lets a viewer poll on an interval for a live tail while staying off the GUI
thread (same worker pattern as the #265 fleet refresh).

Security (ADR-0005 + ADR-0006): reads only the runner's OWN output logs and
journal — never the service ENVIRONMENT, ``~/.forge/runner.env``, or a PAT. The
service/unit NAME comes from the #264 fleet model (name-derived); nothing here
dumps a service's environment.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from forge_cockpit import shellout
from forge_cockpit.discovery import NSSM, SYSTEMD, RunnerEntry
from forge_cockpit.shellout import CommandResult

Runner = Callable[..., CommandResult]

#: NSSM service log dir — ``setup-runner.ps1`` writes to ``$PSScriptRoot/logs`` under
#: ``runner/windows/``. Resolved from this file's repo location; injectable in tests.
DEFAULT_WINDOWS_LOG_DIR = Path(__file__).resolve().parents[3] / "runner" / "windows" / "logs"

#: The two files NSSM writes (AppStdout / AppStderr), in display order.
WINDOWS_LOG_FILES: tuple[str, ...] = ("service.out.log", "service.err.log")

#: Default tail depth (lines) for both mechanisms.
DEFAULT_TAIL_LINES = 200

_TOLERATED = (OSError, subprocess.SubprocessError)


@dataclass(frozen=True)
class LogRead:
    """The result of a log read — text to render plus where it came from (AC2)."""

    ok: bool
    text: str
    source: str


def read_logs(
    entry: RunnerEntry,
    *,
    lines: int = DEFAULT_TAIL_LINES,
    wsl_runner: Runner = shellout.wsl,
    windows_log_dir: Path | None = None,
) -> LogRead:
    """Read the last ``lines`` of ``entry``'s service logs (AC2).

    Windows NSSM -> the ``service.out.log`` / ``service.err.log`` files; Linux
    systemd -> ``journalctl --user -u <unit>`` over WSL. Docker job containers have
    no persistent service log source and return a clear unsupported result.
    """
    if entry.mechanism == SYSTEMD:
        return _read_journal(entry, lines, wsl_runner)
    if entry.mechanism == NSSM:
        return _read_windows_logs(entry, lines, windows_log_dir or DEFAULT_WINDOWS_LOG_DIR)
    return LogRead(
        ok=False,
        text=(
            f"No log source for '{entry.name}': it is an ephemeral docker job "
            "container. Use `docker logs` for a specific job container."
        ),
        source=entry.mechanism,
    )


def _tail(text: str, lines: int) -> str:
    return "\n".join(text.splitlines()[-lines:]) if lines > 0 else text


def _read_windows_logs(entry: RunnerEntry, lines: int, log_dir: Path) -> LogRead:
    source = str(log_dir)
    chunks: list[str] = []
    found = False
    for fname in WINDOWS_LOG_FILES:
        path = log_dir / fname
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            continue
        except OSError as exc:
            chunks.append(f"--- {fname}: cannot read ({exc}) ---")
            continue
        found = True
        chunks.append(f"--- {fname} ---\n{_tail(content, lines)}")

    if not found:
        note = (
            f"No service log files found in {log_dir} "
            f"({' / '.join(WINDOWS_LOG_FILES)}). The service may not have run yet."
        )
        # Include any partial read-error notes we accumulated.
        text = ("\n".join(chunks) + "\n\n" + note) if chunks else note
        return LogRead(ok=False, text=text, source=source)
    return LogRead(ok=True, text="\n\n".join(chunks), source=source)


def _read_journal(entry: RunnerEntry, lines: int, wsl_runner: Runner) -> LogRead:
    argv = ["journalctl", "--user", "-u", entry.name, "-n", str(lines), "--no-pager"]
    source = f"journalctl --user -u {entry.name}"
    try:
        res = wsl_runner(argv)
    except _TOLERATED as exc:
        return LogRead(ok=False, text=f"Could not read journal over WSL: {exc}", source=source)
    if not res.ok:
        detail = (res.stderr or res.stdout or "").strip() or f"journalctl exited {res.returncode}"
        return LogRead(ok=False, text=detail, source=source)
    return LogRead(ok=True, text=res.stdout, source=source)
