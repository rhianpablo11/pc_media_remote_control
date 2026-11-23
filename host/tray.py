"""Ícone da bandeja do sistema (System Tray) para o PC Media Control no Windows."""

from __future__ import annotations

import logging
import os
import webbrowser
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from PIL import Image, ImageDraw

from host.autostart import get_autostart_status, set_autostart
from host.config import get_base_dir, get_logs_dir, open_extension_folder_for_install

if TYPE_CHECKING:
    from host.config import HostSettings
    from host.pairing import PairingManager

logger = logging.getLogger(__name__)


def create_fallback_icon_image(size: int = 64) -> Image.Image:
    """Gera uma imagem de ícone em memória caso assets/icon.png não esteja presente."""
    img = Image.new("RGBA", (size, size), (15, 23, 42, 255))
    draw = ImageDraw.Draw(img)
    margin = size // 4
    points = [
        (margin, margin),
        (margin, size - margin),
        (size - margin, size // 2),
    ]
    draw.polygon(points, fill=(56, 189, 248, 255))
    return img


def load_tray_icon_image() -> Image.Image:
    """Carrega o ícone oficial da pasta assets ou usa o gerador em memória."""
    assets_dir = get_base_dir() / "assets"
    png_path = assets_dir / "icon.png"
    ico_path = assets_dir / "icon.ico"

    for candidate in (png_path, ico_path):
        if candidate.is_file():
            try:
                return Image.open(candidate)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Falha ao abrir ícone %s: %s", candidate, exc)

    return create_fallback_icon_image()


class SystemTrayApp:
    """Controlador do ícone de bandeja utilizando pystray."""

    def __init__(
        self,
        settings: HostSettings,
        pairing_manager: PairingManager | None = None,
        on_exit: Callable[[], Any] | None = None,
        get_remote_input_enabled: Callable[[], bool] | None = None,
        on_toggle_remote_input: Callable[[bool], Any] | None = None,
        get_tailscale_enabled: Callable[[], bool] | None = None,
        on_toggle_tailscale: Callable[[bool], Any] | None = None,
    ) -> None:
        self.settings = settings
        self.pairing_manager = pairing_manager
        self.on_exit_callback = on_exit
        self._get_remote_input_enabled = get_remote_input_enabled
        self._on_toggle_remote_input = on_toggle_remote_input
        self._get_tailscale_enabled = get_tailscale_enabled
        self._on_toggle_tailscale = on_toggle_tailscale
        self._icon: Any = None

    def _open_url(self, path: str = "/") -> None:
        url = f"http://127.0.0.1:{self.settings.port}{path}"
        try:
            webbrowser.open(url)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Erro ao abrir navegador para %s: %s", url, exc)

    def _open_logs(self) -> None:
        logs_dir = get_logs_dir()
        try:
            os.startfile(logs_dir)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Erro ao abrir pasta de logs: %s", exc)

    def _open_extension_dir(self) -> None:
        """Sincroniza, destaca a pasta no Explorer (arrastar e soltar) e abre o guia no Chrome."""
        try:
            open_extension_folder_for_install()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Erro ao abrir pasta da extensão: %s", exc)
        self._open_url("/pair#extensao")

    def _get_autostart_label(self) -> str:
        status = get_autostart_status()
        if status.is_enabled and not status.is_valid:
            return "Iniciar com o Windows (arquivo não encontrado)"
        return "Iniciar com o Windows"

    def _toggle_autostart(self, _icon: Any, _item: Any) -> None:
        status = get_autostart_status()
        set_autostart(not status.is_enabled)

    def _is_remote_input_enabled(self) -> bool:
        if self._get_remote_input_enabled is None:
            return False
        try:
            return bool(self._get_remote_input_enabled())
        except Exception:  # noqa: BLE001
            return False

    def _toggle_remote_input(self, _icon: Any, _item: Any) -> None:
        if self._on_toggle_remote_input is None:
            return
        try:
            self._on_toggle_remote_input(not self._is_remote_input_enabled())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Erro ao alternar mouse/teclado remoto na bandeja: %s", exc)

    def _is_tailscale_enabled(self) -> bool:
        if self._get_tailscale_enabled is None:
            return False
        try:
            return bool(self._get_tailscale_enabled())
        except Exception:  # noqa: BLE001
            return False

    def _toggle_tailscale(self, _icon: Any, _item: Any) -> None:
        if self._on_toggle_tailscale is None:
            return
        try:
            self._on_toggle_tailscale(not self._is_tailscale_enabled())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Erro ao alternar acesso remoto Tailscale na bandeja: %s", exc)

    def _on_exit_clicked(self, _icon: Any, _item: Any) -> None:
        logger.info("Encerramento solicitado pelo menu da bandeja.")
        if self._icon is not None:
            self._icon.stop()
        if self.on_exit_callback is not None:
            try:
                self.on_exit_callback()
            except Exception as exc:  # noqa: BLE001
                logger.error("Erro ao executar callback de encerramento: %s", exc)

    def _get_devices_submenu(self) -> Any:
        import pystray

        items = []
        if self.pairing_manager is not None:
            devices = self.pairing_manager.list_devices()
            if devices:
                for dev in devices:
                    dev_name = dev.get("name", "Dispositivo")
                    dev_date = dev.get("createdAt", "")[:10]
                    label = f"📱 {dev_name} ({dev_date})"
                    items.append(pystray.MenuItem(label, lambda _i, _m: self._open_url("/pair")))
            else:
                items.append(
                    pystray.MenuItem("Nenhum aparelho pareado", lambda _i, _m: None, enabled=False)
                )
        else:
            items.append(
                pystray.MenuItem(
                    "Sem gerenciador de pareamento",
                    lambda _i, _m: None,
                    enabled=False,
                )
            )

        items.append(pystray.Menu.SEPARATOR)
        items.append(
            pystray.MenuItem("Gerenciar / Parear...", lambda _i, _m: self._open_url("/pair"))
        )
        return pystray.Menu(*items)

    def _build_menu(self) -> Any:
        import pystray

        lan_ip = self.settings.lan_ip
        port = self.settings.port
        if self.settings.lan_mode and lan_ip:
            status_text = f"Status: Ativo na LAN ({lan_ip}:{port})"
        else:
            status_text = f"Status: Ativo (Localhost:{port})"

        menu = pystray.Menu(
            pystray.MenuItem(status_text, lambda _i, _m: self._open_url("/")),
            pystray.MenuItem(
                "📱 Parear Celular (QR Code)...",
                lambda _i, _m: self._open_url("/pair"),
            ),
            pystray.MenuItem("🎵 Abrir Central de Mídia", lambda _i, _m: self._open_url("/")),
            pystray.MenuItem("🔒 Dispositivos Pareados", self._get_devices_submenu()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "🖱️ Mouse e Teclado Remoto",
                self._toggle_remote_input,
                checked=lambda _item: self._is_remote_input_enabled(),
                enabled=self._on_toggle_remote_input is not None,
            ),
            pystray.MenuItem(
                "🌐 Acesso Remoto (Tailscale)",
                self._toggle_tailscale,
                checked=lambda _item: self._is_tailscale_enabled(),
                enabled=self._on_toggle_tailscale is not None,
            ),
            pystray.MenuItem(
                self._get_autostart_label(),
                self._toggle_autostart,
                checked=lambda _item: get_autostart_status().is_enabled,
            ),
            pystray.MenuItem(
                "🧩 Abrir pasta da extensão...",
                lambda _i, _m: self._open_extension_dir(),
            ),
            pystray.MenuItem("📂 Abrir pasta de logs", lambda _i, _m: self._open_logs()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Sair", self._on_exit_clicked),
        )
        return menu

    def start(self) -> bool:
        """Inicia o ícone da bandeja em segundo plano (thread separada)."""
        try:
            import pystray

            image = load_tray_icon_image()
            menu = self._build_menu()

            self._icon = pystray.Icon(
                name="PCMediaControl",
                icon=image,
                title="PC Media Control",
                menu=menu,
            )
            self._icon.run_detached()
            logger.info("Ícone na bandeja do sistema iniciado com sucesso.")
            return True
        except Exception:  # noqa: BLE001
            logger.exception("Falha ao iniciar o ícone na bandeja do sistema")
            return False

    def stop(self) -> None:
        """Encerra e remove o ícone da bandeja do sistema."""
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:  # noqa: BLE001
                pass
            finally:
                self._icon = None
                logger.info("Ícone da bandeja do sistema encerrado.")
