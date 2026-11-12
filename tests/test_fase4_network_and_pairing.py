"""Tests for Fase 4: Network interface detection, mDNS, pairing, and LAN security."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from host.app import create_app
from host.config import DEFAULT_EXTENSION_ID, HostSettings
from host.network import (
    LanInterface,
    is_private_ipv4,
    is_virtual_adapter_name,
    resolve_primary_lan_ip,
)
from host.pairing import (
    MAX_FAILED_ATTEMPTS,
    PairingManager,
    hash_token,
)

# ---------------------------------------------------------------------------
# 1. Network Interface Filtering & IP Selection
# ---------------------------------------------------------------------------


def test_is_private_ipv4() -> None:
    assert is_private_ipv4("192.168.1.50") is True
    assert is_private_ipv4("10.0.0.12") is True
    assert is_private_ipv4("172.16.5.1") is True
    assert is_private_ipv4("172.31.255.254") is True

    # Non-private or special ranges
    assert is_private_ipv4("127.0.0.1") is False  # Loopback
    assert is_private_ipv4("169.254.10.20") is False  # Link-local / APIPA
    assert is_private_ipv4("8.8.8.8") is False  # Public internet
    assert is_private_ipv4("1.1.1.1") is False  # Public internet
    assert is_private_ipv4("invalid-ip") is False


def test_is_virtual_adapter_name() -> None:
    assert is_virtual_adapter_name("vEthernet (WSL)") is True
    assert is_virtual_adapter_name("Hyper-V Virtual Ethernet Adapter") is True
    assert is_virtual_adapter_name("VirtualBox Host-Only Ethernet Adapter") is True
    assert is_virtual_adapter_name("Tailscale") is True
    assert is_virtual_adapter_name("ZeroTier One") is True
    assert is_virtual_adapter_name("VMware Network Adapter VMnet1") is True
    assert is_virtual_adapter_name("Docker Desktop") is True

    # Physical adapters
    assert is_virtual_adapter_name("Wi-Fi") is False
    assert is_virtual_adapter_name("Ethernet") is False
    assert is_virtual_adapter_name("Conexão de Rede sem Fio") is False


def test_resolve_primary_lan_ip_override() -> None:
    interfaces = [
        LanInterface("Wi-Fi", "192.168.1.100", is_virtual=False, is_private=True),
    ]
    chosen, _ = resolve_primary_lan_ip(interfaces, override_ip="10.20.30.40")
    assert chosen == "10.20.30.40"


def test_resolve_primary_lan_ip_prefers_physical() -> None:
    interfaces = [
        LanInterface("vEthernet (WSL)", "172.28.16.1", is_virtual=True, is_private=True),
        LanInterface("Wi-Fi", "192.168.0.15", is_virtual=False, is_private=True),
    ]
    with patch("socket.socket") as mock_sock_cls:
        # Simulate routing to 172.28.16.1 if UDP query tried, but fallback/filter prefers Wi-Fi
        mock_sock = MagicMock()
        mock_sock.getsockname.return_value = ("172.28.16.1", 12345)
        mock_sock_cls.return_value.__enter__.return_value = mock_sock

        chosen, candidates = resolve_primary_lan_ip(interfaces)
        # Even though routing suggested virtual adapter, candidate filtering prefers physical Wi-Fi
        assert chosen == "192.168.0.15"
        assert len(candidates) == 2


# ---------------------------------------------------------------------------
# 2. Pairing Manager & Token Store
# ---------------------------------------------------------------------------


def test_pairing_session_generation_and_expiry(tmp_path: Path) -> None:
    mgr = PairingManager(storage_path=tmp_path / "devices.json")
    session = mgr.get_or_create_pairing_session()
    assert len(session.code) >= 8
    assert len(session.pin) == 6
    assert session.pin.isdigit()
    assert session.is_expired is False


def test_pairing_success_and_single_use(tmp_path: Path) -> None:
    store_file = tmp_path / "devices.json"
    mgr = PairingManager(storage_path=store_file)

    session = mgr.get_or_create_pairing_session()
    code = session.code

    ok, msg, res = mgr.verify_and_pair(code, "iPhone Teste")
    assert ok is True
    assert res is not None
    assert "token" in res
    assert "deviceId" in res
    token = res["token"]

    # Code should be consumed (single use)
    ok_retry, _, _ = mgr.verify_and_pair(code, "iPhone Teste 2")
    assert ok_retry is False

    # Store file only contains token hash, never plain token
    assert store_file.is_file()
    saved = json.loads(store_file.read_text(encoding="utf-8"))
    saved_devices = saved["devices"]
    assert len(saved_devices) == 1
    assert saved_devices[0]["token_hash"] == hash_token(token)
    assert token not in store_file.read_text(encoding="utf-8")


def test_pairing_with_pin(tmp_path: Path) -> None:
    store_file = tmp_path / "devices.json"
    mgr = PairingManager(storage_path=store_file)

    session = mgr.get_or_create_pairing_session()
    pin = session.pin
    formatted_pin = f"{pin[:3]} {pin[3:]}"

    ok, _, res = mgr.verify_and_pair(formatted_pin, "Android Teste")
    assert ok is True
    assert res is not None
    assert mgr.validate_token(res["token"]) is not None


def test_pairing_rate_limit_lockout(tmp_path: Path) -> None:
    store_file = tmp_path / "devices.json"
    mgr = PairingManager(storage_path=store_file)
    mgr.get_or_create_pairing_session()

    for i in range(MAX_FAILED_ATTEMPTS - 1):
        ok, msg, _ = mgr.verify_and_pair(f"wrong-{i}")
        assert ok is False
        assert mgr.is_locked_out is False

    # 5th attempt triggers lockout
    ok_5, msg_5, _ = mgr.verify_and_pair("wrong-5")
    assert ok_5 is False
    assert mgr.is_locked_out is True
    assert "Bloqueado" in msg_5

    # Any attempt while locked out is rejected immediately
    ok_locked, msg_locked, _ = mgr.verify_and_pair("wrong-after")
    assert ok_locked is False
    assert "Bloqueado temporariamente" in msg_locked


def test_device_revocation(tmp_path: Path) -> None:
    store_file = tmp_path / "devices.json"
    mgr = PairingManager(storage_path=store_file)

    session = mgr.get_or_create_pairing_session()
    ok, _, res = mgr.verify_and_pair(session.code, "Celular Antigo")
    assert ok is True
    assert res is not None
    token = res["token"]
    dev_id = res["deviceId"]

    revoked_called: list[str] = []
    mgr.set_on_device_revoked(lambda d_id: revoked_called.append(d_id))

    assert mgr.validate_token(token) is not None
    assert mgr.revoke_device(dev_id) is True
    assert dev_id in revoked_called

    # Token must be invalid after revocation
    assert mgr.validate_token(token) is None
    assert len(mgr.list_devices()) == 0


# ---------------------------------------------------------------------------
# 3. Host HTTP Endpoints, DNS Rebinding & Permissions
# ---------------------------------------------------------------------------


def _build_test_app(
    tmp_path: Path,
    lan_mode: bool = True,
    lan_ip: str = "192.168.1.100",
) -> tuple[Any, PairingManager]:
    store_file = tmp_path / "devices.json"
    mgr = PairingManager(storage_path=store_file)
    settings = HostSettings(
        host="0.0.0.0" if lan_mode else "127.0.0.1",
        port=8765,
        lan_mode=lan_mode,
        lan_ip=lan_ip,
        pairing_manager=mgr,
    )
    # Stub dummy providers
    mock_provider = MagicMock()
    mock_provider.name = "mock"
    mock_provider.get_sessions.return_value = []
    mock_audio = MagicMock()
    mock_audio.get_master_volume.return_value = {
        "level": 0.5,
        "muted": False,
        "device_name": "Test",
    }
    mock_audio.get_audio_sessions.return_value = []

    app = create_app(
        settings=settings,
        providers=[mock_provider],
        audio_provider=mock_audio,
        pairing_manager=mgr,
    )
    return app, mgr


def test_host_header_validation(tmp_path: Path) -> None:
    app, _ = _build_test_app(tmp_path)
    client = TestClient(app)

    # Valid hosts
    r1 = client.get("/health", headers={"Host": "localhost:8765"})
    assert r1.status_code == 200

    r2 = client.get("/health", headers={"Host": "192.168.1.100:8765"})
    assert r2.status_code == 200

    # Malicious host (DNS rebinding attempt)
    r3 = client.get("/health", headers={"Host": "evil-attacker.com:8765"})
    assert r3.status_code == 403
    assert "DNS rebinding" in r3.text


def test_loopback_only_endpoints(tmp_path: Path) -> None:
    app, _ = _build_test_app(tmp_path)
    # TestClient default client.host is 'testclient' which is in LOOPBACK_HOSTS
    client = TestClient(app)

    r_test = client.get("/legacy-test")
    assert r_test.status_code == 200

    r_pair = client.get("/pair")
    assert r_pair.status_code == 200
    assert "Pareamento" in r_pair.text

    # Mock non-loopback remote address
    non_loop_client = TestClient(app, client=("192.168.1.55", 54321))
    r_blocked_test = non_loop_client.get("/legacy-test")
    assert r_blocked_test.status_code == 403

    r_blocked_pair = non_loop_client.get("/pair")
    assert r_blocked_pair.status_code == 403


def test_api_pair_and_devices(tmp_path: Path) -> None:
    app, mgr = _build_test_app(tmp_path)
    session = mgr.get_or_create_pairing_session()

    client = TestClient(app, client=("192.168.1.55", 54321))

    # Missing / invalid code
    bad_resp = client.post("/api/pair", json={"code": "000000"})
    assert bad_resp.status_code == 400

    # Valid code exchange
    pair_resp = client.post("/api/pair", json={"code": session.code, "deviceName": "Galaxy S24"})
    assert pair_resp.status_code == 200
    data = pair_resp.json()
    token = data["token"]
    dev_id = data["deviceId"]

    # Non-loopback request to /api/devices without token returns 401
    r_unauth = client.get("/api/devices")
    assert r_unauth.status_code == 401

    # Non-loopback request with Bearer token returns 200
    r_auth = client.get("/api/devices", headers={"Authorization": f"Bearer {token}"})
    assert r_auth.status_code == 200
    devs = r_auth.json()
    assert len(devs) == 1
    assert devs[0]["id"] == dev_id

    # Non-loopback request to /api/state with Bearer token
    r_state = client.get("/api/state", headers={"Authorization": f"Bearer {token}"})
    assert r_state.status_code == 200

    # Revoke device
    r_rev = client.delete(f"/api/devices/{dev_id}", headers={"Authorization": f"Bearer {token}"})
    assert r_rev.status_code == 200

    # Once revoked, access with same token returns 401
    r_state_revoked = client.get("/api/state", headers={"Authorization": f"Bearer {token}"})
    assert r_state_revoked.status_code == 401


# ---------------------------------------------------------------------------
# 4. WebSocket Security & Auth Handshake
# ---------------------------------------------------------------------------


def test_ws_loopback_connects_without_auth(tmp_path: Path) -> None:
    app, _ = _build_test_app(tmp_path)
    client = TestClient(app)

    with client.websocket_connect(
        "/ws",
        headers={"Origin": "http://127.0.0.1:8765"},
    ) as ws:
        msg = ws.receive_text()
        data = json.loads(msg)
        assert data["type"] == "state"


def test_ws_origin_validation(tmp_path: Path) -> None:
    app, _ = _build_test_app(tmp_path)
    client = TestClient(app)

    with pytest.raises(WebSocketDisconnect), client.websocket_connect(
        "/ws",
        headers={"Origin": "http://unauthorized-evil.com"},
    ):
        pass


def test_ws_lan_client_auth_handshake_and_revocation(tmp_path: Path) -> None:
    app, mgr = _build_test_app(tmp_path)
    session = mgr.get_or_create_pairing_session()
    ok, _, res = mgr.verify_and_pair(session.code, "Celular LAN")
    assert ok and res is not None
    token = res["token"]
    dev_id = res["deviceId"]

    # Non-loopback client with lifespan active
    with TestClient(app, client=("192.168.1.55", 54321)) as lan_client:
        # 1. Non-loopback with invalid auth token receives pairing_required and closes
        with lan_client.websocket_connect(
            "/ws",
            headers={"Origin": "http://192.168.1.100:8765"},
        ) as ws_bad:
            ws_bad.send_text(json.dumps({"v": 1, "type": "auth", "token": "invalid_token"}))
            err_frame = json.loads(ws_bad.receive_text())
            assert err_frame.get("code") == "pairing_required"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws_bad.receive_text()
            assert exc_info.value.code == 4001

        # 2. Non-loopback with valid auth token authenticates and receives state
        with lan_client.websocket_connect(
            "/ws",
            headers={"Origin": "http://192.168.1.100:8765"},
        ) as ws_good:
            ws_good.send_text(json.dumps({"v": 1, "type": "auth", "token": token}))
            state_frame = json.loads(ws_good.receive_text())
            assert state_frame.get("type") == "state"

            # 3. Revoking the device terminates the active connection with 4001
            mgr.revoke_device(dev_id)
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws_good.receive_text()
            assert exc_info.value.code == 4001


def test_ws_extension_rejects_non_loopback(tmp_path: Path) -> None:
    app, _ = _build_test_app(tmp_path)
    ext_origin = f"chrome-extension://{DEFAULT_EXTENSION_ID}"

    # Non-loopback is rejected even with valid extension origin
    lan_client = TestClient(app, client=("192.168.1.55", 54321))
    with pytest.raises(WebSocketDisconnect), lan_client.websocket_connect(
        "/ws/extension",
        headers={"Origin": ext_origin},
    ):
        pass

    # Loopback with valid extension origin is accepted
    local_client = TestClient(app)
    with local_client.websocket_connect(
        "/ws/extension",
        headers={"Origin": ext_origin},
    ) as ws_ext:
        # Should stay open and accept json
        ws_ext.send_json({"type": "tabs_update", "tabs": []})
