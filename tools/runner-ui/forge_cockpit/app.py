"""The cockpit main window — a QMainWindow shell with a tabbed layout.

The shell wires three tabs (ADR-0006 Decision 2 charter): "Runner fleet",
"Usage / cost", "Terminal". "Runner fleet" is the live fleet overview
(:class:`~forge_cockpit.fleet_view.FleetTab`, ticket #265) over the #264 discovery
core; "Usage / cost" is the live usage/cost dashboard
(:class:`~forge_cockpit.usage_view.UsageTab`, ticket #274) over the #273 usage
core; "Terminal" is the live embedded pywinpty/ConPTY terminal
(:class:`~forge_cockpit.terminal.TerminalTab`, ticket #275) with a Windows shell
and a WSL session. Keeping the shell separate from the panels lets the smoke test
construct the window headless (QT_QPA_PLATFORM=offscreen) and assert the tab
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
from forge_cockpit.terminal import Spawn, TerminalTab, default_spawn
from forge_cockpit.usage_view import USAGE_REFRESH_MS, LoadUsage, UsageTab, default_load_usage

#: Fleet auto-refresh interval in the running app (AC3). Off in tests.
FLEET_REFRESH_MS = 15_000

#: Placeholder tab title -> the TODO note shown on its body, in display order. The
#: "Runner fleet", "Usage / cost", and "Terminal" tabs are all live panels, wired
#: separately; no TODO placeholder remains.
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


#: Title of the live fleet-overview tab.
FLEET_TAB_TITLE = "Runner fleet"
#: Title of the live usage/cost dashboard tab (#274).
USAGE_TAB_TITLE = "Usage / cost"
#: Title of the live embedded-terminal tab (#275).
TERMINAL_TAB_TITLE = "Terminal"


class CockpitWindow(QMainWindow):
    """The cockpit shell: a main window whose central widget is a tab bar.

    The "Runner fleet" tab is the live :class:`FleetTab` (#265), "Usage / cost" is
    the live :class:`UsageTab` (#274), and "Terminal" is the live
    :class:`TerminalTab` (#275) — the embedded pywinpty/ConPTY terminal with a
    Windows shell and a WSL session.
    """

    def __init__(
        self,
        *,
        fleet_discover: Discover = discovery.discover_fleet,
        fleet_auto_refresh_ms: int = FLEET_REFRESH_MS,
        fleet_initial_refresh: bool = True,
        usage_load: LoadUsage = default_load_usage,
        usage_auto_refresh_ms: int = USAGE_REFRESH_MS,
        usage_initial_refresh: bool = True,
        terminal_spawn: Spawn = default_spawn,
        terminal_autostart: bool = True,
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
        self.usage_tab = UsageTab(
            usage_load,
            auto_refresh_ms=usage_auto_refresh_ms,
            initial_refresh=usage_initial_refresh,
        )
        self.terminal_tab = TerminalTab(
            spawn=terminal_spawn,
            autostart=terminal_autostart,
        )
        live = {
            FLEET_TAB_TITLE: self.fleet_tab,
            USAGE_TAB_TITLE: self.usage_tab,
            TERMINAL_TAB_TITLE: self.terminal_tab,
        }
        for title, todo in COCKPIT_TABS:
            body = live.get(title) or _placeholder(todo)
            self.tabs.addTab(body, title)
        self.setCentralWidget(self.tabs)
