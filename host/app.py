"""FastAPI application factory with WebSocket endpoints for control clients and Chrome extension."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Sequence
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from host.config import HostSettings, normalize_origin
from host.protocol import ErrorMessage
from host.providers.base import AudioControlProvider, SessionProvider
from host.providers.chrome_extension import ChromeExtensionProvider
from host.providers.windows import WindowsProvider
from host.state import HostStateCoordinator

STATIC_DIR = Path(__file__).resolve().parent / "static"
LOCALHOST_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}
logger = logging.getLogger(__name__)


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


def create_app(
    settings: HostSettings | None = None,
    providers: Sequence[SessionProvider] | None = None,
    audio_provider: AudioControlProvider | None = None,
    chrome_provider: ChromeExtensionProvider | None = None,
) -> FastAPI:
    """Create and configure the local-only FastAPI host application."""
    cfg = settings or HostSettings()

    owned_windows: WindowsProvider | None = None
    if providers is None or audio_provider is None:
        owned_windows = WindowsProvider()

    ext_provider = chrome_provider or ChromeExtensionProvider()
    active_audio: AudioControlProvider = (
        audio_provider if audio_provider is not None else owned_windows  # type: ignore[assignment]
    )
    active_providers: list[SessionProvider] = (
        list(providers)
        if providers is not None
        else [ext_provider, owned_windows]  # type: ignore[list-item]
    )

    coordinator = HostStateCoordinator(
        providers=active_providers,
        audio_provider=active_audio,
    )

    async def _on_extension_change() -> None:
        await coordinator.broadcast_state(force=True)

    ext_provider.set_on_change(_on_extension_change)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
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
            if owned_windows is not None:
                owned_windows.close()

    app = FastAPI(title="PC Media Control Host", version="0.1.0", lifespan=lifespan)
    app.state.coordinator = coordinator
    app.state.chrome_provider = ext_provider
    app.state.settings = cfg

    @app.get("/", response_model=None)
    async def index() -> Response:
        dist_index = cfg.client_dist_dir / "index.html"
        if dist_index.is_file():
            return FileResponse(dist_index, headers={"Cache-Control": "no-cache"})
        html_path = STATIC_DIR / "index.html"
        return HTMLResponse(html_path.read_text(encoding="utf-8"))

    @app.get("/legacy-test", response_class=HTMLResponse)
    async def legacy_test_page() -> HTMLResponse:
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

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "v": 1,
                "host": cfg.host,
                "port": cfg.port,
                "extensionConnected": coordinator.extension_connected,
                "extensionId": cfg.extension_id,
            }
        )

    @app.get("/api/state")
    async def get_state() -> JSONResponse:
        state = await coordinator.build_state()
        return JSONResponse(state.model_dump())

    @app.websocket("/ws")
    async def control_websocket(websocket: WebSocket) -> None:
        client_host = websocket.client.host if websocket.client is not None else ""
        if cfg.host in {"127.0.0.1", "::1", "localhost"} and client_host not in LOCALHOST_HOSTS:
            await websocket.close(code=1008, reason="Acesso permitido apenas via localhost")
            return

        origin = normalize_origin(websocket.headers.get("origin"))
        allowed_origins = cfg.get_allowed_ws_origins()
        if not origin or origin not in allowed_origins:
            logger.warning("WebSocket /ws rejeitado por Origin inválido: %r", origin)
            await websocket.close(code=1008, reason="Origin não autorizada")
            return

        await websocket.accept()
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

                response = await coordinator.handle_raw_client_message(raw)
                if response is not None:
                    await websocket.send_text(response.model_dump_json())
        except WebSocketDisconnect:
            pass
        finally:
            coordinator.unregister_client(websocket)

    @app.websocket("/ws/extension")
    async def extension_websocket(websocket: WebSocket) -> None:
        client_host = websocket.client.host if websocket.client is not None else ""
        if client_host not in LOCALHOST_HOSTS:
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
