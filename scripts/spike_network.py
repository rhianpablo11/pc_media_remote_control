"""mDNS discovery and Windows Firewall diagnostic spike (Phase 0)."""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import time
from dataclasses import asdict, dataclass

import ifaddr
from zeroconf import ServiceBrowser, ServiceInfo, ServiceListener, Zeroconf


@dataclass(frozen=True, slots=True)
class NetworkInterfaceInfo:
    """Active IPv4 interface summary."""

    adapter: str
    ip: str
    network_prefix: int


@dataclass(frozen=True, slots=True)
class MdnsTestResult:
    """Result of publishing and discovering a local _pcmedia._tcp.local. service."""

    service_name: str
    hostname_local: str
    published_ip: str
    port: int
    zeroconf_discovered: bool
    zeroconf_resolved_ips: list[str]
    os_getaddrinfo_ips: list[str]
    os_getaddrinfo_error: str | None


@dataclass(frozen=True, slots=True)
class FirewallStatus:
    """Summary of active Windows network category and firewall rules for Python."""

    active_network_profiles: list[dict[str, str]]
    current_firewall_profile_output: str
    python_executable: str
    python_inbound_rules: list[str]


VIRTUAL_ADAPTER_KEYWORDS = ("hyper-v", "vethernet", "virtualbox", "vmware", "wsl", "loopback")


def get_primary_lan_ip(interfaces: list[NetworkInterfaceInfo]) -> str:
    """Choose the primary physical LAN IPv4 address using default route or adapter heuristic."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 80))
            route_ip = sock.getsockname()[0]
            if not route_ip.startswith("127."):
                return route_ip
    except OSError:
        pass

    for iface in interfaces:
        if not any(kw in iface.adapter.lower() for kw in VIRTUAL_ADAPTER_KEYWORDS):
            return iface.ip
    return interfaces[0].ip if interfaces else "127.0.0.1"


def get_lan_ipv4_addresses() -> list[NetworkInterfaceInfo]:
    """Return non-loopback, non-link-local IPv4 addresses on this machine."""
    results: list[NetworkInterfaceInfo] = []
    for adapter in ifaddr.get_adapters():
        for ip_info in adapter.ips:
            if not isinstance(ip_info.ip, str):
                continue
            addr = ip_info.ip
            if addr.startswith("127.") or addr.startswith("169.254."):
                continue
            results.append(
                NetworkInterfaceInfo(
                    adapter=str(adapter.nice_name),
                    ip=addr,
                    network_prefix=int(ip_info.network_prefix),
                )
            )
    return results


class _CaptureListener(ServiceListener):
    def __init__(self, target_name: str) -> None:
        self.target_name = target_name
        self.found_infos: list[ServiceInfo] = []

    def add_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        if name == self.target_name:
            info = zc.get_service_info(type_, name, timeout=2000)
            if info is not None:
                self.found_infos.append(info)

    def update_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        return None

    def remove_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        return None


def test_mdns_roundtrip(lan_ip: str, port: int = 8765) -> MdnsTestResult:
    """Publish _pcmedia._tcp.local. and verify discovery via zeroconf and OS resolver."""
    host = socket.gethostname()
    hostname_local = f"{host}.local"
    service_type = "_pcmedia._tcp.local."
    service_name = f"pcmedia-spike-{host}.{service_type}"

    info = ServiceInfo(
        service_type,
        service_name,
        addresses=[socket.inet_aton(lan_ip)],
        port=port,
        properties={"v": "1", "spike": "true"},
        server=f"{hostname_local}.",
    )

    zc_pub = Zeroconf()
    zc_sub = Zeroconf()
    listener = _CaptureListener(service_name)
    resolved_ips: list[str] = []
    os_ips: list[str] = []
    os_err: str | None = None

    try:
        zc_pub.register_service(info)
        browser = ServiceBrowser(zc_sub, service_type, listener)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not listener.found_infos:
            time.sleep(0.1)
        browser.cancel()

        for found in listener.found_infos:
            resolved_ips.extend(found.parsed_addresses())

        try:
            addr_infos = socket.getaddrinfo(hostname_local, port, family=socket.AF_INET)
            os_ips = sorted({item[4][0] for item in addr_infos})
        except OSError as exc:
            os_err = f"{type(exc).__name__}: {exc}"
    finally:
        zc_sub.close()
        zc_pub.unregister_service(info)
        zc_pub.close()

    return MdnsTestResult(
        service_name=service_name,
        hostname_local=hostname_local,
        published_ip=lan_ip,
        port=port,
        zeroconf_discovered=bool(listener.found_infos),
        zeroconf_resolved_ips=sorted(set(resolved_ips)),
        os_getaddrinfo_ips=os_ips,
        os_getaddrinfo_error=os_err,
    )


def inspect_windows_firewall() -> FirewallStatus:
    """Inspect active network profile category and Windows Firewall rules for Python."""
    import sys

    ps_cmd = (
        "Get-NetConnectionProfile | "
        "Select-Object Name, NetworkCategory, InterfaceAlias | ConvertTo-Json -Compress"
    )
    ps_res = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_cmd],
        capture_output=True,
        text=True,
        check=False,
    )
    profiles: list[dict[str, str]] = []
    if ps_res.returncode == 0 and ps_res.stdout.strip():
        parsed = json.loads(ps_res.stdout)
        if isinstance(parsed, dict):
            parsed = [parsed]
        for item in parsed:
            profiles.append({k: str(v) for k, v in item.items()})

    netsh_profile = subprocess.run(
        ["netsh", "advfirewall", "show", "currentprofile"],
        capture_output=True,
        text=True,
        check=False,
    )

    rules_res = subprocess.run(
        ["netsh", "advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose"],
        capture_output=True,
        text=True,
        check=False,
    )
    python_rules: list[str] = []
    if rules_res.returncode == 0:
        current_block: list[str] = []
        for line in rules_res.stdout.splitlines():
            if not line.strip():
                block_text = "\n".join(current_block)
                if "python" in block_text.lower():
                    python_rules.append(block_text)
                current_block = []
            else:
                current_block.append(line)
        if current_block:
            block_text = "\n".join(current_block)
            if "python" in block_text.lower():
                python_rules.append(block_text)

    return FirewallStatus(
        active_network_profiles=profiles,
        current_firewall_profile_output=netsh_profile.stdout.strip(),
        python_executable=sys.executable,
        python_inbound_rules=python_rules,
    )


def main() -> int:
    """Run mDNS and Windows Firewall checks."""
    parser = argparse.ArgumentParser(
        description="Spike Fase 0: verificar mDNS local e configuração do Firewall do Windows."
    )
    parser.add_argument("--json", action="store_true", help="Saída em formato JSON.")
    args = parser.parse_args()

    interfaces = get_lan_ipv4_addresses()
    primary_ip = get_primary_lan_ip(interfaces)
    mdns = test_mdns_roundtrip(primary_ip)
    fw = inspect_windows_firewall()

    if args.json:
        print(
            json.dumps(
                {
                    "interfaces": [asdict(i) for i in interfaces],
                    "mdns": asdict(mdns),
                    "firewall": asdict(fw),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return 0

    print("Interfaces IPv4 na rede local:")
    for iface in interfaces:
        print(f"  - {iface.adapter}: {iface.ip}/{iface.network_prefix}")

    print("\nTeste mDNS (_pcmedia._tcp.local.):")
    print(f"  Serviço publicado : {mdns.service_name} -> {mdns.published_ip}:{mdns.port}")
    print(f"  Descoberto via zeroconf : {mdns.zeroconf_discovered} ({mdns.zeroconf_resolved_ips})")
    print(
        f"  Resolução OS ({mdns.hostname_local}): "
        f"{mdns.os_getaddrinfo_ips or mdns.os_getaddrinfo_error}"
    )

    print("\nPerfis de rede ativos:")
    for prof in fw.active_network_profiles:
        print(f"  - {prof}")

    print("\nPerfil atual do Firewall:")
    print(fw.current_firewall_profile_output)

    print(f"\nRegras de entrada para Python ({len(fw.python_inbound_rules)} encontradas):")
    for idx, rule in enumerate(fw.python_inbound_rules, start=1):
        print(f"--- Regra {idx} ---\n{rule}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
