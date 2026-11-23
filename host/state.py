"""Host state coordinator unifying session providers and WebSocket clients."""

from __future__ import annotations

import asyncio
import logging
import re
import time
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import replace
from typing import Any

from fastapi import WebSocket
from pydantic import ValidationError

from host.protocol import (
    AckMessage,
    CommandMessage,
    ErrorMessage,
    InputMessage,
    OpenMessage,
    PingMessage,
    PongMessage,
    SearchMessage,
    SearchResultItem,
    SearchResultsMessage,
    SelectMessage,
    SettingsMessage,
    StateMessage,
    VolumeMessage,
    audio_app_to_payload,
    master_to_payload,
    parse_client_message,
    session_to_payload,
)
from host.providers.base import (
    AudioAppInfo,
    AudioControlProvider,
    MasterVolumeInfo,
    MediaSessionInfo,
    RemoteInputProvider,
    SessionProvider,
)

logger = logging.getLogger(__name__)

CHROME_GSMTC_APP_IDS = {"chrome.exe", "chrome"}

_NOTIFICATION_PREFIX_RE = re.compile(r"^\(\d+\+?\)\s*")
_SITE_SUFFIX_RE = re.compile(
    r"\s*[-|–—]\s*(?:Sua\s*M[uú]sica(?:(?:\s*-\s*)?O\s*maior\s*site\s*de\s*m[uú]sica\s*do\s*Brasil)?|YouTube(?:\s*Music)?|Spotify(?:\s*Web\s*Player)?|SoundCloud|Deezer|Netflix|Twitch|Bandcamp|Vimeo|Apple\s*Music)\s*$",
    re.IGNORECASE,
)


def normalize_session_title(title: str | None) -> str:
    """Normalize a session title for deduplication matching between GSMTC and extension."""
    if not title:
        return ""
    t = _NOTIFICATION_PREFIX_RE.sub("", title.strip())
    t = _SITE_SUFFIX_RE.sub("", t).strip(" -|–—_").strip()
    norm = unicodedata.normalize("NFKD", t)
    ascii_clean = "".join(c for c in norm if not unicodedata.combining(c)).lower()
    cleaned = re.sub(r"[^\w\s]", " ", ascii_clean)
    return " ".join(cleaned.split())


def session_titles_match(title_a: str | None, title_b: str | None) -> bool:
    """Check if two session titles match for deduplication purposes."""
    norm_a = normalize_session_title(title_a)
    norm_b = normalize_session_title(title_b)
    if not norm_a or not norm_b:
        return False
    if norm_a == norm_b:
        return True
    return bool((len(norm_a) >= 5 and norm_a in norm_b) or (len(norm_b) >= 5 and norm_b in norm_a))


def _is_chrome_gsmtc_session(session: MediaSessionInfo) -> bool:
    return session.source == "windows" and session.app_id.lower() in CHROME_GSMTC_APP_IDS


def _match_audio_app(
    session: MediaSessionInfo,
    audio_by_key: dict[str, AudioAppInfo],
) -> AudioAppInfo | None:
    app_key = session.app_id.lower()
    if app_key in audio_by_key:
        return audio_by_key[app_key]
    stem = app_key[:-4] if app_key.endswith(".exe") else app_key
    return audio_by_key.get(stem)


class HostStateCoordinator:
    """Coordinates providers, session deduplication, active selection, and WS clients."""

    def __init__(
        self,
        providers: Sequence[SessionProvider],
        audio_provider: AudioControlProvider,
        fallback_session_id: str = "windows:fallback",
        input_provider: RemoteInputProvider | None = None,
        remote_input_enabled: bool = False,
        on_remote_input_change: Callable[[bool], None] | None = None,
        tailscale_enabled: bool = False,
        on_tailscale_change: Callable[[bool], None] | None = None,
        screen_mirror_available: bool = True,
    ) -> None:
        self._providers: list[SessionProvider] = list(providers)
        self._providers_by_source: dict[str, SessionProvider] = {
            p.source: p for p in self._providers
        }
        self._audio_provider = audio_provider
        self._fallback_session_id = fallback_session_id
        self._input_provider = input_provider
        self._remote_input_enabled: bool = bool(remote_input_enabled)
        self._on_remote_input_change = on_remote_input_change
        self._tailscale_enabled: bool = bool(tailscale_enabled)
        self._on_tailscale_change = on_tailscale_change
        self._screen_mirror_available: bool = bool(screen_mirror_available)
        self._selected_session_id: str | None = None
        self._clients: set[WebSocket] = set()
        self._last_state_json: str | None = None
        self._last_session_statuses: dict[str, str] = {}
        self._state_lock = asyncio.Lock()
        self._broadcast_task: asyncio.Task[None] | None = None
        self._broadcast_pending_force: bool = False
        self._last_search_time: float = 0.0
        self._search_rate_limit_sec: float = 1.0

    @property
    def remote_input_enabled(self) -> bool:
        """Whether remote mouse and keyboard control is currently authorized."""
        return self._remote_input_enabled

    def set_remote_input_enabled(self, enabled: bool) -> bool:
        """Enable or disable remote mouse/keyboard control cleanly."""
        flag = bool(enabled)
        self._remote_input_enabled = flag
        if self._on_remote_input_change is not None:
            try:
                self._on_remote_input_change(flag)
            except Exception:  # noqa: BLE001
                logger.exception("Falha ao persistir configuração de mouse/teclado remoto")
        return flag

    @property
    def tailscale_enabled(self) -> bool:
        """Whether optional Tailscale remote access is currently enabled on the host."""
        return self._tailscale_enabled

    def set_tailscale_enabled(self, enabled: bool) -> bool:
        """Enable or disable optional Tailscale remote host access cleanly (PC-only)."""
        flag = bool(enabled)
        self._tailscale_enabled = flag
        if self._on_tailscale_change is not None:
            try:
                self._on_tailscale_change(flag)
            except Exception:  # noqa: BLE001
                logger.exception("Falha ao persistir configuração de acesso remoto Tailscale")
        return flag

    @property
    def has_clients(self) -> bool:
        """Whether any WebSocket control client is currently connected."""
        return bool(self._clients)

    @property
    def extension_connected(self) -> bool:
        """Whether the Chrome extension provider is currently connected."""
        chrome = self._providers_by_source.get("chrome")
        return bool(chrome is not None and chrome.is_connected)

    def register_client(self, ws: WebSocket) -> None:
        """Register an active control WebSocket client."""
        self._clients.add(ws)

    def unregister_client(self, ws: WebSocket) -> None:
        """Remove a disconnected control WebSocket client."""
        self._clients.discard(ws)

    async def build_state(self) -> StateMessage:
        """Collect unified media sessions and audio state across all active providers."""
        async with self._state_lock:
            return await self._build_state_unlocked()

    async def _build_state_unlocked(self) -> StateMessage:
        all_raw_sessions: list[MediaSessionInfo] = []
        for provider in self._providers:
            try:
                items = await provider.list_sessions()
            except Exception:  # noqa: BLE001
                logger.exception("Falha ao listar sessões do provedor %s", provider.source)
                continue
            all_raw_sessions.extend(items)

        extension_titles = [
            s.title
            for s in all_raw_sessions
            if s.source in ("chrome_extension", "chrome") and s.title
        ]

        raw_sessions: list[MediaSessionInfo] = []
        for item in all_raw_sessions:
            if _is_chrome_gsmtc_session(item):
                if self.extension_connected:
                    is_duplicate = any(
                        session_titles_match(item.title, ext_title)
                        for ext_title in extension_titles
                    )
                    if is_duplicate:
                        continue
                item = replace(item, app="Chrome (controle básico)")
            raw_sessions.append(item)

        try:
            master = await self._audio_provider.get_master_volume()
        except Exception:  # noqa: BLE001
            logger.exception("Falha ao ler volume mestre")
            master = MasterVolumeInfo(level=0.0, muted=False, device_name="Desconhecido")

        try:
            audio_apps = await self._audio_provider.list_audio_apps()
        except Exception:  # noqa: BLE001
            logger.exception("Falha ao listar sessões de áudio")
            audio_apps = []

        audio_by_key: dict[str, AudioAppInfo] = {}
        for app_info in audio_apps:
            proc_lower = app_info.process_name.lower()
            audio_by_key[proc_lower] = app_info
            stem = proc_lower[:-4] if proc_lower.endswith(".exe") else proc_lower
            audio_by_key.setdefault(stem, app_info)

        unified_sessions: list[MediaSessionInfo] = []
        for sess in raw_sessions:
            if sess.source == "windows" and sess.volume is None:
                matched = _match_audio_app(sess, audio_by_key)
                if matched is not None:
                    sess = replace(sess, volume=matched.volume, muted=matched.muted)
            unified_sessions.append(sess)

        active_id = self._resolve_active_session_id(unified_sessions)
        self._last_session_statuses = {s.id: s.status for s in unified_sessions}

        return StateMessage(
            sessions=[session_to_payload(s) for s in unified_sessions],
            activeSessionId=active_id,
            masterVolume=master_to_payload(master),
            audioSessions=[audio_app_to_payload(a) for a in audio_apps],
            extensionConnected=self.extension_connected,
            remoteInputEnabled=self._remote_input_enabled,
            tailscaleEnabled=self._tailscale_enabled,
            screenMirrorAvailable=self._screen_mirror_available,
        )

    def _resolve_active_session_id(self, sessions: list[MediaSessionInfo]) -> str | None:
        ids = {s.id for s in sessions}
        if self._selected_session_id is not None and self._selected_session_id in ids:
            return self._selected_session_id
        self._selected_session_id = None

        for sess in sessions:
            if sess.status == "PLAYING":
                return sess.id
        for sess in sessions:
            if sess.is_system_active:
                return sess.id
        return sessions[0].id if sessions else None

    async def get_initial_state_json(self) -> str:
        """Build state JSON for a newly connected client and seed change detection cache."""
        state = await self.build_state()
        payload = state.model_dump_json()
        if self._last_state_json is None:
            self._last_state_json = payload
        return payload

    async def broadcast_state(self, force: bool = False) -> StateMessage:
        """Build state and push it to connected WebSocket clients if changed (or forced)."""
        state = await self.build_state()
        payload = state.model_dump_json()
        if not force and payload == self._last_state_json:
            return state
        self._last_state_json = payload

        stale: list[WebSocket] = []
        for client in list(self._clients):
            try:
                await client.send_text(payload)
            except Exception:  # noqa: BLE001
                stale.append(client)
        for client in stale:
            self._clients.discard(client)
        return state

    def _schedule_coalesced_broadcast(
        self,
        force: bool = False,
        delay_sec: float = 0.035,
    ) -> None:
        """Coalesce rapid state changes (e.g. slider drags) with a trailing debounced broadcast."""
        if self._broadcast_task is not None and not self._broadcast_task.done():
            self._broadcast_pending_force = self._broadcast_pending_force or force
            return

        self._broadcast_pending_force = force

        async def _debounced() -> None:
            await asyncio.sleep(delay_sec)
            force_flag = self._broadcast_pending_force
            self._broadcast_pending_force = False
            self._broadcast_task = None
            try:
                await self.broadcast_state(force=force_flag)
            except Exception:  # noqa: BLE001
                logger.exception("Erro ao transmitir estado coalescido")

        self._broadcast_task = asyncio.create_task(_debounced())

    async def handle_raw_client_message(
        self,
        raw: Any,
    ) -> PongMessage | ErrorMessage | AckMessage | None:
        """Validate and process one incoming JSON message from a control client."""
        start_time = time.perf_counter()
        req_id = (
            str(raw.get("requestId")) if isinstance(raw, dict) and raw.get("requestId") else None
        )
        try:
            msg = parse_client_message(raw)
        except ValidationError as exc:
            return ErrorMessage(
                code="invalid_message",
                message=f"Mensagem inválida no protocolo v1: {exc.errors()[0]['msg']}",
                requestId=req_id,
            )

        if isinstance(msg, PingMessage):
            return PongMessage(requestId=msg.requestId)

        if isinstance(msg, SelectMessage):
            state = await self.build_state()
            if not any(s.id == msg.sessionId for s in state.sessions):
                return ErrorMessage(
                    code="session_not_found",
                    message=f"Sessão não encontrada: {msg.sessionId}",
                    requestId=msg.requestId,
                )
            self._selected_session_id = msg.sessionId
            self._schedule_coalesced_broadcast(force=True)
            if msg.requestId is not None:
                exec_ms = (time.perf_counter() - start_time) * 1000.0
                return AckMessage(
                    requestId=msg.requestId,
                    ok=True,
                    clientSentAt=msg.clientSentAt,
                    execMs=round(exec_ms, 2),
                    target=msg.sessionId,
                )
            return None

        if isinstance(msg, CommandMessage):
            ok, reason = await self._dispatch_command(msg)
            exec_ms = (time.perf_counter() - start_time) * 1000.0
            if not ok:
                if msg.requestId is not None:
                    return AckMessage(
                        requestId=msg.requestId,
                        ok=False,
                        clientSentAt=msg.clientSentAt,
                        execMs=round(exec_ms, 2),
                        target=msg.sessionId,
                        reason=reason,
                    )
                err_text = (
                    f"Não foi possível executar '{msg.action}' em '{msg.sessionId}' ({reason})."
                    if reason
                    else f"Não foi possível executar '{msg.action}' em '{msg.sessionId}'."
                )
                return ErrorMessage(
                    code="command_failed",
                    message=err_text,
                    requestId=msg.requestId,
                )
            self._schedule_coalesced_broadcast(force=True)
            if msg.requestId is not None:
                return AckMessage(
                    requestId=msg.requestId,
                    ok=True,
                    clientSentAt=msg.clientSentAt,
                    execMs=round(exec_ms, 2),
                    target=msg.sessionId,
                    reason=reason,
                )
            return None

        if isinstance(msg, VolumeMessage):
            ok = await self._dispatch_volume(msg)
            exec_ms = (time.perf_counter() - start_time) * 1000.0
            if not ok:
                if msg.requestId is not None:
                    return AckMessage(
                        requestId=msg.requestId,
                        ok=False,
                        clientSentAt=msg.clientSentAt,
                        execMs=round(exec_ms, 2),
                        target=msg.target,
                        reason="volume_failed",
                    )
                return ErrorMessage(
                    code="volume_failed",
                    message=f"Não foi possível ajustar volume de '{msg.target}'.",
                    requestId=msg.requestId,
                )
            self._schedule_coalesced_broadcast(force=True)
            if msg.requestId is not None:
                return AckMessage(
                    requestId=msg.requestId,
                    ok=True,
                    clientSentAt=msg.clientSentAt,
                    execMs=round(exec_ms, 2),
                    target=msg.target,
                )
            return None

        if isinstance(msg, OpenMessage):
            ok = await self._dispatch_open(msg)
            exec_ms = (time.perf_counter() - start_time) * 1000.0
            if not ok:
                if msg.requestId is not None:
                    return AckMessage(
                        requestId=msg.requestId,
                        ok=False,
                        clientSentAt=msg.clientSentAt,
                        execMs=round(exec_ms, 2),
                        reason="open_failed",
                    )
                return ErrorMessage(
                    code="open_failed",
                    message="Extensão Chrome desconectada ou não foi possível abrir a aba.",
                    requestId=msg.requestId,
                )
            self._schedule_coalesced_broadcast(force=True)
            if msg.requestId is not None:
                return AckMessage(
                    requestId=msg.requestId,
                    ok=True,
                    clientSentAt=msg.clientSentAt,
                    execMs=round(exec_ms, 2),
                )
            return None

        if isinstance(msg, SearchMessage):
            now = time.monotonic()
            if (now - self._last_search_time) < self._search_rate_limit_sec:
                return SearchResultsMessage(
                    requestId=msg.requestId or "",
                    ok=False,
                    query=msg.query,
                    results=[],
                    reason="rate_limited",
                    error="Limite de buscas atingido. Aguarde um instante.",
                )
            self._last_search_time = now

            chrome = self._providers_by_source.get("chrome")
            if chrome is None or not getattr(chrome, "is_connected", False):
                fallback_url = (
                    f"https://www.youtube.com/results?search_query={msg.query.replace(' ', '+')}"
                )
                return SearchResultsMessage(
                    requestId=msg.requestId or "",
                    ok=False,
                    query=msg.query,
                    results=[],
                    fallbackUrl=fallback_url,
                    reason="extension_disconnected",
                    error="Extensão Chrome não conectada.",
                )

            search_fn = getattr(chrome, "search_youtube", None)
            if not callable(search_fn):
                return SearchResultsMessage(
                    requestId=msg.requestId or "",
                    ok=False,
                    query=msg.query,
                    results=[],
                    reason="search_not_supported",
                )

            ok, raw_results, reason = await search_fn(msg.query)
            items: list[SearchResultItem] = []
            for item in raw_results:
                try:
                    items.append(
                        SearchResultItem(
                            id=str(item.get("id")),
                            title=str(item.get("title") or ""),
                            channel=str(item.get("channel") or ""),
                            duration=str(item.get("duration") or ""),
                            views=str(item.get("views") or ""),
                            thumbnail=str(item.get("thumbnail") or ""),
                            isLive=bool(item.get("isLive", False)),
                            isShorts=bool(item.get("isShorts", False)),
                        )
                    )
                except Exception:
                    continue

            fallback_url = (
                f"https://www.youtube.com/results?search_query={msg.query.replace(' ', '+')}"
            )
            return SearchResultsMessage(
                requestId=msg.requestId or "",
                ok=ok,
                query=msg.query,
                results=items,
                fallbackUrl=fallback_url if not ok else None,
                reason=reason,
                error=(
                    "Não foi possível extrair resultados da busca do YouTube."
                    if not ok
                    else None
                ),
            )

        if isinstance(msg, SettingsMessage):
            flag = self.set_remote_input_enabled(msg.remoteInputEnabled)
            logger.info("Configuração remoteInputEnabled alterada pelo cliente para: %s", flag)
            self._schedule_coalesced_broadcast(force=True)
            if msg.requestId is not None:
                exec_ms = (time.perf_counter() - start_time) * 1000.0
                return AckMessage(
                    requestId=msg.requestId,
                    ok=True,
                    clientSentAt=msg.clientSentAt,
                    execMs=round(exec_ms, 2),
                    target="settings",
                )
            return None

        if isinstance(msg, InputMessage):
            if not self._remote_input_enabled:
                return ErrorMessage(
                    code="remote_input_disabled",
                    message="Mouse e teclado remoto estão desativados nas configurações.",
                    requestId=msg.requestId,
                )
            ok, reason = await self._dispatch_input(msg)
            exec_ms = (time.perf_counter() - start_time) * 1000.0
            if not ok:
                if msg.requestId is not None:
                    return AckMessage(
                        requestId=msg.requestId,
                        ok=False,
                        clientSentAt=msg.clientSentAt,
                        execMs=round(exec_ms, 2),
                        target=msg.action,
                        reason=reason,
                    )
                if reason == "input_not_supported":
                    return ErrorMessage(
                        code="input_not_supported",
                        message="Controle remoto de entrada indisponível neste host.",
                        requestId=msg.requestId,
                    )
                return None
            if msg.requestId is not None:
                return AckMessage(
                    requestId=msg.requestId,
                    ok=True,
                    clientSentAt=msg.clientSentAt,
                    execMs=round(exec_ms, 2),
                    target=msg.action,
                )
            return None

        return None

    async def _dispatch_input(self, msg: InputMessage) -> tuple[bool, str | None]:
        if self._input_provider is None:
            return False, "input_not_supported"

        action = msg.action
        if action == "mouse_move":
            ok = await self._input_provider.move_mouse(msg.dx or 0, msg.dy or 0)
            return (ok, None if ok else "mouse_move_failed")
        if action == "mouse_move_abs":
            ok = await self._input_provider.move_mouse_abs(
                msg.x or 0.0,
                msg.y or 0.0,
                msg.monitor or 1,
            )
            return (ok, None if ok else "mouse_move_abs_failed")
        if action == "mouse_click":
            ok = await self._input_provider.click_mouse(msg.button or "left", msg.double)
            return (ok, None if ok else "mouse_click_failed")
        if action == "mouse_down":
            ok = await self._input_provider.mouse_button(msg.button or "left", "down")
            return (ok, None if ok else "mouse_down_failed")
        if action == "mouse_up":
            ok = await self._input_provider.mouse_button(msg.button or "left", "up")
            return (ok, None if ok else "mouse_up_failed")
        if action == "mouse_scroll":
            ok = await self._input_provider.scroll_mouse(msg.dx or 0, msg.dy or 0)
            return (ok, None if ok else "mouse_scroll_failed")
        if action == "key_text":
            ok = await self._input_provider.type_text(msg.text or "")
            return (ok, None if ok else "key_text_failed")
        if action == "key_press":
            ok = await self._input_provider.press_key(msg.key or "", list(msg.modifiers))
            return (ok, None if ok else "key_press_failed")
        return False, "unknown_input_action"

    async def _dispatch_open(self, msg: OpenMessage) -> bool:
        chrome = self._providers_by_source.get("chrome")
        if chrome is None or not chrome.is_connected:
            return False
        open_fn = getattr(chrome, "open_in_browser", None)
        if open_fn is None:
            return False
        return bool(await open_fn(mode=msg.mode, query=msg.query, url=msg.url))

    async def _dispatch_command(self, msg: CommandMessage) -> tuple[bool, str | None]:
        if msg.action == "play_video":
            chrome = self._providers_by_source.get("chrome")
            if chrome is None or not getattr(chrome, "is_connected", False):
                return False, "extension_disconnected"
            play_fn = getattr(chrome, "play_video", None)
            if not callable(play_fn):
                return False, "play_video_not_supported"
            return await play_fn(
                video_id=msg.videoId or "",
                mode=msg.mode or "current_tab",
                fullscreen=msg.fullscreen,
                session_id=msg.sessionId,
            )

        target_session_id = msg.sessionId
        if not target_session_id:
            target_session_id = self._selected_session_id
        if not target_session_id and self._last_session_statuses:
            target_session_id = next(iter(self._last_session_statuses.keys()))
        if not target_session_id:
            return False, "no_active_session"

        known_status = self._last_session_statuses.get(target_session_id, "UNKNOWN")
        logger.info(
            "Despachando comando action=%s session=%s (status_host=%s, ativa=%s)",
            msg.action,
            target_session_id,
            known_status,
            self._selected_session_id,
        )
        if target_session_id == self._fallback_session_id:
            ok = await self._audio_provider.send_media_key(msg.action)
            return (ok, None if ok else "media_key_failed")

        source = target_session_id.split(":", 1)[0]
        provider = self._providers_by_source.get(source)
        if provider is None:
            return (False, "provider_not_found")

        dispatch_fn = getattr(provider, "execute_command_with_reason", None)
        if callable(dispatch_fn):
            return await dispatch_fn(target_session_id, msg.action, msg.value)

        ok = await provider.execute_command(target_session_id, msg.action, msg.value)
        return (ok, None if ok else "command_failed")

    async def _dispatch_volume(self, msg: VolumeMessage) -> bool:
        if msg.target == "master":
            await self._audio_provider.set_master_volume(level=msg.value, muted=msg.muted)
            return True

        if msg.target.startswith("windows-audio:"):
            return await self._audio_provider.set_audio_app_volume(
                msg.target,
                level=msg.value,
                muted=msg.muted,
            )

        source = msg.target.split(":", 1)[0]
        provider = self._providers_by_source.get(source)
        if provider is None:
            return False
        return await provider.set_session_volume(msg.target, level=msg.value, muted=msg.muted)
