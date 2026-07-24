"""Tests for the fleet tab's control + log wiring (ticket #266, AC1/AC2/AC3).

Hermetic + headless (offscreen): discovery, the controller, the log reader, and
the user-notifier are all fakes, so no service, WSL, UAC prompt, or modal dialog
is touched. Locks:

* AC1 — a control button runs the controller for the SELECTED runner OFF the GUI
  thread and surfaces success (status line) and failure (status + notifier).
* AC2 — "View logs" opens a :class:`LogViewer` bound to the selected runner.
* AC3 — a failed (e.g. non-elevated) NSSM action surfaces a clear message via the
  notifier; it is never a silent no-op. Docker rows disable control + logs.
"""

from __future__ import annotations

from threading import get_ident

import pytest

from forge_cockpit import control
from forge_cockpit.control import ActionResult
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
from forge_cockpit.fleet_view import FleetTab
from forge_cockpit.log_view import LogViewer
from forge_cockpit.logs import LogRead

NSSM_ENTRY = RunnerEntry(
    name="forge-runner-acme-widgets",
    mechanism=NSSM,
    service_state="running",
    target=Target("acme", "widgets"),
    online=OnlineStatus.unknown(),
)
SYSTEMD_ENTRY = RunnerEntry(
    name="forge-runner-acme-tools",
    mechanism=SYSTEMD,
    service_state="running",
    target=Target("acme", "tools"),
    online=OnlineStatus.unknown(),
)
DOCKER_ENTRY = RunnerEntry(
    name="runner-run-abc123",
    mechanism=DOCKER,
    service_state="running",
    target=UNKNOWN_TARGET,
    online=OnlineStatus.unknown(),
)
FLEET = Fleet(runners=(NSSM_ENTRY, SYSTEMD_ENTRY, DOCKER_ENTRY))


@pytest.fixture
def _app(qapp):
    return qapp


class RecordingController:
    """Fake controller: records (entry, action) + thread, returns a canned result."""

    def __init__(self, ok: bool = True, message: str = "done", elevated: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self.thread_idents: list[int] = []
        self._ok, self._message, self._elevated = ok, message, elevated

    def __call__(self, entry: RunnerEntry, action: str) -> ActionResult:
        self.calls.append((entry.name, action))
        self.thread_idents.append(get_ident())
        return ActionResult(
            action=action,
            name=entry.name,
            mechanism=entry.mechanism,
            ok=self._ok,
            elevated=self._elevated,
            message=self._message,
        )


class RecordingNotifier:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def __call__(self, level: str, title: str, text: str) -> None:
        self.calls.append((level, title, text))


def _fake_read(entry: RunnerEntry, **_kw) -> LogRead:
    return LogRead(ok=True, text=f"logs for {entry.name}", source="fake")


def _make_tab(qtbot, controller=None, notifier=None) -> FleetTab:
    tab = FleetTab(
        lambda: FLEET,
        initial_refresh=False,
        controller=controller or RecordingController(),
        read_logs=_fake_read,
        notifier=notifier or RecordingNotifier(),
    )
    qtbot.addWidget(tab)
    with qtbot.waitSignal(tab.fleet_loaded, timeout=5000):
        tab.refresh()
    return tab


# --------------------------------------------------------------------------- #
# Selection gates the controls (AC1/AC2/AC3).
# --------------------------------------------------------------------------- #
def test_controls_disabled_without_selection(_app, qtbot):
    tab = _make_tab(qtbot)
    assert not tab.start_button.isEnabled()
    assert not tab.stop_button.isEnabled()
    assert not tab.restart_button.isEnabled()
    assert not tab.logs_button.isEnabled()


def test_nssm_selection_enables_controls_and_logs(_app, qtbot):
    tab = _make_tab(qtbot)
    tab.table.selectRow(0)  # NSSM
    assert tab.selected_entry() is NSSM_ENTRY
    assert tab.start_button.isEnabled()
    assert tab.logs_button.isEnabled()


def test_docker_selection_disables_control_and_logs(_app, qtbot):
    tab = _make_tab(qtbot)
    tab.table.selectRow(2)  # docker
    assert tab.selected_entry() is DOCKER_ENTRY
    assert not tab.start_button.isEnabled()
    assert not tab.stop_button.isEnabled()
    assert not tab.restart_button.isEnabled()
    assert not tab.logs_button.isEnabled()


# --------------------------------------------------------------------------- #
# AC1 — a control action runs off the GUI thread + surfaces success.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "button_attr,action",
    [("start_button", control.START), ("stop_button", control.STOP), ("restart_button", control.RESTART)],
)
def test_control_button_runs_controller_off_gui_thread(_app, qtbot, button_attr, action):
    ctrl = RecordingController(ok=True, message=f"{action} ok")
    tab = _make_tab(qtbot, controller=ctrl)
    tab.table.selectRow(0)  # NSSM
    gui_thread = get_ident()

    with qtbot.waitSignal(tab.action_completed, timeout=5000) as sig:
        getattr(tab, button_attr).click()

    assert ctrl.calls == [("forge-runner-acme-widgets", action)]
    assert ctrl.thread_idents[0] != gui_thread  # ran off the GUI thread (AC1)
    result = sig.args[0]
    assert result.ok is True
    assert tab.status_label.text() == f"{action} ok"


def test_systemd_control_issues_action(_app, qtbot):
    ctrl = RecordingController(ok=True, message="started")
    tab = _make_tab(qtbot, controller=ctrl)
    tab.table.selectRow(1)  # systemd

    with qtbot.waitSignal(tab.action_completed, timeout=5000):
        tab.start_button.click()

    assert ctrl.calls == [("forge-runner-acme-tools", control.START)]


# --------------------------------------------------------------------------- #
# AC3 — a failed action surfaces a clear message via the notifier (never silent).
# --------------------------------------------------------------------------- #
def test_failed_action_surfaces_via_notifier(_app, qtbot):
    ctrl = RecordingController(
        ok=False,
        message="Start of 'forge-runner-acme-widgets' needs Windows administrator rights.",
        elevated=True,
    )
    notifier = RecordingNotifier()
    tab = _make_tab(qtbot, controller=ctrl, notifier=notifier)
    tab.table.selectRow(0)

    with qtbot.waitSignal(tab.action_completed, timeout=5000):
        tab.start_button.click()

    # Status line updated AND a warning dialog fired — not a silent no-op.
    assert "administrator" in tab.status_label.text()
    assert len(notifier.calls) == 1
    level, _title, text = notifier.calls[0]
    assert level == "warning"
    assert "administrator" in text


def test_controller_exception_is_surfaced(_app, qtbot):
    def boom(entry, action):
        raise RuntimeError("nssm missing")

    notifier = RecordingNotifier()
    tab = _make_tab(qtbot, controller=boom, notifier=notifier)
    tab.table.selectRow(0)

    with qtbot.waitSignal(tab.action_failed, timeout=5000) as sig:
        tab.start_button.click()

    assert "nssm missing" in sig.args[0]
    assert notifier.calls and notifier.calls[0][0] == "critical"


# --------------------------------------------------------------------------- #
# AC2 — "View logs" opens a LogViewer bound to the selected runner.
# --------------------------------------------------------------------------- #
def test_view_logs_opens_viewer_for_selected_runner(_app, qtbot):
    tab = _make_tab(qtbot)
    tab.table.selectRow(0)  # NSSM

    with qtbot.waitSignal(tab.log_viewer_opened, timeout=5000) as sig:
        tab.logs_button.click()

    viewer = sig.args[0]
    assert isinstance(viewer, LogViewer)
    qtbot.addWidget(viewer)
    # The viewer reads via the injected reader for THIS entry.
    with qtbot.waitSignal(viewer.logs_loaded, timeout=5000):
        viewer.refresh()
    assert "forge-runner-acme-widgets" in viewer.text.toPlainText()
