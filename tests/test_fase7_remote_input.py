"""Automated tests for Fase 7: remote input protocol, security gate, and Win32 SendInput."""

from __future__ import annotations

import ctypes
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from host import input_control
from host.app import create_app
from host.config import HostConfigStore, HostSettings
from host.input_control import (
    INPUT,
    INPUT_KEYBOARD,
    INPUT_MOUSE,
    KEYBDINPUT,
    KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE,
    MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_WHEEL,
    MOUSEINPUT,
    WindowsInputProvider,
)
from host.pairing import PairingManager
from host.protocol import (
    AckMessage,
    ErrorMessage,
    InputMessage,
    SettingsMessage,
    parse_client_message,
)
from host.providers.base import (
    AudioAppInfo,
    MasterVolumeInfo,
    MediaAction,
    MediaSessionInfo,
    MouseButton,
)
from host.state import HostStateCoordinator
from host.tray import SystemTrayApp


class FakeInputProvider:
    """In-memory RemoteInputProvider stub that records every input call safely."""

    def __init__(self, should_succeed: bool = True) -> None:
        self.should_succeed = should_succeed
        self.calls: list[tuple[Any, ...]] = []

    async def move_mouse(self, dx: int, dy: int) -> bool:
        self.calls.append(("move_mouse", dx, dy))
        return self.should_succeed

    async def click_mouse(self, button: MouseButton, double: bool = False) -> bool:
        self.calls.append(("click_mouse", button, double))
        return self.should_succeed

    async def mouse_button(self, button: MouseButton, state: Literal["down", "up"]) -> bool:
        self.calls.append(("mouse_button", button, state))
        return self.should_succeed

    async def scroll_mouse(self, dx: int, dy: int) -> bool:
        self.calls.append(("scroll_mouse", dx, dy))
        return self.should_succeed

    async def type_text(self, text: str) -> bool:
        self.calls.append(("type_text", text))
        return self.should_succeed

    async def press_key(self, key: str, modifiers: list[str] | None = None) -> bool:
        self.calls.append(("press_key", key, list(modifiers or [])))
        return self.should_succeed


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


def test_input_and_settings_protocol_validation() -> None:
    move = parse_client_message(
        {"v": 1, "type": "input", "action": "mouse_move", "dx": 14, "dy": -9}
    )
    assert isinstance(move, InputMessage)
    assert move.dx == 14
    assert move.dy == -9

    click = parse_client_message({"v": 1, "type": "input", "action": "mouse_click"})
    assert isinstance(click, InputMessage)
    assert click.button == "left"
    assert click.double is False

    scroll = parse_client_message({"v": 1, "type": "input", "action": "mouse_scroll", "dy": -120})
    assert isinstance(scroll, InputMessage)
    assert scroll.dx == 0
    assert scroll.dy == -120

    txt = parse_client_message(
        {"v": 1, "type": "input", "action": "key_text", "text": "Ação çãé!"}
    )
    assert isinstance(txt, InputMessage)
    assert txt.text == "Ação çãé!"

    space_txt = parse_client_message({"v": 1, "type": "input", "action": "key_text", "text": " "})
    assert isinstance(space_txt, InputMessage)

    key = parse_client_message(
        {
            "v": 1,
            "type": "input",
            "action": "key_press",
            "key": "  TAB ",
            "modifiers": ["alt", "alt"],
        }
    )
    assert isinstance(key, InputMessage)
    assert key.key == "tab"
    assert key.modifiers == ["alt"]

    settings_msg = parse_client_message(
        {"v": 1, "type": "settings", "remoteInputEnabled": True, "requestId": "req-1"}
    )
    assert isinstance(settings_msg, SettingsMessage)
    assert settings_msg.remoteInputEnabled is True

    # Invalid cases
    invalid_payloads: list[dict[str, Any]] = [
        {"v": 1, "type": "input", "action": "mouse_move", "dx": 10},
        {"v": 1, "type": "input", "action": "mouse_move", "dx": 501, "dy": 0},
        {"v": 1, "type": "input", "action": "mouse_move", "dx": 0, "dy": -501},
        {"v": 1, "type": "input", "action": "mouse_scroll"},
        {"v": 1, "type": "input", "action": "mouse_scroll", "dy": 1201},
        {"v": 1, "type": "input", "action": "key_text", "text": ""},
        {"v": 1, "type": "input", "action": "key_text", "text": "abc\x00def"},
        {"v": 1, "type": "input", "action": "key_text", "text": "a" * 501},
        {"v": 1, "type": "input", "action": "key_press", "key": "not_allowed_key"},
        {
            "v": 1,
            "type": "input",
            "action": "key_press",
            "key": "delete",
            "modifiers": ["ctrl", "alt"],
        },
    ]
    for bad in invalid_payloads:
        with pytest.raises(ValidationError):
            parse_client_message(bad)


def test_config_store_persistence_and_default_off(tmp_path: Path) -> None:
    cfg_path = tmp_path / "settings.json"
    store = HostConfigStore(path=cfg_path)
    assert store.get_remote_input_enabled() is False

    assert store.set_remote_input_enabled(True) is True
    reloaded = HostConfigStore(path=cfg_path)
    assert reloaded.get_remote_input_enabled() is True

    assert reloaded.set_remote_input_enabled(False) is False
    reloaded2 = HostConfigStore(path=cfg_path)
    assert reloaded2.get_remote_input_enabled() is False

    # Recover cleanly from corrupt JSON
    cfg_path.write_text("{corrupt json", encoding="utf-8")
    recovered = HostConfigStore(path=cfg_path)
    assert recovered.get_remote_input_enabled() is False


@pytest.mark.anyio
async def test_security_gate_and_high_freq_input_dispatch(tmp_path: Path) -> None:
    store = HostConfigStore(path=tmp_path / "settings.json")
    fake_input = FakeInputProvider()
    coord = HostStateCoordinator(
        providers=[MinimalSessionProvider()],
        audio_provider=MinimalAudioProvider(),
        input_provider=fake_input,
        remote_input_enabled=store.get_remote_input_enabled(),
        on_remote_input_change=store.set_remote_input_enabled,
    )

    state0 = await coord.build_state()
    assert state0.remoteInputEnabled is False

    # Rejected while disabled
    res_move = await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "mouse_move", "dx": 10, "dy": 5}
    )
    assert isinstance(res_move, ErrorMessage)
    assert res_move.code == "remote_input_disabled"
    assert fake_input.calls == []

    # Enable via SettingsMessage
    res_set = await coord.handle_raw_client_message(
        {"v": 1, "type": "settings", "remoteInputEnabled": True, "requestId": "set-1"}
    )
    assert isinstance(res_set, AckMessage)
    assert res_set.ok is True
    assert store.get_remote_input_enabled() is True
    assert (await coord.build_state()).remoteInputEnabled is True

    if coord._broadcast_task is not None:
        coord._broadcast_task.cancel()
        coord._broadcast_task = None

    # High-frequency mouse_move without requestId returns None & does NOT schedule state broadcast
    res_move_ok = await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "mouse_move", "dx": 12, "dy": -8}
    )
    assert res_move_ok is None
    assert coord._broadcast_task is None

    await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "mouse_click", "button": "left", "double": True}
    )
    await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "mouse_down", "button": "left"}
    )
    await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "mouse_up", "button": "left"}
    )
    await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "mouse_scroll", "dy": -120}
    )
    await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "key_text", "text": "Olá mundo çã!"}
    )
    res_key = await coord.handle_raw_client_message(
        {
            "v": 1,
            "type": "input",
            "action": "key_press",
            "key": "tab",
            "modifiers": ["alt"],
            "requestId": "k-1",
        }
    )
    assert isinstance(res_key, AckMessage)
    assert res_key.ok is True

    assert fake_input.calls == [
        ("move_mouse", 12, -8),
        ("click_mouse", "left", True),
        ("mouse_button", "left", "down"),
        ("mouse_button", "left", "up"),
        ("scroll_mouse", 0, -120),
        ("type_text", "Olá mundo çã!"),
        ("press_key", "tab", ["alt"]),
    ]

    # Disable again -> subsequent input blocked immediately
    await coord.handle_raw_client_message(
        {"v": 1, "type": "settings", "remoteInputEnabled": False}
    )
    res_blocked = await coord.handle_raw_client_message(
        {"v": 1, "type": "input", "action": "key_text", "text": "nao vai"}
    )
    assert isinstance(res_blocked, ErrorMessage)
    assert res_blocked.code == "remote_input_disabled"


def test_app_remote_input_websocket_and_pair_loopback_guard(tmp_path: Path) -> None:
    cfg_store = HostConfigStore(path=tmp_path / "settings.json")
    fake_input = FakeInputProvider()
    app = create_app(
        settings=HostSettings(host="127.0.0.1", port=8765, poll_interval_sec=60.0),
        providers=[MinimalSessionProvider()],
        audio_provider=MinimalAudioProvider(),
        input_provider=fake_input,
        config_store=cfg_store,
    )

    with TestClient(app) as client:
        assert client.get("/health").json()["remoteInputEnabled"] is False

        with client.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:8765"}) as ws:
            initial = ws.receive_json()
            assert initial["remoteInputEnabled"] is False

            ws.send_json({"v": 1, "type": "input", "action": "mouse_click", "button": "left"})
            err = ws.receive_json()
            assert err["type"] == "error"
            assert err["code"] == "remote_input_disabled"

            # Enable from /pair loopback form
            resp = client.post(
                "/pair/remote-input", data={"enabled": "true"}, follow_redirects=False
            )
            assert resp.status_code == 303
            updated_state = ws.receive_json()
            assert updated_state["remoteInputEnabled"] is True
            assert client.get("/health").json()["remoteInputEnabled"] is True

            ws.send_json(
                {
                    "v": 1,
                    "type": "input",
                    "action": "mouse_click",
                    "button": "right",
                    "requestId": "clk-1",
                }
            )
            ack = ws.receive_json()
            assert ack["type"] == "ack"
            assert ack["ok"] is True
            assert fake_input.calls == [("click_mouse", "right", False)]

    # Non-loopback clients must be rejected with 403 on /pair/remote-input
    lan_client = TestClient(app, client=("192.168.15.20", 50000))
    forbidden = lan_client.post("/pair/remote-input", data={"enabled": "false"})
    assert forbidden.status_code == 403


@pytest.mark.anyio
async def test_windows_input_provider_send_input_mocked(monkeypatch: pytest.MonkeyPatch) -> None:
    # Verify 64-bit Win32 SendInput struct layout matches OS ABI cleanly
    if ctypes.sizeof(ctypes.c_void_p) == 8:
        assert ctypes.sizeof(INPUT) == 40
        assert ctypes.sizeof(MOUSEINPUT) == 32
        assert ctypes.sizeof(KEYBDINPUT) == 24

    captured: list[dict[str, Any]] = []

    def fake_send_input(count: int, arr: Any, cb_size: int) -> int:
        assert cb_size == ctypes.sizeof(INPUT)
        for idx in range(count):
            item = arr[idx]
            if item.type == INPUT_MOUSE:
                captured.append(
                    {
                        "type": "mouse",
                        "dx": item.mi.dx,
                        "dy": item.mi.dy,
                        "data": item.mi.mouseData,
                        "flags": item.mi.dwFlags,
                    }
                )
            elif item.type == INPUT_KEYBOARD:
                captured.append(
                    {
                        "type": "key",
                        "vk": item.ki.wVk,
                        "scan": item.ki.wScan,
                        "flags": item.ki.dwFlags,
                    }
                )
        return count

    fake_u32 = SimpleNamespace(
        SendInput=fake_send_input,
        MapVirtualKeyW=lambda vk, _m: vk,
    )
    monkeypatch.setattr(input_control, "_get_user32", lambda: fake_u32)

    provider = WindowsInputProvider()
    assert await provider.move_mouse(15, -10) is True
    assert await provider.click_mouse("right", double=False) is True
    assert await provider.click_mouse("left", double=True) is True
    assert await provider.mouse_button("left", "down") is True
    assert await provider.scroll_mouse(0, -120) is True
    assert await provider.type_text("ç\n\t") is True
    assert await provider.press_key("c", ["ctrl"]) is True

    assert captured[0] == {
        "type": "mouse",
        "dx": 15,
        "dy": -10,
        "data": 0,
        "flags": MOUSEEVENTF_MOVE,
    }
    assert captured[1]["flags"] == MOUSEEVENTF_RIGHTDOWN
    assert captured[2]["flags"] == MOUSEEVENTF_RIGHTUP
    # Double left click emits down/up x2
    assert [c["flags"] for c in captured[3:7]] == [
        MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP,
    ]
    assert captured[7]["flags"] == MOUSEEVENTF_LEFTDOWN
    assert captured[8]["flags"] == MOUSEEVENTF_WHEEL
    assert captured[8]["data"] == (-120 & 0xFFFFFFFF)

    # Unicode 'ç' (U+00E7 = 231) + Return (0x0D) + Tab (0x09)
    unicode_events = captured[9:15]
    assert unicode_events[0] == {
        "type": "key",
        "vk": 0,
        "scan": ord("ç"),
        "flags": KEYEVENTF_UNICODE,
    }
    assert unicode_events[1] == {
        "type": "key",
        "vk": 0,
        "scan": ord("ç"),
        "flags": KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
    }
    assert unicode_events[2]["vk"] == 0x0D
    assert unicode_events[4]["vk"] == 0x09

    # Ctrl+C: ctrl down (0x11) -> c down (0x43) -> c up -> ctrl up
    shortcut_events = captured[15:19]
    assert [e["vk"] for e in shortcut_events] == [0x11, 0x43, 0x43, 0x11]
    assert [e["flags"] & KEYEVENTF_KEYUP for e in shortcut_events] == [
        0,
        0,
        KEYEVENTF_KEYUP,
        KEYEVENTF_KEYUP,
    ]


def test_tray_menu_includes_remote_input_toggle() -> None:
    enabled_state = False

    def toggle_fn(next_val: bool) -> bool:
        nonlocal enabled_state
        enabled_state = next_val
        return enabled_state

    tray = SystemTrayApp(
        settings=HostSettings(port=8765, lan_mode=True, lan_ip="192.168.1.50"),
        pairing_manager=PairingManager(),
        get_remote_input_enabled=lambda: enabled_state,
        on_toggle_remote_input=toggle_fn,
    )

    menu = tray._build_menu()
    item_texts = [str(item.text) for item in menu.items if hasattr(item, "text")]
    assert any("Mouse e Teclado Remoto" in t for t in item_texts)

    tray._toggle_remote_input(None, None)
    assert enabled_state is True
    tray._toggle_remote_input(None, None)
    assert enabled_state is False
