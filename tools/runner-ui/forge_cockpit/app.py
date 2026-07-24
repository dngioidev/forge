"""The cockpit main window — a QMainWindow shell with a tabbed layout.

Wave-1 wires three empty placeholder tabs (ADR-0006 Decision 2 charter):
"Runner fleet", "Usage / cost", "Terminal". Each holds a TODO label only; the
real panels arrive in Waves 1b/2/3. Keeping the shell separate from the panels
lets the smoke test construct the window headless (QT_QPA_PLATFORM=offscreen)
and assert the tab wiring without a desktop session.
"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QLabel,
    QMainWindow,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

#: Tab title -> the TODO note shown on its placeholder, in display order.
COCKPIT_TABS: tuple[tuple[str, str], ...] = (
    ("Runner fleet", "TODO: runner fleet control (service/container state, start/stop)."),
    ("Usage / cost", "TODO: Claude usage / cost / token monitor (from local transcripts)."),
    ("Terminal", "TODO: embedded ConPTY terminal session."),
)

WINDOW_TITLE = "Forge Cockpit"


def _placeholder(todo: str) -> QWidget:
    """An empty tab body carrying a single centered TODO label."""
    page = QWidget()
    layout = QVBoxLayout(page)
    label = QLabel(todo)
    label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    label.setWordWrap(True)
    layout.addWidget(label)
    return page


class CockpitWindow(QMainWindow):
    """The cockpit shell: a main window whose central widget is a tab bar."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(WINDOW_TITLE)
        self.resize(1024, 720)

        self.tabs = QTabWidget()
        for title, todo in COCKPIT_TABS:
            self.tabs.addTab(_placeholder(todo), title)
        self.setCentralWidget(self.tabs)
