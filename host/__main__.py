"""CLI entrypoint for running the local-only host server."""

from __future__ import annotations

import argparse
import os

import uvicorn

from host.app import create_app
from host.config import DEFAULT_EXTENSION_ID, HostSettings


def main() -> int:
    """Start the FastAPI host strictly bound to 127.0.0.1."""
    parser = argparse.ArgumentParser(description="PC Media Control Host (localhost)")
    parser.add_argument("--port", type=int, default=8765, help="Porta HTTP/WS (padrão: 8765)")
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=0.5,
        help="Intervalo de atualização de estado em segundos (padrão: 0.5)",
    )
    parser.add_argument(
        "--extension-id",
        default=os.environ.get("PCMEDIA_EXTENSION_ID", DEFAULT_EXTENSION_ID),
        help="ID autorizado da extensão Chrome para /ws/extension",
    )
    args = parser.parse_args()

    settings = HostSettings(
        host="127.0.0.1",
        port=args.port,
        poll_interval_sec=args.poll_interval,
        extension_id=args.extension_id,
    )
    app = create_app(settings=settings)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
