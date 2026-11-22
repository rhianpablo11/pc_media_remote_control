"""Protocol v1 Pydantic models for WebSocket client-host communication."""

from __future__ import annotations

import math
import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from host.input_control import ALLOWED_REMOTE_KEYS, is_dangerous_key_combo
from host.providers.base import (
    AudioAppInfo,
    MasterVolumeInfo,
    MediaAction,
    MediaSessionInfo,
    MediaStatus,
    MouseButton,
    PlaybackControls,
)

YOUTUBE_VIDEO_ID_REGEX = re.compile(r"^[A-Za-z0-9_-]{11}$")


class ControlsPayload(BaseModel):
    """Supported transport controls for a session."""

    play: bool = False
    pause: bool = False
    toggle: bool = False
    next: bool = False
    previous: bool = False
    seek: bool = False
    skipAd: bool = False
    fullscreen: bool = False


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
    isFullscreen: bool = False


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
    remoteInputEnabled: bool = False


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


class AckMessage(BaseModel):
    """Server -> client command/volume acknowledgement with latency telemetry."""

    v: Literal[1] = 1
    type: Literal["ack"] = "ack"
    requestId: str | None = None
    ok: bool = True
    clientSentAt: float | None = None
    execMs: float = 0.0
    target: str | None = None
    reason: str | None = None


class CommandMessage(BaseModel):
    """Client -> server playback command."""

    v: Literal[1]
    type: Literal["command"]
    sessionId: str | None = None
    action: MediaAction
    value: float | None = None
    videoId: str | None = None
    mode: Literal["current_tab", "new_tab"] | None = None
    fullscreen: bool | None = None
    requestId: str | None = None
    clientSentAt: float | None = None

    @model_validator(mode="after")
    def _validate_command(self) -> CommandMessage:
        if self.action in {"seek", "seek_relative"}:
            if self.value is None or not math.isfinite(self.value):
                raise ValueError("O comando 'seek'/'seek_relative' exige 'value' numérico.")
            if self.action == "seek" and self.value < 0:
                raise ValueError("O comando 'seek' exige 'value' >= 0 em segundos.")
        if self.action == "play_video" and (
            not self.videoId or not YOUTUBE_VIDEO_ID_REGEX.match(self.videoId)
        ):
            raise ValueError("O comando 'play_video' exige 'videoId' de 11 caracteres válido.")
        return self


class VolumeMessage(BaseModel):
    """Client -> server volume or mute command."""

    v: Literal[1]
    type: Literal["volume"]
    target: str
    value: float | None = Field(default=None, ge=0.0, le=1.0)
    muted: bool | None = None
    requestId: str | None = None
    clientSentAt: float | None = None

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
    clientSentAt: float | None = None


class PingMessage(BaseModel):
    """Client -> server keepalive ping."""

    v: Literal[1]
    type: Literal["ping"]
    requestId: str | None = None
    clientSentAt: float | None = None


class OpenMessage(BaseModel):
    """Client -> server request to open a YouTube search or URL in Chrome."""

    v: Literal[1]
    type: Literal["open"]
    mode: Literal["youtube_search", "url"]
    query: str | None = None
    url: str | None = None
    requestId: str | None = None
    clientSentAt: float | None = None

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


class AuthMessage(BaseModel):
    """Client -> server authentication handshake message."""

    v: Literal[1] = 1
    type: Literal["auth"] = "auth"
    token: str
    requestId: str | None = None


class SearchMessage(BaseModel):
    """Client -> server request to search YouTube via the extension."""

    v: Literal[1] = 1
    type: Literal["search"] = "search"
    query: str
    requestId: str | None = None
    clientSentAt: float | None = None

    @model_validator(mode="after")
    def _validate_query(self) -> SearchMessage:
        cleaned = self.query.strip() if self.query else ""
        if not cleaned:
            raise ValueError("O comando 'search' exige 'query' não vazia.")
        if len(cleaned) > 120:
            cleaned = cleaned[:120]
        self.query = cleaned
        return self


class SearchResultItem(BaseModel):
    """Single parsed video search result."""

    id: str
    title: str
    channel: str = ""
    duration: str = ""
    views: str = ""
    thumbnail: str = ""
    isLive: bool = False
    isShorts: bool = False


class SearchResultsMessage(BaseModel):
    """Server -> client response with parsed YouTube video search results."""

    v: Literal[1] = 1
    type: Literal["search_results"] = "search_results"
    requestId: str | None = None
    ok: bool = True
    query: str = ""
    results: list[SearchResultItem] = Field(default_factory=list)
    fallbackUrl: str | None = None
    error: str | None = None
    reason: str | None = None


InputAction = Literal[
    "mouse_move",
    "mouse_click",
    "mouse_down",
    "mouse_up",
    "mouse_scroll",
    "key_text",
    "key_press",
]
ModifierKey = Literal["ctrl", "alt", "shift", "win"]


class InputMessage(BaseModel):
    """Client -> server remote touchpad mouse and keyboard input event."""

    v: Literal[1] = 1
    type: Literal["input"] = "input"
    action: InputAction
    dx: int | None = None
    dy: int | None = None
    button: MouseButton | None = None
    double: bool = False
    text: str | None = None
    key: str | None = None
    modifiers: list[ModifierKey] = Field(default_factory=list)
    requestId: str | None = None
    clientSentAt: float | None = None

    @model_validator(mode="after")
    def _validate_input_payload(self) -> InputMessage:
        if self.action == "mouse_move":
            if self.dx is None or self.dy is None:
                raise ValueError("O evento 'mouse_move' exige 'dx' e 'dy' inteiros.")
            if not (-500 <= self.dx <= 500) or not (-500 <= self.dy <= 500):
                raise ValueError("Deltas de 'mouse_move' devem estar entre -500 e 500.")
            return self

        if self.action == "mouse_scroll":
            if self.dx is None and self.dy is None:
                raise ValueError("O evento 'mouse_scroll' exige 'dx' e/ou 'dy'.")
            if self.dx is not None and not (-1200 <= self.dx <= 1200):
                raise ValueError("Delta 'dx' de 'mouse_scroll' deve estar entre -1200 e 1200.")
            if self.dy is not None and not (-1200 <= self.dy <= 1200):
                raise ValueError("Delta 'dy' de 'mouse_scroll' deve estar entre -1200 e 1200.")
            if self.dx is None:
                self.dx = 0
            if self.dy is None:
                self.dy = 0
            return self

        if self.action in {"mouse_click", "mouse_down", "mouse_up"}:
            if self.button is None:
                self.button = "left"
            return self

        if self.action == "key_text":
            if self.text is None or len(self.text) == 0:
                raise ValueError("O evento 'key_text' exige 'text' não vazio.")
            if "\x00" in self.text:
                raise ValueError("O evento 'key_text' não aceita bytes nulos.")
            if len(self.text) > 500:
                raise ValueError("O evento 'key_text' aceita no máximo 500 caracteres.")
            return self

        # key_press
        if not self.key or not self.key.strip():
            raise ValueError("O evento 'key_press' exige 'key'.")
        norm_key = self.key.strip().lower()
        if norm_key not in ALLOWED_REMOTE_KEYS:
            raise ValueError(f"Tecla '{norm_key}' não permitida no controle remoto.")
        dedup_mods: list[ModifierKey] = []
        for mod in self.modifiers:
            if mod not in dedup_mods:
                dedup_mods.append(mod)
        if is_dangerous_key_combo(norm_key, dedup_mods):
            raise ValueError("Combinação de teclas bloqueada por segurança.")
        self.key = norm_key
        self.modifiers = dedup_mods
        return self


class SettingsMessage(BaseModel):
    """Client -> server host security settings toggle (e.g. remote touchpad/keyboard)."""

    v: Literal[1] = 1
    type: Literal["settings"] = "settings"
    remoteInputEnabled: bool
    requestId: str | None = None
    clientSentAt: float | None = None


ClientMessage = Annotated[
    CommandMessage
    | VolumeMessage
    | SelectMessage
    | PingMessage
    | OpenMessage
    | AuthMessage
    | SearchMessage
    | InputMessage
    | SettingsMessage,
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
            fullscreen=c.fullscreen,
        ),
        volume=round(session.volume, 3) if session.volume is not None else None,
        muted=session.muted,
        isSystemActive=session.is_system_active,
        isFullscreen=session.is_fullscreen,
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


ServerMessage = Annotated[
    StateMessage | ErrorMessage | PongMessage | AckMessage | SearchResultsMessage,
    Field(discriminator="type"),
]
_SERVER_MESSAGE_ADAPTER: TypeAdapter[ServerMessage] = TypeAdapter(ServerMessage)


def parse_server_message(raw: object) -> ServerMessage:
    """Validate and parse an outgoing server JSON object against Protocol v1."""
    return _SERVER_MESSAGE_ADAPTER.validate_python(raw)
