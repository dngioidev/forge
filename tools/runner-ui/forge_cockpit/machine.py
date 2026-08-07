"""Live machine resource metrics core (ticket #395, ADR-0008 extension).

The runner-monitoring spike (``docs/spikes/2026-08-05-runner-machine-monitoring.md``)
found ``psutil`` already declared in ``pyproject.toml``/``uv.lock`` (BSD-3-Clause,
license-cleared) but unused anywhere in the cockpit, and recommended in-process
sampling as the correct-weight answer for a single-box tool — no new dependency,
no second background process, no scrape endpoint. This module is that sampling
layer.

Scope (spike's own sequencing): **live only**, no persistence. A snapshot is a
single point-in-time read with no memory of history — the spike's open question
(should machine-health history survive the cockpit UI being closed, via an
always-on sampler?) is explicitly deferred; this core answers "how loaded is
this machine right now," not "how loaded was it an hour ago."

Framework-agnostic like every other core (:mod:`discovery`, :mod:`usage`,
:mod:`control`) — no FastAPI import here; :mod:`server` calls :func:`snapshot`
and serializes the typed result.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import psutil


@dataclass(frozen=True)
class MachineSnapshot:
    """A single point-in-time read of the local machine's resource load.

    Percentages are already 0-100 (psutil's own convention); the UI maps them
    onto the existing heat scale (cool -> alarm) rather than this core making
    any judgment call about what counts as "hot" — that's presentation, not data.
    """

    cpu_percent: float
    memory_percent: float
    memory_used_bytes: int
    memory_total_bytes: int
    disk_percent: float
    disk_used_bytes: int
    disk_total_bytes: int


def snapshot(*, disk_path: str | Path = "/") -> MachineSnapshot:
    """Sample CPU / memory / disk right now.

    ``disk_path`` defaults to the filesystem root, which on Windows resolves to
    the drive the interpreter is running from (psutil's own behavior) — the
    right default for "the runner's work volume" without hand-rolling a
    per-OS path guess. A caller with a specific work directory can pass it.

    ``cpu_percent`` uses a **non-blocking** call (``interval=None``): the first
    invocation in a process returns ``0.0`` (psutil compares against its own
    last call), which is an accurate "no baseline yet" reading, not a bug — a
    blocking ``interval=`` would stall this request for that many seconds,
    wrong for a live-polled HTTP endpoint.
    """
    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage(str(disk_path))
    return MachineSnapshot(
        cpu_percent=cpu,
        memory_percent=mem.percent,
        memory_used_bytes=mem.used,
        memory_total_bytes=mem.total,
        disk_percent=disk.percent,
        disk_used_bytes=disk.used,
        disk_total_bytes=disk.total,
    )
