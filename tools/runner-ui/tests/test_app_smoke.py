"""Headless smoke test for the cockpit shell (AC2 + AC4).

Constructs the real QMainWindow under the offscreen Qt platform, asserts the
three placeholder tabs are wired, then tears down — proving the app launches
without a desktop session on the CI runner.
"""

from __future__ import annotations

import pytest

from forge_cockpit.app import COCKPIT_TABS, WINDOW_TITLE, CockpitWindow


@pytest.fixture
def app(qapp):
    """Reuse pytest-qt's session QApplication (already offscreen via conftest)."""
    return qapp


def test_window_has_three_placeholder_tabs(app, qtbot):
    window = CockpitWindow()
    qtbot.addWidget(window)

    assert window.windowTitle() == WINDOW_TITLE
    assert window.tabs.count() == 3
    assert [window.tabs.tabText(i) for i in range(window.tabs.count())] == [
        "Runner fleet",
        "Usage / cost",
        "Terminal",
    ]


def test_each_tab_has_a_todo_placeholder(app, qtbot):
    from PySide6.QtWidgets import QLabel

    window = CockpitWindow()
    qtbot.addWidget(window)

    for i, (_title, todo) in enumerate(COCKPIT_TABS):
        page = window.tabs.widget(i)
        assert page is not None
        texts = [lbl.text() for lbl in page.findChildren(QLabel)]
        assert todo in texts  # each tab carries its TODO note


def test_window_show_and_close_headless(app, qtbot):
    """Full launch/teardown cycle: show the window, then close it."""
    window = CockpitWindow()
    qtbot.addWidget(window)
    window.show()
    assert window.isVisible()
    window.close()
    assert not window.isVisible()
