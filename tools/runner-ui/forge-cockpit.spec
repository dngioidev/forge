# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the forge cockpit (ticket #268, ADR-0006).
#
# Hand-written and committed deliberately (it is NOT gitignored, unlike the
# generated build/ and dist/ output). It produces a single-file desktop binary
# so an adopter can run the cockpit without provisioning a Python toolchain.
#
# Build it (does not run in CI - packaging is heavy and host-specific; CI only
# runs the pytest suite):
#
#   Windows (PowerShell):
#     $env:PATH = "C:\Program Files\Python312;C:\Program Files\Python312\Scripts;C:\Program Files\WinGet\Links;$env:PATH"
#     uv run --with pyinstaller pyinstaller forge-cockpit.spec
#
#   WSL / Linux:
#     uv run --with pyinstaller pyinstaller forge-cockpit.spec
#
# Output: dist/forge-cockpit (a ~100MB onefile bundle per ADR-0006's accepted
# trade-off). `--with pyinstaller` keeps PyInstaller out of the committed
# uv.lock - it is a build-time-only tool, not a runtime dependency.

block_cipher = None

a = Analysis(
    ["forge_cockpit/__main__.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="forge-cockpit",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # a windowed GUI app, not a console tool
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
