"""Configuration settings and origin/extension-ID helpers for the host server."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import socket
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from host.pairing import PairingManager

DEFAULT_EXTENSION_ID = "dcnkokmkhlcocfengaobkeacnbdjdcfa"


def get_base_dir() -> Path:
    """Return the base directory for resources, supporting PyInstaller bundles and dev sources."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def get_app_data_dir() -> Path:
    """Return the persistent user data dir (%LOCALAPPDATA%\\PCMediaControl or ~/.pcmediacontrol)."""
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        base = Path(local_app_data) / "PCMediaControl"
    else:
        base = Path.home() / ".pcmediacontrol"
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_logs_dir() -> Path:
    """Return the persistent log directory (%LOCALAPPDATA%\\PCMediaControl\\logs)."""
    logs = get_app_data_dir() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    return logs


def get_installed_extension_dir() -> Path:
    """Return the persistent user directory for the Chrome extension."""
    ext_dir = get_app_data_dir() / "extension"
    ext_dir.mkdir(parents=True, exist_ok=True)
    return ext_dir


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sync_installed_extension() -> Path:
    """Ensure the Chrome extension in %LOCALAPPDATA%\\PCMediaControl\\extension is up to date."""
    target_dir = get_installed_extension_dir()
    source_dir = get_base_dir() / "extension"

    if not source_dir.is_dir():
        return target_dir

    source_manifest_path = source_dir / "manifest.json"
    target_manifest_path = target_dir / "manifest.json"

    should_sync = not target_manifest_path.is_file()

    if not should_sync and source_manifest_path.is_file():
        try:
            with open(source_manifest_path, encoding="utf-8") as sf:
                src_manifest = json.load(sf)
            with open(target_manifest_path, encoding="utf-8") as tf:
                tgt_manifest = json.load(tf)
            if src_manifest.get("version") != tgt_manifest.get("version"):
                should_sync = True
        except Exception:
            should_sync = True

    if not should_sync:
        for item in source_dir.iterdir():
            if not item.is_file():
                continue
            target_file = target_dir / item.name
            if not target_file.is_file():
                should_sync = True
                break
            try:
                if _file_sha256(item) != _file_sha256(target_file):
                    should_sync = True
                    break
            except Exception:
                should_sync = True
                break

    if should_sync:
        for item in source_dir.iterdir():
            if item.is_file():
                shutil.copy2(item, target_dir / item.name)

        instructions = (
            "======================================================================\n"
            "PC Media Control — Como carregar a extensao no Google Chrome\n"
            "======================================================================\n\n"
            "1. Abra o Google Chrome no seu computador.\n"
            "2. Na barra de enderecos, digite: chrome://extensions e aperte Enter.\n"
            "3. No canto superior direito, ative a chave 'Modo do desenvolvedor'.\n"
            "4. Clique no botao 'Carregar sem compactacao' (Load unpacked).\n"
            f"5. Selecione ESTA PASTA: {target_dir}\n"
            "6. Pronto! A extensao estara conectada ao PC Media Control de forma\n"
            "   permanente e nao sera perdida mesmo ao mover ou atualizar o app.\n"
            "======================================================================\n"
        )
        (target_dir / "LEIA-ME.txt").write_text(instructions, encoding="utf-8")

    return target_dir


class HostConfigStore:
    """Persistent user settings store (%LOCALAPPDATA%\\PCMediaControl\\settings.json)."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (get_app_data_dir() / "settings.json")
        self._data: dict[str, object] = self._load()

    @property
    def path(self) -> Path:
        return self._path

    def _load(self) -> dict[str, object]:
        if not self._path.is_file():
            return {"remoteInputEnabled": False}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {"remoteInputEnabled": bool(raw.get("remoteInputEnabled", False)), **raw}
        except Exception:
            pass
        return {"remoteInputEnabled": False}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self._path.with_suffix(".tmp")
        tmp_path.write_text(
            json.dumps(self._data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(tmp_path, self._path)

    def get_remote_input_enabled(self) -> bool:
        """Return whether remote mouse and keyboard control is enabled (default False)."""
        return bool(self._data.get("remoteInputEnabled", False))

    def set_remote_input_enabled(self, enabled: bool) -> bool:
        """Persist remote mouse/keyboard toggle to settings.json cleanly."""
        flag = bool(enabled)
        self._data["remoteInputEnabled"] = flag
        self._save()
        return flag


DEFAULT_CLIENT_DIST_DIR = get_base_dir() / "client" / "dist"
DEFAULT_DEV_WS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")


def extension_id_from_public_key_b64(key_b64: str) -> str:
    """Compute Chrome's 32-char 'a'..'p' extension ID from a base64 SPKI public key."""
    der = base64.b64decode(key_b64.strip())
    digest = hashlib.sha256(der).digest()[:16]
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0x0F)) for b in digest)


def normalize_origin(origin: str | None) -> str:
    """Normalize an HTTP(S) or chrome-extension Origin header, returning '' if invalid."""
    if not origin:
        return ""
    cleaned = origin.strip()
    if cleaned.lower() == "null":
        return ""
    parsed = urlsplit(cleaned)
    if not parsed.scheme or not parsed.netloc:
        return ""
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return ""
    if parsed.username is not None or parsed.password is not None:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


@dataclass(frozen=True, slots=True)
class HostSettings:
    """Runtime settings for the FastAPI host."""

    host: str = "127.0.0.1"
    port: int = 8765
    poll_interval_sec: float = 0.5
    extension_id: str = os.environ.get("PCMEDIA_EXTENSION_ID", DEFAULT_EXTENSION_ID)
    allowed_ws_origins: tuple[str, ...] | None = None
    extra_ws_origins: tuple[str, ...] = ()
    dev_mode: bool = False
    client_dist_dir: Path = DEFAULT_CLIENT_DIST_DIR
    lan_mode: bool = False
    lan_ip: str | None = None
    pairing_manager: PairingManager | None = None

    def get_allowed_ws_origins(self) -> set[str]:
        """Return normalized Origin values permitted to connect to /ws."""
        base: list[str]
        default_port_suffix = "" if self.port == 80 else f":{self.port}"
        if self.allowed_ws_origins is not None:
            base = list(self.allowed_ws_origins)
        else:
            base = [
                f"http://127.0.0.1{default_port_suffix}",
                f"http://localhost{default_port_suffix}",
                f"http://[::1]{default_port_suffix}",
            ]
            if self.lan_mode and self.lan_ip:
                base.append(f"http://{self.lan_ip}{default_port_suffix}")
                try:
                    hostname = socket.gethostname().lower()
                    base.append(f"http://{hostname}.local{default_port_suffix}")
                    base.append(f"http://pcmedia.local{default_port_suffix}")
                except Exception:  # noqa: BLE001
                    pass

        dev_origins = DEFAULT_DEV_WS_ORIGINS if self.dev_mode else ()
        normalized = {
            normalize_origin(item) for item in (*base, *dev_origins, *self.extra_ws_origins)
        }
        normalized.discard("")
        return normalized

    def get_allowed_hosts(self) -> set[str]:
        """Return permitted Host header values to prevent DNS rebinding."""
        port_suffix = f":{self.port}" if self.port != 80 else ""
        allowed = {
            "localhost",
            f"localhost{port_suffix}",
            "127.0.0.1",
            f"127.0.0.1{port_suffix}",
            "[::1]",
            f"[::1]{port_suffix}",
            "testclient",
            "testserver",
            "testserver:80",
        }
        if self.lan_mode and self.lan_ip:
            allowed.add(self.lan_ip)
            allowed.add(f"{self.lan_ip}{port_suffix}")
            try:
                raw_host = socket.gethostname().lower()
                allowed.add(raw_host)
                allowed.add(f"{raw_host}{port_suffix}")
                allowed.add(f"{raw_host}.local")
                allowed.add(f"{raw_host}.local{port_suffix}")
                allowed.add("pcmedia.local")
                allowed.add(f"pcmedia.local{port_suffix}")
            except Exception:  # noqa: BLE001
                pass

        if self.dev_mode:
            allowed.add("localhost:5173")
            allowed.add("127.0.0.1:5173")

        return allowed

    def get_extension_origin(self) -> str:
        """Return the single permitted chrome-extension:// Origin for /ws/extension."""
        ext_id = self.extension_id.strip().lower()
        return f"chrome-extension://{ext_id}" if ext_id else ""
