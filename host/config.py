"""Configuration settings and origin/extension-ID helpers for the host server."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import socket
import subprocess
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
            "PC Media Control — Como instalar a extensao no Google Chrome\n"
            "======================================================================\n\n"
            "JEITO MAIS RAPIDO (Arrastar e Soltar):\n"
            "1. Abra o Google Chrome e digite: chrome://extensions\n"
            "2. No canto superior direito, ative 'Modo do desenvolvedor'.\n"
            "3. Arraste ESTA PASTA ('extension') direto para dentro da janela\n"
            "   do Chrome.\n\n"
            "ALTERNATIVA (colando o caminho com Ctrl+V):\n"
            "1. Em chrome://extensions com 'Modo do desenvolvedor' ativado,\n"
            "   clique em 'Carregar sem compactacao' (Load unpacked).\n"
            f"2. Cole o caminho abaixo (ja copiado pelo app): {target_dir}\n"
            "======================================================================\n"
        )
        (target_dir / "LEIA-ME.txt").write_text(instructions, encoding="utf-8")

    return target_dir


def copy_text_to_clipboard(text: str) -> bool:
    """Copy text to the Windows clipboard using clip.exe (best-effort)."""
    if sys.platform != "win32":
        return False
    try:
        res = subprocess.run(
            ["clip.exe"],
            input=text.encode("utf-16"),
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return res.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def open_extension_folder_for_install(ext_dir: Path | None = None) -> Path:
    """Sync the extension dir, copy its path, and select it in Explorer for drag-and-drop."""
    target_dir = ext_dir if ext_dir is not None else sync_installed_extension()
    copy_text_to_clipboard(str(target_dir))
    try:
        subprocess.Popen(["explorer.exe", f"/select,{target_dir}"])
    except Exception:  # noqa: BLE001
        if hasattr(os, "startfile"):
            os.startfile(target_dir)
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
        defaults: dict[str, object] = {
            "remoteInputEnabled": False,
            "tailscaleEnabled": False,
            "tailscaleHostname": "",
        }
        if not self._path.is_file():
            return defaults
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {
                    **defaults,
                    **raw,
                    "remoteInputEnabled": bool(raw.get("remoteInputEnabled", False)),
                    "tailscaleEnabled": bool(raw.get("tailscaleEnabled", False)),
                    "tailscaleHostname": sanitize_hostname(
                        str(raw.get("tailscaleHostname") or "")
                    ),
                }
        except Exception:
            pass
        return defaults

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

    def get_tailscale_enabled(self) -> bool:
        """Return whether optional Tailscale remote hosts/origins are permitted."""
        return bool(self._data.get("tailscaleEnabled", False))

    def set_tailscale_enabled(self, enabled: bool) -> bool:
        """Persist optional Tailscale remote access toggle to settings.json cleanly."""
        flag = bool(enabled)
        self._data["tailscaleEnabled"] = flag
        self._save()
        return flag

    def get_tailscale_hostname(self) -> str:
        """Return optional manual Tailscale MagicDNS hostname."""
        return sanitize_hostname(str(self._data.get("tailscaleHostname") or ""))

    def set_tailscale_hostname(self, hostname: str) -> str:
        """Sanitize and persist optional Tailscale MagicDNS hostname."""
        clean = sanitize_hostname(hostname)
        self._data["tailscaleHostname"] = clean
        self._save()
        return clean


DEFAULT_CLIENT_DIST_DIR = get_base_dir() / "client" / "dist"
DEFAULT_DEV_WS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")


def sanitize_hostname(raw: str | None) -> str:
    """Normalize a hostname or MagicDNS FQDN (strips scheme, port, path, trailing dot)."""
    if not raw:
        return ""
    cleaned = raw.strip().lower()
    if "://" in cleaned:
        parsed = urlsplit(cleaned)
        cleaned = (parsed.hostname or "").strip().lower()
    else:
        cleaned = cleaned.split("/", 1)[0].strip()
        if cleaned.count(":") == 1:
            cleaned = cleaned.split(":", 1)[0].strip()
    return cleaned.rstrip(".")


def build_tailscale_hosts_and_origins(
    port: int,
    tailscale_ip: str | None,
    tailscale_hostname: str | None,
) -> tuple[set[str], set[str]]:
    """Build allowed Host headers and WebSocket Origins for Tailscale access."""
    hosts: set[str] = set()
    origins: set[str] = set()
    port_suffix = f":{port}" if port != 80 else ""

    clean_ip = tailscale_ip.strip().lower() if tailscale_ip else ""
    if clean_ip:
        hosts.add(clean_ip)
        hosts.add(f"{clean_ip}{port_suffix}")
        origins.add(f"http://{clean_ip}{port_suffix}")
        origins.add(f"https://{clean_ip}")
        origins.add(f"https://{clean_ip}{port_suffix}")

    clean_host = sanitize_hostname(tailscale_hostname)
    if clean_host:
        hosts.add(clean_host)
        hosts.add(f"{clean_host}{port_suffix}")
        hosts.add(f"{clean_host}:443")
        origins.add(f"https://{clean_host}")
        origins.add(f"https://{clean_host}{port_suffix}")
        origins.add(f"http://{clean_host}")
        origins.add(f"http://{clean_host}{port_suffix}")

    return hosts, origins


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
    tailscale_enabled: bool = False
    tailscale_ip: str | None = None
    tailscale_hostname: str | None = None
    extra_allowed_hosts: tuple[str, ...] = ()

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
            if self.tailscale_enabled:
                _, ts_origins = build_tailscale_hosts_and_origins(
                    self.port,
                    self.tailscale_ip,
                    self.tailscale_hostname,
                )
                base.extend(ts_origins)

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

        if self.tailscale_enabled:
            ts_hosts, _ = build_tailscale_hosts_and_origins(
                self.port,
                self.tailscale_ip,
                self.tailscale_hostname,
            )
            allowed.update(ts_hosts)

        for item in self.extra_allowed_hosts:
            cleaned = item.strip().lower()
            if cleaned:
                allowed.add(cleaned)

        if self.dev_mode:
            allowed.add("localhost:5173")
            allowed.add("127.0.0.1:5173")

        return allowed

    def get_extension_origin(self) -> str:
        """Return the single permitted chrome-extension:// Origin for /ws/extension."""
        ext_id = self.extension_id.strip().lower()
        return f"chrome-extension://{ext_id}" if ext_id else ""
