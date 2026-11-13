"""GSMTC media session discovery and control spike for Windows (Phase 0)."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSession as MediaSession,
)
from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
)
from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
)

TICKS_PER_SECOND = 10_000_000


@dataclass(frozen=True, slots=True)
class SessionControlsInfo:
    """Playback capabilities reported by a GSMTC session."""

    play: bool
    pause: bool
    toggle: bool
    next: bool
    previous: bool
    seek: bool


@dataclass(frozen=True, slots=True)
class SessionSnapshot:
    """Serializable snapshot of a single GSMTC media session."""

    index: int
    is_current: bool
    app_id: str
    title: str
    artist: str
    album: str
    subtitle: str
    playback_type: str
    status: str
    position_sec: float
    estimated_position_sec: float
    start_sec: float
    duration_sec: float
    min_seek_sec: float
    max_seek_sec: float
    last_updated_utc: str | None
    controls: SessionControlsInfo
    media_props_error: str | None = None


def format_seconds(seconds: float) -> str:
    """Format a non-negative duration in seconds as MM:SS or HH:MM:SS."""
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours:d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def parse_time_argument(raw: str) -> float:
    """Parse seconds as float or HH:MM:SS / MM:SS string into seconds."""
    text = raw.strip()
    if ":" not in text:
        value = float(text)
        if value < 0:
            raise ValueError("Position must be non-negative")
        return value

    parts = text.split(":")
    if len(parts) not in (2, 3):
        raise ValueError(f"Invalid time format: {raw!r}")
    numbers = [float(p) for p in parts]
    if any(n < 0 for n in numbers):
        raise ValueError("Time components must be non-negative")
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]


def seconds_to_100ns_ticks(seconds: float) -> int:
    """Convert seconds to WinRT 100-nanosecond ticks."""
    if seconds < 0:
        raise ValueError("Seek seconds cannot be negative")
    return int(round(seconds * TICKS_PER_SECOND))


def estimate_position_seconds(
    reported_position: timedelta,
    end_time: timedelta,
    last_updated: datetime | None,
    status_name: str,
    now_utc: datetime | None = None,
) -> float:
    """Estimate current playback position when a session is actively playing."""
    pos_sec = max(0.0, reported_position.total_seconds())
    end_sec = max(0.0, end_time.total_seconds())
    if status_name != "PLAYING" or last_updated is None or last_updated.year <= 1601:
        return min(pos_sec, end_sec) if end_sec > 0 else pos_sec

    ref_now = now_utc or datetime.now(UTC)
    updated_utc = (
        last_updated.replace(tzinfo=UTC)
        if last_updated.tzinfo is None
        else last_updated.astimezone(UTC)
    )
    elapsed = max(0.0, (ref_now - updated_utc).total_seconds())
    estimated = pos_sec + elapsed
    if end_sec > 0:
        return min(estimated, end_sec)
    return estimated


def _safe_last_updated_iso(last_updated: datetime | None) -> str | None:
    if last_updated is None or last_updated.year <= 1601:
        return None
    dt = (
        last_updated.replace(tzinfo=UTC)
        if last_updated.tzinfo is None
        else last_updated.astimezone(UTC)
    )
    return dt.isoformat()


def _session_signature(session: MediaSession) -> tuple[str, str, float, float]:
    """Build a best-effort signature to match current_session against get_sessions()."""
    info = session.get_playback_info()
    tl = session.get_timeline_properties()
    last_upd = tl.last_updated_time.timestamp() if tl.last_updated_time.year > 1601 else 0.0
    return (
        session.source_app_user_model_id or "",
        info.playback_status.name,
        tl.end_time.total_seconds(),
        last_upd,
    )


def _safe_playback_type_name(obj: object) -> str | None:
    """Safely read MediaPlaybackType enum name without failing if winrt-Windows.Media is absent."""
    try:
        playback_type = getattr(obj, "playback_type", None)
        return playback_type.name if playback_type is not None else None
    except ModuleNotFoundError:
        return None


async def read_session_snapshot(
    index: int,
    session: MediaSession,
    current_sig: tuple[str, str, float, float] | None,
) -> SessionSnapshot:
    """Collect metadata, playback info, controls, and timeline from a GSMTC session."""
    info = session.get_playback_info()
    ctrl = info.controls
    tl = session.get_timeline_properties()

    title = ""
    artist = ""
    album = ""
    subtitle = ""
    playback_type = _safe_playback_type_name(info) or "UNKNOWN"
    props_error: str | None = None

    try:
        props = await session.try_get_media_properties_async()
        if props is not None:
            title = props.title or ""
            artist = props.artist or ""
            album = props.album_title or ""
            subtitle = props.subtitle or ""
            prop_type = _safe_playback_type_name(props)
            if prop_type is not None:
                playback_type = prop_type
    except Exception as exc:  # noqa: BLE001
        props_error = f"{type(exc).__name__}: {exc}"

    status_name = PlaybackStatus(info.playback_status).name
    sig = _session_signature(session)
    is_current = current_sig is not None and sig == current_sig

    last_updated_iso = _safe_last_updated_iso(tl.last_updated_time)
    est_pos = estimate_position_seconds(
        tl.position,
        tl.end_time,
        tl.last_updated_time,
        status_name,
    )

    return SessionSnapshot(
        index=index,
        is_current=is_current,
        app_id=session.source_app_user_model_id or "(desconhecido)",
        title=title,
        artist=artist,
        album=album,
        subtitle=subtitle,
        playback_type=playback_type,
        status=status_name,
        position_sec=tl.position.total_seconds(),
        estimated_position_sec=est_pos,
        start_sec=tl.start_time.total_seconds(),
        duration_sec=tl.end_time.total_seconds(),
        min_seek_sec=tl.min_seek_time.total_seconds(),
        max_seek_sec=tl.max_seek_time.total_seconds(),
        last_updated_utc=last_updated_iso,
        controls=SessionControlsInfo(
            play=ctrl.is_play_enabled,
            pause=ctrl.is_pause_enabled,
            toggle=ctrl.is_play_pause_toggle_enabled,
            next=ctrl.is_next_enabled,
            previous=ctrl.is_previous_enabled,
            seek=ctrl.is_playback_position_enabled,
        ),
        media_props_error=props_error,
    )


async def fetch_sessions() -> tuple[list[MediaSession], list[SessionSnapshot]]:
    """Query Windows GSMTC manager and return raw sessions alongside snapshots."""
    manager = await SessionManager.request_async()
    current = manager.get_current_session()
    current_sig = _session_signature(current) if current is not None else None
    sessions = list(manager.get_sessions())
    snapshots = [
        await read_session_snapshot(i, sess, current_sig) for i, sess in enumerate(sessions)
    ]
    return sessions, snapshots


def resolve_session_index(
    snapshots: list[SessionSnapshot],
    selector: str | None,
) -> int:
    """Resolve a session index from an integer string, app/title substring, or current session."""
    if not snapshots:
        raise ValueError("Nenhuma sessão GSMTC ativa encontrada.")

    if selector is None:
        for snap in snapshots:
            if snap.is_current:
                return snap.index
        return 0

    try:
        idx = int(selector)
    except ValueError:
        needle = selector.lower()
        matches = [
            s.index for s in snapshots if needle in s.app_id.lower() or needle in s.title.lower()
        ]
        if not matches:
            raise ValueError(f"Nenhuma sessão corresponde a {selector!r}.") from None
        return matches[0]

    if idx < 0 or idx >= len(snapshots):
        raise ValueError(
            f"Índice de sessão inválido: {idx} (disponíveis: 0..{len(snapshots) - 1})."
        )
    return idx


async def execute_session_action(
    session: MediaSession,
    action: str,
    seek_seconds: float | None = None,
) -> bool:
    """Invoke a transport control command on the target GSMTC session."""
    if action == "play":
        return bool(await session.try_play_async())
    if action == "pause":
        return bool(await session.try_pause_async())
    if action == "toggle":
        return bool(await session.try_toggle_play_pause_async())
    if action == "next":
        return bool(await session.try_skip_next_async())
    if action == "previous":
        return bool(await session.try_skip_previous_async())
    if action == "seek":
        if seek_seconds is None:
            raise ValueError("A ação 'seek' exige --seconds.")
        ticks = seconds_to_100ns_ticks(seek_seconds)
        return bool(await session.try_change_playback_position_async(ticks))
    raise ValueError(f"Ação desconhecida: {action!r}")


def print_snapshots(snapshots: list[SessionSnapshot], as_json: bool = False) -> None:
    """Render GSMTC session snapshots to stdout."""
    if as_json:
        print(json.dumps([asdict(s) for s in snapshots], indent=2, ensure_ascii=False))
        return

    if not snapshots:
        print("Nenhuma sessão GSMTC encontrada no momento.")
        return

    print(f"Sessões GSMTC encontradas: {len(snapshots)}")
    print("-" * 88)
    for snap in snapshots:
        marker = " [ATIVA]" if snap.is_current else ""
        enabled = [
            name
            for name, flag in (
                ("play", snap.controls.play),
                ("pause", snap.controls.pause),
                ("toggle", snap.controls.toggle),
                ("next", snap.controls.next),
                ("prev", snap.controls.previous),
                ("seek", snap.controls.seek),
            )
            if flag
        ]
        pos_str = format_seconds(snap.position_sec)
        est_str = format_seconds(snap.estimated_position_sec)
        dur_str = format_seconds(snap.duration_sec)

        print(
            f"[{snap.index}] {snap.app_id}{marker}  |  status={snap.status} ({snap.playback_type})"
        )
        print(f"    Título : {snap.title or '(vazio)'}")
        album_part = f"  |  Álbum: {snap.album}" if snap.album else ""
        print(f"    Artista: {snap.artist or '(vazio)'}{album_part}")
        print(
            f"    Tempo  : raw={pos_str} ({snap.position_sec:.2f}s) | "
            f"est={est_str} ({snap.estimated_position_sec:.2f}s) / "
            f"{dur_str} ({snap.duration_sec:.2f}s)"
        )
        print(
            f"    Seek   : [{snap.min_seek_sec:.1f}s .. {snap.max_seek_sec:.1f}s] | "
            f"Atualizado: {snap.last_updated_utc or 'N/D'}"
        )
        print(f"    Controles habilitados: {', '.join(enabled) if enabled else '(nenhum)'}")
        if snap.media_props_error:
            print(f"    Aviso props: {snap.media_props_error}")
    print("-" * 88)


async def watch_loop(duration_sec: float, interval_sec: float = 1.0) -> None:
    """Poll GSMTC snapshots periodically to observe timeline/session changes."""
    deadline = asyncio.get_running_loop().time() + duration_sec
    print(f"Observando sessões GSMTC por {duration_sec:.0f}s (intervalo {interval_sec:.1f}s)...")
    while asyncio.get_running_loop().time() < deadline:
        _, snapshots = await fetch_sessions()
        now_local = datetime.now().strftime("%H:%M:%S")
        print(f"\n[{now_local}]")
        for s in snapshots:
            marker = "*" if s.is_current else " "
            print(
                f"  {marker}[{s.index}] {s.app_id} | {s.status:7s} | "
                f"raw={s.position_sec:6.2f}s est={s.estimated_position_sec:6.2f}s / "
                f"{s.duration_sec:6.2f}s | {s.title[:45]}"
            )
        await asyncio.sleep(interval_sec)


async def interactive_loop() -> None:
    """Interactive REPL for inspecting and controlling GSMTC sessions."""
    print("Modo interativo GSMTC. Comandos: list, play [id], pause [id], toggle [id],")
    print("  next [id], prev [id], seek <id> <seg|MM:SS>, watch [seg], quit")
    while True:
        _, snapshots = await fetch_sessions()
        print_snapshots(snapshots)
        try:
            raw = input("media> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not raw:
            continue
        parts = raw.split()
        cmd = parts[0].lower()
        if cmd in ("quit", "exit", "q"):
            break
        if cmd in ("list", "ls"):
            continue
        if cmd == "watch":
            secs = float(parts[1]) if len(parts) > 1 else 5.0
            await watch_loop(secs)
            continue

        action_map = {
            "play": "play",
            "pause": "pause",
            "toggle": "toggle",
            "next": "next",
            "prev": "previous",
            "previous": "previous",
            "seek": "seek",
        }
        if cmd not in action_map:
            print(f"Comando desconhecido: {cmd!r}")
            continue

        action = action_map[cmd]
        try:
            if action == "seek":
                if len(parts) < 3:
                    print("Uso: seek <indice_ou_app> <segundos|MM:SS>")
                    continue
                selector = parts[1]
                seek_sec = parse_time_argument(parts[2])
            else:
                selector = parts[1] if len(parts) > 1 else None
                seek_sec = None

            sessions, snapshots = await fetch_sessions()
            idx = resolve_session_index(snapshots, selector)
            ok = await execute_session_action(sessions[idx], action, seek_sec)
            print(f"Comando '{action}' na sessão [{idx}] ({snapshots[idx].app_id}): retorno={ok}")
        except Exception as exc:  # noqa: BLE001
            print(f"Erro ao executar comando: {exc}")


def build_parser() -> argparse.ArgumentParser:
    """Create CLI argument parser for the GSMTC spike."""
    parser = argparse.ArgumentParser(
        description="Spike Fase 0: listar e controlar sessões de mídia GSMTC no Windows."
    )
    parser.add_argument(
        "--action",
        choices=("list", "play", "pause", "toggle", "next", "previous", "seek"),
        default="list",
        help="Ação a executar (padrão: list).",
    )
    parser.add_argument(
        "--session",
        default=None,
        help="Índice da sessão ou trecho do app/título (padrão: sessão ativa).",
    )
    parser.add_argument(
        "--seconds",
        default=None,
        help="Posição alvo para 'seek' em segundos ou MM:SS.",
    )
    parser.add_argument(
        "--watch",
        type=float,
        default=None,
        help="Observa mudanças nas sessões por N segundos.",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Abre prompt interativo para testar comandos.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Imprime a listagem em formato JSON.",
    )
    return parser


async def async_main(args: argparse.Namespace) -> int:
    """Execute the requested GSMTC spike action."""
    if args.interactive:
        await interactive_loop()
        return 0

    if args.watch is not None:
        await watch_loop(args.watch)
        return 0

    sessions, snapshots = await fetch_sessions()
    if args.action == "list":
        print_snapshots(snapshots, as_json=args.json)
        return 0

    idx = resolve_session_index(snapshots, args.session)
    seek_sec = parse_time_argument(args.seconds) if args.seconds is not None else None
    ok = await execute_session_action(sessions[idx], args.action, seek_sec)
    target = snapshots[idx]
    print(f"Ação '{args.action}' -> [{idx}] {target.app_id} ({target.title!r}): resultado={ok}")
    return 0 if ok else 2


def main() -> int:
    """CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args()
    try:
        return asyncio.run(async_main(args))
    except ValueError as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
