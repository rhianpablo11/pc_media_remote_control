"""Abstract session and audio provider contracts for the host."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

MediaStatus = Literal[
    "PLAYING",
    "PAUSED",
    "STOPPED",
    "CHANGING",
    "OPENED",
    "CLOSED",
    "UNKNOWN",
]
MediaAction = Literal[
    "play",
    "pause",
    "toggle",
    "next",
    "previous",
    "seek",
    "seek_relative",
    "skip_ad",
]


@dataclass(frozen=True, slots=True)
class PlaybackControls:
    """Transport actions supported by a media session."""

    play: bool = False
    pause: bool = False
    toggle: bool = False
    next: bool = False
    previous: bool = False
    seek: bool = False
    skip_ad: bool = False


@dataclass(frozen=True, slots=True)
class MediaSessionInfo:
    """Unified media session model exposed by any SessionProvider."""

    id: str
    source: str
    app: str
    app_id: str
    title: str
    artist: str = ""
    album: str = ""
    artwork_url: str | None = None
    status: MediaStatus = "UNKNOWN"
    position: float = 0.0
    duration: float = 0.0
    controls: PlaybackControls = field(default_factory=PlaybackControls)
    volume: float | None = None
    muted: bool | None = None
    is_system_active: bool = False


@dataclass(frozen=True, slots=True)
class AudioAppInfo:
    """Per-application Core Audio session exposed by the system provider."""

    id: str
    source: str
    app: str
    process_name: str
    pid: int
    active: bool
    volume: float
    muted: bool


@dataclass(frozen=True, slots=True)
class MasterVolumeInfo:
    """Default system audio output endpoint state."""

    level: float
    muted: bool
    device_name: str


class SessionProvider(Protocol):
    """Contract for a media session source (Windows GSMTC, Chrome extension, etc.)."""

    @property
    def source(self) -> str:
        """Short origin identifier included in session IDs (e.g. 'windows', 'chrome')."""
        ...

    @property
    def is_connected(self) -> bool:
        """Whether this provider is currently active/connected."""
        ...

    async def list_sessions(self) -> list[MediaSessionInfo]:
        """Return currently available media sessions from this provider."""
        ...

    async def execute_command(
        self,
        session_id: str,
        action: MediaAction,
        value: float | None = None,
    ) -> bool:
        """Execute a playback transport command on a session owned by this provider."""
        ...

    async def set_session_volume(
        self,
        session_id: str,
        level: float | None = None,
        muted: bool | None = None,
    ) -> bool:
        """Set per-session volume/mute when supported natively by the provider."""
        ...


class AudioControlProvider(Protocol):
    """Contract for OS master/per-app volume control and media-key fallback."""

    async def get_master_volume(self) -> MasterVolumeInfo:
        """Read current master volume and mute state."""
        ...

    async def set_master_volume(
        self,
        level: float | None = None,
        muted: bool | None = None,
    ) -> MasterVolumeInfo:
        """Update master volume level (0..1) and/or mute state."""
        ...

    async def list_audio_apps(self) -> list[AudioAppInfo]:
        """List active/recent per-application audio sessions."""
        ...

    async def set_audio_app_volume(
        self,
        app_audio_id: str,
        level: float | None = None,
        muted: bool | None = None,
    ) -> bool:
        """Update volume (0..1) and/or mute state for a specific app audio ID."""
        ...

    async def send_media_key(self, action: MediaAction) -> bool:
        """Send a global OS media key as fallback for apps without GSMTC (e.g. VLC 3.x)."""
        ...
