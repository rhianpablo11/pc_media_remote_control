"""CLI entrypoint for running the host server, system tray, and doctor diagnostics."""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import socket
import subprocess
import sys
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

from host.app import create_app
from host.config import DEFAULT_EXTENSION_ID, HostSettings, get_logs_dir
from host.network import list_lan_interfaces, resolve_primary_lan_ip
from host.pairing import PairingManager, render_qr_ascii
from host.single_instance import SingleInstanceLock
from host.tray import SystemTrayApp

logger = logging.getLogger("pc_media_control")


def setup_logging(log_level: str = "INFO", console: bool = True) -> Path:
    """Configure rotating file logging in %LOCALAPPDATA%\\PCMediaControl\\logs."""
    logs_dir = get_logs_dir()
    log_file = logs_dir / "pc_media_control.log"
    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=3 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )
    handlers: list[logging.Handler] = [file_handler]

    has_stdout = getattr(sys, "stdout", None) is not None
    if console and has_stdout:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        )
        handlers.append(console_handler)

    level_num = getattr(logging, log_level.upper(), logging.INFO)
    logging.basicConfig(level=level_num, handlers=handlers, force=True)
    return log_file


def run_doctor(port: int = 8765) -> int:
    """Run interactive network, firewall, and AP-isolation diagnostics."""
    print("=" * 64)
    print("        PC Media Control — Diagnóstico de Rede (Doctor)        ")
    print("=" * 64)
    print()

    # 1. Interface and IP selection
    print("[1/5] Adaptadores de rede detectados:")
    interfaces = list_lan_interfaces()
    chosen_ip, _ = resolve_primary_lan_ip(interfaces)

    if not interfaces:
        print("  [AVISO] Nenhum adaptador de rede IPv4 encontrado.")
    else:
        for iface in interfaces:
            v_tag = "[VIRTUAL/VPN]" if iface.is_virtual else "[FÍSICO]"
            p_tag = "Privado" if iface.is_private else "Público"
            chosen_mark = "  <-- IP SELECIONADO" if iface.ip == chosen_ip else ""
            print(f"  - {iface.name}: {iface.ip} {v_tag} ({p_tag}){chosen_mark}")

    print(f"\n  IP principal da LAN: {chosen_ip}")
    print()

    # 2. Windows Network Profile (Public vs Private)
    print("[2/5] Perfil da conexão no Windows (Public vs Private):")
    is_public = False
    try:
        ps_cmd = (
            "Get-NetConnectionProfile | "
            "Select-Object Name, NetworkCategory, InterfaceAlias | "
            "ConvertTo-Json -Compress"
        )
        res = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode == 0 and res.stdout.strip():
            data = json.loads(res.stdout)
            if isinstance(data, dict):
                data = [data]
            for item in data:
                cat = item.get("NetworkCategory")
                cat_name = "Público" if cat == 0 else ("Privado" if cat == 1 else "Domínio")
                if cat == 0:
                    is_public = True
                print(f"  - {item.get('InterfaceAlias')} ({item.get('Name')}): {cat_name}")
        else:
            print("  Não foi possível consultar os perfis de rede via PowerShell.")
    except Exception as exc:  # noqa: BLE001
        print(f"  Erro ao consultar perfil de rede: {exc}")

    if is_public:
        print("  [ALERTA] Uma rede ativa está configurada como Perfil Público!")
        print("           O Firewall do Windows bloqueia conexões de entrada em redes públicas.")
        print("           Mude para rede Privada via Configurações ou comando:")
        print("           Set-NetConnectionProfile -NetworkCategory Private")
    else:
        print("  [OK] Nenhuma rede física ativa detectada como Pública.")
    print()

    # 3. Windows Firewall Rules
    print("[3/5] Regras no Firewall do Windows:")
    has_named_rule = False
    try:
        fw_cmd = (
            "Get-NetFirewallRule -DisplayName '*PC Media Control*' -ErrorAction SilentlyContinue | "
            "Select-Object DisplayName, Enabled, Direction, Action | "
            "ConvertTo-Json -Compress"
        )
        rule_check = subprocess.run(
            ["powershell", "-NoProfile", "-Command", fw_cmd],
            capture_output=True,
            text=True,
            check=False,
        )
        if rule_check.returncode == 0 and rule_check.stdout.strip():
            rules_data = json.loads(rule_check.stdout)
            if isinstance(rules_data, dict):
                rules_data = [rules_data]
            for r in rules_data:
                name = r.get("DisplayName")
                enabled = r.get("Enabled")
                has_named_rule = True
                print(f"  [OK] Regra nominal encontrada: {name} (Habilitada: {enabled})")
        else:
            print("  [INFO] Nenhuma regra nominal 'PC Media Control' encontrada no Firewall.")
            print("         (O acesso na LAN ainda pode estar liberado via regra para python.exe,")
            print("          porta genérica ou política permissiva da sub-rede local).")
            print("         Para registrar regra dedicada: execute .\\scripts\\allow_firewall.cmd")
    except Exception as exc:  # noqa: BLE001
        print(f"  Erro ao inspecionar firewall via PowerShell: {exc}")
    print()

    # 4. Port Listening & LAN TCP Connectivity Check
    print(f"[4/5] Conectividade TCP na porta {port} (Localhost e IP da LAN):")
    loopback_ok = False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.8)
        loopback_ok = sock.connect_ex(("127.0.0.1", port)) == 0

    lan_ok = False
    if chosen_ip and chosen_ip != "127.0.0.1":
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1.2)
            lan_ok = sock.connect_ex((chosen_ip, port)) == 0

    if lan_ok:
        print(f"  [OK] A porta {port} está ABERTA e ACESSÍVEL via IP da LAN ({chosen_ip}:{port})!")
        print("       O host está respondendo na rede; conexões do celular devem funcionar.")
        if not has_named_rule:
            print("       (Conexão confirmada mesmo sem regra nominal 'PC Media Control').")
    elif loopback_ok:
        print(f"  [AVISO] A porta {port} está aberta em 127.0.0.1, mas INACESSÍVEL na LAN:")
        print(f"          {chosen_ip}:{port} não respondeu.")
        print("          Possíveis causas:")
        print("          1. O host foi iniciado sem suporte à LAN.")
        print("             Execute: .\\.venv\\Scripts\\python.exe -m host")
        print("          2. O Firewall do Windows está bloqueando conexões externas.")
        print("             Execute como Administrador: .\\scripts\\allow_firewall.cmd")
    else:
        print(f"  A porta {port} está livre (o host não está rodando no momento).")
        print("  Para iniciar na LAN: .\\.venv\\Scripts\\python.exe -m host")
    print()

    # 5. AP Isolation & Hotspot Guidance
    print("[5/5] Isolamento de clientes (AP Isolation) & Plano B:")
    print("  - Algumas redes Wi-Fi ativam 'AP Isolation', o que bloqueia o acesso local.")
    print("  - Teste: tente abrir http://<ip_do_pc>:8765 no navegador do celular.")
    print("    Se a página não carregar com o firewall liberado, a rede possui AP Isolation.")
    print("  - Plano B (Hotspot): ative o 'Hotspot Móvel' do Windows ou do celular,")
    print("    conecte ambos na mesma rede do hotspot e inicie o host normalmente.")
    print("=" * 64)
    return 0


def main() -> int:
    """Start the FastAPI host strictly bound or on LAN with pairing and system tray."""
    parser = argparse.ArgumentParser(description="PC Media Control Host")
    subparsers = parser.add_subparsers(dest="subcommand")

    # doctor subcommand
    doctor_parser = subparsers.add_parser(
        "doctor", help="Executa diagnóstico de rede, firewall e pareamento"
    )
    doctor_parser.add_argument(
        "--port", type=int, default=8765, help="Porta a testar (padrão: 8765)"
    )

    # main server flags
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
    parser.add_argument(
        "--lan",
        action="store_true",
        default=True,
        help="Habilita modo LAN com pareamento obrigatório (padrão: ativado)",
    )
    parser.add_argument(
        "--local-only",
        action="store_true",
        help="Executa estritamente em 127.0.0.1 (desativa acesso via LAN)",
    )
    parser.add_argument(
        "--ip",
        default=None,
        help="Sobrescreve o IP da LAN informado no QR code e pareamento",
    )
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Modo dev: autoriza origens do Vite (http://localhost:5173) no /ws",
    )
    parser.add_argument(
        "--allow-ws-origin",
        action="append",
        default=[],
        help="Origem extra autorizada no /ws (pode repetir)",
    )
    parser.add_argument(
        "--no-tray",
        action="store_true",
        help="Não exibe o ícone na bandeja do sistema",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Executa sem saída para console padrão (modo background)",
    )
    args = parser.parse_args()

    # Configure rotating file logging
    log_file = setup_logging(console=not args.headless)

    if args.subcommand == "doctor":
        return run_doctor(port=args.port)

    logger.info("PC Media Control iniciando. Arquivo de log: %s", log_file)

    # Single-instance lock
    lock = SingleInstanceLock()
    if not lock.acquire():
        logger.warning("Instância existente detectada. Abrindo página de pareamento...")
        with contextlib.suppress(Exception):
            webbrowser.open(f"http://127.0.0.1:{args.port}/pair")
        return 0

    lan_mode = not args.local_only
    bind_host = "0.0.0.0" if lan_mode else "127.0.0.1"
    lan_ip: str | None = None
    pairing_mgr = PairingManager()

    if lan_mode:
        interfaces = list_lan_interfaces()
        lan_ip, candidates = resolve_primary_lan_ip(interfaces=interfaces, override_ip=args.ip)

        physical_candidates = [c for c in candidates if not c.is_virtual]
        if len(physical_candidates) > 1 and not args.headless:
            print("\n[Aviso] Múltiplos adaptadores de rede físicos encontrados:")
            for cand in physical_candidates:
                marker = " (ativo no QR)" if cand.ip == lan_ip else ""
                print(f"  - {cand.name}: {cand.ip}{marker}")

        session = pairing_mgr.get_or_create_pairing_session()
        pairing_url = f"http://{lan_ip}:{args.port}/?pair={session.code}"

        if not args.headless:
            print("\n" + "=" * 58)
            print("          PC MEDIA CONTROL — MODO LAN ATIVADO             ")
            print("=" * 58)
            print(f"IP da LAN:  {lan_ip}")
            print(f"Porta:      {args.port}")
            print(f"URL:        {pairing_url}")
            print(f"PIN (6 dig): {session.pin[:3]} {session.pin[3:]}  (expira em 5 min)")
            print(f"Pareamento: http://127.0.0.1:{args.port}/pair (apenas no PC)")
            print("-" * 58)
            print("Escaneie o QR Code abaixo com a câmera do celular:")
            with contextlib.suppress(Exception):
                print(render_qr_ascii(pairing_url))
            print("=" * 58 + "\n")
    else:
        if not args.headless:
            print(f"\nPC Media Control Host rodando em modo local: http://127.0.0.1:{args.port}\n")

    settings = HostSettings(
        host=bind_host,
        port=args.port,
        poll_interval_sec=args.poll_interval,
        extension_id=args.extension_id,
        dev_mode=args.dev,
        extra_ws_origins=tuple(args.allow_ws_origin),
        lan_mode=lan_mode,
        lan_ip=lan_ip,
        pairing_manager=pairing_mgr,
    )

    app = create_app(settings=settings, pairing_manager=pairing_mgr)

    server = uvicorn.Server(
        config=uvicorn.Config(
            app=app,
            host=settings.host,
            port=settings.port,
            log_level="info" if not args.headless else "warning",
        )
    )

    tray_app: SystemTrayApp | None = None
    if not args.no_tray:
        tray_app = SystemTrayApp(
            settings=settings,
            pairing_manager=pairing_mgr,
            on_exit=lambda: setattr(server, "should_exit", True),
        )
        tray_app.start()

    try:
        server.run()
    finally:
        if tray_app is not None:
            tray_app.stop()
        lock.release()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
