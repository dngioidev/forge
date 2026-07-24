"""The cockpit main window — a QMainWindow shell with a tabbed layout.

The shell wires three tabs (ADR-0006 Decision 2 charter): "Runner fleet",
"Usage / cost", "Terminal". "Runner fleet" is now the live fleet overview
(:class:`~forge_cockpit.fleet_view.FleetTab`, ticket #265) over the #264
discovery core; the remaining two are still TODO placeholders whose real panels
arrive in Waves 2/3. Keeping the shell separate from the panels lets the smoke
test construct the window headless (QT_QPA_PLATFORM=offscreen) and assert the tab
wiring without a desktop session.
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

from forge_cockpit import discovery
from forge_cockpit.fleet_view import Discover, FleetTab

#: Fleet auto-refresh interval in the running app (AC3). Off in tests.
FLEET_REFRESH_MS = 15_000

#: Placeholder tab title -> the TODO note shown on its body, in display order.
#: The "Runner fleet" tab is the live :class:`FleetTab`, wired separately.
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


#: Title of the live fleet-overview tab (the rest stay placeholders).
FLEET_TAB_TITLE = "Runner fleet"


class CockpitWindow(QMainWindow):
    """The cockpit shell: a main window whose central widget is a tab bar.

    The "Runner fleet" tab is the live :class:`FleetTab` (#265); the others remain
    TODO placeholders until their waves land.
    """

    def __init__(
        self,
        *,
        fleet_discover: Discover = discovery.discover_fleet,
        fleet_auto_refresh_ms: int = FLEET_REFRESH_MS,
        fleet_initial_refresh: bool = True,
    ) -> None:
        super().__init__()
        self.setWindowTitle(WINDOW_TITLE)
        self.resize(1024, 720)

        self.tabs = QTabWidget()
        self.fleet_tab = FleetTab(
            fleet_discover,
            auto_refresh_ms=fleet_auto_refresh_ms,
            initial_refresh=fleet_initial_refresh,
        )
        for title, todo in COCKPIT_TABS:
            body = self.fleet_tab if title == FLEET_TAB_TITLE else _placeholder(todo)
            self.tabs.addTab(body, title)
        self.setCentralWidget(self.tabs)
