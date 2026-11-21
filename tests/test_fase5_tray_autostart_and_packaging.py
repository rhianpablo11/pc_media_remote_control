"""Automated tests for Fase 5: system tray, autostart, single-instance lock, and packaging."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from host.autostart import get_startup_command, is_autostart_enabled
from host.config import (
    DEFAULT_CLIENT_DIST_DIR,
    HostSettings,
    get_app_data_dir,
    get_base_dir,
    get_logs_dir,
)
from host.pairing import PairingManager
from host.single_instance import SingleInstanceLock
from host.tray import SystemTrayApp, create_fallback_icon_image, load_tray_icon_image


def test_config_paths_and_directories() -> None:
    base_dir = get_base_dir()
    assert base_dir.is_dir()
    assert (base_dir / "host").is_dir()
    assert (base_dir / "assets").is_dir()

    app_data = get_app_data_dir()
    assert app_data.is_dir()
    assert "PCMediaControl" in str(app_data) or ".pcmediacontrol" in str(app_data)

    logs_dir = get_logs_dir()
    assert logs_dir.is_dir()
    assert logs_dir.parent == app_data

    assert DEFAULT_CLIENT_DIST_DIR.name == "dist"
    assert DEFAULT_CLIENT_DIST_DIR.parent.name == "client"


def test_autostart_command_generation() -> None:
    cmd = get_startup_command()
    assert isinstance(cmd, str)
    assert "--lan" in cmd
    assert "--tray" in cmd

    # is_autostart_enabled should query winreg safely without crashing
    enabled = is_autostart_enabled()
    assert isinstance(enabled, bool)


def test_single_instance_lock_mutex() -> None:
    test_mutex_name = f"Global\\PCMediaControl_TestMutex_{os.getpid()}"
    lock1 = SingleInstanceLock(mutex_name=test_mutex_name)
    lock2 = SingleInstanceLock(mutex_name=test_mutex_name)

    try:
        # First acquisition should succeed
        assert lock1.acquire() is True
        assert lock1.is_already_running is False

        # Second acquisition on the same mutex must fail
        assert lock2.acquire() is False
        assert lock2.is_already_running is True

        # Releasing the first lock allows subsequent acquisition
        lock1.release()
        lock3 = SingleInstanceLock(mutex_name=test_mutex_name)
        assert lock3.acquire() is True
        lock3.release()
    finally:
        lock1.release()
        lock2.release()


def test_tray_icon_loader_and_fallback() -> None:
    # 1. Fallback in-memory image
    fallback_img = create_fallback_icon_image(size=48)
    assert fallback_img.size == (48, 48)
    assert fallback_img.mode == "RGBA"

    # 2. Disk icon loaded from assets
    disk_img = load_tray_icon_image()
    assert disk_img.size[0] > 0
    assert disk_img.size[1] > 0


def test_system_tray_menu_structure() -> None:
    settings = HostSettings(
        port=8765,
        lan_mode=True,
        lan_ip="192.168.1.50",
    )
    pairing_mgr = PairingManager()
    exit_called = False

    def on_exit() -> None:
        nonlocal exit_called
        exit_called = True

    tray = SystemTrayApp(
        settings=settings,
        pairing_manager=pairing_mgr,
        on_exit=on_exit,
    )

    menu = tray._build_menu()
    menu_items = list(menu.items)
    item_texts = [str(item.text) for item in menu_items if hasattr(item, "text")]

    # Verify key menu items are present
    assert any("Status: Ativo na LAN" in t for t in item_texts)
    assert any("Parear Celular (QR Code)" in t for t in item_texts)
    assert any("Abrir Central de Mídia" in t for t in item_texts)
    assert any("Dispositivos Pareados" in t for t in item_texts)
    assert any("Iniciar com o Windows" in t for t in item_texts)
    assert any("Abrir pasta da extensão" in t for t in item_texts)
    assert any("Abrir pasta de logs" in t for t in item_texts)
    assert any("Sair" in t for t in item_texts)

    # Test exit callback
    tray._on_exit_clicked(None, None)
    assert exit_called is True


def test_pyinstaller_spec_file_exists_and_bundles_all_assets() -> None:
    spec_path = Path.cwd() / "pc_media_control.spec"
    assert spec_path.is_file()

    content = spec_path.read_text(encoding="utf-8")
    assert "client/dist" in content
    assert "extension" in content
    assert "assets" in content
    assert "pystray" in content
    assert "icon.ico" in content


def test_gui_mode_without_console_stdout_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure host can configure logging and uvicorn without crashing when sys.stdout is None."""
    import uvicorn

    from host.__main__ import setup_logging
    from host.app import create_app
    from host.config import HostSettings

    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    # 1. setup_logging must not throw AttributeError
    log_file = setup_logging(console=True)
    assert log_file.is_file()

    # 2. uvicorn.Config with log_config=None must initialize without crashing
    settings = HostSettings(port=8765, host="127.0.0.1", lan_mode=False)
    app = create_app(settings=settings)
    cfg = uvicorn.Config(
        app=app,
        host=settings.host,
        port=settings.port,
        log_config=None,
    )
    server = uvicorn.Server(cfg)
    assert server is not None


def test_extension_sync_to_appdata() -> None:
    """Ensure Chrome extension files are synced to stable %LOCALAPPDATA% directory with LEIA-ME."""
    from host.config import get_installed_extension_dir, sync_installed_extension

    ext_dir = sync_installed_extension()
    assert ext_dir == get_installed_extension_dir()
    assert ext_dir.is_dir()

    manifest_file = ext_dir / "manifest.json"
    assert manifest_file.is_file()

    readme_file = ext_dir / "LEIA-ME.txt"
    assert readme_file.is_file()
    readme_content = readme_file.read_text(encoding="utf-8")
    assert "chrome://extensions" in readme_content
    assert "Modo do desenvolvedor" in readme_content


def test_extension_sync_detects_file_hash_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ensure sync_installed_extension re-syncs when a file changes even without version bump."""
    from host import config as host_config

    src_root = tmp_path / "src"
    ext_src = src_root / "extension"
    ext_src.mkdir(parents=True)
    (ext_src / "manifest.json").write_text('{"version": "0.2.0"}', encoding="utf-8")
    (ext_src / "content.js").write_text("// updated content", encoding="utf-8")

    tgt_ext = tmp_path / "appdata" / "extension"
    tgt_ext.mkdir(parents=True)
    (tgt_ext / "manifest.json").write_text('{"version": "0.2.0"}', encoding="utf-8")
    (tgt_ext / "content.js").write_text("// stale content", encoding="utf-8")

    monkeypatch.setattr(host_config, "get_base_dir", lambda: src_root)
    monkeypatch.setattr(host_config, "get_installed_extension_dir", lambda: tgt_ext)

    host_config.sync_installed_extension()
    assert (tgt_ext / "content.js").read_text(encoding="utf-8") == "// updated content"
    assert (tgt_ext / "LEIA-ME.txt").is_file()


def test_autostart_helpers_and_status() -> None:
    """Ensure parse_executable_from_command and autostart status behave deterministically."""
    from host.autostart import (
        install_executable_to_app_data,
        parse_executable_from_command,
    )

    # 1. Quoted command parsing
    p1 = parse_executable_from_command(r'"C:\PCMedia\PCMediaControl.exe" --lan')
    assert p1 == Path(r"C:\PCMedia\PCMediaControl.exe")

    # 2. Unquoted command parsing
    p2 = parse_executable_from_command(r"C:\PCMedia\app.exe --tray")
    assert p2 == Path(r"C:\PCMedia\app.exe")

    # 3. Empty command
    assert parse_executable_from_command("") is None

    # 4. install_executable_to_app_data should resolve to a valid path inside app_data_dir
    target_exe = install_executable_to_app_data()
    assert target_exe.name == "PCMediaControl.exe"
    assert "PCMediaControl" in str(target_exe.parent)


