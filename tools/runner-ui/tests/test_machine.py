"""Unit tests for the live machine-metrics core (ticket #395).

Hermetic: ``psutil``'s three sampling calls are monkeypatched at the
``forge_cockpit.machine`` module boundary, so the suite never depends on the
actual host's load and is deterministic across CI runners.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from forge_cockpit import machine
from forge_cockpit.machine import MachineSnapshot, snapshot


def test_snapshot_reads_cpu_memory_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(machine.psutil, "cpu_percent", lambda interval=None: 42.5)
    monkeypatch.setattr(
        machine.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(percent=61.0, used=8_000_000_000, total=16_000_000_000),
    )
    monkeypatch.setattr(
        machine.psutil,
        "disk_usage",
        lambda path: SimpleNamespace(percent=73.2, used=300_000_000_000, total=500_000_000_000),
    )

    snap = snapshot()

    assert snap == MachineSnapshot(
        cpu_percent=42.5,
        memory_percent=61.0,
        memory_used_bytes=8_000_000_000,
        memory_total_bytes=16_000_000_000,
        disk_percent=73.2,
        disk_used_bytes=300_000_000_000,
        disk_total_bytes=500_000_000_000,
    )


def test_snapshot_is_non_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    """``cpu_percent`` must be called with ``interval=None`` — a blocking interval
    would stall a live-polled HTTP endpoint for that many seconds."""
    seen: dict[str, object] = {}

    def fake_cpu_percent(interval=None):
        seen["interval"] = interval
        return 10.0

    monkeypatch.setattr(machine.psutil, "cpu_percent", fake_cpu_percent)
    monkeypatch.setattr(
        machine.psutil, "virtual_memory", lambda: SimpleNamespace(percent=0, used=0, total=1)
    )
    monkeypatch.setattr(
        machine.psutil, "disk_usage", lambda path: SimpleNamespace(percent=0, used=0, total=1)
    )

    snapshot()

    assert seen["interval"] is None


def test_snapshot_disk_path_is_passed_through(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    monkeypatch.setattr(machine.psutil, "cpu_percent", lambda interval=None: 0.0)
    monkeypatch.setattr(
        machine.psutil, "virtual_memory", lambda: SimpleNamespace(percent=0, used=0, total=1)
    )

    def fake_disk_usage(path):
        seen["path"] = path
        return SimpleNamespace(percent=0, used=0, total=1)

    monkeypatch.setattr(machine.psutil, "disk_usage", fake_disk_usage)

    snapshot(disk_path="D:/work")

    assert seen["path"] == "D:/work"
