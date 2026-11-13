"""Gerenciamento de inicialização automática no Windows via Registro (HKCU)."""

from __future__ import annotations

import logging
import os
import shutil
import sys
import winreg
from pathlib import Path
from typing import NamedTuple

from host.config import get_app_data_dir, get_base_dir

logger = logging.getLogger(__name__)

REG_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_NAME = "PCMediaControl"


class AutostartStatus(NamedTuple):
    """Representa o estado atual da configuração de autostart no Registro."""

    is_enabled: bool
    is_valid: bool
    command: str
    target_path: Path | None


def parse_executable_from_command(command: str) -> Path | None:
    """Extrai o caminho do executável a partir de uma linha de comando com ou sem aspas."""
    if not command:
        return None
    cmd = command.strip()
    if cmd.startswith('"'):
        end_quote = cmd.find('"', 1)
        if end_quote != -1:
            return Path(cmd[1:end_quote])
    tokens = cmd.split()
    if tokens:
        return Path(tokens[0])
    return None


def install_executable_to_app_data() -> Path:
    """Copia o executável para %LOCALAPPDATA%\\PCMediaControl\\PCMediaControl.exe."""
    target_dir = get_app_data_dir()
    target_exe = target_dir / "PCMediaControl.exe"

    source_exe: Path | None = None
    if getattr(sys, "frozen", False):
        source_exe = Path(sys.executable).resolve()
    else:
        # Em ambiente dev, verifica se o executável foi gerado na pasta dist/
        dev_dist_exe = get_base_dir() / "dist" / "PCMediaControl.exe"
        if dev_dist_exe.is_file():
            source_exe = dev_dist_exe.resolve()

    if source_exe is not None and source_exe.is_file():
        target_dir.mkdir(parents=True, exist_ok=True)
        if source_exe != target_exe.resolve():
            temp_target = target_dir / "PCMediaControl.exe.tmp"
            shutil.copy2(source_exe, temp_target)
            temp_target.replace(target_exe)
            logger.info("Executável copiado para local estável: %s", target_exe)
        return target_exe

    return target_exe


def get_startup_command() -> str:
    """Retorna o comando adequado apontando para o caminho estável em %LOCALAPPDATA%."""
    target_exe = get_app_data_dir() / "PCMediaControl.exe"
    if getattr(sys, "frozen", False) or target_exe.is_file():
        return f'"{target_exe}" --lan --tray'

    # Fallback para ambiente de desenvolvimento sem executável compilado
    exe_dir = os.path.dirname(sys.executable)
    pythonw = os.path.join(exe_dir, "pythonw.exe")
    python_bin = pythonw if os.path.exists(pythonw) else sys.executable
    return f'"{python_bin}" -m host --lan --tray'


def get_autostart_status() -> AutostartStatus:
    """Consulta detalhada do estado de autostart no Registro e checagem de existência do arquivo."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            REG_RUN_KEY,
            0,
            winreg.KEY_READ,
        ) as key:
            value, _ = winreg.QueryValueEx(key, APP_NAME)
            cmd_str = str(value)
            exe_path = parse_executable_from_command(cmd_str)
            is_valid = exe_path is not None and exe_path.is_file()
            return AutostartStatus(
                is_enabled=True,
                is_valid=is_valid,
                command=cmd_str,
                target_path=exe_path,
            )
    except FileNotFoundError:
        return AutostartStatus(is_enabled=False, is_valid=False, command="", target_path=None)
    except OSError as e:
        logger.warning("Falha ao consultar autostart no Registro: %s", e)
        return AutostartStatus(is_enabled=False, is_valid=False, command="", target_path=None)


def is_autostart_enabled() -> bool:
    """Retorna True se o autostart estiver configurado E o arquivo existir em disco."""
    status = get_autostart_status()
    return status.is_enabled and status.is_valid


def set_autostart(enabled: bool) -> bool:
    """Habilita ou desabilita o autostart do PC Media Control no Registro do Windows."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            REG_RUN_KEY,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            if enabled:
                install_executable_to_app_data()
                cmd = get_startup_command()
                winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, cmd)
                logger.info("Autostart habilitado no Registro: %s", cmd)
            else:
                try:
                    winreg.DeleteValue(key, APP_NAME)
                    logger.info("Autostart desabilitado no Registro")
                except FileNotFoundError:
                    pass
        return True
    except OSError as e:
        logger.error("Erro ao configurar autostart no Registro: %s", e)
        return False
