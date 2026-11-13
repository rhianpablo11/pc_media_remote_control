"""Unit and integration tests for Fase 1 host, Protocol v1, and session providers."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from host.app import create_app
from host.config import DEFAULT_EXTENSION_ID, HostSettings, extension_id_from_public_key_b64
from host.protocol import (
    CommandMessage,
    OpenMessage,
    PingMessage,
    SelectMessage,
    VolumeMessage,
    normalize_media_title,
    parse_client_message,
    session_to_payload,
)
from host.providers.base import (
    AudioAppInfo,
    MasterVolumeInfo,
    MediaAction,
    MediaSessionInfo,
    PlaybackControls,
)
from host.providers.chrome_extension import ChromeExtensionProvider
from host.providers.windows import (
    friendly_app_name,
    parse_windows_session_id,
)
from host.state import HostStateCoordinator


class FakeWindowsProvider:
    """In-memory mock of WindowsProvider for fast deterministic tests."""

    def __init__(self) -> None:
        self.sessions: list[MediaSessionInfo] = [
            MediaSessionInfo(
                id="windows:Spotify.exe:0",
                source="windows",
                app="Spotify",
                app_id="Spotify.exe",
                title="Música Teste",
                artist="Artista Teste",
                status="PLAYING",
                position=12.0,
                duration=180.0,
                controls=PlaybackControls(
                    play=False, pause=True, toggle=True, next=True, previous=True, seek=True
                ),
                is_system_active=True,
            ),
            MediaSessionInfo(
                id="windows:chrome.exe:0",
                source="windows",
                app="Google Chrome",
                app_id="chrome.exe",
                title="YouTube GSMTC Agregado",
                artist="Canal",
                status="PAUSED",
                position=5.0,
                duration=300.0,
                controls=PlaybackControls(play=True, pause=False, toggle=True, seek=True),
            ),
        ]
        self.master = MasterVolumeInfo(level=0.4, muted=False, device_name="Fone Fake")
        self.audio_apps: list[AudioAppInfo] = [
            AudioAppInfo(
                id="windows-audio:Spotify.exe",
                source="windows",
                app="Spotify",
                process_name="Spotify.exe",
                pid=101,
                active=True,
                volume=0.8,
                muted=False,
            ),
            AudioAppInfo(
                id="windows-audio:vlc.exe",
                source="windows",
                app="VLC",
                process_name="vlc.exe",
                pid=202,
                active=False,
                volume=0.5,
                muted=False,
            ),
        ]
        self.executed_commands: list[tuple[str, MediaAction, float | None]] = []
        self.media_keys_sent: list[MediaAction] = []

    @property
    def source(self) -> str:
        return "windows"

    @property
    def is_connected(self) -> bool:
        return True

    async def list_sessions(self) -> list[MediaSessionInfo]:
        return list(self.sessions)

    async def execute_command(
        self,
        session_id: str,
        action: MediaAction,
        value: float | None = None,
    ) -> bool:
        if not any(s.id == session_id for s in self.sessions):
            return False
        self.executed_commands.append((session_id, action, value))
        return True

    async def set_session_volume(
        self,
        session_id: str,
        level: float | None = None,
        muted: bool | None = None,
    ) -> bool:
        if session_id == "windows:Spotify.exe:0":
            return await self.set_audio_app_volume("windows-audio:Spotify.exe", level, muted)
        return False

    async def get_master_volume(self) -> MasterVolumeInfo:
        return self.master

    async def set_master_volume(
        self,
        level: float | None = None,
        muted: bool | None = None,
    ) -> MasterVolumeInfo:
        self.master = MasterVolumeInfo(
            level=self.master.level if level is None else level,
            muted=self.master.muted if muted is None else muted,
            device_name=self.master.device_name,
        )
        return self.master

    async def list_audio_apps(self) -> list[AudioAppInfo]:
        return list(self.audio_apps)

    async def set_audio_app_volume(
        self,
        app_audio_id: str,
        level: float | None = None,
        muted: bool | None = None,
    ) -> bool:
        for i, item in enumerate(self.audio_apps):
            if item.id == app_audio_id:
                self.audio_apps[i] = AudioAppInfo(
                    id=item.id,
                    source=item.source,
                    app=item.app,
                    process_name=item.process_name,
                    pid=item.pid,
                    active=item.active,
                    volume=item.volume if level is None else level,
                    muted=item.muted if muted is None else muted,
                )
                return True
        return False

    async def send_media_key(self, action: MediaAction) -> bool:
        if action == "seek":
            return False
        self.media_keys_sent.append(action)
        return True


class FakeExtensionTransport:
    """In-memory extension WebSocket stub that auto-acks requests."""

    def __init__(self, provider: ChromeExtensionProvider, ack_ok: bool = True) -> None:
        self.provider = provider
        self.ack_ok = ack_ok
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: Any) -> None:
        self.sent.append(data)
        req_id = data.get("requestId")
        if req_id:
            await self.provider.handle_message(
                {"v": 1, "type": "extension_ack", "requestId": req_id, "ok": self.ack_ok}
            )


def test_protocol_v1_validation() -> None:
    cmd = parse_client_message(
        {
            "v": 1,
            "type": "command",
            "sessionId": "windows:Spotify.exe:0",
            "action": "seek",
            "value": 42,
        }
    )
    assert isinstance(cmd, CommandMessage)
    assert cmd.value == 42.0

    vol = parse_client_message({"v": 1, "type": "volume", "target": "master", "value": 0.65})
    assert isinstance(vol, VolumeMessage)
    assert vol.value == 0.65

    sel = parse_client_message({"v": 1, "type": "select", "sessionId": "chrome:11"})
    assert isinstance(sel, SelectMessage)

    ping = parse_client_message({"v": 1, "type": "ping", "requestId": "r1"})
    assert isinstance(ping, PingMessage)

    rel_cmd = parse_client_message(
        {
            "v": 1,
            "type": "command",
            "sessionId": "chrome:11",
            "action": "seek_relative",
            "value": -10,
        }
    )
    assert isinstance(rel_cmd, CommandMessage)
    assert rel_cmd.value == -10.0

    skip_cmd = parse_client_message(
        {"v": 1, "type": "command", "sessionId": "chrome:11", "action": "skip_ad"}
    )
    assert isinstance(skip_cmd, CommandMessage)

    open_search = parse_client_message(
        {"v": 1, "type": "open", "mode": "youtube_search", "query": "  lo-fi study  "}
    )
    assert isinstance(open_search, OpenMessage)
    assert open_search.query == "lo-fi study"

    open_url = parse_client_message(
        {
            "v": 1,
            "type": "open",
            "mode": "url",
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        }
    )
    assert isinstance(open_url, OpenMessage)

    with pytest.raises(ValidationError):
        parse_client_message({"v": 2, "type": "ping"})
    with pytest.raises(ValidationError):
        parse_client_message(
            {"v": 1, "type": "command", "sessionId": "windows:Spotify.exe:0", "action": "seek"}
        )
    with pytest.raises(ValidationError):
        parse_client_message(
            {"v": 1, "type": "command", "sessionId": "chrome:11", "action": "seek_relative"}
        )
    with pytest.raises(ValidationError):
        parse_client_message({"v": 1, "type": "volume", "target": "master", "value": 1.5})
    with pytest.raises(ValidationError):
        parse_client_message({"v": 1, "type": "volume", "target": "master"})
    with pytest.raises(ValidationError):
        parse_client_message({"v": 1, "type": "open", "mode": "youtube_search", "query": "   "})
    with pytest.raises(ValidationError):
        parse_client_message({"v": 1, "type": "open", "mode": "url", "url": "javascript:alert(1)"})
    with pytest.raises(ValidationError):
        parse_client_message({"v": 1, "type": "open", "mode": "url", "url": "chrome://extensions"})


def test_normalize_media_title_strips_notification_counts() -> None:
    assert normalize_media_title("(2509) Never Gonna Give You Up") == "Never Gonna Give You Up"
    assert normalize_media_title("(1) Lo-fi Hip Hop Radio") == "Lo-fi Hip Hop Radio"
    assert normalize_media_title("(99+) Ao Vivo") == "Ao Vivo"
    assert normalize_media_title("Normal Title") == "Normal Title"
    assert normalize_media_title("") == ""
    assert normalize_media_title(None) == ""

    # Verify session_to_payload strips notification prefix in Protocol v1 payload
    raw = MediaSessionInfo(
        id="chrome:99",
        source="chrome",
        app="Google Chrome",
        app_id="chrome.exe",
        title="(2509) Never Gonna Give You Up",
        artist="Rick Astley",
        status="PLAYING",
        position=10.0,
        duration=200.0,
        controls=PlaybackControls(play=True, pause=True, toggle=True),
    )
    payload = session_to_payload(raw)
    assert payload.title == "Never Gonna Give You Up"


def test_windows_helper_functions() -> None:
    assert friendly_app_name("Spotify.exe") == "Spotify"
    assert friendly_app_name("chrome.exe") == "Google Chrome"
    assert friendly_app_name("vlc.exe") == "VLC"
    assert friendly_app_name("CustomApp.exe") == "CustomApp"
    assert parse_windows_session_id("windows:Spotify.exe:0") == ("Spotify.exe", 0)
    assert parse_windows_session_id("chrome:42") is None


def test_coordinator_unifies_and_deduplicates_chrome_when_extension_connected() -> None:
    async def _scenario() -> None:
        win = FakeWindowsProvider()
        ext = ChromeExtensionProvider()
        coord = HostStateCoordinator(providers=[ext, win], audio_provider=win)

        # Without extension: Windows Spotify + Chrome GSMTC both appear
        state_no_ext = await coord.build_state()
        assert state_no_ext.extensionConnected is False
        assert [s.id for s in state_no_ext.sessions] == [
            "windows:Spotify.exe:0",
            "windows:chrome.exe:0",
        ]
        # Windows session volume enriched from audio apps
        assert state_no_ext.sessions[0].volume == 0.8

        # Connect extension with 2 YouTube tabs -> chrome.exe GSMTC hidden
        transport = FakeExtensionTransport(ext)
        ext.attach(transport)
        await ext.handle_message(
            {
                "v": 1,
                "type": "extension_state",
                "tabs": [
                    {
                        "tabId": "101",
                        "title": "Video Um",
                        "channel": "Canal A",
                        "status": "PLAYING",
                        "position": 10.0,
                        "duration": 120.0,
                        "volume": 0.7,
                        "muted": False,
                    },
                    {
                        "tabId": "102",
                        "title": "Video Dois",
                        "channel": "Canal B",
                        "status": "PAUSED",
                        "position": 20.0,
                        "duration": 240.0,
                        "volume": 0.4,
                        "muted": True,
                    },
                ],
            }
        )

        state_with_ext = await coord.build_state()
        assert state_with_ext.extensionConnected is True
        assert [s.id for s in state_with_ext.sessions] == [
            "chrome:101",
            "chrome:102",
            "windows:Spotify.exe:0",
        ]
        assert all(s.appId != "chrome.exe" or s.source == "chrome" for s in state_with_ext.sessions)

        # Commands and tab volume route to Chrome extension
        err = await coord.handle_raw_client_message(
            {"v": 1, "type": "command", "sessionId": "chrome:102", "action": "seek", "value": 55}
        )
        assert err is None
        err = await coord.handle_raw_client_message(
            {"v": 1, "type": "volume", "target": "chrome:101", "value": 0.35}
        )
        assert err is None
        assert transport.sent[0]["type"] == "command"
        assert transport.sent[0]["tabId"] == "102"
        assert transport.sent[1]["type"] == "volume"
        assert transport.sent[1]["value"] == 0.35

        # Fallback media key + VLC Core Audio volume
        err = await coord.handle_raw_client_message(
            {"v": 1, "type": "command", "sessionId": "windows:fallback", "action": "toggle"}
        )
        assert err is None
        assert win.media_keys_sent == ["toggle"]

        err = await coord.handle_raw_client_message(
            {"v": 1, "type": "volume", "target": "windows-audio:vlc.exe", "value": 0.25}
        )
        assert err is None
        assert win.audio_apps[1].volume == 0.25

        # Disconnect extension -> Windows chrome.exe GSMTC reappears
        ext.detach(transport)
        state_after = await coord.build_state()
        assert state_after.extensionConnected is False
        assert "windows:chrome.exe:0" in [s.id for s in state_after.sessions]

    asyncio.run(_scenario())


def test_fastapi_endpoints_and_websockets_with_mocked_providers() -> None:
    win = FakeWindowsProvider()
    ext = ChromeExtensionProvider()
    app = create_app(
        settings=HostSettings(host="127.0.0.1", port=8765, poll_interval_sec=60.0),
        providers=[ext, win],
        audio_provider=win,
        chrome_provider=ext,
    )

    with TestClient(app) as client:
        html_resp = client.get("/")
        assert html_resp.status_code == 200
        assert "PC Media Control" in html_resp.text

        health = client.get("/health").json()
        assert health["status"] == "ok"
        assert health["host"] == "127.0.0.1"
        assert health["extensionConnected"] is False

        api_state = client.get("/api/state").json()
        assert api_state["v"] == 1
        assert len(api_state["sessions"]) == 2

        with client.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:8765"}) as ws:
            initial = ws.receive_json()
            assert initial["type"] == "state"
            assert initial["activeSessionId"] == "windows:Spotify.exe:0"

            ws.send_json({"v": 1, "type": "ping", "requestId": "p1"})
            pong = ws.receive_json()
            assert pong == {"v": 1, "type": "pong", "requestId": "p1"}

            ws.send_text("{bad json")
            err = ws.receive_json()
            assert err["type"] == "error"
            assert err["code"] == "invalid_json"

            ws.send_json({"v": 1, "type": "select", "sessionId": "windows:chrome.exe:0"})
            updated = ws.receive_json()
            assert updated["activeSessionId"] == "windows:chrome.exe:0"

            ws.send_json(
                {
                    "v": 1,
                    "type": "command",
                    "sessionId": "windows:Spotify.exe:0",
                    "action": "pause",
                }
            )
            after_cmd = ws.receive_json()
            assert after_cmd["type"] == "state"
            assert win.executed_commands[-1] == ("windows:Spotify.exe:0", "pause", None)

            ws.send_json({"v": 1, "type": "volume", "target": "master", "value": 0.2})
            after_vol = ws.receive_json()
            assert after_vol["masterVolume"]["level"] == 0.2

            ws.send_json({"v": 1, "type": "select", "sessionId": "windows:missing:0"})
            missing_err = ws.receive_json()
            assert missing_err["type"] == "error"
            assert missing_err["code"] == "session_not_found"

            ws.send_json({"v": 1, "type": "open", "mode": "youtube_search", "query": "lofi"})
            open_err = ws.receive_json()
            assert open_err["type"] == "error"
            assert open_err["code"] == "open_failed"

            # Connect Chrome extension via /ws/extension and observe deduplication live
            ext_origin = f"chrome-extension://{DEFAULT_EXTENSION_ID}"
            with client.websocket_connect(
                "/ws/extension", headers={"origin": ext_origin}
            ) as ext_ws:
                _ = ws.receive_json()  # broadcast on extension attach
                ext_ws.send_json(
                    {
                        "v": 1,
                        "type": "extension_state",
                        "tabs": [
                            {
                                "tabId": "77",
                                "title": "YouTube Tab",
                                "channel": "Canal X",
                                "artworkUrl": "https://i.ytimg.com/vi/abc123456/hqdefault.jpg",
                                "status": "PLAYING",
                                "position": 3.0,
                                "duration": 60.0,
                                "volume": 0.9,
                                "controls": {
                                    "play": True,
                                    "pause": True,
                                    "toggle": True,
                                    "seek": True,
                                    "skipAd": True,
                                },
                            }
                        ],
                    }
                )
                ext_state = ws.receive_json()
                assert ext_state["extensionConnected"] is True
                ids = [s["id"] for s in ext_state["sessions"]]
                assert "chrome:77" in ids
                assert "windows:chrome.exe:0" not in ids
                tab_77 = next(s for s in ext_state["sessions"] if s["id"] == "chrome:77")
                assert tab_77["controls"]["skipAd"] is True

                # Extension keepalive ping -> pong
                ext_ws.send_json({"type": "ping", "ts": 987654})
                ext_pong = ext_ws.receive_json()
                assert ext_pong == {"v": 1, "type": "pong", "ts": 987654}

                # Skip-ad command + open forwarding via extension
                ws.send_json(
                    {"v": 1, "type": "command", "sessionId": "chrome:77", "action": "skip_ad"}
                )
                fwd_skip = ext_ws.receive_json()
                assert fwd_skip["type"] == "command"
                assert fwd_skip["action"] == "skip_ad"
                assert fwd_skip["tabId"] == "77"
                ext_ws.send_json(
                    {"type": "extension_ack", "requestId": fwd_skip["requestId"], "ok": True}
                )
                _ = ws.receive_json()

                ws.send_json(
                    {"v": 1, "type": "open", "mode": "youtube_search", "query": "synthwave"}
                )
                fwd_open = ext_ws.receive_json()
                assert fwd_open["type"] == "open"
                assert fwd_open["mode"] == "youtube_search"
                assert fwd_open["query"] == "synthwave"
                ext_ws.send_json(
                    {"type": "extension_ack", "requestId": fwd_open["requestId"], "ok": True}
                )
                _ = ws.receive_json()


def test_manifest_key_matches_default_extension_id() -> None:
    manifest_path = Path(__file__).resolve().parent.parent / "extension" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert "key" in manifest and manifest["key"]
    assert extension_id_from_public_key_b64(manifest["key"]) == DEFAULT_EXTENSION_ID


def test_websocket_origin_validation_rejects_invalid_and_missing_origins() -> None:
    win = FakeWindowsProvider()
    ext = ChromeExtensionProvider()
    app = create_app(
        settings=HostSettings(
            host="127.0.0.1",
            port=8765,
            poll_interval_sec=60.0,
            extra_ws_origins=("http://192.168.1.50:8765",),
        ),
        providers=[ext, win],
        audio_provider=win,
        chrome_provider=ext,
    )

    with TestClient(app) as client:
        # /ws valid origins (own loopback + configured LAN origin for Fase 4)
        for valid_origin in (
            "http://127.0.0.1:8765",
            "http://localhost:8765",
            "http://192.168.1.50:8765",
        ):
            with client.websocket_connect("/ws", headers={"origin": valid_origin}) as ws:
                assert ws.receive_json()["type"] == "state"

        # /ws rejected origins (missing, evil domain, wrong port, extension origin, null)
        for invalid_headers in (
            {},
            {"origin": "http://evil.com"},
            {"origin": "http://127.0.0.1:9999"},
            {"origin": f"chrome-extension://{DEFAULT_EXTENSION_ID}"},
            {"origin": "null"},
        ):
            with (
                pytest.raises((WebSocketDisconnect, Exception)),
                client.websocket_connect("/ws", headers=invalid_headers),
            ):
                pass

        # /ws/extension accepts ONLY chrome-extension://<DEFAULT_EXTENSION_ID>
        valid_ext_origin = f"chrome-extension://{DEFAULT_EXTENSION_ID}"
        with client.websocket_connect("/ws/extension", headers={"origin": valid_ext_origin}):
            pass

        for bad_ext_headers in (
            {},
            {"origin": "http://127.0.0.1:8765"},
            {"origin": "http://evil.com"},
            {"origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        ):
            with (
                pytest.raises((WebSocketDisconnect, Exception)),
                client.websocket_connect("/ws/extension", headers=bad_ext_headers),
            ):
                pass


def test_dev_mode_gates_vite_websocket_origin() -> None:
    default_settings = HostSettings(host="127.0.0.1", port=8765, poll_interval_sec=60.0)
    assert "http://localhost:5173" not in default_settings.get_allowed_ws_origins()
    assert "http://127.0.0.1:5173" not in default_settings.get_allowed_ws_origins()

    win = FakeWindowsProvider()
    ext = ChromeExtensionProvider()
    prod_app = create_app(
        settings=default_settings,
        providers=[ext, win],
        audio_provider=win,
        chrome_provider=ext,
    )
    with TestClient(prod_app) as client:
        for dev_origin in ("http://localhost:5173", "http://127.0.0.1:5173"):
            with (
                pytest.raises((WebSocketDisconnect, Exception)),
                client.websocket_connect("/ws", headers={"origin": dev_origin}),
            ):
                pass

    dev_settings = HostSettings(
        host="127.0.0.1",
        port=8765,
        poll_interval_sec=60.0,
        dev_mode=True,
    )
    assert "http://localhost:5173" in dev_settings.get_allowed_ws_origins()
    dev_app = create_app(
        settings=dev_settings,
        providers=[ext, win],
        audio_provider=win,
        chrome_provider=ext,
    )
    with (
        TestClient(dev_app) as client,
        client.websocket_connect("/ws", headers={"origin": "http://localhost:5173"}) as ws,
    ):
        assert ws.receive_json()["type"] == "state"


def test_host_serves_client_dist_and_prevents_path_traversal(tmp_path: Path) -> None:
    dist_dir = tmp_path / "dist"
    (dist_dir / "assets").mkdir(parents=True)
    (dist_dir / "icons").mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html><body>PWA BUILD OK</body></html>", encoding="utf-8")
    (dist_dir / "manifest.webmanifest").write_text('{"name":"PC Media Control"}', encoding="utf-8")
    (dist_dir / "sw.js").write_text("// sw", encoding="utf-8")
    (dist_dir / "favicon.svg").write_text("<svg></svg>", encoding="utf-8")
    (dist_dir / "assets" / "app.js").write_text("console.log('ok');", encoding="utf-8")
    (dist_dir / "icons" / "icon-192.png").write_bytes(b"pngbytes")
    (tmp_path / "secret.txt").write_text("do-not-leak", encoding="utf-8")

    win = FakeWindowsProvider()
    ext = ChromeExtensionProvider()
    app = create_app(
        settings=HostSettings(poll_interval_sec=60.0, client_dist_dir=dist_dir),
        providers=[ext, win],
        audio_provider=win,
        chrome_provider=ext,
    )

    with TestClient(app) as client:
        root_resp = client.get("/")
        assert root_resp.status_code == 200
        assert "PWA BUILD OK" in root_resp.text

        legacy_resp = client.get("/legacy-test")
        assert legacy_resp.status_code == 200
        assert "PC Media Control" in legacy_resp.text

        manifest_resp = client.get("/manifest.webmanifest")
        assert manifest_resp.status_code == 200
        assert "application/manifest+json" in manifest_resp.headers["content-type"]

        assert client.get("/sw.js").status_code == 200
        assert client.get("/favicon.svg").status_code == 200
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/icons/icon-192.png").content == b"pngbytes"
        assert client.get("/assets/../../secret.txt").status_code == 404

    fallback_app = create_app(
        settings=HostSettings(poll_interval_sec=60.0, client_dist_dir=tmp_path / "missing"),
        providers=[ext, win],
        audio_provider=win,
        chrome_provider=ext,
    )
    with TestClient(fallback_app) as client:
        fallback_resp = client.get("/")
        assert fallback_resp.status_code == 200
        assert "PC Media Control" in fallback_resp.text


def test_dispatch_command_logs_host_session_status(caplog: pytest.LogCaptureFixture) -> None:
    win = FakeWindowsProvider()
    ext = ChromeExtensionProvider()
    coordinator = HostStateCoordinator(providers=[ext, win], audio_provider=win)

    async def _run() -> Any:
        await coordinator.build_state()
        return await coordinator.handle_raw_client_message(
            {
                "v": 1,
                "type": "command",
                "sessionId": "windows:Spotify.exe:0",
                "action": "pause",
            }
        )

    with caplog.at_level("INFO", logger="host.state"):
        reply = asyncio.run(_run())

    assert reply is None
    assert any(
        "action=pause" in rec.message
        and "session=windows:Spotify.exe:0" in rec.message
        and "status_host=PLAYING" in rec.message
        and "ativa=None" in rec.message
        for rec in caplog.records
    )


class ManualTransport:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: Any) -> None:
        self.sent.append(data)


def test_chrome_extension_idempotency_and_error_reasons() -> None:
    ext = ChromeExtensionProvider(command_timeout_sec=0.2)
    transport = ManualTransport()
    ext.attach(transport)

    # Seed an active playing tab
    tab_playing = {
        "tabId": "100",
        "title": "Video 1",
        "status": "PLAYING",
        "controls": {"play": True, "pause": True},
    }
    tab_paused = {
        "tabId": "200",
        "title": "Video 2",
        "status": "PAUSED",
        "controls": {"play": True, "pause": True},
    }
    asyncio.run(
        ext.handle_message({"type": "extension_state", "tabs": [tab_playing, tab_paused]})
    )

    # 1. Idempotent play when already playing
    ok, reason = asyncio.run(ext.execute_command_with_reason("chrome:100", "play"))
    assert ok is True
    assert reason == "already_playing"
    assert len(transport.sent) == 0  # no WS round-trip needed

    # 2. Idempotent pause when already paused
    ok, reason = asyncio.run(ext.execute_command_with_reason("chrome:200", "pause"))
    assert ok is True
    assert reason == "already_paused"
    assert len(transport.sent) == 0

    # 3. Command error propagation with exact cause
    async def _test_reason(error_reason: str) -> None:
        async def _respond_ack() -> None:
            await asyncio.sleep(0.01)
            req_id = transport.sent[-1]["requestId"]
            await ext.handle_message(
                {
                    "type": "extension_ack",
                    "requestId": req_id,
                    "ok": False,
                    "reason": error_reason,
                }
            )

        task = asyncio.create_task(_respond_ack())
        res_ok, res_reason = await ext.execute_command_with_reason("chrome:100", "pause")
        await task
        assert res_ok is False
        assert res_reason == error_reason

    for r in ["tab_closed", "tab_discarded", "no_media_element", "autoplay_rejected", "timeout"]:
        asyncio.run(_test_reason(r))

    # 4. State confirmed fallback: ack is False, but session status changed to expected
    async def _test_state_confirmed() -> None:
        async def _respond_false_and_update() -> None:
            await asyncio.sleep(0.02)
            req_id = transport.sent[-1]["requestId"]
            await ext.handle_message(
                {
                    "type": "extension_ack",
                    "requestId": req_id,
                    "ok": False,
                    "reason": "frame_swallowed",
                }
            )
            # Meanwhile, top frame starts playing and sends state
            await ext.handle_message(
                {
                    "type": "extension_state",
                    "tabs": [
                        {**tab_paused, "status": "PLAYING"},
                    ],
                }
            )

        task = asyncio.create_task(_respond_false_and_update())
        res_ok, res_reason = await ext.execute_command_with_reason("chrome:200", "play")
        await task
        assert res_ok is True
        assert res_reason == "state_confirmed"

    asyncio.run(_test_state_confirmed())


def test_windows_provider_audio_cache_and_optimistic_update() -> None:
    import time

    from host.providers.base import AudioAppInfo, MasterVolumeInfo
    from host.providers.windows import WindowsProvider

    win = WindowsProvider()
    win.invalidate_cache()

    # Pre-populate cache directly to test cache hits and optimistic updates
    win._cached_master = MasterVolumeInfo(level=0.5, muted=False, device_name="Test Speakers")
    win._cached_master_time = time.monotonic()
    win._cached_audio_apps = [
        AudioAppInfo(
            id="windows-audio:spotify.exe",
            source="windows",
            app="Spotify",
            process_name="spotify.exe",
            pid=1234,
            active=True,
            volume=0.8,
            muted=False,
        )
    ]
    win._cached_audio_apps_time = time.monotonic()

    # Cache hit within TTL returns instantly
    t0 = time.perf_counter()
    master = asyncio.run(win.get_master_volume())
    dt_master = (time.perf_counter() - t0) * 1000.0
    assert master.level == 0.5
    assert dt_master < 5.0  # In-memory hit is < 5ms (usually < 0.1ms)

    apps = asyncio.run(win.list_audio_apps())
    assert len(apps) == 1
    assert apps[0].app == "Spotify"
    assert apps[0].volume == 0.8

    win.close()


def test_host_state_ack_telemetry_and_reasons() -> None:
    win = FakeWindowsProvider()
    ext = ChromeExtensionProvider(command_timeout_sec=0.2)
    transport = FakeExtensionTransport(ext)
    ext.attach(transport)
    coord = HostStateCoordinator(providers=[win, ext], audio_provider=win)

    # 1. Successful command with requestId and clientSentAt receives AckMessage
    t_client = 1731490000000.0
    msg = {
        "v": 1,
        "type": "command",
        "sessionId": "windows:Spotify.exe:0",
        "action": "pause",
        "requestId": "req-123",
        "clientSentAt": t_client,
    }
    reply = asyncio.run(coord.handle_raw_client_message(msg))
    assert reply is not None
    assert reply.type == "ack"
    assert reply.ok is True
    assert reply.requestId == "req-123"
    assert reply.clientSentAt == t_client
    assert reply.execMs >= 0.0
    assert reply.target == "windows:Spotify.exe:0"

    # 2. Volume command with requestId receives AckMessage
    vol_msg = {
        "v": 1,
        "type": "volume",
        "target": "master",
        "value": 0.35,
        "requestId": "req-vol",
        "clientSentAt": t_client,
    }
    vol_reply = asyncio.run(coord.handle_raw_client_message(vol_msg))
    assert vol_reply is not None
    assert vol_reply.type == "ack"
    assert vol_reply.ok is True
    assert vol_reply.requestId == "req-vol"
    assert vol_reply.target == "master"
