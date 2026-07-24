"""Headless smoke test for the cockpit shell (AC2 + AC4).

Constructs the real QMainWindow under the offscreen Qt platform, asserts the
three tabs are wired — the live "Runner fleet" fleet overview (#265), the live
"Usage / cost" dashboard (#274), and the remaining "Terminal" TODO placeholder —
then tears down, proving the app launches without a desktop session on the CI
runner.
"""

from __future__ import annotations

import pytest

from forge_cockpit.app import (
    COCKPIT_TABS,
    FLEET_TAB_TITLE,
    USAGE_TAB_TITLE,
    WINDOW_TITLE,
    CockpitWindow,
)
from forge_cockpit.discovery import Fleet
from forge_cockpit.fleet_view import FleetTab
from forge_cockpit.usage_view import UsageSnapshot, UsageTab

#: Tab titles that are live panels (not TODO placeholders) — skipped by the
#: placeholder assertion below.
_LIVE_TITLES = {FLEET_TAB_TITLE, USAGE_TAB_TITLE}


def _make_window() -> CockpitWindow:
    """A fully hermetic cockpit window: no discovery, no transcript parse, no timers."""
    return CockpitWindow(
        fleet_discover=lambda: Fleet(runners=()),
        fleet_auto_refresh_ms=0,
        fleet_initial_refresh=False,
        usage_load=lambda: UsageSnapshot(),
        usage_auto_refresh_ms=0,
        usage_initial_refresh=False,
    )


@pytest.fixture
def app(qapp):
    """Reuse pytest-qt's session QApplication (already offscreen via conftest)."""
    return qapp


def test_window_has_three_tabs(app, qtbot):
    window = _make_window()
    qtbot.addWidget(window)

    assert window.windowTitle() == WINDOW_TITLE
    assert window.tabs.count() == 3
    assert [window.tabs.tabText(i) for i in range(window.tabs.count())] == [
        "Runner fleet",
        "Usage / cost",
        "Terminal",
    ]


def test_runner_fleet_tab_is_the_live_fleet_view(app, qtbot):
    window = _make_window()
    qtbot.addWidget(window)

    idx = next(i for i in range(window.tabs.count()) if window.tabs.tabText(i) == FLEET_TAB_TITLE)
    assert isinstance(window.tabs.widget(idx), FleetTab)
    assert window.fleet_tab is window.tabs.widget(idx)


def test_usage_cost_tab_is_the_live_usage_view(app, qtbot):
    window = _make_window()
    qtbot.addWidget(window)

    idx = next(i for i in range(window.tabs.count()) if window.tabs.tabText(i) == USAGE_TAB_TITLE)
    assert isinstance(window.tabs.widget(idx), UsageTab)
    assert window.usage_tab is window.tabs.widget(idx)


def test_placeholder_tabs_keep_their_todo(app, qtbot):
    from PySide6.QtWidgets import QLabel

    window = _make_window()
    qtbot.addWidget(window)

    for i, (title, todo) in enumerate(COCKPIT_TABS):
        if title in _LIVE_TITLES:
            continue  # live panels have no TODO placeholder
        page = window.tabs.widget(i)
        assert page is not None
        texts = [lbl.text() for lbl in page.findChildren(QLabel)]
        assert todo in texts  # each remaining tab carries its TODO note


def test_window_show_and_close_headless(app, qtbot):
    """Full launch/teardown cycle: show the window, then close it."""
    window = _make_window()
    qtbot.addWidget(window)
    window.show()
    assert window.isVisible()
    window.close()
    assert not window.isVisible()
