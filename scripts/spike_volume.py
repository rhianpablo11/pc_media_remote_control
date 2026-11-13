"""Windows Core Audio master and per-app session volume spike (Phase 0)."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass

from pycaw.pycaw import AudioUtilities

SESSION_STATE_LABELS: dict[int, str] = {
    0: "Inactive",
    1: "Active",
    2: "Expired",
}


@dataclass(frozen=True, slots=True)
class MasterVolumeSnapshot:
    """Current state of the default multimedia output endpoint."""

    device_name: str
    device_id: str
    volume: float
    muted: bool


@dataclass(frozen=True, slots=True)
class AudioSessionSnapshot:
    """Current state of a single Windows Core Audio session."""

    index: int
    pid: int
    process_name: str
    display_name: str
    state_code: int
    state: str
    volume: float
    muted: bool
    grouping_param: str
    identifier: str
    instance_identifier: str


def parse_volume_level(raw: str) -> float:
    """Parse a volume value as 0.0..1.0 scalar or 0%..100% percentage string."""
    text = raw.strip()
    if text.endswith("%"):
        pct = float(text[:-1].strip())
        if not 0.0 <= pct <= 100.0:
            raise ValueError(f"Porcentagem de volume fora de 0..100%: {raw!r}")
        return pct / 100.0

    val = float(text)
    if not 0.0 <= val <= 1.0:
        raise ValueError(f"Volume deve estar entre 0.0 e 1.0 (ou use sufixo %, ex: 50%): {raw!r}")
    return val


def parse_mute_flag(raw: str) -> bool | None:
    """Parse 'on'/'true'/'1' -> True, 'off'/'false'/'0' -> False, 'toggle' -> None."""
    normalized = raw.strip().lower()
    if normalized in ("on", "true", "1", "yes", "sim", "mute"):
        return True
    if normalized in ("off", "false", "0", "no", "nao", "não", "unmute"):
        return False
    if normalized == "toggle":
        return None
    raise ValueError(f"Valor de mudo inválido: {raw!r} (use on, off ou toggle)")


def get_master_snapshot() -> tuple[object, MasterVolumeSnapshot]:
    """Fetch default multimedia speakers endpoint and its volume snapshot."""
    speakers = AudioUtilities.GetSpeakers()
    if speakers is None:
        raise RuntimeError("Nenhum dispositivo de saída de áudio padrão encontrado.")
    ep = speakers.EndpointVolume
    snap = MasterVolumeSnapshot(
        device_name=str(speakers.FriendlyName or "(desconhecido)"),
        device_id=str(speakers.id),
        volume=float(ep.GetMasterVolumeLevelScalar()),
        muted=bool(ep.GetMute()),
    )
    return ep, snap


def get_audio_sessions() -> tuple[list[object], list[AudioSessionSnapshot]]:
    """List all Core Audio sessions with process metadata and volume state."""
    raw_sessions = AudioUtilities.GetAllSessions()
    snapshots: list[AudioSessionSnapshot] = []
    for idx, sess in enumerate(raw_sessions):
        pid = int(sess.ProcessId)
        if pid == 0:
            proc_name = "System Sounds"
        elif sess.Process is not None:
            proc_name = sess.Process.name()
        else:
            proc_name = f"(pid:{pid})"

        state_code = int(sess.State)
        vol_iface = sess.SimpleAudioVolume
        snapshots.append(
            AudioSessionSnapshot(
                index=idx,
                pid=pid,
                process_name=proc_name,
                display_name=str(sess.DisplayName or ""),
                state_code=state_code,
                state=SESSION_STATE_LABELS.get(state_code, f"Unknown({state_code})"),
                volume=float(vol_iface.GetMasterVolume()),
                muted=bool(vol_iface.GetMute()),
                grouping_param=str(sess.GroupingParam),
                identifier=str(sess.Identifier or ""),
                instance_identifier=str(sess.InstanceIdentifier or ""),
            )
        )
    return raw_sessions, snapshots


def resolve_session_indices(
    snapshots: list[AudioSessionSnapshot],
    selector: str,
    all_matches: bool = False,
) -> list[int]:
    """Resolve one or more session indices by numeric index or process/display substring."""
    if not snapshots:
        raise ValueError("Nenhuma sessão de áudio encontrada.")

    try:
        idx = int(selector)
    except ValueError:
        needle = selector.lower()
        matches = [
            s.index
            for s in snapshots
            if needle in s.process_name.lower() or needle in s.display_name.lower()
        ]
        if not matches:
            raise ValueError(f"Nenhuma sessão de áudio corresponde a {selector!r}.") from None
        return matches if all_matches else [matches[0]]

    if idx < 0 or idx >= len(snapshots):
        raise ValueError(
            f"Índice de sessão inválido: {idx} (disponíveis: 0..{len(snapshots) - 1})."
        )
    return [idx]


def set_master_volume(level: float | None = None, mute: str | None = None) -> MasterVolumeSnapshot:
    """Update master volume and/or mute state on the default speakers endpoint."""
    ep, current = get_master_snapshot()
    if level is not None:
        ep.SetMasterVolumeLevelScalar(level, None)
    if mute is not None:
        target_mute = parse_mute_flag(mute)
        final_mute = (not current.muted) if target_mute is None else target_mute
        ep.SetMute(int(final_mute), None)
    _, updated = get_master_snapshot()
    return updated


def set_session_volume(
    selector: str,
    level: float | None = None,
    mute: str | None = None,
    all_matches: bool = False,
) -> list[AudioSessionSnapshot]:
    """Update volume and/or mute state on matching audio session(s)."""
    raw_sessions, snapshots = get_audio_sessions()
    indices = resolve_session_indices(snapshots, selector, all_matches=all_matches)
    for idx in indices:
        vol_iface = raw_sessions[idx].SimpleAudioVolume
        if level is not None:
            vol_iface.SetMasterVolume(level, None)
        if mute is not None:
            target_mute = parse_mute_flag(mute)
            final_mute = (not snapshots[idx].muted) if target_mute is None else target_mute
            vol_iface.SetMute(int(final_mute), None)

    _, updated = get_audio_sessions()
    return [updated[idx] for idx in indices]


def print_state(
    master: MasterVolumeSnapshot,
    sessions: list[AudioSessionSnapshot],
    as_json: bool = False,
) -> None:
    """Render master and per-app audio session volumes."""
    if as_json:
        payload = {
            "master": asdict(master),
            "sessions": [asdict(s) for s in sessions],
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    mute_label = "MUDO" if master.muted else "ATIVO"
    print(f"Dispositivo padrão: {master.device_name}")
    print(f"Volume mestre     : {master.volume * 100:5.1f}% ({master.volume:.3f}) [{mute_label}]")
    print("-" * 88)
    print(f"Sessões de áudio ({len(sessions)}):")
    for s in sessions:
        s_mute = "MUDO" if s.muted else "SOM "
        disp = f" | nome={s.display_name!r}" if s.display_name else ""
        print(
            f"  [{s.index}] {s.process_name:22s} pid={s.pid:<6d} "
            f"estado={s.state:8s} vol={s.volume * 100:5.1f}% ({s.volume:.2f}) [{s_mute}]{disp}"
        )
        print(f"       group={s.grouping_param}")
    print("-" * 88)


def interactive_loop() -> None:
    """Interactive prompt for inspecting and adjusting master and app volumes."""
    print("Modo interativo de volume. Comandos:")
    print("  list | master <0..1|%> | master-mute <on|off|toggle>")
    print("  vol <id_ou_app> <0..1|%> | mute <id_ou_app> <on|off|toggle> | quit")
    while True:
        _, master = get_master_snapshot()
        _, sessions = get_audio_sessions()
        print_state(master, sessions)
        try:
            raw = input("volume> ").strip()
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
        try:
            if cmd == "master" and len(parts) == 2:
                updated = set_master_volume(level=parse_volume_level(parts[1]))
                print(f"Volume mestre ajustado para {updated.volume * 100:.1f}%")
            elif cmd == "master-mute" and len(parts) == 2:
                updated = set_master_volume(mute=parts[1])
                print(f"Mudo mestre: {updated.muted}")
            elif cmd == "vol" and len(parts) == 3:
                res = set_session_volume(parts[1], level=parse_volume_level(parts[2]))
                for item in res:
                    print(f"[{item.index}] {item.process_name}: {item.volume * 100:.1f}%")
            elif cmd == "mute" and len(parts) == 3:
                res = set_session_volume(parts[1], mute=parts[2])
                for item in res:
                    print(f"[{item.index}] {item.process_name}: mudo={item.muted}")
            else:
                print("Comando inválido.")
        except Exception as exc:  # noqa: BLE001
            print(f"Erro: {exc}")


def build_parser() -> argparse.ArgumentParser:
    """Build CLI argument parser for the Core Audio volume spike."""
    parser = argparse.ArgumentParser(
        description="Spike Fase 0: listar e alterar volume mestre e por aplicativo no Windows."
    )
    parser.add_argument(
        "--master",
        default=None,
        help="Define o volume mestre (0.0..1.0 ou 0%%..100%%).",
    )
    parser.add_argument(
        "--master-mute",
        default=None,
        help="Define o mudo do volume mestre (on, off ou toggle).",
    )
    parser.add_argument(
        "--session",
        default=None,
        help="Índice da sessão ou trecho do nome do processo/app.",
    )
    parser.add_argument(
        "--volume",
        default=None,
        help="Define o volume da sessão selecionada (0.0..1.0 ou 0%%..100%%).",
    )
    parser.add_argument(
        "--mute",
        default=None,
        help="Define o mudo da sessão selecionada (on, off ou toggle).",
    )
    parser.add_argument(
        "--all-matches",
        action="store_true",
        help="Aplica a alteração a todas as sessões que casarem com --session.",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Abre prompt interativo para testar volumes.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Imprime o estado em formato JSON.",
    )
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args()

    if args.interactive:
        interactive_loop()
        return 0

    try:
        if args.master is not None or args.master_mute is not None:
            level = parse_volume_level(args.master) if args.master is not None else None
            set_master_volume(level=level, mute=args.master_mute)

        if args.session is not None:
            if args.volume is None and args.mute is None:
                raise ValueError("--session exige --volume e/ou --mute.")
            level = parse_volume_level(args.volume) if args.volume is not None else None
            set_session_volume(
                args.session,
                level=level,
                mute=args.mute,
                all_matches=args.all_matches,
            )

        _, master = get_master_snapshot()
        _, sessions = get_audio_sessions()
        print_state(master, sessions, as_json=args.json)
        return 0
    except ValueError as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
