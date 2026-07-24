"""Tests for the "Runner fleet" overview tab (ticket #265).

Hermetic + headless: discovery is replaced with an in-memory fixture fleet (no
service, WSL, docker, or network is touched), and every widget is built under the
offscreen Qt platform (conftest). The suite locks the ACs:

* AC1 — every runner renders across the five columns (name / target / mechanism /
  service state / online count).
* AC2 — a *running* service whose known repo shows **0** online runners is flagged
  (warning icon + row highlight + tooltip), while the near-miss cases (stopped, or
  online unknown, or online > 0) are NOT.
* AC3 — refresh re-queries discovery **off the GUI thread** and updates the model
  without blocking the UI.
"""

from __future__ import annotations

from threading import get_ident

import pytest

from forge_cockpit.discovery import (
    DOCKER,
    NSSM,
    SYSTEMD,
    Fleet,
    OnlineStatus,
    RunnerEntry,
    Target,
    UNKNOWN_TARGET,
)
from forge_cockpit.fleet_view import FleetTab, FleetTableModel, is_mistargeted
from PySide6.QtCore import Qt


# --------------------------------------------------------------------------- #
# Fixture fleet — one entry per interesting case.
# --------------------------------------------------------------------------- #
def _online(n: int) -> OnlineStatus:
    return OnlineStatus(online=n, offline=0, total=n, known=True)


# A running NSSM service whose repo has 0 online runners -> MIS-TARGETED (AC2).
MISTARGETED = RunnerEntry(
    name="forge-runner-acme-widgets",
    mechanism=NSSM,
    service_state="running",
    target=Target(owner="acme", repo="widgets"),
    online=OnlineStatus(online=0, offline=1, total=1, known=True),
)
# A healthy running service: 2 online -> not flagged.
HEALTHY = RunnerEntry(
    name="forge-runner-acme-forge",
    mechanism=NSSM,
    service_state="running",
    target=Target(owner="acme", repo="forge"),
    online=_online(2),
)
# Running but online count is UNKNOWN (gh error) -> not flagged (we don't guess).
UNKNOWN_ONLINE = RunnerEntry(
    name="forge-runner-acme-tools",
    mechanism=SYSTEMD,
    service_state="running",
    target=Target(owner="acme", repo="tools"),
    online=OnlineStatus.unknown(),
)
# Stopped service with 0 online -> not flagged (not running, so no mis-target).
STOPPED = RunnerEntry(
    name="forge-runner-acme-legacy",
    mechanism=SYSTEMD,
    service_state="stopped",
    target=Target(owner="acme", repo="legacy"),
    online=OnlineStatus(online=0, offline=0, total=0, known=True),
)
# A docker job container (unknown target) -> never flagged.
DOCKER_JOB = RunnerEntry(
    name="runner-run-abc123",
    mechanism=DOCKER,
    service_state="running",
    target=UNKNOWN_TARGET,
    online=OnlineStatus.unknown(),
)

FIXTURE_ROWS = (MISTARGETED, HEALTHY, UNKNOWN_ONLINE, STOPPED, DOCKER_JOB)
FIXTURE_FLEET = Fleet(runners=FIXTURE_ROWS)


class RecordingDiscover:
    """A discovery stand-in: records call count + the thread it ran on."""

    def __init__(self, fleet: Fleet) -> None:
        self.fleet = fleet
        self.calls = 0
        self.thread_idents: list[int] = []

    def __call__(self) -> Fleet:
        self.calls += 1
        self.thread_idents.append(get_ident())
        return self.fleet


@pytest.fixture
def _app(qapp):
    return qapp


def _make_tab(qtbot, discover) -> FleetTab:
    tab = FleetTab(discover, initial_refresh=False)
    qtbot.addWidget(tab)
    return tab


def _load(qtbot, tab) -> None:
    with qtbot.waitSignal(tab.fleet_loaded, timeout=5000):
        tab.refresh()


# --------------------------------------------------------------------------- #
# is_mistargeted — the pure AC2 rule.
# --------------------------------------------------------------------------- #
def test_is_mistargeted_flags_running_zero_online():
    assert is_mistargeted(MISTARGETED) is True


@pytest.mark.parametrize("entry", [HEALTHY, UNKNOWN_ONLINE, STOPPED, DOCKER_JOB])
def test_is_mistargeted_does_not_flag_near_misses(entry):
    assert is_mistargeted(entry) is False


# --------------------------------------------------------------------------- #
# AC1 — every runner renders across the five columns.
# --------------------------------------------------------------------------- #
def test_all_rows_render_with_columns(_app, qtbot):
    tab = _make_tab(qtbot, RecordingDiscover(FIXTURE_FLEET))
    _load(qtbot, tab)
    model = tab.model

    assert model.rowCount() == len(FIXTURE_ROWS)
    assert model.columnCount() == 5
    headers = [
        model.headerData(c, Qt.Orientation.Horizontal, Qt.ItemDataRole.DisplayRole)
        for c in range(model.columnCount())
    ]
    assert headers == ["Runner", "Target repo", "OS / mechanism", "Service state", "Online runners"]

    # Row 0 is the mis-targeted NSSM entry — spot-check every column's text.
    def cell(r, c):
        return model.data(model.index(r, c), Qt.ItemDataRole.DisplayRole)

    assert cell(0, 0) == "forge-runner-acme-widgets"
    assert cell(0, 1) == "acme/widgets"
    assert cell(0, 2) == NSSM
    assert cell(0, 3) == "running"
    assert cell(0, 4) == "0"
    # Unknown online count renders as "?" (row 2).
    assert cell(2, 4) == "?"
    # Docker job's unknown target renders the legacy sentinel slug (row 4).
    assert cell(4, 1) == "unknown/legacy"


# --------------------------------------------------------------------------- #
# AC2 — the mis-targeted row is visibly flagged; the others are not.
# --------------------------------------------------------------------------- #
def test_mistargeted_row_is_flagged(_app, qtbot):
    tab = _make_tab(qtbot, RecordingDiscover(FIXTURE_FLEET))
    _load(qtbot, tab)
    model = tab.model

    assert tab.mistarget_rows() == [0]

    warn_idx = model.index(0, 0)
    icon = model.data(warn_idx, Qt.ItemDataRole.DecorationRole)
    assert icon is not None and not icon.isNull()  # warning icon present
    assert model.data(warn_idx, Qt.ItemDataRole.BackgroundRole) is not None  # row highlight
    tip = model.data(warn_idx, Qt.ItemDataRole.ToolTipRole)
    assert tip is not None and "acme/widgets" in tip and "0 online" in tip


def test_healthy_rows_are_not_flagged(_app, qtbot):
    tab = _make_tab(qtbot, RecordingDiscover(FIXTURE_FLEET))
    _load(qtbot, tab)
    model = tab.model

    for row in range(1, model.rowCount()):
        idx = model.index(row, 0)
        assert model.data(idx, Qt.ItemDataRole.DecorationRole) is None
        assert model.data(idx, Qt.ItemDataRole.BackgroundRole) is None
        assert model.data(idx, Qt.ItemDataRole.ToolTipRole) is None


# --------------------------------------------------------------------------- #
# AC3 — refresh re-queries off the GUI thread, non-blocking, and updates.
# --------------------------------------------------------------------------- #
def test_refresh_runs_discovery_off_the_gui_thread(_app, qtbot):
    discover = RecordingDiscover(FIXTURE_FLEET)
    tab = _make_tab(qtbot, discover)
    gui_thread = get_ident()

    _load(qtbot, tab)

    assert discover.calls == 1
    # The discovery call recorded a thread ident that is NOT the GUI thread's.
    assert discover.thread_idents[0] != gui_thread
    assert tab.discovery_ran_off_gui_thread is True


def test_refresh_requeries_and_updates_model(_app, qtbot):
    discover = RecordingDiscover(Fleet(runners=(HEALTHY,)))
    tab = _make_tab(qtbot, discover)

    _load(qtbot, tab)
    assert tab.model.rowCount() == 1
    assert tab.mistarget_rows() == []

    # Fleet changes under us: a mis-target appears. Refresh must re-query + update.
    discover.fleet = FIXTURE_FLEET
    _load(qtbot, tab)

    assert discover.calls == 2
    assert tab.model.rowCount() == len(FIXTURE_ROWS)
    assert tab.mistarget_rows() == [0]


def test_refresh_failure_is_surfaced_not_raised(_app, qtbot):
    def boom() -> Fleet:
        raise RuntimeError("gh exploded")

    tab = FleetTab(boom, initial_refresh=False)
    qtbot.addWidget(tab)

    with qtbot.waitSignal(tab.refresh_failed, timeout=5000) as sig:
        tab.refresh()

    assert "gh exploded" in sig.args[0]
    assert "failed" in tab.status_label.text().lower()
    assert tab.model.rowCount() == 0  # nothing rendered, no crash


def test_auto_refresh_interval_wires_a_running_timer(_app, qtbot):
    tab = FleetTab(RecordingDiscover(FIXTURE_FLEET), auto_refresh_ms=10_000, initial_refresh=False)
    qtbot.addWidget(tab)
    assert tab._timer.isActive()
    assert tab._timer.interval() == 10_000


def test_model_set_fleet_directly(_app, qtbot):
    model = FleetTableModel()
    model.set_fleet(FIXTURE_FLEET)
    assert model.rowCount() == len(FIXTURE_ROWS)
    assert model.entry_at(0) is MISTARGETED
