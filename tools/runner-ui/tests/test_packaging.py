"""Packaging test (#268) — the one-command launch is really wired.

AC1 promises ``uv run forge-cockpit`` launches the cockpit on Windows and
WSL/Linux. That works only if the ``forge-cockpit`` console-script entry point
declared in ``pyproject.toml`` resolves to a real callable. These tests assert
that contract without booting the GUI (no ``QApplication``, no event loop), so
they pass headless on the CI runner alongside the rest of the suite.
"""

from __future__ import annotations

from importlib.metadata import entry_points


def _forge_cockpit_entry_point():
    scripts = entry_points(group="console_scripts")
    return next((e for e in scripts if e.name == "forge-cockpit"), None)


def test_console_script_is_declared():
    """The installed distribution exposes a ``forge-cockpit`` console script."""
    ep = _forge_cockpit_entry_point()
    assert ep is not None, "forge-cockpit console_scripts entry point is not installed"
    assert ep.value == "forge_cockpit.__main__:main"


def test_console_script_resolves_to_callable():
    """``uv run forge-cockpit`` will import + call this exact callable."""
    ep = _forge_cockpit_entry_point()
    assert ep is not None
    main = ep.load()  # imports forge_cockpit.__main__ and grabs `main`
    assert callable(main)
    assert main.__module__ == "forge_cockpit.__main__"
    assert main.__name__ == "main"


def test_main_is_importable_directly():
    """The module path used by the entry point imports cleanly."""
    from forge_cockpit.__main__ import main

    assert callable(main)
