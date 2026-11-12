"""Configuration settings and origin/extension-ID helpers for the host server."""

from __future__ import annotations

import base64
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

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

    def get_allowed_ws_origins(self) -> set[str]:
        """Return normalized Origin values permitted to connect to /ws."""
        base: tuple[str, ...]
        if self.allowed_ws_origins is not None:
            base = self.allowed_ws_origins
        else:
            default_port_suffix = "" if self.port == 80 else f":{self.port}"
            base = (
                f"http://127.0.0.1{default_port_suffix}",
                f"http://localhost{default_port_suffix}",
                f"http://[::1]{default_port_suffix}",
            )
        dev_origins = DEFAULT_DEV_WS_ORIGINS if self.dev_mode else ()
        normalized = {
            normalize_origin(item) for item in (*base, *dev_origins, *self.extra_ws_origins)
        }
        normalized.discard("")
        return normalized

    def get_extension_origin(self) -> str:
        """Return the single permitted chrome-extension:// Origin for /ws/extension."""
        ext_id = self.extension_id.strip().lower()
        return f"chrome-extension://{ext_id}" if ext_id else ""
