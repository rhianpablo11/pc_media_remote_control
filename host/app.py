"""FastAPI application factory with WebSocket endpoints, LAN pairing, and security guards."""

from __future__ import annotations

import asyncio
import contextlib
import html
import json
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse

from host.config import (
    HostConfigStore,
    HostSettings,
    build_tailscale_hosts_and_origins,
    get_installed_extension_dir,
    normalize_origin,
    open_extension_folder_for_install,
    sanitize_hostname,
)
from host.input_control import WindowsInputProvider
from host.network import MdnsPublisher, TailscaleInfo, detect_tailscale_info
from host.pairing import (
    PairingManager,
    render_qr_data_url,
)
from host.protocol import ErrorMessage, PongMessage
from host.providers.base import AudioControlProvider, RemoteInputProvider, SessionProvider
from host.providers.chrome_extension import ChromeExtensionProvider
from host.providers.windows import WindowsProvider
from host.screen_mirror import MssScreenCaptureProvider, ScreenCaptureProvider
from host.state import HostStateCoordinator

STATIC_DIR = Path(__file__).resolve().parent / "static"
LOCALHOST_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "[::1]", "::1", "testclient", "testserver"}
PROXY_HEADER_NAMES = (
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "forwarded",
    "x-real-ip",
    "tailscale-user-login",
    "tailscale-user-name",
)
MAX_SCREEN_CLIENTS = 2
logger = logging.getLogger(__name__)


def is_loopback_client(host_or_ip: str | None) -> bool:
    """Return True if the remote peer IP is loopback."""
    if not host_or_ip:
        return False
    clean = host_or_ip.strip().lower()
    return clean in LOCALHOST_HOSTS


def _extract_hostname(host_header: str | None) -> str:
    if not host_header:
        return ""
    clean = host_header.strip().lower()
    if not clean:
        return ""
    if clean.startswith("["):
        end_bracket = clean.find("]")
        if end_bracket != -1:
            return clean[: end_bracket + 1]
    if ":" in clean:
        return clean.split(":", 1)[0].strip()
    return clean


def is_proxied_request(headers: Mapping[str, str]) -> bool:
    """Return True when reverse-proxy or Tailscale Serve forwarding headers are present."""
    for key, val in headers.items():
        if key.strip().lower() in PROXY_HEADER_NAMES and val and val.strip():
            return True
    return False


def is_trusted_local_request(
    client_host: str | None,
    headers: Mapping[str, str],
) -> bool:
    """Return True only for direct unproxied loopback connections on the local PC."""
    if not is_loopback_client(client_host):
        return False
    if is_proxied_request(headers):
        return False
    host_header = ""
    for key, val in headers.items():
        if key.strip().lower() == "host":
            host_header = val
            break
    if host_header:
        hostname = _extract_hostname(host_header)
        if hostname and hostname not in LOCAL_HOSTNAMES:
            return False
    return True


async def _authenticate_ws_client(
    websocket: WebSocket,
    pairing_mgr: PairingManager,
    device_websockets: dict[str, set[WebSocket]],
    client_host: str,
    endpoint_label: str,
) -> str | None:
    """Perform first-frame JSON token auth for non-local WebSocket clients."""
    try:
        raw_auth_text = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
    except TimeoutError:
        logger.warning(
            "WebSocket %s rejeitado de %s: timeout de 5.0s aguardando auth na LAN",
            endpoint_label,
            client_host,
        )
        with contextlib.suppress(Exception):
            err = ErrorMessage(
                code="pairing_required",
                message="Tempo limite de autenticação expirado. Pareie o dispositivo.",
            )
            await websocket.send_text(err.model_dump_json())
            await websocket.close(code=4001, reason="Authentication timeout")
        return None
    except WebSocketDisconnect:
        logger.info(
            "WebSocket %s desconectado pelo cliente %s durante handshake",
            endpoint_label,
            client_host,
        )
        return None

    try:
        raw_auth_json = json.loads(raw_auth_text)
    except json.JSONDecodeError:
        logger.warning(
            "WebSocket %s rejeitado de %s: frame de auth não é JSON válido: %r",
            endpoint_label,
            client_host,
            raw_auth_text[:120],
        )
        with contextlib.suppress(Exception):
            err = ErrorMessage(
                code="invalid_json",
                message="Payload de autenticação não é JSON válido.",
            )
            await websocket.send_text(err.model_dump_json())
            await websocket.close(code=4001, reason="Invalid JSON auth frame")
        return None

    if (
        not isinstance(raw_auth_json, dict)
        or raw_auth_json.get("type") != "auth"
        or not raw_auth_json.get("token")
    ):
        logger.warning(
            "WebSocket %s rejeitado de %s: frame de auth inválido ou sem token: %r",
            endpoint_label,
            client_host,
            raw_auth_text[:120],
        )
        with contextlib.suppress(Exception):
            err = ErrorMessage(
                code="pairing_required",
                message="Dispositivo não autenticado. Autenticação obrigatória na LAN.",
            )
            await websocket.send_text(err.model_dump_json())
            await websocket.close(code=4001, reason="Pairing required")
        return None

    token = str(raw_auth_json["token"])
    device = pairing_mgr.validate_token(token)
    if device is None:
        logger.warning(
            "WebSocket %s rejeitado de %s: token inválido, revogado ou inexistente",
            endpoint_label,
            client_host,
        )
        with contextlib.suppress(Exception):
            err = ErrorMessage(
                code="pairing_required",
                message="Token de pareamento inválido ou revogado. Pareie novamente.",
            )
            await websocket.send_text(err.model_dump_json())
            await websocket.close(code=4001, reason="Pairing token invalid or revoked")
        return None

    device_websockets[device.id].add(websocket)
    logger.info(
        "WebSocket %s autenticado com sucesso para '%s' (ID: %s, IP: %s)",
        endpoint_label,
        device.name,
        device.id,
        client_host,
    )
    return device.id


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
    input_provider: RemoteInputProvider | None = None,
    config_store: HostConfigStore | None = None,
    screen_provider: ScreenCaptureProvider | None = None,
) -> FastAPI:
    """Create and configure the FastAPI host application with pairing and security."""
    cfg = settings or HostSettings()
    cfg_store = config_store or HostConfigStore()
    pairing_mgr = pairing_manager or cfg.pairing_manager or PairingManager()

    owned_windows: WindowsProvider | None = None
    if providers is None or audio_provider is None:
        owned_windows = WindowsProvider()

    owned_screen: MssScreenCaptureProvider | None = None
    if screen_provider is None:
        owned_screen = MssScreenCaptureProvider()
    active_screen: ScreenCaptureProvider = (
        screen_provider if screen_provider is not None else owned_screen  # type: ignore[assignment]
    )

    ext_provider = chrome_provider or ChromeExtensionProvider()
    active_audio: AudioControlProvider = (
        audio_provider if audio_provider is not None else owned_windows  # type: ignore[assignment]
    )
    active_providers: list[SessionProvider] = (
        list(providers) if providers is not None else [ext_provider, owned_windows]  # type: ignore[list-item]
    )
    active_input: RemoteInputProvider = (
        input_provider
        if input_provider is not None
        else WindowsInputProvider(screen_provider=active_screen)
    )

    ts_enabled_initial = bool(cfg.tailscale_enabled or cfg_store.get_tailscale_enabled())
    ts_hostname_initial = sanitize_hostname(
        cfg.tailscale_hostname or cfg_store.get_tailscale_hostname()
    )
    ts_info_cache = TailscaleInfo(
        available=bool(cfg.tailscale_ip or ts_hostname_initial),
        ip=cfg.tailscale_ip,
        dns_name=ts_hostname_initial or None,
    )
    if ts_enabled_initial and ts_info_cache.ip is None:
        detected_ts = detect_tailscale_info(query_cli=False)
        ts_info_cache = TailscaleInfo(
            available=bool(detected_ts.ip or ts_hostname_initial or detected_ts.dns_name),
            ip=detected_ts.ip,
            dns_name=ts_hostname_initial or detected_ts.dns_name,
        )

    def _on_tailscale_store_change(enabled: bool) -> None:
        cfg_store.set_tailscale_enabled(enabled)

    coordinator = HostStateCoordinator(
        providers=active_providers,
        audio_provider=active_audio,
        input_provider=active_input,
        remote_input_enabled=cfg_store.get_remote_input_enabled(),
        on_remote_input_change=cfg_store.set_remote_input_enabled,
        tailscale_enabled=ts_enabled_initial,
        on_tailscale_change=_on_tailscale_store_change,
        screen_mirror_available=True,
    )

    def _refresh_tailscale_cache(query_cli: bool = False) -> TailscaleInfo:
        nonlocal ts_info_cache
        detected = detect_tailscale_info(query_cli=query_cli)
        stored_host = sanitize_hostname(
            cfg.tailscale_hostname or cfg_store.get_tailscale_hostname()
        )
        resolved_ip = cfg.tailscale_ip or detected.ip
        resolved_dns = stored_host or detected.dns_name
        ts_info_cache = TailscaleInfo(
            available=bool(resolved_ip or resolved_dns),
            ip=resolved_ip,
            dns_name=resolved_dns,
        )
        return ts_info_cache

    def _get_effective_allowed_hosts() -> set[str]:
        allowed = cfg.get_allowed_hosts()
        if coordinator.tailscale_enabled:
            ts_hosts, _ = build_tailscale_hosts_and_origins(
                cfg.port,
                ts_info_cache.ip,
                ts_info_cache.dns_name,
            )
            allowed.update(ts_hosts)
        return allowed

    def _get_effective_allowed_ws_origins() -> set[str]:
        allowed = cfg.get_allowed_ws_origins()
        if coordinator.tailscale_enabled and cfg.allowed_ws_origins is None:
            _, ts_origins = build_tailscale_hosts_and_origins(
                cfg.port,
                ts_info_cache.ip,
                ts_info_cache.dns_name,
            )
            for item in ts_origins:
                norm = normalize_origin(item)
                if norm:
                    allowed.add(norm)
        return allowed

    async def _on_extension_change() -> None:
        await coordinator.broadcast_state(force=True)

    ext_provider.set_on_change(_on_extension_change)

    device_websockets: dict[str, set[WebSocket]] = defaultdict(set)
    active_screen_clients: set[WebSocket] = set()
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
            if owned_screen is not None:
                owned_screen.close()

    app = FastAPI(title="PC Media Control Host", version="0.1.0", lifespan=lifespan)
    app.state.coordinator = coordinator
    app.state.chrome_provider = ext_provider
    app.state.settings = cfg
    app.state.pairing_manager = pairing_mgr
    app.state.config_store = cfg_store
    app.state.screen_provider = active_screen

    def _set_remote_input_threadsafe(enabled: bool) -> bool:
        flag = coordinator.set_remote_input_enabled(enabled)
        if server_loop is not None and server_loop.is_running():
            try:
                current_loop = asyncio.get_running_loop()
            except RuntimeError:
                current_loop = None

            coro = coordinator.broadcast_state(force=True)
            if current_loop is server_loop:
                server_loop.create_task(coro)
            else:
                asyncio.run_coroutine_threadsafe(coro, server_loop)
        return flag

    def _set_tailscale_threadsafe(enabled: bool) -> bool:
        if enabled:
            _refresh_tailscale_cache(query_cli=False)
        flag = coordinator.set_tailscale_enabled(enabled)
        if server_loop is not None and server_loop.is_running():
            try:
                current_loop = asyncio.get_running_loop()
            except RuntimeError:
                current_loop = None

            coro = coordinator.broadcast_state(force=True)
            if current_loop is server_loop:
                server_loop.create_task(coro)
            else:
                asyncio.run_coroutine_threadsafe(coro, server_loop)
        return flag

    app.state.set_remote_input_enabled = _set_remote_input_threadsafe
    app.state.set_tailscale_enabled = _set_tailscale_threadsafe

    # 1. Host header validation middleware (mitigate DNS rebinding)
    @app.middleware("http")
    async def validate_host_header(request: Request, call_next: Any) -> Response:
        host_header = request.headers.get("host")
        if host_header:
            clean_host = host_header.strip().lower()
            allowed = _get_effective_allowed_hosts()
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
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        html_path = STATIC_DIR / "index.html"
        return HTMLResponse(html_path.read_text(encoding="utf-8"))

    @app.get("/pair", response_class=HTMLResponse)
    async def pairing_page(request: Request) -> HTMLResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")

        session = pairing_mgr.get_or_create_pairing_session()
        lan_ip = cfg.lan_ip or "127.0.0.1"
        pairing_url = f"http://{lan_ip}:{cfg.port}/?pair={session.code}"
        qr_data_url = render_qr_data_url(pairing_url)
        paired_devices = pairing_mgr.list_devices()
        ext_dir_raw = str(get_installed_extension_dir())
        ext_dir_html = html.escape(ext_dir_raw)
        ext_dir_js = json.dumps(ext_dir_raw)
        ext_connected = coordinator.extension_connected
        ext_badge_text = "Conectada" if ext_connected else "Não detectada"
        ext_badge_bg = "#e6f6ec" if ext_connected else "#fff4e5"
        ext_badge_color = "#1b7a34" if ext_connected else "#a66300"
        ext_note_text = (
            "Extensão conectada com sucesso!"
            if ext_connected
            else "Aguardando conexão da extensão no Google Chrome…"
        )

        ts_info = _refresh_tailscale_cache(query_cli=False)
        ts_enabled = coordinator.tailscale_enabled
        ts_badge_text = "Ativado" if ts_enabled else "Desativado (padrão)"
        ts_badge_bg = "#e6f6ec" if ts_enabled else "#f2f2f7"
        ts_badge_color = "#1b7a34" if ts_enabled else "#666"
        ts_next_val = "false" if ts_enabled else "true"
        ts_btn_label = "Desativar Acesso Tailscale" if ts_enabled else "Ativar Acesso Tailscale"
        ts_btn_bg = "#c62828" if ts_enabled else "#0066cc"
        ts_ip_html = html.escape(ts_info.ip or "Não detectado")
        ts_dns_val = ts_info.dns_name or ""
        ts_dns_html = html.escape(ts_dns_val)
        ts_qr_url = (
            f"http://{ts_info.ip}:{cfg.port}/?pair={session.code}"
            if ts_info.ip
            else (f"https://{ts_dns_val}/?pair={session.code}" if ts_dns_val else "")
        )
        ts_qr_block = ""
        if ts_enabled and ts_qr_url:
            ts_qr_data = render_qr_data_url(ts_qr_url)
            ts_qr_safe = html.escape(ts_qr_url)
            ts_qr_block = f"""
            <div style="text-align:center;margin:14px 0 8px 0;">
              <img src="{ts_qr_data}" alt="QR Code Tailscale" class="qr-img"
                   style="width:170px;height:170px;" />
              <div style="font-size:12px;color:#555;word-break:break-all;margin-top:6px;">
                URL Tailscale: <a href="{ts_qr_safe}" style="color:#0066cc;">{ts_qr_safe}</a>
              </div>
            </div>"""
        ts_serve_host = ts_dns_val or "meu-pc.tailnet.ts.net"
        ts_serve_note = (
            f"Para HTTPS automático (instalação PWA no Android), rode: "
            f"<code>tailscale serve --bg {cfg.port}</code> e acesse "
            f"<code>https://{html.escape(ts_serve_host)}</code>."
        )

        pin_formatted = f"{session.pin[:3]} {session.pin[3:]}"
        devices_rows = "".join(
            f"""
            <tr>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e5ea;">
                <strong>{html.escape(str(d["name"]))}</strong>
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

        remote_enabled = coordinator.remote_input_enabled
        remote_badge = "Ativado" if remote_enabled else "Desativado"
        remote_color = "#1b7a34" if remote_enabled else "#666"
        remote_btn_label = (
            "Desativar Mouse/Teclado Remoto"
            if remote_enabled
            else "Ativar Mouse/Teclado Remoto"
        )
        remote_next_val = "false" if remote_enabled else "true"

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
      max-width: 520px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.08);
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
      background: #0066cc; color: white; border: none; padding: 12px 16px;
      border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%;
    }}
    .btn-secondary {{
      background: #efeff4; color: #1d1d1f; border: 1px solid #d5d5dc;
      padding: 10px 12px; border-radius: 10px; font-size: 13px; font-weight: 600;
      cursor: pointer; flex: 1;
    }}
    .ext-header {{
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      margin-bottom: 8px;
    }}
    .ext-badge {{
      display: inline-block; padding: 4px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 700; white-space: nowrap;
      background: {ext_badge_bg}; color: {ext_badge_color};
    }}
    .path-box {{
      background: #f2f2f7; border: 1px solid #e5e5ea; border-radius: 10px;
      padding: 10px 12px; font-family: ui-monospace, Consolas, monospace; font-size: 12px;
      word-break: break-all; color: #1d1d1f; margin: 10px 0;
    }}
    .btn-row {{ display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }}
    .steps {{
      margin: 12px 0 6px 0; padding-left: 20px; font-size: 13px;
      color: #444; line-height: 1.55;
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

    <section id="extensao">
      <div class="ext-header">
        <h2 style="font-size: 16px; margin: 0;">Extensão do Google Chrome</h2>
        <span id="ext-status-badge" class="ext-badge">{ext_badge_text}</span>
      </div>
      <p style="font-size: 13px; color: #666; margin: 0 0 8px 0;">
        Desbloqueia controle por aba do YouTube, busca de vídeos, tela cheia e pular anúncios.
      </p>
      <div class="path-box" id="ext-dir-path">{ext_dir_html}</div>
      <form method="POST" action="/pair/open-extension-dir" id="open-ext-form" style="margin: 0;">
        <button type="submit" class="btn" id="open-ext-btn">
          Abrir pasta (arrastar para o Chrome)
        </button>
      </form>
      <div class="btn-row">
        <button type="button" class="btn-secondary" id="copy-path-btn">Copiar caminho</button>
        <button type="button" class="btn-secondary" id="copy-chrome-url-btn">
          Copiar chrome://extensions
        </button>
      </div>
      <ol class="steps">
        <li>Clique em <strong>Abrir pasta (arrastar para o Chrome)</strong> acima.</li>
        <li>
          Cole <code>chrome://extensions</code> no Chrome e ative o
          <strong>Modo do desenvolvedor</strong>.
        </li>
        <li>
          <strong>Arraste a pasta</strong> <code>extension</code> para dentro da aba do Chrome
          (ou clique em <em>Carregar sem compactação</em> e cole com <code>Ctrl+V</code>).
        </li>
      </ol>
      <p id="ext-status-note" style="font-size: 12px; color: {ext_badge_color}; margin: 8px 0 0 0;">
        {ext_note_text}
      </p>
    </section>

    <hr style="border: none; border-top: 1px solid #e5e5ea; margin: 28px 0;" />

    <h2 style="font-size: 16px; margin: 0 0 8px 0;">Dispositivos Autorizados</h2>
    <table>
      <tbody>
        {devices_rows}
      </tbody>
    </table>

    <hr style="border: none; border-top: 1px solid #e5e5ea; margin: 28px 0;" />

    <h2 style="font-size: 16px; margin: 0 0 6px 0;">Segurança — Mouse e Teclado Remoto</h2>
    <p style="font-size: 13px; color: #666; margin: 0 0 12px 0;">
      Status atual: <strong style="color: {remote_color};">{remote_badge}</strong>.
      Permite mover o cursor e digitar pelo celular pareado.
    </p>
    <form method="POST" action="/pair/remote-input" style="margin: 0;">
      <input type="hidden" name="enabled" value="{remote_next_val}" />
      <button type="submit" class="btn" style="background: #1d1d1f;">{remote_btn_label}</button>
    </form>

    <hr style="border: none; border-top: 1px solid #e5e5ea; margin: 28px 0;" />

    <section id="tailscale">
      <div class="ext-header">
        <h2 style="font-size: 16px; margin: 0;">Acesso Remoto (Tailscale — opcional)</h2>
        <span class="ext-badge" style="background:{ts_badge_bg};color:{ts_badge_color};">
          {ts_badge_text}
        </span>
      </div>
      <p style="font-size: 13px; color: #666; margin: 0 0 8px 0;">
        Por padrão, apenas dispositivos na sua rede Wi-Fi local acessam o host. Ative somente se
        quiser acessar o PC fora de casa pela sua rede privada Tailscale.
      </p>
      <div class="path-box" style="margin-bottom:10px;">
        IP Tailscale: <strong>{ts_ip_html}</strong>
        {f" · MagicDNS: <strong>{ts_dns_html}</strong>" if ts_dns_html else ""}
      </div>
      {ts_qr_block}
      <form method="POST" action="/pair/tailscale" style="margin: 8px 0 10px 0;">
        <label style="display:block;font-size:12px;font-weight:600;color:#444;margin-bottom:4px;">
          Host MagicDNS Tailscale (opcional)
        </label>
        <div class="btn-row" style="margin-top:0;margin-bottom:10px;">
          <input
            type="text"
            name="hostname"
            value="{ts_dns_html}"
            placeholder="ex.: meu-pc.tailnet.ts.net"
            style="flex:1;padding:9px 11px;border-radius:10px;
                   border:1px solid #d5d5dc;font-size:13px;"
          />
          <button
            type="submit"
            name="action"
            value="save_host"
            class="btn-secondary"
            style="flex:0 0 auto;"
          >
            Salvar host
          </button>
        </div>
        <button
          type="submit"
          name="enabled"
          value="{ts_next_val}"
          class="btn"
          style="background:{ts_btn_bg};"
        >
          {ts_btn_label}
        </button>
      </form>
      <p style="font-size: 12px; color: #666; margin: 6px 0 0 0;">
        {ts_serve_note}
      </p>
    </section>
  </div>
  <script>
    (function () {{
      var extDir = {ext_dir_js};
      var openForm = document.getElementById("open-ext-form");
      var copyPathBtn = document.getElementById("copy-path-btn");
      var copyChromeBtn = document.getElementById("copy-chrome-url-btn");
      var badge = document.getElementById("ext-status-badge");
      var note = document.getElementById("ext-status-note");

      function flashButton(btn, label) {{
        var prev = btn.textContent;
        btn.textContent = label;
        setTimeout(function () {{ btn.textContent = prev; }}, 1500);
      }}

      function copyText(text, btn) {{
        if (navigator.clipboard && navigator.clipboard.writeText) {{
          navigator.clipboard.writeText(text).then(function () {{
            flashButton(btn, "Copiado!");
          }}).catch(function () {{}});
        }}
      }}

      if (copyPathBtn) {{
        copyPathBtn.addEventListener("click", function () {{
          copyText(extDir, copyPathBtn);
        }});
      }}

      if (copyChromeBtn) {{
        copyChromeBtn.addEventListener("click", function () {{
          copyText("chrome://extensions", copyChromeBtn);
        }});
      }}

      if (openForm) {{
        openForm.addEventListener("submit", function (ev) {{
          ev.preventDefault();
          fetch("/pair/open-extension-dir", {{
            method: "POST",
            headers: {{ "X-Requested-With": "fetch" }}
          }}).then(function () {{
            var openBtn = document.getElementById("open-ext-btn");
            if (openBtn) flashButton(openBtn, "Pasta aberta e caminho copiado!");
          }}).catch(function () {{}});
        }});
      }}

      function pollExtensionStatus() {{
        fetch("/api/extension/status")
          .then(function (res) {{ return res.ok ? res.json() : null; }})
          .then(function (data) {{
            if (!data || !badge || !note) return;
            if (data.connected) {{
              badge.textContent = "Conectada";
              badge.style.background = "#e6f6ec";
              badge.style.color = "#1b7a34";
              note.textContent = "Extensão conectada com sucesso!";
              note.style.color = "#1b7a34";
            }} else {{
              badge.textContent = "Não detectada";
              badge.style.background = "#fff4e5";
              badge.style.color = "#a66300";
              note.textContent = "Aguardando conexão da extensão no Google Chrome…";
              note.style.color = "#a66300";
            }}
          }})
          .catch(function () {{}});
      }}

      setInterval(pollExtensionStatus, 2500);
    }})();
  </script>
</body>
</html>"""
        return HTMLResponse(html_content)

    @app.get("/api/extension/status")
    async def extension_status(request: Request) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        return JSONResponse(
            {
                "connected": coordinator.extension_connected,
                "extensionId": cfg.extension_id,
                "extensionDir": str(get_installed_extension_dir()),
            }
        )

    @app.post("/pair/open-extension-dir")
    async def open_extension_dir_endpoint(request: Request) -> Response:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        ext_dir = open_extension_folder_for_install()
        is_fetch = (
            request.headers.get("x-requested-with") == "fetch"
            or "application/json" in request.headers.get("accept", "")
        )
        if is_fetch:
            return JSONResponse({"ok": True, "extensionDir": str(ext_dir)})
        return Response(status_code=303, headers={"Location": "/pair#extensao"})

    @app.post("/pair/refresh")
    async def refresh_pairing(request: Request) -> Response:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        pairing_mgr.get_or_create_pairing_session(force_new=True)
        return Response(status_code=303, headers={"Location": "/pair"})

    @app.post("/pair/revoke/{device_id}")
    async def revoke_device_form(request: Request, device_id: str) -> Response:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        pairing_mgr.revoke_device(device_id)
        return Response(status_code=303, headers={"Location": "/pair"})

    @app.post("/pair/remote-input")
    async def toggle_remote_input_form(request: Request) -> Response:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        raw_body = (await request.body()).decode("utf-8", errors="ignore")
        parsed_form = parse_qs(raw_body, keep_blank_values=True)
        enabled_list = parsed_form.get("enabled")
        raw_val = (
            str(enabled_list[0]).strip().lower()
            if enabled_list
            else str(request.query_params.get("enabled") or "").strip().lower()
        )
        next_state = (
            raw_val in {"1", "true", "on", "yes"}
            if raw_val
            else (not coordinator.remote_input_enabled)
        )
        coordinator.set_remote_input_enabled(next_state)
        await coordinator.broadcast_state(force=True)
        return Response(status_code=303, headers={"Location": "/pair"})

    @app.post("/pair/tailscale")
    async def toggle_tailscale_form(request: Request) -> Response:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            raise HTTPException(status_code=403, detail="Acesso restrito ao computador local.")
        raw_body = (await request.body()).decode("utf-8", errors="ignore")
        parsed_form = parse_qs(raw_body, keep_blank_values=True)
        if "hostname" in parsed_form:
            cfg_store.set_tailscale_hostname(str(parsed_form["hostname"][0]))

        enabled_list = parsed_form.get("enabled")
        raw_val = (
            str(enabled_list[0]).strip().lower()
            if enabled_list
            else str(request.query_params.get("enabled") or "").strip().lower()
        )
        if raw_val:
            next_state = raw_val in {"1", "true", "on", "yes"}
            coordinator.set_tailscale_enabled(next_state)
        _refresh_tailscale_cache(query_cli=True)
        await coordinator.broadcast_state(force=True)
        return Response(status_code=303, headers={"Location": "/pair#tailscale"})

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
        if not is_trusted_local_request(client_host, request.headers):
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
        if not is_trusted_local_request(client_host, request.headers):
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

    # 5. Media state & screen monitor APIs (require auth unless trusted local)
    @app.get("/api/state")
    async def get_state(request: Request) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            token = _extract_bearer_token(request)
            if not token or not pairing_mgr.validate_token(token):
                raise HTTPException(
                    status_code=401,
                    detail="Token de autorização ausente ou inválido.",
                )

        state = await coordinator.build_state()
        return JSONResponse(state.model_dump())

    @app.get("/api/screen/monitors")
    async def get_screen_monitors(request: Request) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        if not is_trusted_local_request(client_host, request.headers):
            token = _extract_bearer_token(request)
            if not token or not pairing_mgr.validate_token(token):
                raise HTTPException(
                    status_code=401,
                    detail="Token de autorização ausente ou inválido.",
                )

        monitors = await active_screen.list_monitors()
        return JSONResponse({"monitors": [m.to_dict() for m in monitors]})

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
                "remoteInputEnabled": coordinator.remote_input_enabled,
                "tailscaleEnabled": coordinator.tailscale_enabled,
                "screenMirrorAvailable": True,
            }
        )

    # 6. WebSocket control endpoint with LAN token authentication
    @app.websocket("/ws")
    async def control_websocket(websocket: WebSocket) -> None:
        client_host = websocket.client.host if websocket.client is not None else ""
        is_local = is_trusted_local_request(client_host, websocket.headers)

        # In localhost-only mode, block non-local completely
        if not cfg.lan_mode and not is_local:
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
            allowed_hosts = _get_effective_allowed_hosts()
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
        allowed_origins = _get_effective_allowed_ws_origins()
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
        if not is_local:
            authenticated_device_id = await _authenticate_ws_client(
                websocket,
                pairing_mgr,
                device_websockets,
                client_host,
                "/ws",
            )
            if authenticated_device_id is None:
                return

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
                    # Handle optional re-auth or local auth frame gracefully
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

    # 7. WebSocket lightweight screen mirror endpoint (on-demand JPEG frames)
    @app.websocket("/ws/screen")
    async def screen_websocket(websocket: WebSocket) -> None:
        client_host = websocket.client.host if websocket.client is not None else ""
        is_local = is_trusted_local_request(client_host, websocket.headers)

        if not cfg.lan_mode and not is_local:
            logger.warning(
                "WebSocket /ws/screen rejeitado de %s: modo LAN desativado",
                client_host,
            )
            await websocket.close(code=1008, reason="Acesso permitido apenas via localhost")
            return

        raw_host = websocket.headers.get("host")
        if raw_host:
            clean_host = raw_host.strip().lower()
            allowed_hosts = _get_effective_allowed_hosts()
            if clean_host not in allowed_hosts:
                logger.warning(
                    "WebSocket /ws/screen rejeitado de %s: Host inválido %r",
                    client_host,
                    raw_host,
                )
                await websocket.close(code=1008, reason="Host inválido (DNS rebinding mitigado)")
                return

        raw_origin = websocket.headers.get("origin")
        origin = normalize_origin(raw_origin)
        allowed_origins = _get_effective_allowed_ws_origins()
        if not origin or origin not in allowed_origins:
            logger.warning(
                "WebSocket /ws/screen rejeitado de %s: Origin inválida %r",
                client_host,
                raw_origin,
            )
            await websocket.close(code=1008, reason="Origin não autorizada")
            return

        if len(active_screen_clients) >= MAX_SCREEN_CLIENTS:
            logger.warning("WebSocket /ws/screen rejeitado: limite de clientes simultâneos")
            await websocket.close(code=1013, reason="Limite de visualizações simultâneas atingido.")
            return

        await websocket.accept()

        authenticated_device_id: str | None = None
        if not is_local:
            authenticated_device_id = await _authenticate_ws_client(
                websocket,
                pairing_mgr,
                device_websockets,
                client_host,
                "/ws/screen",
            )
            if authenticated_device_id is None:
                return

        active_screen_clients.add(websocket)
        monitors = await active_screen.list_monitors()
        initial_monitor = next(
            (m.id for m in monitors if m.primary),
            monitors[0].id if monitors else 1,
        )
        stream_cfg: dict[str, Any] = {
            "monitor": initial_monitor,
            "fps": 8,
            "quality": 60,
            "max_width": 960,
            "paused": False,
            "dirty": True,
        }
        wake_event = asyncio.Event()
        stop_event = asyncio.Event()

        async def _stream_loop() -> None:
            last_digest: bytes | None = None
            last_sent_at = 0.0
            last_monitor: int | None = None
            while not stop_event.is_set():
                if stream_cfg["paused"]:
                    wake_event.clear()
                    await wake_event.wait()
                    continue

                tick_start = time.monotonic()
                target_mon = int(stream_cfg["monitor"])
                frame = await active_screen.capture_jpeg(
                    monitor_id=target_mon,
                    max_width=int(stream_cfg["max_width"]),
                    quality=int(stream_cfg["quality"]),
                    include_cursor=True,
                )
                if stop_event.is_set():
                    break

                if frame is not None:
                    now = time.monotonic()
                    changed = (
                        stream_cfg["dirty"]
                        or frame.monitor_id != last_monitor
                        or frame.digest != last_digest
                        or (now - last_sent_at) >= 2.0
                    )
                    if changed:
                        stream_cfg["dirty"] = False
                        try:
                            await asyncio.wait_for(
                                websocket.send_bytes(frame.jpeg_bytes),
                                timeout=3.0,
                            )
                        except Exception:  # noqa: BLE001
                            stop_event.set()
                            break
                        last_digest = frame.digest
                        last_sent_at = now
                        last_monitor = frame.monitor_id

                interval = 1.0 / max(1, int(stream_cfg["fps"]))
                sleep_for = max(0.02, interval - (time.monotonic() - tick_start))
                wake_event.clear()
                if not stream_cfg["dirty"] and not stop_event.is_set():
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(wake_event.wait(), timeout=sleep_for)

        stream_task: asyncio.Task[None] | None = None
        try:
            meta_payload = {
                "v": 1,
                "type": "screen_meta",
                "monitors": [m.to_dict() for m in monitors],
                "activeMonitor": initial_monitor,
                "fps": stream_cfg["fps"],
                "quality": stream_cfg["quality"],
                "maxWidth": stream_cfg["max_width"],
                "paused": False,
            }
            await websocket.send_text(json.dumps(meta_payload))
            stream_task = asyncio.create_task(_stream_loop())

            while not stop_event.is_set():
                text = await websocket.receive_text()
                try:
                    raw = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if not isinstance(raw, dict):
                    continue

                msg_type = raw.get("type")
                if msg_type == "auth":
                    token = str(raw.get("token") or "")
                    device = pairing_mgr.validate_token(token)
                    if device is not None:
                        authenticated_device_id = device.id
                        device_websockets[device.id].add(websocket)
                    continue

                if msg_type == "ping":
                    req_id = raw.get("requestId")
                    await websocket.send_text(
                        PongMessage(requestId=str(req_id) if req_id else None).model_dump_json()
                    )
                    continue

                if msg_type == "screen_config":
                    if isinstance(raw.get("monitor"), int):
                        stream_cfg["monitor"] = max(1, min(16, int(raw["monitor"])))
                    if isinstance(raw.get("fps"), (int, float)):
                        stream_cfg["fps"] = max(1, min(15, int(raw["fps"])))
                    if isinstance(raw.get("quality"), (int, float)):
                        stream_cfg["quality"] = max(25, min(85, int(raw["quality"])))
                    if isinstance(raw.get("maxWidth"), (int, float)):
                        stream_cfg["max_width"] = max(320, min(1280, int(raw["maxWidth"])))
                    if isinstance(raw.get("paused"), bool):
                        stream_cfg["paused"] = raw["paused"]
                    stream_cfg["dirty"] = True
                    wake_event.set()
        except WebSocketDisconnect:
            pass
        finally:
            stop_event.set()
            wake_event.set()
            if stream_task is not None:
                stream_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stream_task
            active_screen_clients.discard(websocket)
            if authenticated_device_id:
                device_websockets[authenticated_device_id].discard(websocket)

    # 8. Chrome extension WebSocket endpoint (strictly unproxied loopback only)
    @app.websocket("/ws/extension")
    async def extension_websocket(websocket: WebSocket) -> None:
        client_host = websocket.client.host if websocket.client is not None else ""
        if not is_trusted_local_request(client_host, websocket.headers):
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
