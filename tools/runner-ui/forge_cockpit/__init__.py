"""Forge cockpit — framework-agnostic Python cores for the local self-hosted runner fleet.

ADR-0006 introduced a native PySide6 desktop app; ADR-0008 re-architected the
cockpit as a local FastAPI web app. In #355 the PySide6 (LGPLv3) desktop UI and
its PyInstaller packaging were removed ahead of web-app parity, so the license
check is clean with zero exceptions before the OSS flip. There is no runnable
desktop UI in the interim — the web app (#351) rebuilds the presentation layer on
the retained, framework-agnostic cores below.

Retained cores (no Qt, no GUI toolkit):

- ``control``    — runner service control (start/stop/restart, elevation)
- ``discovery``  — runner fleet discovery
- ``logs``       — runner log reading
- ``provision``  — runner provisioning
- ``shellout``   — shell-out + WSL2 interop helper
- ``usage``      — Claude usage / cost monitor
"""

__version__ = "0.1.0"
