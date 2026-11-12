"""Protocol v1 Pydantic models for WebSocket client-host communication."""

from __future__ import annotations

import math
import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from host.providers.base import (
    AudioAppInfo,
    MasterVolumeInfo,
    MediaAction,
    MediaSessionInfo,
    MediaStatus,
    PlaybackControls,
)


class ControlsPayload(BaseModel):
    """Supported transport controls for a session."""

    play: bool = False
    pause: bool = False
    toggle: bool = False
    next: bool = False
    previous: bool = False
    seek: bool = False
    skipAd: bool = False


class SessionPayload(BaseModel):
    """Serialized media session entry in a Protocol v1 state broadcast."""

    id: str
    source: str
    app: str
    appId: str
    title: str
    artist: str = ""
    album: str = ""
    artworkUrl: str | None = None
    status: MediaStatus = "UNKNOWN"
    position: float = 0.0
    duration: float = 0.0
    controls: ControlsPayload = Field(default_factory=ControlsPayload)
    volume: float | None = None
    muted: bool | None = None
    isSystemActive: bool = False


class MasterVolumePayload(BaseModel):
    """Default system output volume state."""

    level: float = Field(ge=0.0, le=1.0)
    muted: bool
    deviceName: str


class AudioSessionPayload(BaseModel):
    """Per-application Core Audio volume entry."""

    id: str
    source: str
    app: str
    processName: str
    pid: int
    active: bool
    volume: float = Field(ge=0.0, le=1.0)
    muted: bool


class StateMessage(BaseModel):
    """Server -> client full media and volume state snapshot."""

    v: Literal[1] = 1
    type: Literal["state"] = "state"
    sessions: list[SessionPayload]
    activeSessionId: str | None
    masterVolume: MasterVolumePayload
    audioSessions: list[AudioSessionPayload]
    extensionConnected: bool = False


class ErrorMessage(BaseModel):
    """Server -> client error notification."""

    v: Literal[1] = 1
    type: Literal["error"] = "error"
    code: str
    message: str
    requestId: str | None = None


class PongMessage(BaseModel):
    """Server -> client keepalive acknowledgement."""

    v: Literal[1] = 1
    type: Literal["pong"] = "pong"
    requestId: str | None = None


class CommandMessage(BaseModel):
    """Client -> server playback command."""

    v: Literal[1]
    type: Literal["command"]
    sessionId: str
    action: MediaAction
    value: float | None = None
    requestId: str | None = None

    @model_validator(mode="after")
    def _validate_seek_value(self) -> CommandMessage:
        if self.action == "seek" and (
            self.value is None or not math.isfinite(self.value) or self.value < 0
        ):
            raise ValueError("O comando 'seek' exige 'value' >= 0 em segundos.")
        if self.action == "seek_relative" and (
            self.value is None or not math.isfinite(self.value)
        ):
            raise ValueError("O comando 'seek_relative' exige 'value' finito em segundos.")
        return self


class VolumeMessage(BaseModel):
    """Client -> server volume or mute command."""

    v: Literal[1]
    type: Literal["volume"]
    target: str
    value: float | None = Field(default=None, ge=0.0, le=1.0)
    muted: bool | None = None
    requestId: str | None = None

    @model_validator(mode="after")
    def _validate_target_fields(self) -> VolumeMessage:
        if self.value is None and self.muted is None:
            raise ValueError("O comando 'volume' exige 'value' e/ou 'muted'.")
        return self


class SelectMessage(BaseModel):
    """Client -> server active session selection."""

    v: Literal[1]
    type: Literal["select"]
    sessionId: str
    requestId: str | None = None


class PingMessage(BaseModel):
    """Client -> server keepalive ping."""

    v: Literal[1]
    type: Literal["ping"]
    requestId: str | None = None


class OpenMessage(BaseModel):
    """Client -> server request to open a YouTube search or URL in Chrome."""

    v: Literal[1]
    type: Literal["open"]
    mode: Literal["youtube_search", "url"]
    query: str | None = None
    url: str | None = None
    requestId: str | None = None

    @model_validator(mode="after")
    def _validate_open_target(self) -> OpenMessage:
        if self.mode == "youtube_search":
            if not self.query or not self.query.strip():
                raise ValueError("O modo 'youtube_search' exige 'query' não vazia.")
            self.query = self.query.strip()
            return self

        if not self.url or not self.url.strip():
            raise ValueError("O modo 'url' exige uma URL http/https válida.")
        cleaned_url = self.url.strip()
        parsed = urlsplit(cleaned_url)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Apenas URLs com esquema http:// ou https:// são permitidas.")
        self.url = cleaned_url
        return self


ClientMessage = Annotated[
    CommandMessage | VolumeMessage | SelectMessage | PingMessage | OpenMessage,
    Field(discriminator="type"),
]
_CLIENT_MESSAGE_ADAPTER: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


def parse_client_message(raw: object) -> ClientMessage:
    """Validate and parse an incoming client JSON object against Protocol v1."""
    return _CLIENT_MESSAGE_ADAPTER.validate_python(raw)


_NOTIFICATION_PREFIX_RE = re.compile(r"^\(\d+\+?\)\s*")


def normalize_media_title(raw_title: str | None) -> str:
    """Strip browser/notification unread badges like '(2509) ' or '(1) ' from titles."""
    if not raw_title:
        return ""
    cleaned = raw_title.strip()
    return _NOTIFICATION_PREFIX_RE.sub("", cleaned).strip()


def session_to_payload(session: MediaSessionInfo) -> SessionPayload:
    """Convert domain MediaSessionInfo into Protocol v1 SessionPayload."""
    c: PlaybackControls = session.controls
    return SessionPayload(
        id=session.id,
        source=session.source,
        app=session.app,
        appId=session.app_id,
        title=normalize_media_title(session.title),
        artist=session.artist,
        album=session.album,
        artworkUrl=session.artwork_url,
        status=session.status,
        position=round(session.position, 2),
        duration=round(session.duration, 2),
        controls=ControlsPayload(
            play=c.play,
            pause=c.pause,
            toggle=c.toggle,
            next=c.next,
            previous=c.previous,
            seek=c.seek,
            skipAd=c.skip_ad,
        ),
        volume=round(session.volume, 3) if session.volume is not None else None,
        muted=session.muted,
        isSystemActive=session.is_system_active,
    )


def master_to_payload(master: MasterVolumeInfo) -> MasterVolumePayload:
    """Convert domain MasterVolumeInfo into Protocol v1 MasterVolumePayload."""
    return MasterVolumePayload(
        level=round(max(0.0, min(1.0, master.level)), 3),
        muted=master.muted,
        deviceName=master.device_name,
    )


def audio_app_to_payload(item: AudioAppInfo) -> AudioSessionPayload:
    """Convert domain AudioAppInfo into Protocol v1 AudioSessionPayload."""
    return AudioSessionPayload(
        id=item.id,
        source=item.source,
        app=item.app,
        processName=item.process_name,
        pid=item.pid,
        active=item.active,
        volume=round(max(0.0, min(1.0, item.volume)), 3),
        muted=item.muted,
    )
