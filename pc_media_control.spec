# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

root_dir = Path.cwd()

datas = [
    (str(root_dir / "client" / "dist"), "client/dist"),
    (str(root_dir / "extension"), "extension"),
    (str(root_dir / "assets"), "assets"),
    (str(root_dir / "host" / "static"), "host/static"),
]

hiddenimports = [
    "pystray",
    "pystray._win32",
    "PIL",
    "PIL.Image",
    "PIL.ImageDraw",
    "uvicorn",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespans",
    "uvicorn.lifespans.on",
    "fastapi",
    "starlette",
    "zeroconf",
    "zeroconf._asyncio",
    "winrt.windows.media.control",
    "winrt.windows.media",
    "winrt.windows.foundation",
    "winrt.windows.foundation.collections",
    "pycaw.pycaw",
    "comtypes",
    "comtypes.client",
    "qrcode",
    "qrcode.image.svg",
    "mss",
    "mss.windows",
    "host.screen_mirror",
    "host.tray",
    "host.autostart",
    "host.single_instance",
    "host.network",
    "host.pairing",
    "host.protocol",
    "host.state",
    "host.app",
    "host.config",
    "host.input_control",
    "host.providers.base",
    "host.providers.windows",
    "host.providers.chrome_extension",
]

a = Analysis(
    ["host/__main__.py"],
    pathex=[str(root_dir)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "notebook", "scipy"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="PCMediaControl",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    icon=str(root_dir / "assets" / "icon.ico"),
)
