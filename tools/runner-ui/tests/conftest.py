"""Shared test config — force Qt to run headless on the CI runner.

The Windows self-hosted runner has no interactive desktop session, so every Qt
test constructs widgets under the ``offscreen`` platform plugin. Setting it here
(before any PySide6 import) means the suite runs the same locally and in CI.
"""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
