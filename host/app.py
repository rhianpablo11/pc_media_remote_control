"""FastAPI application factory with WebSocket endpoints, LAN pairing, and security guards."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections import defaultdict
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse

from host.config import HostSettings, normalize_origin
from host.network import MdnsPublisher
from host.pairing import (
    PairingManager,
    render_qr_data_url,
)
from host.protocol import ErrorMessage
from host.providers.base import AudioControlProvider, SessionProvider
from host.providers.chrome_extension import ChromeExtensionProvider
from host.providers.windows import WindowsProvider
from host.state import HostStateCoordinator

STATIC_DIR = Path(__file__).resolve().parent / "static"
LOCALHOST_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}
logger = logging.getLogger(__name__)


def is_loopback_client(host_or_ip: str | None) -> bool:
    """Return True if the remote peer IP is loopback."""
    if not host_or_ip:
        return False
    clean = host_or_ip.strip().lower()
    return clean in LOCALHOST_HOSTS


def _serve_dist_file(
    dist_dir: Path,
    rel_path: str,
    media_type: str | None = None,
    cache_control: str | None = None,
) -> FileResponse:
    root = dist_dir.resolve()
    target = (root / rel_path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(status_code=404, detail="Arquivo estático não encontrado.")
    headers = {"Cache-Control": cache_control} if cache_control else None
    return FileResponse(target, media_type=media_type, headers=headers)


def _extract_bearer_token(request: Request) -> str | None:
    """Extract bearer token from Authorization header or ?token= query parameter."""
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return request.query_params.get("token")


def create_app(
    settings: HostSettings | None = None,
    providers: Sequence[SessionProvider] | None = None,
    audio_provider: AudioControlProvider | None = None,
    chrome_provider: ChromeExtensionProvider | None = None,
    pairing_manager: PairingManager | None = None,
) -> FastAPI:
    """Create and configure the FastAPI host application with pairing and security."""
    cfg = settings or HostSettings()
    pairing_mgr = pairing_manager or cfg.pairing_manager or PairingManager()

    owned_windows: WindowsProvider | None = None
    if providers is None or audio_provider is None:
        owned_windows = WindowsProvider()

    ext_provider = chrome_provider or ChromeExtensionProvider()
    active_audio: AudioControlProvider = (
        audio_provider if audio_provider is not None else owned_windows  # type: ignore[assignment]
    )
    active_providers: list[SessionProvider] = (
        list(providers) if providers is not None else [ext_provider, owned_windows]  # type: ignore[list-item]
    )

    coordinator = HostStateCoordinator(
        providers=active_providers,
        audio_provider=active_audio,
    )

    async def _on_extension_change() -> None:
        await coordinator.broadcast_state(force=True)

    ext_provider.set_on_change(_on_extension_change)

    device_websockets: dict[str, set[WebSocket]] = defaultdict(set)
    server_loop: asyncio.AbstractEventLoop | None = None

    def _on_device_revoked(device_id: str) -> None:
        sockets = list(device_websockets.pop(device_id, set()))
        for ws in sockets:
            coro = ws.close(code=4001, reason="Dispositivo revogado pelo administrador")
            if server_loop is not None and server_loop.is_running():
                try:
                    current_loop = asyncio.get_running_loop()
                except RuntimeError:
                    current_loop = None

                if current_loop is server_loop:
                    server_loop.create_task(coro)
                else:
                    asyncio.run_coroutine_threadsafe(coro, server_loop)
            else:
                with contextlib.suppress(Exception):
                    asyncio.create_task(coro)

    pairing_mgr.set_on_device_revoked(_on_device_revoked)

    mdns_publisher: MdnsPublisher | None = None
    if cfg.lan_mode and cfg.lan_ip:
        mdns_publisher = MdnsPublisher(lan_ip=cfg.lan_ip, port=cfg.port)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        nonlocal server_loop
        server_loop = asyncio.get_running_loop()

        if mdns_publisher is not None:
            await mdns_publisher.async_start()

        async def _poll_loop() -> None:
            while True:
                await asyncio.sleep(cfg.poll_interval_sec)
                if coordinator.has_clients:
                    await coordinator.broadcast_state()

        poll_task = asyncio.create_task(_poll_loop())
        try:
            yield
        finally:
            poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poll_task
            if mdns_publisher is not None:
                await mdns_publisher.async_stop()
            if owned_windows is not None:
                owned_windows.close()

    app = FastAPI(title="PC Media Control Host", version="0.1.0", lifespan=lifespan)
    app.state.coordinator = coordinator
    app.state.chrome_provider = ext_provider
    app.state.settings = cfg
    app.state.pairing_manager = pairing_mgr

    # 1. Host header validation middleware (mitigate DNS rebinding)
    @app.middleware("http")
    async def validate_host_header(request: Request, call_next: Any) -> Response:
        host_header = request.headers.get("host")
        if host_header:
            clean_host = host_header.strip().lower()
            allowed = cfg.get_allowed_hosts()
            if clean_host not in allowed:
                logger.warning("Requisição HTTP rejeitada por Host inválido: %r", host_header)
                return PlainTextResponse(
                    "Cabeçalho Host inválido (DNS rebinding mitigado).",
                    status_code=403,
                )
        return await call_next(request)

    # 2. Public static PWA files (served to both loopback and LAN for pairing)
    @app.get("/", response_model=None)
    async def index() -> Response:
        dist_index = cfg.client_dist_dir / "index.html"
        if dist_index.is_file():
            return FileResponse(dist_index, headers={"Cache-Control": "no-cache"})
        html_path = STATIC_DIR / "index.html"
        return HTMLResponse(html_path.read_text(encoding="utf-8"))

    @app.get("/manifest.webmanifest")
    async def web_manifest() -> FileResponse:
        return _serve_dist_file(
            cfg.client_dist_dir,
            "manifest.webmanifest",
            media_type="application/manifest+json",
            cache_control="no-cache",
        )

    @app.get("/sw.js")
    async def service_worker_js() -> FileResponse:
        return _serve_dist_file(
            cfg.client_dist_dir,
            "sw.js",
            media_type="application/javascript",
            cache_control="no-cache",
        )

    @app.get("/favicon.svg")
    async def favicon_svg() -> FileResponse:
        return _serve_dist_file(
            cfg.client_dist_dir,
            "favicon.svg",
            media_type="image/svg+xml",
        )

    @app.get("/assets/{asset_path:path}")
    async def client_assets(asset_path: str) -> FileResponse:
        return _serve_dist_file(cfg.client_dist_dir, f"assets/{asset_path}")

    @app.get("/icons/{icon_path:path}")
    async def client_icons(icon_path: str) -> FileResponse:
        return _serve_dist_file(cfg.client_dist_dir, f"icons/{icon_path}")

    # 3. Loopback-only endpoints
    @app.get("/legacy-test", response_class=HTMLResponse)
    async def legacy_test_page(request: Request) -> HTMLResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_loopback_client(client_host):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        html_path = STATIC_DIR / "index.html"
        return HTMLResponse(html_path.read_text(encoding="utf-8"))

    @app.get("/pair", response_class=HTMLResponse)
    async def pairing_page(request: Request) -> HTMLResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_loopback_client(client_host):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")

        session = pairing_mgr.get_or_create_pairing_session()
        lan_ip = cfg.lan_ip or "127.0.0.1"
        pairing_url = f"http://{lan_ip}:{cfg.port}/?pair={session.code}"
        qr_data_url = render_qr_data_url(pairing_url)
        paired_devices = pairing_mgr.list_devices()

        pin_formatted = f"{session.pin[:3]} {session.pin[3:]}"
        devices_rows = "".join(
            f"""
            <tr>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e5ea;">
                <strong>{d["name"]}</strong>
              </td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e5ea; color: #666;">
                {d["createdAt"][:19].replace("T", " ")}
              </td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e5ea; text-align: right;">
                <form method="POST" action="/pair/revoke/{d["id"]}" style="margin: 0;">
                  <button type="submit" class="revoke-btn">Revogar</button>
                </form>
              </td>
            </tr>
            """
            for d in paired_devices
        ) or (
            '<tr><td colspan="3" style="padding: 16px; text-align: center; color: #888;">'
            "Nenhum dispositivo pareado ainda.</td></tr>"
        )

        html_content = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Pareamento — PC Media Control</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f7; color: #1d1d1f; margin: 0; padding: 24px;
      display: flex; justify-content: center;
    }}
    .card {{
      background: white; border-radius: 20px; padding: 28px;
      max-width: 480px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }}
    h1 {{ font-size: 22px; margin-top: 0; text-align: center; }}
    .qr-box {{ text-align: center; margin: 20px 0; }}
    .qr-img {{ width: 220px; height: 220px; border-radius: 16px; border: 1px solid #e5e5ea; }}
    .pin-box {{
      background: #f2f2f7; border-radius: 14px; padding: 12px 16px;
      text-align: center; margin: 16px 0;
    }}
    .pin-code {{ font-size: 32px; font-weight: 700; letter-spacing: 4px; color: #0066cc; }}
    .url-box {{
      font-size: 13px; color: #666; word-break: break-all;
      text-align: center; margin-bottom: 20px;
    }}
    .btn {{
      background: #0066cc; color: white; border: none; padding: 12px 20px;
      border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%;
    }}
    .revoke-btn {{
      background: #ff3b30; color: white; border: none; padding: 6px 12px;
      border-radius: 8px; cursor: pointer; font-size: 13px;
    }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 12px; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Parear Celular</h1>
    <p style="text-align: center; color: #666; font-size: 14px; margin-top: 4px;">
      Escaneie o QR code com a câmera do celular ou digite o PIN no aplicativo.
    </p>

    <div class="qr-box">
      <img src="{qr_data_url}" alt="QR Code de Pareamento" class="qr-img" />
    </div>

    <div class="pin-box">
      <div style="font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600;">
        PIN alternativo
      </div>
      <div class="pin-code">{pin_formatted}</div>
      <div style="font-size: 12px; color: #888; margin-top: 4px;">
        Expira em {session.seconds_remaining}s
      </div>
    </div>

    <div class="url-box">
      URL direta: <br />
      <a href="{pairing_url}" target="_blank" style="color: #0066cc;">{pairing_url}</a>
    </div>

    <form method="POST" action="/pair/refresh">
      <button type="submit" class="btn">Gerar Novo Código</button>
    </form>

    <hr style="border: none; border-top: 1px solid #e5e5ea; margin: 28px 0;" />

    <h2 style="font-size: 16px; margin: 0 0 8px 0;">Dispositivos Autorizados</h2>
    <table>
      <tbody>
        {devices_rows}
      </tbody>
    </table>
  </div>
</body>
</html>"""
        return HTMLResponse(html_content)

    @app.post("/pair/refresh")
    async def refresh_pairing(request: Request) -> Response:
        client_host = request.client.host if request.client is not None else ""
        if not is_loopback_client(client_host):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        pairing_mgr.get_or_create_pairing_session(force_new=True)
        return Response(status_code=303, headers={"Location": "/pair"})

    @app.post("/pair/revoke/{device_id}")
    async def revoke_device_form(request: Request, device_id: str) -> Response:
        client_host = request.client.host if request.client is not None else ""
        if not is_loopback_client(client_host):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        pairing_mgr.revoke_device(device_id)
        return Response(status_code=303, headers={"Location": "/pair"})

    # 4. Pairing API
    @app.post("/api/pair")
    async def api_pair(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Corpo da requisição deve ser JSON válido.",
            ) from None

        code_or_pin = str(body.get("code") or body.get("pin") or "").strip()
        device_name = str(body.get("deviceName") or "Celular").strip()
        if not code_or_pin:
            raise HTTPException(status_code=400, detail="Código ou PIN de pareamento obrigatório.")

        ok, msg, res = pairing_mgr.verify_and_pair(code_or_pin, device_name)
        if not ok:
            status_code = 429 if pairing_mgr.is_locked_out else 400
            return JSONResponse({"error": msg, "code": "pairing_failed"}, status_code=status_code)

        return JSONResponse(res)

    @app.get("/api/devices")
    async def api_list_devices(request: Request) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_loopback_client(client_host):
            token = _extract_bearer_token(request)
            if not token or not pairing_mgr.validate_token(token):
                raise HTTPException(
                    status_code=401,
                    detail="Token de autorização ausente ou inválido.",
                )
        return JSONResponse(pairing_mgr.list_devices())

    @app.delete("/api/devices/{device_id}")
    async def api_revoke_device(request: Request, device_id: str) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_loopback_client(client_host):
            token = _extract_bearer_token(request)
            if not token or not pairing_mgr.validate_token(token):
                raise HTTPException(
                    status_code=401,
                    detail="Token de autorização ausente ou inválido.",
                )

        ok = pairing_mgr.revoke_device(device_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Dispositivo não encontrado.")
        return JSONResponse({"status": "ok", "revoked": True, "deviceId": device_id})

    # 5. Media state API (requires authentication when accessed from LAN)
    @app.get("/api/state")
    async def get_state(request: Request) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_loopback_client(client_host):
            token = _extract_bearer_token(request)
            if not token or not pairing_mgr.validate_token(token):
                raise HTTPException(
                    status_code=401,
                    detail="Token de autorização ausente ou inválido.",
                )

        state = await coordinator.build_state()
        return JSONResponse(state.model_dump())

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "v": 1,
                "host": cfg.host,
                "port": cfg.port,
                "lanMode": cfg.lan_mode,
                "lanIp": cfg.lan_ip,
                "extensionConnected": coordinator.extension_connected,
                "extensionId": cfg.extension_id,
            }
        )

    # 6. WebSocket control endpoint with LAN token authentication
    @app.websocket("/ws")
    async def control_websocket(websocket: WebSocket) -> None:
        client_host = websocket.client.host if websocket.client is not None else ""
        is_loopback = is_loopback_client(client_host)

        # In localhost-only mode, block non-loopback completely
        if not cfg.lan_mode and not is_loopback:
            logger.warning(
                "WebSocket /ws rejeitado de %s: modo LAN desativado (--lan necessário)",
                client_host,
            )
            await websocket.close(code=1008, reason="Acesso permitido apenas via localhost")
            return

        # Validate Host header against allowed hosts (DNS rebinding mitigation)
        raw_host = websocket.headers.get("host")
        if raw_host:
            clean_host = raw_host.strip().lower()
            allowed_hosts = cfg.get_allowed_hosts()
            if clean_host not in allowed_hosts:
                logger.warning(
                    "WebSocket /ws rejeitado de %s: cabeçalho Host inválido %r (permitidos: %s)",
                    client_host,
                    raw_host,
                    allowed_hosts,
                )
                await websocket.close(code=1008, reason="Host inválido (DNS rebinding mitigado)")
                return

        # Validate Origin header
        raw_origin = websocket.headers.get("origin")
        origin = normalize_origin(raw_origin)
        allowed_origins = cfg.get_allowed_ws_origins()
        if not origin or origin not in allowed_origins:
            logger.warning(
                "WebSocket /ws rejeitado de %s: Origin inválida ou ausente %r",
                client_host,
                raw_origin,
            )
            await websocket.close(code=1008, reason="Origin não autorizada")
            return

        await websocket.accept()

        authenticated_device_id: str | None = None

        # Non-loopback LAN connections must authenticate via first frame
        if not is_loopback:
            try:
                raw_auth_text = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
            except TimeoutError:
                logger.warning(
                    "WebSocket /ws rejeitado de %s: timeout de 5.0s aguardando auth na LAN",
                    client_host,
                )
                with contextlib.suppress(Exception):
                    err = ErrorMessage(
                        code="pairing_required",
                        message="Tempo limite de autenticação expirado. Pareie o dispositivo.",
                    )
                    await websocket.send_text(err.model_dump_json())
                    await websocket.close(
                        code=4001,
                        reason="Authentication timeout",
                    )
                return
            except WebSocketDisconnect:
                logger.info(
                    "WebSocket /ws desconectado pelo cliente %s durante handshake", client_host
                )
                return

            try:
                raw_auth_json = json.loads(raw_auth_text)
            except json.JSONDecodeError:
                logger.warning(
                    "WebSocket /ws rejeitado de %s: frame de auth não é JSON válido: %r",
                    client_host,
                    raw_auth_text[:120],
                )
                with contextlib.suppress(Exception):
                    err = ErrorMessage(
                        code="invalid_json",
                        message="Payload de autenticação não é JSON válido.",
                    )
                    await websocket.send_text(err.model_dump_json())
                    await websocket.close(
                        code=4001,
                        reason="Invalid JSON auth frame",
                    )
                return

            if (
                not isinstance(raw_auth_json, dict)
                or raw_auth_json.get("type") != "auth"
                or not raw_auth_json.get("token")
            ):
                logger.warning(
                    "WebSocket /ws rejeitado de %s: frame de auth inválido ou sem token: %r",
                    client_host,
                    raw_auth_text[:120],
                )
                err = ErrorMessage(
                    code="pairing_required",
                    message="Dispositivo não autenticado. Autenticação obrigatória na LAN.",
                )
                await websocket.send_text(err.model_dump_json())
                await websocket.close(code=4001, reason="Pairing required")
                return

            token = str(raw_auth_json["token"])
            device = pairing_mgr.validate_token(token)
            if device is None:
                logger.warning(
                    "WebSocket /ws rejeitado de %s: token inválido, revogado ou inexistente",
                    client_host,
                )
                err = ErrorMessage(
                    code="pairing_required",
                    message="Token de pareamento inválido ou revogado. Pareie novamente.",
                )
                await websocket.send_text(err.model_dump_json())
                await websocket.close(code=4001, reason="Pairing token invalid or revoked")
                return

            authenticated_device_id = device.id
            device_websockets[device.id].add(websocket)
            logger.info(
                "WebSocket /ws autenticado com sucesso para dispositivo '%s' (ID: %s, IP: %s)",
                device.name,
                device.id,
                client_host,
            )

        coordinator.register_client(websocket)
        try:
            initial_json = await coordinator.get_initial_state_json()
            await websocket.send_text(initial_json)

            while True:
                text = await websocket.receive_text()
                try:
                    raw = json.loads(text)
                except json.JSONDecodeError:
                    err = ErrorMessage(
                        code="invalid_json",
                        message="JSON inválido recebido pelo WebSocket.",
                    )
                    await websocket.send_text(err.model_dump_json())
                    continue

                if isinstance(raw, dict) and raw.get("type") == "auth":
                    # Handle optional re-auth or loopback auth frame gracefully
                    token = str(raw.get("token") or "")
                    device = pairing_mgr.validate_token(token)
                    if device is not None:
                        authenticated_device_id = device.id
                        device_websockets[device.id].add(websocket)
                    continue

                response = await coordinator.handle_raw_client_message(raw)
                if response is not None:
                    await websocket.send_text(response.model_dump_json())
        except WebSocketDisconnect:
            pass
        finally:
            coordinator.unregister_client(websocket)
            if authenticated_device_id:
                device_websockets[authenticated_device_id].discard(websocket)

    # 7. Chrome extension WebSocket endpoint (strictly loopback only)
    @app.websocket("/ws/extension")
    async def extension_websocket(websocket: WebSocket) -> None:
        client_host = websocket.client.host if websocket.client is not None else ""
        if not is_loopback_client(client_host):
            logger.warning(
                "WebSocket /ws/extension rejeitado de %s: aceita apenas conexões locais",
                client_host,
            )
            await websocket.close(code=1008, reason="Acesso permitido apenas via localhost")
            return

        origin = normalize_origin(websocket.headers.get("origin"))
        expected_origin = cfg.get_extension_origin()
        if not expected_origin or origin != expected_origin:
            logger.warning(
                "WebSocket /ws/extension rejeitado por Origin inválido: %r (esperado: %r)",
                origin,
                expected_origin,
            )
            await websocket.close(code=1008, reason="Origin de extensão não autorizada")
            return

        await websocket.accept()
        ext_provider.attach(websocket)
        await coordinator.broadcast_state(force=True)
        try:
            while True:
                raw = await websocket.receive_json()
                if isinstance(raw, dict):
                    await ext_provider.handle_message(raw)
        except WebSocketDisconnect:
            pass
        finally:
            ext_provider.detach(websocket)
            await coordinator.broadcast_state(force=True)

    return app
