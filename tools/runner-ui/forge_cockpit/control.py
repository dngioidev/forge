"""Runner control actions (ticket #266) — start / stop / restart per mechanism.

Reimplements nothing: it drives the service managers that are already the API —
``nssm start|stop|restart <service>`` for a Windows NSSM service (the manager
``setup-runner.ps1`` installs the runner under) and ``systemctl --user
start|stop|restart <unit>`` (reached over ``wsl.exe --`` interop) for a Linux
``--user`` unit — all through the argv-list shell-out helper in
:mod:`forge_cockpit.shellout`.

Privilege handling (AC3, ADR-0006 Decision 4): mutating a Windows NSSM service
(it runs as LocalSystem) needs administrator rights. When the cockpit is **not**
already elevated the action is run through an **explicit** per-action UAC
"runas" elevation (PowerShell ``Start-Process -Verb RunAs -Wait -PassThru``, whose
exit code mirrors the elevated child's). It **never silently no-ops**: it either
runs directly (already admin), prompts for elevation, or returns a failure result
carrying a clear "run elevated" message. systemd ``--user`` needs no elevation.

Security invariants (ADR-0005 + ADR-0006): the service/unit NAME comes from the
#264 fleet model (name-derived, never the env). Nothing here reads the service
ENVIRONMENT, ``~/.forge/runner.env``, or a PAT; :mod:`shellout` refuses any argv
referencing ``runner.env`` as a hard backstop.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
from collections.abc import Callable
from dataclasses import dataclass

from forge_cockpit import shellout
from forge_cockpit.discovery import NSSM, SYSTEMD, RunnerEntry
from forge_cockpit.shellout import CommandResult

# The three control verbs (AC1).
START = "start"
STOP = "stop"
RESTART = "restart"
ACTIONS: tuple[str, ...] = (START, STOP, RESTART)

# Errors that mean "the manager is simply absent / the call could not spawn" —
# turned into a clear failure result rather than propagated as a crash.
_TOLERATED = (OSError, subprocess.SubprocessError)

# Windows exit code the elevation launcher reports when the UAC prompt is declined
# (ERROR_CANCELLED). Surfaced as an explicit "run elevated" failure, never a no-op.
_ERROR_CANCELLED = 1223

# Injectable seams (defaulted to the real helpers; overridden with fakes in tests).
Runner = Callable[..., CommandResult]
Elevator = Callable[[list[str]], CommandResult]
AdminProbe = Callable[[], bool]


@dataclass(frozen=True)
class ActionResult:
    """The outcome of a control action, ready to surface to the user (AC1)."""

    action: str
    name: str
    mechanism: str
    ok: bool
    #: True when the action was routed through a UAC elevation (Windows, non-admin).
    elevated: bool
    #: A human-readable success/failure line for the status bar / dialog.
    message: str


# --------------------------------------------------------------------------- #
# Privilege probe + per-action elevation ("runas") — AC3.
# --------------------------------------------------------------------------- #
def is_elevated() -> bool:
    """Best-effort: is this process running with Windows administrator rights?

    Non-Windows returns ``True`` (the systemd ``--user`` path needs no elevation).
    On any probe error we conservatively return ``False`` so a Windows mutation
    elevates rather than failing silently.
    """
    if os.name != "nt":
        return True
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - platform/loader specific
        return False


def _ps_single_quote(value: str) -> str:
    """Quote ``value`` as a PowerShell single-quoted literal (doubling ``'``)."""
    return "'" + value.replace("'", "''") + "'"


def elevate_run(
    argv: list[str], *, runner: Runner = shellout.run, timeout: float | None = 120.0
) -> CommandResult:
    """Run ``argv`` with an explicit per-action UAC elevation and return its result.

    Launches (non-elevated) a PowerShell that spawns ``argv`` elevated via
    ``Start-Process -Verb RunAs -Wait -PassThru`` and exits with the elevated
    child's exit code — so the returned :class:`CommandResult`'s ``returncode``
    reflects whether the elevated action itself succeeded. If the UAC prompt is
    declined ``Start-Process`` raises and the launcher exits ``1223``
    (ERROR_CANCELLED); there is never a silent no-op (AC3, ADR-0006 Decision 4).
    """
    if not argv:
        raise ValueError("argv must be a non-empty list")
    exe, *args = argv
    start = f"Start-Process -FilePath {_ps_single_quote(exe)}"
    if args:
        start += " -ArgumentList " + ", ".join(_ps_single_quote(a) for a in args)
    start += " -Verb RunAs -Wait -PassThru"
    script = (
        "$ErrorActionPreference='Stop'; "
        f"try {{ $p = {start}; exit $p.ExitCode }} "
        f"catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit {_ERROR_CANCELLED} }}"
    )
    return runner(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        timeout=timeout,
    )


# --------------------------------------------------------------------------- #
# Per-mechanism argv (the managers are the API — we never reimplement them).
# --------------------------------------------------------------------------- #
def windows_service_argv(name: str, action: str) -> list[str]:
    """``nssm start|stop|restart <name>`` — the manager that installed the service."""
    return ["nssm", action, name]


def systemd_argv(name: str, action: str) -> list[str]:
    """``systemctl --user start|stop|restart <unit>`` (run over ``wsl.exe --``)."""
    return ["systemctl", "--user", action, name]


# --------------------------------------------------------------------------- #
# Control orchestration.
# --------------------------------------------------------------------------- #
def control(
    entry: RunnerEntry,
    action: str,
    *,
    runner: Runner = shellout.run,
    wsl_runner: Runner = shellout.wsl,
    is_admin: AdminProbe = is_elevated,
    elevate: Elevator = elevate_run,
) -> ActionResult:
    """Start / stop / restart ``entry``'s service, surfacing success/failure (AC1).

    Routes by mechanism: a systemd ``--user`` unit over WSL (no elevation), a
    Windows NSSM service directly when already admin else through a per-action UAC
    elevation (AC3). Docker job containers are ephemeral one-job runners and are
    not controllable as a service — a clear unsupported result is returned.
    """
    if action not in ACTIONS:
        raise ValueError(f"unknown action {action!r}; expected one of {ACTIONS}")

    if entry.mechanism == SYSTEMD:
        return _control_systemd(entry, action, wsl_runner)
    if entry.mechanism == NSSM:
        return _control_nssm(entry, action, runner, is_admin, elevate)
    return ActionResult(
        action=action,
        name=entry.name,
        mechanism=entry.mechanism,
        ok=False,
        elevated=False,
        message=(
            f"Cannot {action} '{entry.name}': it is an ephemeral docker job "
            "container, not a managed service. Control applies to NSSM services "
            "and systemd --user units."
        ),
    )


def _control_systemd(entry: RunnerEntry, action: str, wsl_runner: Runner) -> ActionResult:
    argv = systemd_argv(entry.name, action)
    try:
        res = wsl_runner(argv)
    except _TOLERATED as exc:
        return ActionResult(
            action, entry.name, SYSTEMD, False, False,
            f"Could not {action} '{entry.name}' over WSL: {exc}",
        )
    if res.ok:
        return ActionResult(
            action, entry.name, SYSTEMD, True, False,
            f"{action.capitalize()} succeeded for systemd --user unit '{entry.name}'.",
        )
    detail = (res.stderr or res.stdout or "").strip() or f"systemctl exited {res.returncode}"
    return ActionResult(
        action, entry.name, SYSTEMD, False, False,
        f"{action.capitalize()} failed for '{entry.name}': {detail}",
    )


def _control_nssm(
    entry: RunnerEntry,
    action: str,
    runner: Runner,
    is_admin: AdminProbe,
    elevate: Elevator,
) -> ActionResult:
    argv = windows_service_argv(entry.name, action)
    admin = is_admin()
    try:
        res = runner(argv) if admin else elevate(argv)
    except _TOLERATED as exc:
        return ActionResult(
            action, entry.name, NSSM, False, not admin,
            f"Could not {action} '{entry.name}': {exc}",
        )

    if res.ok:
        note = " (elevated via UAC)" if not admin else ""
        return ActionResult(
            action, entry.name, NSSM, res.ok, not admin,
            f"{action.capitalize()} succeeded for service '{entry.name}'{note}.",
        )

    # Failed. A non-admin failure is almost certainly a declined/failed elevation:
    # make the "run elevated" requirement EXPLICIT rather than a silent no-op (AC3).
    if not admin:
        message = (
            f"{action.capitalize()} of '{entry.name}' needs Windows administrator "
            f"rights and the elevation was declined or failed (exit {res.returncode}). "
            "Re-run the action and accept the UAC prompt, or launch the cockpit as "
            "administrator."
        )
    else:
        detail = (res.stderr or res.stdout or "").strip() or f"nssm exited {res.returncode}"
        message = f"{action.capitalize()} failed for '{entry.name}': {detail}"
    return ActionResult(action, entry.name, NSSM, False, not admin, message)
