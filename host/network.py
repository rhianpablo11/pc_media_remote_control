"""Network adapter filtering, LAN IP resolution, and mDNS service publication."""

from __future__ import annotations

import logging
import re
import socket
from dataclasses import dataclass
from typing import Any

import ifaddr

logger = logging.getLogger(__name__)

VIRTUAL_ADAPTER_KEYWORDS = (
    "hyper-v",
    "vethernet",
    "virtualbox",
    "vmware",
    "wsl",
    "loopback",
    "docker",
    "tailscale",
    "zerotier",
    "wireguard",
    "bluetooth",
    "teredo",
    "isatap",
)

MDNS_SERVICE_TYPE = "_pcmedia._tcp.local."


@dataclass(frozen=True, slots=True)
class LanInterface:
    """Discovered IPv4 network interface on the local machine."""

    name: str
    ip: str
    prefix: int = 24
    is_virtual: bool = False
    is_private: bool = True


def is_private_ipv4(ip: str) -> bool:
    """Return True if ip is in RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)."""
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(p) for p in parts]
    except ValueError:
        return False

    # 10.0.0.0 - 10.255.255.255
    if octets[0] == 10:
        return True
    # 172.16.0.0 - 172.31.255.255
    if octets[0] == 172 and 16 <= octets[1] <= 31:
        return True
    # 192.168.0.0 - 192.168.255.255
    return bool(octets[0] == 192 and octets[1] == 168)


def is_virtual_adapter_name(adapter_name: str) -> bool:
    """Return True if adapter name matches virtual/container/VPN keywords."""
    low = adapter_name.lower()
    return any(kw in low for kw in VIRTUAL_ADAPTER_KEYWORDS)


def list_lan_interfaces() -> list[LanInterface]:
    """Inspect all machine adapters and classify physical vs virtual IPv4 interfaces."""
    interfaces: list[LanInterface] = []
    for adapter in ifaddr.get_adapters():
        name = str(adapter.nice_name or adapter.name or "")
        is_virt = is_virtual_adapter_name(name)
        for ip_info in adapter.ips:
            if not isinstance(ip_info.ip, str):
                continue
            ip = ip_info.ip
            if ip.startswith("127.") or ip.startswith("169.254."):
                continue
            is_priv = is_private_ipv4(ip)
            interfaces.append(
                LanInterface(
                    name=name,
                    ip=ip,
                    prefix=int(ip_info.network_prefix),
                    is_virtual=is_virt,
                    is_private=is_priv,
                )
            )
    return interfaces


def resolve_primary_lan_ip(
    interfaces: list[LanInterface] | None = None,
    override_ip: str | None = None,
) -> tuple[str, list[LanInterface]]:
    """Select the primary physical LAN IP, returning (chosen_ip, all_candidates).

    1. If override_ip is specified, use it.
    2. Query OS default route via dummy UDP socket connection.
    3. Filter out virtual adapters and prefer private IPs.
    4. Fall back to 127.0.0.1 if no physical interface is active.
    """
    candidates = interfaces if interfaces is not None else list_lan_interfaces()

    if override_ip:
        clean_override = override_ip.strip()
        if clean_override:
            return clean_override, candidates

    # Query routing table for outbound default gateway interface
    route_ip: str | None = None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 80))
            candidate_route = sock.getsockname()[0]
            is_loop = candidate_route.startswith("127.")
            is_link_local = candidate_route.startswith("169.254.")
            if not is_loop and not is_link_local:
                route_ip = candidate_route
    except OSError:
        pass

    # If route_ip belongs to a physical private interface, prefer it
    if route_ip:
        matched = [c for c in candidates if c.ip == route_ip]
        if matched and not matched[0].is_virtual and matched[0].is_private:
            return route_ip, candidates

    # Prefer non-virtual private adapters (Wi-Fi / Ethernet)
    physical_private = [c for c in candidates if not c.is_virtual and c.is_private]
    if physical_private:
        return physical_private[0].ip, candidates

    # Next prefer any non-virtual adapter
    physical_any = [c for c in candidates if not c.is_virtual]
    if physical_any:
        return physical_any[0].ip, candidates

    # Fall back to route_ip or first candidate or loopback
    if route_ip:
        return route_ip, candidates
    if candidates:
        return candidates[0].ip, candidates
    return "127.0.0.1", candidates


class MdnsPublisher:
    """Publishes _pcmedia._tcp.local. service via zeroconf."""

    def __init__(self, lan_ip: str, port: int, hostname: str | None = None) -> None:
        self.lan_ip = lan_ip
        self.port = port
        raw_host = hostname or socket.gethostname()
        # Clean hostname for mDNS
        clean_host = re.sub(r"[^a-zA-Z0-9\-]", "-", raw_host).strip("-") or "pcmedia"
        self.server_name = f"{clean_host}.local."
        self.service_name = f"PC Media Control ({clean_host}).{MDNS_SERVICE_TYPE}"
        self._zeroconf: Any = None
        self._service_info: Any = None

    def start(self) -> bool:
        """Register mDNS service with zeroconf."""
        try:
            from zeroconf import IPVersion, ServiceInfo, Zeroconf

            packed_ip = socket.inet_aton(self.lan_ip)
            self._service_info = ServiceInfo(
                type_=MDNS_SERVICE_TYPE,
                name=self.service_name,
                addresses=[packed_ip],
                port=self.port,
                properties={
                    b"v": b"1",
                    b"host": self.lan_ip.encode("utf-8"),
                    b"port": str(self.port).encode("utf-8"),
                },
                server=self.server_name,
            )
            self._zeroconf = Zeroconf(ip_version=IPVersion.V4Only)
            self._zeroconf.register_service(self._service_info)
            logger.info("mDNS publicado: %s -> %s:%d", self.service_name, self.lan_ip, self.port)
            return True
        except Exception:  # noqa: BLE001
            logger.exception("Falha ao publicar mDNS")
            return False

    def stop(self) -> None:
        """Unregister mDNS service cleanly."""
        if self._zeroconf is not None and self._service_info is not None:
            try:
                self._zeroconf.unregister_service(self._service_info)
                self._zeroconf.close()
            except Exception:  # noqa: BLE001
                pass
            finally:
                self._zeroconf = None
                self._service_info = None
