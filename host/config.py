"""Configuration settings and origin/extension-ID helpers for the host server."""

from __future__ import annotations

import base64
import hashlib
import os
import socket
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from host.pairing import PairingManager

DEFAULT_EXTENSION_ID = "dcnkokmkhlcocfengaobkeacnbdjdcfa"
DEFAULT_CLIENT_DIST_DIR = Path(__file__).resolve().parent.parent / "client" / "dist"
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
