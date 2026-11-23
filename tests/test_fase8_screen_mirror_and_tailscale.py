"""Automated tests for Fase 8: lightweight screen mirror and optional Tailscale access."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from host.app import create_app, is_trusted_local_request
from host.config import (
    DEFAULT_EXTENSION_ID,
    HostConfigStore,
    HostSettings,
    sanitize_hostname,
)
from host.input_control import compute_virtual_desktop_abs_coords
from host.network import (
    LanInterface,
    detect_tailscale_info,
    is_tailscale_ipv4,
    resolve_primary_lan_ip,
)
from host.pairing import PairingManager
from host.protocol import ErrorMessage, InputMessage, StateMessage, parse_client_message
from host.providers.base import (
    AudioAppInfo,
    MasterVolumeInfo,
    MediaAction,
    MediaSessionInfo,
    MouseButton,
)
from host.screen_mirror import (
    MonitorInfo,
    ScreenFrame,
    VirtualBounds,
    draw_cursor_on_image,
    encode_rgb_to_jpeg_frame,
)
from host.state import HostStateCoordinator
from host.tray import SystemTrayApp


class FakeScreenCaptureProvider:
    """In-memory deterministic screen capture provider for testing /ws/screen."""

    def __init__(self) -> None:
        self.monitors = [
            MonitorInfo(
                id=1,
                name="Tela 1 (1920x1080)",
                left=0,
                top=0,
                width=1920,
                height=1080,
                primary=True,
            ),
            MonitorInfo(
                id=2,
                name="Tela 2 (1280x720)",
                left=1920,
                top=0,
                width=1280,
                height=720,
                primary=False,
            ),
        ]
        self.capture_calls: list[tuple[int, int, int, bool]] = []
        self._frame_seq = 0
        self.closed = False

    async def list_monitors(self) -> list[MonitorInfo]:
        return list(self.monitors)

    async def get_virtual_bounds(self) -> VirtualBounds:
        return VirtualBounds(left=0, top=0, width=3200, height=1080)

    async def capture_jpeg(
        self,
        monitor_id: int = 1,
        max_width: int = 960,
        quality: int = 60,
        include_cursor: bool = True,
    ) -> ScreenFrame | None:
        self._frame_seq += 1
        self.capture_calls.append((monitor_id, max_width, quality, include_cursor))
        color = (24, 60, 120) if monitor_id == 1 else (90, 30, 80)
        img = Image.new("RGB", (320, 180), color)
        # Ensure each capture gets distinct pixels when config changes or frames advance cleanly
        img.putpixel((self._frame_seq % 300, 10), (255, 255, 255))
        return encode_rgb_to_jpeg_frame(img, monitor_id=monitor_id, quality=quality)

    def close(self) -> None:
        self.closed = True


class FakeInputProvider:
    """In-memory RemoteInputProvider recording move_mouse_abs and clicks."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def move_mouse(self, dx: int, dy: int) -> bool:
        self.calls.append(("move_mouse", dx, dy))
        return True

    async def move_mouse_abs(self, x: float, y: float, monitor: int = 1) -> bool:
        self.calls.append(("move_mouse_abs", round(x, 4), round(y, 4), monitor))
        return True

    async def click_mouse(self, button: MouseButton, double: bool = False) -> bool:
        self.calls.append(("click_mouse", button, double))
        return True

    async def mouse_button(self, button: MouseButton, state: Literal["down", "up"]) -> bool:
        self.calls.append(("mouse_button", button, state))
        return True

    async def scroll_mouse(self, dx: int, dy: int) -> bool:
        self.calls.append(("scroll_mouse", dx, dy))
        return True

    async def type_text(self, text: str) -> bool:
        self.calls.append(("type_text", text))
        return True

    async def press_key(self, key: str, modifiers: list[str] | None = None) -> bool:
        self.calls.append(("press_key", key, list(modifiers or [])))
        return True


class MinimalAudioProvider:
    async def get_master_volume(self) -> MasterVolumeInfo:
        return MasterVolumeInfo(level=0.5, muted=False, device_name="Alto-falantes")

    async def set_master_volume(
        self, level: float | None = None, muted: bool | None = None
    ) -> MasterVolumeInfo:
        return MasterVolumeInfo(
            level=0.5 if level is None else level,
            muted=False if muted is None else muted,
            device_name="Alto-falantes",
        )

    async def list_audio_apps(self) -> list[AudioAppInfo]:
        return []

    async def set_audio_app_volume(
        self, app_audio_id: str, level: float | None = None, muted: bool | None = None
    ) -> bool:
        return True

    async def send_media_key(self, action: MediaAction) -> bool:
        return True


class MinimalSessionProvider:
    @property
    def source(self) -> str:
        return "windows"

    @property
    def is_connected(self) -> bool:
        return True

    async def list_sessions(self) -> list[MediaSessionInfo]:
        return []

    async def execute_command(
        self, session_id: str, action: MediaAction, value: float | None = None
    ) -> bool:
        return False

    async def set_session_volume(
        self, session_id: str, level: float | None = None, muted: bool | None = None
    ) -> bool:
        return False


def _build_fase8_app(
    tmp_path: Path,
    *,
    lan_mode: bool = True,
    tailscale_enabled: bool = False,
    tailscale_ip: str | None = None,
    tailscale_hostname: str | None = None,
) -> tuple[Any, PairingManager, FakeScreenCaptureProvider, HostConfigStore]:
    mgr = PairingManager(storage_path=tmp_path / "devices.json")
    store = HostConfigStore(path=tmp_path / "settings.json")
    screen = FakeScreenCaptureProvider()
    settings = HostSettings(
        host="0.0.0.0" if lan_mode else "127.0.0.1",
        port=8765,
        lan_mode=lan_mode,
        lan_ip="192.168.15.4",
        pairing_manager=mgr,
        tailscale_enabled=tailscale_enabled,
        tailscale_ip=tailscale_ip,
        tailscale_hostname=tailscale_hostname,
    )
    app = create_app(
        settings=settings,
        providers=[MinimalSessionProvider()],
        audio_provider=MinimalAudioProvider(),
        pairing_manager=mgr,
        input_provider=FakeInputProvider(),
        config_store=store,
        screen_provider=screen,
    )
    return app, mgr, screen, store


# ---------------------------------------------------------------------------
# 1. Screen Mirror Coordinate Mapping, Encoding & Protocol Validation
# ---------------------------------------------------------------------------


def test_compute_virtual_desktop_abs_coords_single_and_multi_monitor() -> None:
    single = (0, 0, 1920, 1080)
    assert compute_virtual_desktop_abs_coords(0.0, 0.0, single, single) == (0, 0)
    assert compute_virtual_desktop_abs_coords(1.0, 1.0, single, single) == (65535, 65535)
    cx, cy = compute_virtual_desktop_abs_coords(0.5, 0.5, single, single)
    assert 32760 <= cx <= 32780
    assert 32760 <= cy <= 32780

    # Left secondary monitor at (-1920, 0), primary at (0, 0) -> total width 3840
    left_mon = (-1920, 0, 1920, 1080)
    right_mon = (0, 0, 1920, 1080)
    virtual = (-1920, 0, 3840, 1080)
    ax_left, _ = compute_virtual_desktop_abs_coords(0.0, 0.5, left_mon, virtual)
    ax_left_edge, _ = compute_virtual_desktop_abs_coords(1.0, 0.5, left_mon, virtual)
    ax_right_edge, ay_bottom = compute_virtual_desktop_abs_coords(1.0, 1.0, right_mon, virtual)
    assert ax_left == 0
    assert 32000 <= ax_left_edge < 32800
    assert ax_right_edge == 65535
    assert ay_bottom == 65535

    # Clamping out-of-range inputs
    assert compute_virtual_desktop_abs_coords(-0.5, 1.7, single, single) == (0, 65535)


def test_mouse_move_abs_protocol_and_state_message() -> None:
    msg = parse_client_message(
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": 0.42, "y": 0.75}
    )
    assert isinstance(msg, InputMessage)
    assert msg.monitor == 1

    msg_mon2 = parse_client_message(
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": 0.1, "y": 0.9, "monitor": 2}
    )
    assert isinstance(msg_mon2, InputMessage)
    assert msg_mon2.monitor == 2

    state = StateMessage(
        sessions=[],
        activeSessionId=None,
        masterVolume={"level": 0.5, "muted": False, "deviceName": "PC"},
        audioSessions=[],
        tailscaleEnabled=True,
        screenMirrorAvailable=True,
    )
    assert state.tailscaleEnabled is True
    assert state.screenMirrorAvailable is True

    invalid = [
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": 0.5},
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": -0.01, "y": 0.5},
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": 0.5, "y": 1.01},
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": 0.5, "y": 0.5, "monitor": 0},
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": 0.5, "y": 0.5, "monitor": 17},
    ]
    for payload in invalid:
        with pytest.raises(ValidationError):
            parse_client_message(payload)


def test_draw_cursor_and_jpeg_frame_encoding() -> None:
    monitor = MonitorInfo(id=1, name="Tela 1", left=0, top=0, width=1920, height=1080, primary=True)
    img_inside = Image.new("RGB", (640, 360), (20, 20, 20))
    draw_cursor_on_image(img_inside, (960, 540), monitor)
    # Cursor drawn at center should modify center pixel
    assert img_inside.getpixel((320, 180)) != (20, 20, 20)

    # Cursor on another monitor should not alter image
    img_outside = Image.new("RGB", (640, 360), (20, 20, 20))
    draw_cursor_on_image(img_outside, (2500, 540), monitor)
    assert img_outside.getpixel((320, 180)) == (20, 20, 20)

    frame = encode_rgb_to_jpeg_frame(img_inside, monitor_id=1, quality=60)
    assert frame.jpeg_bytes[:2] == b"\xff\xd8"
    assert len(frame.digest) == 8
    assert frame.width == 640
    assert frame.height == 360


@pytest.mark.anyio
async def test_mouse_move_abs_respects_security_gate(tmp_path: Path) -> None:
    store = HostConfigStore(path=tmp_path / "settings.json")
    fake_input = FakeInputProvider()
    coord = HostStateCoordinator(
        providers=[MinimalSessionProvider()],
        audio_provider=MinimalAudioProvider(),
        input_provider=fake_input,
        remote_input_enabled=store.get_remote_input_enabled(),
        on_remote_input_change=store.set_remote_input_enabled,
    )

    blocked = await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "mouse_move_abs", "x": 0.5, "y": 0.5}
    )
    assert isinstance(blocked, ErrorMessage)
    assert blocked.code == "remote_input_disabled"
    assert fake_input.calls == []

    coord.set_remote_input_enabled(True)
    res = await coord.handle_raw_client_message(
        {
            "v": 1,
            "type": "input",
            "action": "mouse_move_abs",
            "x": 0.25,
            "y": 0.75,
            "monitor": 2,
            "requestId": "abs-1",
        }
    )
    assert res is not None
    assert ("move_mouse_abs", 0.25, 0.75, 2) in fake_input.calls


# ---------------------------------------------------------------------------
# 2. Screen Mirror Endpoints & Revocation
# ---------------------------------------------------------------------------


def test_screen_monitors_endpoint_and_ws_stream_loopback(tmp_path: Path) -> None:
    app, mgr, screen, _ = _build_fase8_app(tmp_path)

    local_client = TestClient(app)
    r_mon = local_client.get("/api/screen/monitors")
    assert r_mon.status_code == 200
    mons = r_mon.json()["monitors"]
    assert len(mons) == 2
    assert mons[0]["id"] == 1

    # Non-loopback without token returns 401
    lan_client = TestClient(app, client=("192.168.15.20", 54321))
    assert lan_client.get("/api/screen/monitors").status_code == 401

    session = mgr.get_or_create_pairing_session()
    ok, _, res = mgr.verify_and_pair(session.code, "Phone Test")
    assert ok and res is not None
    r_mon_auth = lan_client.get(
        "/api/screen/monitors",
        headers={"Authorization": f"Bearer {res['token']}"},
    )
    assert r_mon_auth.status_code == 200

    with local_client.websocket_connect(
        "/ws/screen",
        headers={"Origin": "http://127.0.0.1:8765"},
    ) as ws:
        meta = json.loads(ws.receive_text())
        assert meta["type"] == "screen_meta"
        assert len(meta["monitors"]) == 2

        jpeg_bytes = ws.receive_bytes()
        assert jpeg_bytes[:2] == b"\xff\xd8"

        ws.send_text(
            json.dumps(
                {
                    "v": 1,
                    "type": "screen_config",
                    "monitor": 2,
                    "fps": 12,
                    "quality": 70,
                    "maxWidth": 640,
                    "paused": False,
                }
            )
        )
        ws.send_text(json.dumps({"v": 1, "type": "ping", "requestId": "p1"}))
        seen_pong = False
        for _ in range(4):
            msg = ws.receive()
            if msg.get("text"):
                data = json.loads(msg["text"])
                if data.get("type") == "pong":
                    seen_pong = True
                    break
        assert seen_pong is True
        assert any(call[0] == 1 for call in screen.capture_calls)


def test_ws_screen_lan_auth_and_immediate_revocation(tmp_path: Path) -> None:
    app, mgr, _, _ = _build_fase8_app(tmp_path)
    session = mgr.get_or_create_pairing_session()
    ok, _, res = mgr.verify_and_pair(session.code, "Celular Espelho")
    assert ok and res is not None
    token = res["token"]
    dev_id = res["deviceId"]

    with TestClient(app, client=("192.168.15.33", 55555)) as lan_client:
        # Invalid auth frame -> pairing_required + 4001
        with lan_client.websocket_connect(
            "/ws/screen",
            headers={"Origin": "http://192.168.15.4:8765"},
        ) as ws_bad:
            ws_bad.send_text(json.dumps({"v": 1, "type": "auth", "token": "wrong"}))
            err = json.loads(ws_bad.receive_text())
            assert err["code"] == "pairing_required"
            with pytest.raises(WebSocketDisconnect) as exc_bad:
                ws_bad.receive_text()
            assert exc_bad.value.code == 4001

        # Valid auth frame -> receives meta & frame, then closed immediately on revocation
        with lan_client.websocket_connect(
            "/ws/screen",
            headers={"Origin": "http://192.168.15.4:8765"},
        ) as ws_good:
            ws_good.send_text(json.dumps({"v": 1, "type": "auth", "token": token}))
            meta = json.loads(ws_good.receive_text())
            assert meta["type"] == "screen_meta"
            frame_bytes = ws_good.receive_bytes()
            assert frame_bytes[:2] == b"\xff\xd8"

            mgr.revoke_device(dev_id)
            with pytest.raises(WebSocketDisconnect) as exc_revoked:
                while True:
                    msg = ws_good.receive()
                    if msg.get("type") == "websocket.close":
                        raise WebSocketDisconnect(code=int(msg.get("code", 1000)))
            assert exc_revoked.value.code == 4001


# ---------------------------------------------------------------------------
# 3. Optional Tailscale Support & Reverse Proxy Security Hardening
# ---------------------------------------------------------------------------


def test_tailscale_detection_and_lan_priority_preserved() -> None:
    assert is_tailscale_ipv4("100.64.0.1") is True
    assert is_tailscale_ipv4("100.127.255.254") is True
    assert is_tailscale_ipv4("100.63.255.255") is False
    assert is_tailscale_ipv4("100.128.0.1") is False
    assert is_tailscale_ipv4("192.168.1.5") is False
    assert is_tailscale_ipv4("bad") is False

    interfaces = [
        LanInterface("Tailscale", "100.88.12.5", is_virtual=True, is_private=False),
        LanInterface("Wi-Fi", "192.168.15.4", is_virtual=False, is_private=True),
    ]
    # Primary LAN IP still ignores Tailscale and selects physical Wi-Fi
    chosen, _ = resolve_primary_lan_ip(interfaces)
    assert chosen == "192.168.15.4"

    cli_payload = json.dumps(
        {
            "Self": {
                "DNSName": "meu-pc.tailnet.ts.net.",
                "TailscaleIPs": ["100.88.12.5", "fd7a::1"],
            }
        }
    )
    with patch(
        "subprocess.run",
        return_value=subprocess.CompletedProcess(["tailscale"], 0, stdout=cli_payload, stderr=""),
    ):
        ts_info = detect_tailscale_info(interfaces=interfaces, query_cli=True)
    assert ts_info.available is True
    assert ts_info.ip == "100.88.12.5"
    assert ts_info.dns_name == "meu-pc.tailnet.ts.net"


def test_tailscale_opt_in_host_and_origin_validation(tmp_path: Path) -> None:
    # Default disabled: rejects 100.x and *.ts.net
    app_off, _, _, store_off = _build_fase8_app(
        tmp_path / "off",
        tailscale_enabled=False,
        tailscale_ip="100.88.12.5",
        tailscale_hostname="meu-pc.tailnet.ts.net",
    )
    assert store_off.get_tailscale_enabled() is False
    client_off = TestClient(app_off, client=("100.88.12.99", 40000))
    assert client_off.get("/health", headers={"Host": "100.88.12.5:8765"}).status_code == 403
    assert (
        client_off.get("/health", headers={"Host": "meu-pc.tailnet.ts.net"}).status_code == 403
    )

    # Enabled opt-in: allows configured Tailscale IP and MagicDNS host
    app_on, mgr_on, _, _ = _build_fase8_app(
        tmp_path / "on",
        tailscale_enabled=True,
        tailscale_ip="100.88.12.5",
        tailscale_hostname="meu-pc.tailnet.ts.net",
    )
    session = mgr_on.get_or_create_pairing_session()
    ok, _, res = mgr_on.verify_and_pair(session.code, "Phone Remoto")
    assert ok and res is not None

    client_on = TestClient(app_on, client=("100.88.12.99", 40000))
    health = client_on.get("/health", headers={"Host": "100.88.12.5:8765"})
    assert health.status_code == 200
    assert health.json()["tailscaleEnabled"] is True

    # Remote /ws with valid Tailscale origin works after auth frame
    with client_on.websocket_connect(
        "/ws",
        headers={
            "Host": "meu-pc.tailnet.ts.net",
            "Origin": "https://meu-pc.tailnet.ts.net",
        },
    ) as ws:
        ws.send_text(json.dumps({"v": 1, "type": "auth", "token": res["token"]}))
        state = json.loads(ws.receive_text())
        assert state["type"] == "state"
        assert state["tailscaleEnabled"] is True


def test_tailscale_serve_proxy_hardening_never_bypasses_auth(tmp_path: Path) -> None:
    """Requests proxied from 127.0.0.1 (e.g. tailscale serve) must NEVER be treated as local."""
    app, mgr, _, _ = _build_fase8_app(
        tmp_path,
        tailscale_enabled=True,
        tailscale_ip="100.88.12.5",
        tailscale_hostname="meu-pc.tailnet.ts.net",
    )
    session = mgr.get_or_create_pairing_session()
    ok, _, res = mgr.verify_and_pair(session.code, "Phone Via Serve")
    assert ok and res is not None
    token = res["token"]

    proxy_headers = {
        "Host": "meu-pc.tailnet.ts.net",
        "X-Forwarded-For": "100.90.1.2",
        "X-Forwarded-Proto": "https",
        "Tailscale-User-Login": "usuario@exemplo.com",
    }
    assert is_trusted_local_request("127.0.0.1", proxy_headers) is False

    # Peer IP is 127.0.0.1 because tailscale serve proxies over loopback!
    proxied_client = TestClient(app, client=("127.0.0.1", 55123))

    # Local-only management routes MUST return 403
    assert proxied_client.get("/pair", headers=proxy_headers).status_code == 403
    assert proxied_client.get("/legacy-test", headers=proxy_headers).status_code == 403
    assert proxied_client.post("/pair/tailscale", headers=proxy_headers).status_code == 403

    # Extension WS MUST reject proxied requests even from 127.0.0.1
    with (
        pytest.raises(WebSocketDisconnect),
        proxied_client.websocket_connect(
            "/ws/extension",
            headers={
                **proxy_headers,
                "Origin": f"chrome-extension://{DEFAULT_EXTENSION_ID}",
            },
        ),
    ):
        pass

    # Protected APIs MUST require paired Bearer token (401 without token)
    assert proxied_client.get("/api/state", headers=proxy_headers).status_code == 401
    assert proxied_client.get("/api/devices", headers=proxy_headers).status_code == 401
    assert proxied_client.get("/api/screen/monitors", headers=proxy_headers).status_code == 401

    # Protected APIs succeed WITH valid Bearer token
    auth_headers = {**proxy_headers, "Authorization": f"Bearer {token}"}
    assert proxied_client.get("/api/state", headers=auth_headers).status_code == 200
    assert proxied_client.get("/api/screen/monitors", headers=auth_headers).status_code == 200

    # /ws MUST require first-frame auth even though peer IP is 127.0.0.1
    ws_headers = {**proxy_headers, "Origin": "https://meu-pc.tailnet.ts.net"}
    with proxied_client.websocket_connect("/ws", headers=ws_headers) as ws_unauth:
        ws_unauth.send_text(json.dumps({"v": 1, "type": "ping"}))
        err = json.loads(ws_unauth.receive_text())
        assert err["code"] == "pairing_required"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws_unauth.receive_text()
        assert exc.value.code == 4001

    # /ws and /ws/screen succeed WITH valid token
    with proxied_client.websocket_connect("/ws/screen", headers=ws_headers) as ws_screen:
        ws_screen.send_text(json.dumps({"v": 1, "type": "auth", "token": token}))
        meta = json.loads(ws_screen.receive_text())
        assert meta["type"] == "screen_meta"
        frame_bytes = ws_screen.receive_bytes()
        assert frame_bytes[:2] == b"\xff\xd8"


def test_tailscale_config_persistence_tray_and_doctor(tmp_path: Path) -> None:
    assert sanitize_hostname("https://Meu-PC.Tailnet.ts.net:8765/") == "meu-pc.tailnet.ts.net"

    cfg_path = tmp_path / "settings.json"
    store = HostConfigStore(path=cfg_path)
    assert store.get_tailscale_enabled() is False
    store.set_tailscale_enabled(True)
    store.set_tailscale_hostname("https://Note.Tailnet.ts.net/")
    reloaded = HostConfigStore(path=cfg_path)
    assert reloaded.get_tailscale_enabled() is True
    assert reloaded.get_tailscale_hostname() == "note.tailnet.ts.net"

    # Tray exposes Tailscale toggle item and calls callback
    toggled: list[bool] = []
    tray = SystemTrayApp(
        settings=HostSettings(),
        get_tailscale_enabled=lambda: False,
        on_toggle_tailscale=lambda flag: toggled.append(flag),
    )
    tray._toggle_tailscale(None, SimpleNamespace())
    assert toggled == [True]

    # /pair local form updates hostname & toggles Tailscale
    app, _, _, store_pair = _build_fase8_app(tmp_path / "pair")
    local_client = TestClient(app)
    resp = local_client.post(
        "/pair/tailscale",
        data={"hostname": "casa-pc.tailnet.ts.net", "enabled": "true"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert store_pair.get_tailscale_enabled() is True
    assert store_pair.get_tailscale_hostname() == "casa-pc.tailnet.ts.net"

    # Doctor logs Tailscale informational line when available
    from host.__main__ import run_doctor

    with (
        patch("host.__main__.list_lan_interfaces") as mock_ifaces,
        patch(
            "host.__main__.detect_tailscale_info",
            return_value=SimpleNamespace(available=True, ip="100.88.12.5", dns_name="pc.ts.net"),
        ),
        patch("subprocess.run", return_value=MagicMock(returncode=1, stdout="")),
        patch("socket.socket") as mock_sock_cls,
        patch("builtins.print") as mock_print,
    ):
        mock_ifaces.return_value = [
            LanInterface("Wi-Fi", "192.168.15.4", is_virtual=False, is_private=True),
        ]
        mock_sock_cls.return_value.__enter__.return_value.connect_ex.return_value = 0
        assert run_doctor(port=8765) == 0
        lines = [str(c.args[0]) for c in mock_print.call_args_list if c.args]
        assert any("Tailscale detectado (opcional)" in line for line in lines)
