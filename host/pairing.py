"""Pairing session management, one-time code/PIN exchange, and persistent device authorization."""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import logging
import os
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import qrcode
import qrcode.image.svg

logger = logging.getLogger(__name__)

DEFAULT_PAIRING_TTL_SEC = 300.0  # 5 minutes
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION_SEC = 300.0  # 5 minutes


def get_default_devices_file_path() -> Path:
    """Return %LOCALAPPDATA%\\PCMediaControl\\devices.json or ~/.pcmediacontrol/devices.json."""
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        base = Path(local_app_data) / "PCMediaControl"
    else:
        base = Path.home() / ".pcmediacontrol"
    base.mkdir(parents=True, exist_ok=True)
    return base / "devices.json"


def hash_token(token: str) -> str:
    """Compute deterministic SHA-256 hex digest of an authentication token."""
    return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()


@dataclass
class PairedDevice:
    """Authorized device record stored persistently on the host."""

    id: str
    name: str
    token_hash: str
    created_at: str
    last_seen_at: str

    def to_public_dict(self) -> dict[str, Any]:
        """Return public representation without token hash."""
        return {
            "id": self.id,
            "name": self.name,
            "createdAt": self.created_at,
            "lastSeenAt": self.last_seen_at,
        }


@dataclass
class ActivePairingSession:
    """Current temporary code and PIN available for pairing."""

    code: str
    pin: str
    created_at: float
    expires_at: float

    @property
    def is_expired(self) -> bool:
        return time.time() >= self.expires_at

    @property
    def seconds_remaining(self) -> int:
        return max(0, int(self.expires_at - time.time()))


class PairingManager:
    """Manages short-lived pairing sessions and persistent authorized devices."""

    def __init__(
        self,
        storage_path: Path | None = None,
        ttl_sec: float = DEFAULT_PAIRING_TTL_SEC,
    ) -> None:
        self.storage_path = storage_path or get_default_devices_file_path()
        self.ttl_sec = ttl_sec
        self._devices: dict[str, PairedDevice] = {}
        self._devices_by_hash: dict[str, PairedDevice] = {}
        self._active_session: ActivePairingSession | None = None
        self._failed_attempts: int = 0
        self._lockout_until: float = 0.0
        self._on_device_revoked: Callable[[str], None] | None = None
        self._load_devices()

    def set_on_device_revoked(self, callback: Callable[[str], None] | None) -> None:
        """Register callback invoked with device_id when a device is revoked."""
        self._on_device_revoked = callback

    def _load_devices(self) -> None:
        if not self.storage_path.is_file():
            return
        try:
            raw = json.loads(self.storage_path.read_text(encoding="utf-8"))
            dev_list = raw.get("devices") or []
            for item in dev_list:
                dev = PairedDevice(
                    id=str(item["id"]),
                    name=str(item.get("name") or "Dispositivo"),
                    token_hash=str(item["token_hash"]),
                    created_at=str(item.get("created_at") or datetime.now(UTC).isoformat()),
                    last_seen_at=str(item.get("last_seen_at") or datetime.now(UTC).isoformat()),
                )
                self._devices[dev.id] = dev
                self._devices_by_hash[dev.token_hash] = dev
        except Exception:  # noqa: BLE001
            logger.exception("Falha ao carregar devices.json em %s", self.storage_path)

    def _save_devices(self) -> None:
        try:
            self.storage_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "devices": [
                    {
                        "id": d.id,
                        "name": d.name,
                        "token_hash": d.token_hash,
                        "created_at": d.created_at,
                        "last_seen_at": d.last_seen_at,
                    }
                    for d in self._devices.values()
                ]
            }
            tmp_path = self.storage_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp_path.replace(self.storage_path)
        except Exception:  # noqa: BLE001
            logger.exception("Falha ao salvar devices.json em %s", self.storage_path)

    @property
    def is_locked_out(self) -> bool:
        """Whether verification is temporarily blocked due to excessive failed attempts."""
        return time.time() < self._lockout_until

    @property
    def lockout_seconds_remaining(self) -> int:
        return max(0, int(self._lockout_until - time.time()))

    def get_or_create_pairing_session(self, force_new: bool = False) -> ActivePairingSession:
        """Return the active valid pairing session or create a new code and PIN."""
        now = time.time()
        if (
            not force_new
            and self._active_session is not None
            and not self._active_session.is_expired
        ):
            return self._active_session

        code = secrets.token_urlsafe(16)
        pin = f"{secrets.randbelow(1_000_000):06d}"
        session = ActivePairingSession(
            code=code,
            pin=pin,
            created_at=now,
            expires_at=now + self.ttl_sec,
        )
        self._active_session = session
        return session

    def verify_and_pair(
        self,
        code_or_pin: str,
        device_name: str | None = None,
    ) -> tuple[bool, str, dict[str, Any] | None]:
        """Exchange single-use code or PIN for a long-lived auth token.

        Returns (ok, message_or_error_code, result_dict_or_none).
        """
        now = time.time()
        if self.is_locked_out:
            sec = self.lockout_seconds_remaining
            return (
                False,
                f"Bloqueado temporariamente por excesso de tentativas. Tente novamente em {sec}s.",
                None,
            )

        session = self._active_session
        if session is None or session.is_expired:
            self._failed_attempts += 1
            if self._failed_attempts >= MAX_FAILED_ATTEMPTS:
                self._lockout_until = now + LOCKOUT_DURATION_SEC
            return False, "Código de pareamento expirado ou inexistente. Gere um novo no PC.", None

        submitted = code_or_pin.strip()
        matches_code = secrets.compare_digest(session.code, submitted)
        # Allow PIN with or without space (e.g. "123 456" vs "123456")
        clean_pin = submitted.replace(" ", "").replace("-", "")
        matches_pin = secrets.compare_digest(session.pin, clean_pin)

        if not matches_code and not matches_pin:
            self._failed_attempts += 1
            if self._failed_attempts >= MAX_FAILED_ATTEMPTS:
                self._lockout_until = now + LOCKOUT_DURATION_SEC
                lockout_s = int(LOCKOUT_DURATION_SEC)
                return (
                    False,
                    f"Tentativas excedidas. Bloqueado temporariamente por {lockout_s}s.",
                    None,
                )
            remaining = MAX_FAILED_ATTEMPTS - self._failed_attempts
            return False, f"Código ou PIN inválido. {remaining} tentativa(s) restante(s).", None

        # Burn code immediately (single use)
        self._active_session = None
        self._failed_attempts = 0

        # Generate long-lived bearer token
        raw_token = secrets.token_urlsafe(32)
        thash = hash_token(raw_token)
        device_id = f"dev_{secrets.token_hex(6)}"
        now_iso = datetime.now(UTC).isoformat()
        clean_name = (device_name or "Dispositivo").strip()[:64] or "Dispositivo"

        dev = PairedDevice(
            id=device_id,
            name=clean_name,
            token_hash=thash,
            created_at=now_iso,
            last_seen_at=now_iso,
        )
        self._devices[device_id] = dev
        self._devices_by_hash[thash] = dev
        self._save_devices()

        logger.info("Dispositivo pareado com sucesso: %s (%s)", dev.name, dev.id)
        return (
            True,
            "Pareamento concluído com sucesso.",
            {
                "token": raw_token,
                "deviceId": dev.id,
                "deviceName": dev.name,
            },
        )

    def validate_token(self, raw_token: str | None) -> PairedDevice | None:
        """Validate bearer token against authorized device hashes and update last_seen_at."""
        if not raw_token:
            return None
        thash = hash_token(raw_token)
        dev = self._devices_by_hash.get(thash)
        if dev is None:
            return None
        dev.last_seen_at = datetime.now(UTC).isoformat()
        return dev

    def list_devices(self) -> list[dict[str, Any]]:
        """Return list of authorized paired devices without sensitive token hashes."""
        return [dev.to_public_dict() for dev in self._devices.values()]

    def revoke_device(self, device_id: str) -> bool:
        """Revoke authorization for a device, remove from store, and trigger disconnect."""
        dev = self._devices.pop(device_id, None)
        if dev is None:
            return False
        self._devices_by_hash.pop(dev.token_hash, None)
        self._save_devices()
        logger.info("Dispositivo revogado: %s (%s)", dev.name, device_id)
        if self._on_device_revoked is not None:
            with contextlib.suppress(Exception):
                self._on_device_revoked(device_id)
        return True


def render_qr_ascii(url: str) -> str:
    """Render a compact ASCII QR code string for terminal printing."""
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.make(fit=True)
    f = io.StringIO()
    qr.print_ascii(out=f, invert=True)
    return f.getvalue()


def render_qr_data_url(url: str) -> str:
    """Render a Base64 SVG data URL for HTML/browser embedding without PIL."""
    qr = qrcode.QRCode(border=2, image_factory=qrcode.image.svg.SvgPathImage)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image()
    buf = io.BytesIO()
    img.save(buf)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"
