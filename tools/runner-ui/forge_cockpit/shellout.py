"""Shell-out + WSL2 interop helper (ADR-0006 Decision 4).

The cockpit reimplements nothing: it discovers and controls the runner fleet by
shelling out to the managers that are already the API (``sc``/``Get-Service``,
``systemctl --user``, ``docker``, ``gh``), reaching the WSL2 Linux runner from
Windows via ``wsl.exe -- ...`` interop.

Security invariants (non-negotiable, ADR-0005 + ADR-0006):

* Commands are always an argv **list**; ``shell=True`` is never used, so there is
  no shell-injection surface and no word-splitting of untrusted state.
* This module never reads ``~/.forge/runner.env`` and never surfaces the PAT. It
  reads service *state* only. To make that a hard guarantee rather than a
  convention, :func:`run` refuses any argv that points at a ``runner.env`` path.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import PurePath, PureWindowsPath

#: Basenames that hold (or could hold) the runner PAT — off-limits to the cockpit.
_FORBIDDEN_BASENAMES = frozenset({"runner.env"})


class RunnerEnvAccessError(RuntimeError):
    """Raised when a command would touch the gitignored PAT store (``runner.env``).

    The cockpit reads service state only; reaching for the secret store is a bug,
    so we fail loudly instead of silently running it.
    """


@dataclass(frozen=True)
class CommandResult:
    """The captured outcome of a shelled-out command."""

    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def _looks_like_runner_env(token: str) -> bool:
    """True if ``token`` references a ``runner.env`` / ``*.runner.env`` path.

    Guards both native (``C:\\Users\\me\\.forge\\runner.env``) and WSL/POSIX
    (``/home/me/.forge/runner.env``) spellings, plus the ``*.runner.env`` variant.
    """
    # Split on both separators so a Windows path parses on any host and vice-versa.
    for parts in (PurePath(token).parts, PureWindowsPath(token).parts):
        for part in parts:
            base = part.lower()
            if base in _FORBIDDEN_BASENAMES or base.endswith(".runner.env"):
                return True
    return False


def _assert_pat_safe(argv: list[str]) -> None:
    for token in argv:
        if _looks_like_runner_env(token):
            raise RunnerEnvAccessError(
                "refusing to run a command referencing the runner PAT store "
                "(runner.env); the cockpit reads service state only"
            )


def run(argv: list[str], *, timeout: float | None = 30.0) -> CommandResult:
    """Run ``argv`` as a list (never ``shell=True``) and capture stdout/stderr/rc.

    Args:
        argv: the command and its arguments as a list. A string is rejected — a
            bare string would invite ``shell=True``-style splitting, which this
            helper exists to prevent.
        timeout: seconds before the child is killed and ``TimeoutExpired`` raises.

    Raises:
        TypeError: if ``argv`` is not a non-empty list.
        RunnerEnvAccessError: if any token references ``runner.env``.
    """
    if not isinstance(argv, list) or not argv:
        raise TypeError("argv must be a non-empty list of strings (never a shell string)")
    _assert_pat_safe(argv)

    completed = subprocess.run(  # noqa: S603 — argv list, shell=False, validated above
        argv,
        shell=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return CommandResult(
        argv=tuple(argv),
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def wsl(argv: list[str], *, distro: str | None = None, timeout: float | None = 30.0) -> CommandResult:
    """Run ``argv`` inside WSL2 by prefixing ``wsl.exe -- ...`` (Windows -> Linux interop).

    This is how a Windows-native cockpit drives the WSL2 Linux runner
    (``systemctl --user``, ``docker``) from one process, per ADR-0006 Decision 4.

    Args:
        argv: the Linux-side command as a list (e.g. ``["systemctl", "--user", "status", unit]``).
        distro: optional ``-d <distro>`` target; defaults to the default distro.
    """
    if not isinstance(argv, list) or not argv:
        raise TypeError("argv must be a non-empty list of strings (never a shell string)")

    prefix = ["wsl.exe"]
    if distro:
        prefix += ["-d", distro]
    prefix += ["--"]
    return run(prefix + argv, timeout=timeout)


def wsl_available() -> bool:
    """Best-effort probe: is ``wsl.exe`` present and responsive on this host?"""
    if os.name != "nt":
        return False
    try:
        return wsl(["true"], timeout=10.0).ok
    except (OSError, subprocess.SubprocessError):
        return False
