"""Gerenciamento de inicialização automática no Windows via Registro (HKCU)."""

from __future__ import annotations

import logging
import os
import sys
import winreg

logger = logging.getLogger(__name__)

REG_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_NAME = "PCMediaControl"


def get_startup_command() -> str:
    """Retorna o comando adequado para iniciar o PC Media Control em segundo plano."""
    if getattr(sys, "frozen", False):
        # Executável compilado via PyInstaller
        exe_path = os.path.abspath(sys.executable)
        return f'"{exe_path}" --lan --tray'

    # Ambiente Python convencional
    exe_dir = os.path.dirname(sys.executable)
    pythonw = os.path.join(exe_dir, "pythonw.exe")
    python_bin = pythonw if os.path.exists(pythonw) else sys.executable

    return f'"{python_bin}" -m host --lan --tray'


def is_autostart_enabled() -> bool:
    """Verifica se o autostart do PC Media Control está habilitado no Registro."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            REG_RUN_KEY,
            0,
            winreg.KEY_READ,
        ) as key:
            value, _ = winreg.QueryValueEx(key, APP_NAME)
            return bool(value)
    except FileNotFoundError:
        return False
    except OSError as e:
        logger.warning("Falha ao consultar autostart no Registro: %s", e)
        return False


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
