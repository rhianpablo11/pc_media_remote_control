"""Chrome MV3 extension SessionProvider communicating over localhost WebSocket."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Literal, Protocol

from host.providers.base import (
    MediaAction,
    MediaSessionInfo,
    MediaStatus,
    PlaybackControls,
)


class ExtensionTransport(Protocol):
    """Minimal async JSON transport implemented by FastAPI WebSocket."""

    async def send_json(self, data: Any) -> None:
        """Send a JSON-serializable payload to the connected extension."""
        ...


def _normalize_status(raw: str | None) -> MediaStatus:
    allowed: set[str] = {"PLAYING", "PAUSED", "STOPPED", "CHANGING", "OPENED", "CLOSED"}
    if raw and raw.upper() in allowed:
        return raw.upper()  # type: ignore[return-value]
    return "UNKNOWN"


def parse_chrome_tab_session(raw_tab: dict[str, Any]) -> MediaSessionInfo:
    """Convert an extension tab payload into a unified MediaSessionInfo."""
    tab_id = str(raw_tab.get("tabId") or raw_tab.get("id") or "").removeprefix("chrome:")
    raw_controls = raw_tab.get("controls") or {}
    controls = PlaybackControls(
        play=bool(raw_controls.get("play", True)),
        pause=bool(raw_controls.get("pause", True)),
        toggle=bool(raw_controls.get("toggle", True)),
        next=bool(raw_controls.get("next", False)),
        previous=bool(raw_controls.get("previous", False)),
        seek=bool(raw_controls.get("seek", True)),
        skip_ad=bool(raw_controls.get("skipAd", raw_controls.get("skip_ad", False))),
    )
    volume_raw = raw_tab.get("volume")
    volume = max(0.0, min(1.0, float(volume_raw))) if volume_raw is not None else None
    muted_raw = raw_tab.get("muted")
    muted = bool(muted_raw) if muted_raw is not None else None

    return MediaSessionInfo(
        id=f"chrome:{tab_id}",
        source="chrome",
        app=str(raw_tab.get("app") or "Google Chrome"),
        app_id="chrome.exe",
        title=str(raw_tab.get("title") or ""),
        artist=str(raw_tab.get("artist") or raw_tab.get("channel") or ""),
        album=str(raw_tab.get("album") or ""),
        artwork_url=str(raw_tab["artworkUrl"]) if raw_tab.get("artworkUrl") else None,
        status=_normalize_status(raw_tab.get("status")),
        position=max(0.0, float(raw_tab.get("position") or 0.0)),
        duration=max(0.0, float(raw_tab.get("duration") or 0.0)),
        controls=controls,
        volume=volume,
        muted=muted,
        is_system_active=bool(raw_tab.get("active", False)),
    )


class ChromeExtensionProvider:
    """SessionProvider backed by a connected Chrome MV3 extension over localhost WebSocket."""

    def __init__(self, command_timeout_sec: float = 2.0) -> None:
        self._transport: ExtensionTransport | None = None
        self._sessions: list[MediaSessionInfo] = []
        self._pending: dict[str, asyncio.Future[bool]] = {}
        self._command_timeout_sec = command_timeout_sec
        self._on_change: Callable[[], Awaitable[None]] | None = None

    @property
    def source(self) -> str:
        return "chrome"

    @property
    def is_connected(self) -> bool:
        return self._transport is not None

    def set_on_change(self, callback: Callable[[], Awaitable[None]] | None) -> None:
        """Register an async callback invoked whenever extension tabs update."""
        self._on_change = callback

    def attach(self, transport: ExtensionTransport) -> None:
        """Attach an active extension WebSocket transport."""
        self._fail_pending()
        self._transport = transport

    def detach(self, transport: ExtensionTransport | None = None) -> None:
        """Detach the extension transport and clear cached Chrome tab sessions."""
        if transport is not None and self._transport is not transport:
            return
        self._transport = None
        self._sessions = []
        self._fail_pending()

    def _fail_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_result(False)
        self._pending.clear()

    async def handle_message(self, payload: dict[str, Any]) -> None:
        """Process an incoming JSON message from the Chrome extension."""
        msg_type = payload.get("type")
        if msg_type == "extension_state":
            raw_tabs = payload.get("tabs") or []
            self._sessions = [
                parse_chrome_tab_session(tab) for tab in raw_tabs if isinstance(tab, dict)
            ]
            if self._on_change is not None:
                await self._on_change()
            return

        if msg_type == "extension_ack":
            req_id = str(payload.get("requestId") or "")
            future = self._pending.pop(req_id, None)
            if future is not None and not future.done():
                future.set_result(bool(payload.get("ok", False)))
            return

        if msg_type == "ping" and self._transport is not None:
            await self._transport.send_json(
                {
                    "v": 1,
                    "type": "pong",
                    "ts": payload.get("ts"),
                }
            )

    async def list_sessions(self) -> list[MediaSessionInfo]:
        """Return Chrome tab media sessions reported by the connected extension."""
        if not self.is_connected:
            return []
        return list(self._sessions)

    async def _send_request(self, payload: dict[str, Any]) -> bool:
        if self._transport is None:
            return False

        req_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._pending[req_id] = future

        message = {"v": 1, "requestId": req_id, **payload}
        try:
            await self._transport.send_json(message)
            return await asyncio.wait_for(future, timeout=self._command_timeout_sec)
        except (TimeoutError, OSError, RuntimeError):
            return False
        finally:
            self._pending.pop(req_id, None)

    async def execute_command(
        self,
        session_id: str,
        action: MediaAction,
        value: float | None = None,
    ) -> bool:
        """Forward a transport control command to a Chrome tab via the extension."""
        if not self.is_connected or not session_id.startswith("chrome:"):
            return False
        tab_id = session_id[len("chrome:") :]
        payload: dict[str, Any] = {
            "type": "command",
            "sessionId": session_id,
            "tabId": tab_id,
            "action": action,
        }
        if value is not None:
            payload["value"] = value
        return await self._send_request(payload)

    async def set_session_volume(
        self,
        session_id: str,
        level: float | None = None,
        muted: bool | None = None,
    ) -> bool:
        """Forward a per-tab volume/mute command to the Chrome extension."""
        if not self.is_connected or not session_id.startswith("chrome:"):
            return False
        tab_id = session_id[len("chrome:") :]
        payload: dict[str, Any] = {
            "type": "volume",
            "sessionId": session_id,
            "tabId": tab_id,
        }
        if level is not None:
            payload["value"] = max(0.0, min(1.0, float(level)))
        if muted is not None:
            payload["muted"] = bool(muted)
        return await self._send_request(payload)

    async def open_in_browser(
        self,
        mode: Literal["youtube_search", "url"],
        query: str | None = None,
        url: str | None = None,
    ) -> bool:
        """Ask the extension to open a YouTube search or URL in a new Chrome tab."""
        if not self.is_connected:
            return False
        payload: dict[str, Any] = {
            "type": "open",
            "mode": mode,
        }
        if query is not None:
            payload["query"] = query
        if url is not None:
            payload["url"] = url
        return await self._send_request(payload)
