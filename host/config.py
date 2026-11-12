"""Configuration settings for the local host server."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class HostSettings:
    """Runtime settings for the Fase 1 local-only FastAPI host."""

    host: str = "127.0.0.1"
    port: int = 8765
    poll_interval_sec: float = 0.5
