"""Windows SessionProvider and AudioControlProvider using GSMTC, Core Audio, and media keys."""

from __future__ import annotations

import asyncio
import ctypes
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

from host.providers.base import (
    AudioAppInfo,
    MasterVolumeInfo,
    MediaAction,
    MediaSessionInfo,
    MediaStatus,
    PlaybackControls,
)

TICKS_PER_SECOND = 10_000_000
KEYEVENTF_KEYUP = 0x0002
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_PLAY_PAUSE = 0xB3

_FRIENDLY_APP_NAMES: dict[str, str] = {
    "spotify.exe": "Spotify",
    "chrome.exe": "Google Chrome",
    "msedge.exe": "Microsoft Edge",
    "vlc.exe": "VLC",
    "firefox.exe": "Firefox",
    "systemsounds": "Sons do Sistema",
}


def friendly_app_name(app_id: str) -> str:
    """Convert an AUMID or executable name into a readable app label."""
    if not app_id:
        return "Aplicativo"
    lower = app_id.lower()
    if lower in _FRIENDLY_APP_NAMES:
        return _FRIENDLY_APP_NAMES[lower]
    if "!" in app_id:
        suffix = app_id.rsplit("!", 1)[-1]
        if suffix and suffix.lower() != "app":
            return suffix
        prefix = app_id.split("!", 1)[0].split("_", 1)[0]
        return prefix.rsplit(".", 1)[-1]
    if lower.endswith(".exe"):
        return app_id[:-4]
    return app_id


def estimate_position_seconds(
    reported_position: timedelta,
    end_time: timedelta,
    last_updated: datetime | None,
    status_name: str,
    now_utc: datetime | None = None,
) -> float:
    """Extrapolate current playback position from GSMTC last_updated_time while playing."""
    pos_sec = max(0.0, reported_position.total_seconds())
    end_sec = max(0.0, end_time.total_seconds())
    if status_name != "PLAYING" or last_updated is None or last_updated.year <= 1601:
        return min(pos_sec, end_sec) if end_sec > 0 else pos_sec

    ref_now = now_utc or datetime.now(UTC)
    updated_utc = (
        last_updated.replace(tzinfo=UTC)
        if last_updated.tzinfo is None
        else last_updated.astimezone(UTC)
    )
    elapsed = max(0.0, (ref_now - updated_utc).total_seconds())
    estimated = pos_sec + elapsed
    if end_sec > 0:
        return min(estimated, end_sec)
    return estimated


def parse_windows_session_id(session_id: str) -> tuple[str, int] | None:
    """Parse 'windows:<app_id>:<occurrence>' into (app_id, occurrence)."""
    if not session_id.startswith("windows:"):
        return None
    rest = session_id[len("windows:") :]
    if ":" not in rest:
        return None
    app_id, idx_str = rest.rsplit(":", 1)
    try:
        idx = int(idx_str)
    except ValueError:
        return None
    if idx < 0:
        return None
    return app_id, idx


def _session_signature(session: Any) -> tuple[str, str, float, float]:
    info = session.get_playback_info()
    tl = session.get_timeline_properties()
    last_upd = tl.last_updated_time.timestamp() if tl.last_updated_time.year > 1601 else 0.0
    return (
        session.source_app_user_model_id or "",
        info.playback_status.name,
        tl.end_time.total_seconds(),
        last_upd,
    )


def _normalize_status(name: str) -> MediaStatus:
    allowed: set[str] = {"PLAYING", "PAUSED", "STOPPED", "CHANGING", "OPENED", "CLOSED"}
    if name in allowed:
        return name  # type: ignore[return-value]
    return "UNKNOWN"


class WindowsProvider:
    """Windows system media/volume provider backed by GSMTC, Pycaw, and media keys."""

    FALLBACK_SESSION_ID = "windows:fallback"

    def __init__(self) -> None:
        self._com_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pycaw-com")
        self._com_thread_state = threading.local()

    @property
    def source(self) -> str:
        return "windows"

    @property
    def is_connected(self) -> bool:
        return True

    def close(self) -> None:
        """Shut down the dedicated COM worker executor."""
        self._com_executor.shutdown(wait=False)

    def _ensure_com_initialized(self) -> None:
        if getattr(self._com_thread_state, "initialized", False):
            return
        import comtypes

        comtypes.CoInitialize()
        self._com_thread_state.initialized = True

    async def _run_com(self, fn: Any, *args: Any) -> Any:
        loop = asyncio.get_running_loop()

        def _wrapper() -> Any:
            self._ensure_com_initialized()
            return fn(*args)

        return await loop.run_in_executor(self._com_executor, _wrapper)

    async def list_sessions(self) -> list[MediaSessionInfo]:
        """List all GSMTC sessions with origin-prefixed deterministic IDs."""
        from winrt.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        )
        from winrt.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
        )

        manager = await SessionManager.request_async()
        current = manager.get_current_session()
        current_sig = _session_signature(current) if current is not None else None
        sessions = list(manager.get_sessions())

        app_counts: dict[str, int] = {}
        results: list[MediaSessionInfo] = []
        for sess in sessions:
            app_id = sess.source_app_user_model_id or "unknown"
            occ = app_counts.get(app_id, 0)
            app_counts[app_id] = occ + 1

            info = sess.get_playback_info()
            ctrl = info.controls
            tl = sess.get_timeline_properties()
            status_name = PlaybackStatus(info.playback_status).name
            is_current = current_sig is not None and _session_signature(sess) == current_sig

            title = ""
            artist = ""
            album = ""
            try:
                props = await sess.try_get_media_properties_async()
                if props is not None:
                    title = props.title or ""
                    artist = props.artist or ""
                    album = props.album_title or ""
            except Exception:  # noqa: BLE001
                pass

            pos_sec = estimate_position_seconds(
                tl.position,
                tl.end_time,
                tl.last_updated_time,
                status_name,
            )
            dur_sec = max(0.0, tl.end_time.total_seconds())

            results.append(
                MediaSessionInfo(
                    id=f"windows:{app_id}:{occ}",
                    source=self.source,
                    app=friendly_app_name(app_id),
                    app_id=app_id,
                    title=title,
                    artist=artist,
                    album=album,
                    artwork_url=None,
                    status=_normalize_status(status_name),
                    position=pos_sec,
                    duration=dur_sec,
                    controls=PlaybackControls(
                        play=bool(ctrl.is_play_enabled),
                        pause=bool(ctrl.is_pause_enabled),
                        toggle=bool(ctrl.is_play_pause_toggle_enabled),
                        next=bool(ctrl.is_next_enabled),
                        previous=bool(ctrl.is_previous_enabled),
                        seek=bool(ctrl.is_playback_position_enabled),
                    ),
                    is_system_active=is_current,
                )
            )
        return results

    async def execute_command(
        self,
        session_id: str,
        action: MediaAction,
        value: float | None = None,
    ) -> bool:
        """Execute a GSMTC command on a Windows session or global media-key fallback."""
        if session_id == self.FALLBACK_SESSION_ID:
            return await self.send_media_key(action)

        parsed = parse_windows_session_id(session_id)
        if parsed is None:
            return False
        target_app_id, target_occ = parsed

        from winrt.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        )

        manager = await SessionManager.request_async()
        app_counts: dict[str, int] = {}
        target_session: Any = None
        for sess in manager.get_sessions():
            app_id = sess.source_app_user_model_id or "unknown"
            occ = app_counts.get(app_id, 0)
            app_counts[app_id] = occ + 1
            if app_id == target_app_id and occ == target_occ:
                target_session = sess
                break

        if target_session is None:
            return False

        if action == "play":
            return bool(await target_session.try_play_async())
        if action == "pause":
            return bool(await target_session.try_pause_async())
        if action == "toggle":
            return bool(await target_session.try_toggle_play_pause_async())
        if action == "next":
            return bool(await target_session.try_skip_next_async())
        if action == "previous":
            return bool(await target_session.try_skip_previous_async())
        if action == "seek":
            if value is None or value < 0:
                return False
            ticks = int(round(value * TICKS_PER_SECOND))
            return bool(await target_session.try_change_playback_position_async(ticks))
        return False

    async def set_session_volume(
        self,
        session_id: str,
        level: float | None = None,
        muted: bool | None = None,
    ) -> bool:
        """Map a Windows GSMTC session to its Core Audio app session when possible."""
        parsed = parse_windows_session_id(session_id)
        if parsed is None:
            return False
        app_id, _ = parsed
        return await self.set_audio_app_volume(f"windows-audio:{app_id}", level=level, muted=muted)

    def _read_master_sync(self) -> MasterVolumeInfo:
        from pycaw.pycaw import AudioUtilities

        speakers = AudioUtilities.GetSpeakers()
        if speakers is None:
            raise RuntimeError("Nenhum dispositivo de saída de áudio padrão encontrado.")
        ep = speakers.EndpointVolume
        return MasterVolumeInfo(
            level=float(ep.GetMasterVolumeLevelScalar()),
            muted=bool(ep.GetMute()),
            device_name=str(speakers.FriendlyName or "Alto-falantes"),
        )

    def _set_master_sync(self, level: float | None, muted: bool | None) -> MasterVolumeInfo:
        from pycaw.pycaw import AudioUtilities

        speakers = AudioUtilities.GetSpeakers()
        if speakers is None:
            raise RuntimeError("Nenhum dispositivo de saída de áudio padrão encontrado.")
        ep = speakers.EndpointVolume
        if level is not None:
            clamped = max(0.0, min(1.0, float(level)))
            ep.SetMasterVolumeLevelScalar(clamped, None)
        if muted is not None:
            ep.SetMute(int(bool(muted)), None)
        return MasterVolumeInfo(
            level=float(ep.GetMasterVolumeLevelScalar()),
            muted=bool(ep.GetMute()),
            device_name=str(speakers.FriendlyName or "Alto-falantes"),
        )

    def _list_audio_apps_sync(self) -> list[AudioAppInfo]:
        from pycaw.pycaw import AudioUtilities

        grouped: dict[str, AudioAppInfo] = {}
        for sess in AudioUtilities.GetAllSessions():
            state_code = int(sess.State)
            if state_code == 2:  # Expired
                continue

            pid = int(sess.ProcessId)
            if pid == 0:
                proc_name = "SystemSounds"
            elif sess.Process is not None:
                proc_name = str(sess.Process.name())
            else:
                proc_name = f"pid-{pid}"

            key = proc_name.lower()
            vol_iface = sess.SimpleAudioVolume
            volume = float(vol_iface.GetMasterVolume())
            muted = bool(vol_iface.GetMute())
            is_active = state_code == 1

            existing = grouped.get(key)
            if existing is None:
                grouped[key] = AudioAppInfo(
                    id=f"windows-audio:{proc_name}",
                    source=self.source,
                    app=friendly_app_name(proc_name),
                    process_name=proc_name,
                    pid=pid,
                    active=is_active,
                    volume=volume,
                    muted=muted,
                )
            elif is_active and not existing.active:
                grouped[key] = AudioAppInfo(
                    id=existing.id,
                    source=existing.source,
                    app=existing.app,
                    process_name=existing.process_name,
                    pid=pid,
                    active=True,
                    volume=volume,
                    muted=muted,
                )

        return sorted(grouped.values(), key=lambda item: (not item.active, item.app.lower()))

    def _set_audio_app_volume_sync(
        self,
        app_audio_id: str,
        level: float | None,
        muted: bool | None,
    ) -> bool:
        from pycaw.pycaw import AudioUtilities

        target = app_audio_id
        if target.startswith("windows-audio:"):
            target = target[len("windows-audio:") :]
        target_lower = target.lower()
        target_stem = target_lower[:-4] if target_lower.endswith(".exe") else target_lower

        updated = False
        for sess in AudioUtilities.GetAllSessions():
            if int(sess.State) == 2:
                continue
            pid = int(sess.ProcessId)
            if pid == 0:
                proc_name = "SystemSounds"
            elif sess.Process is not None:
                proc_name = str(sess.Process.name())
            else:
                proc_name = f"pid-{pid}"

            proc_lower = proc_name.lower()
            proc_stem = proc_lower[:-4] if proc_lower.endswith(".exe") else proc_lower
            if proc_lower != target_lower and proc_stem != target_stem:
                continue

            vol_iface = sess.SimpleAudioVolume
            if level is not None:
                clamped = max(0.0, min(1.0, float(level)))
                vol_iface.SetMasterVolume(clamped, None)
            if muted is not None:
                vol_iface.SetMute(int(bool(muted)), None)
            updated = True
        return updated

    async def get_master_volume(self) -> MasterVolumeInfo:
        """Read default speakers master volume and mute state."""
        return await self._run_com(self._read_master_sync)

    async def set_master_volume(
        self,
        level: float | None = None,
        muted: bool | None = None,
    ) -> MasterVolumeInfo:
        """Set default speakers master volume and/or mute state."""
        return await self._run_com(self._set_master_sync, level, muted)

    async def list_audio_apps(self) -> list[AudioAppInfo]:
        """List grouped per-app Core Audio sessions."""
        return await self._run_com(self._list_audio_apps_sync)

    async def set_audio_app_volume(
        self,
        app_audio_id: str,
        level: float | None = None,
        muted: bool | None = None,
    ) -> bool:
        """Update per-app Core Audio volume and/or mute state."""
        return await self._run_com(self._set_audio_app_volume_sync, app_audio_id, level, muted)

    async def send_media_key(self, action: MediaAction) -> bool:
        """Send a global Win32 media key for apps without GSMTC (e.g. VLC 3.x)."""
        vk_map: dict[str, int] = {
            "play": VK_MEDIA_PLAY_PAUSE,
            "pause": VK_MEDIA_PLAY_PAUSE,
            "toggle": VK_MEDIA_PLAY_PAUSE,
            "next": VK_MEDIA_NEXT_TRACK,
            "previous": VK_MEDIA_PREV_TRACK,
        }
        vk = vk_map.get(action)
        if vk is None:
            return False

        def _press() -> bool:
            user32 = ctypes.windll.user32
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
            return True

        return await asyncio.to_thread(_press)
