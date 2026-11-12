"""CLI entrypoint for running the local-only Fase 1 host server."""

from __future__ import annotations

import argparse

import uvicorn

from host.app import create_app
from host.config import HostSettings


def main() -> int:
    """Start the FastAPI host strictly bound to 127.0.0.1."""
    parser = argparse.ArgumentParser(description="PC Media Control Host (Fase 1 - localhost)")
    parser.add_argument("--port", type=int, default=8765, help="Porta HTTP/WS (padrão: 8765)")
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=0.5,
        help="Intervalo de atualização de estado em segundos (padrão: 0.5)",
    )
    args = parser.parse_args()

    settings = HostSettings(host="127.0.0.1", port=args.port, poll_interval_sec=args.poll_interval)
    app = create_app(settings=settings)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
