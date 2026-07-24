"""Launch the cockpit: ``uv run python -m forge_cockpit``."""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from forge_cockpit.app import CockpitWindow


def main(argv: list[str] | None = None) -> int:
    """Boot the Qt application and show the cockpit window."""
    app = QApplication.instance() or QApplication(argv if argv is not None else sys.argv)
    window = CockpitWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
