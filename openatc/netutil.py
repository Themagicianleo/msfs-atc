"""Local-network helpers: find the LAN address and refuse everything else."""

from __future__ import annotations

import ipaddress
import socket
from typing import Optional


def is_local_address(addr: Optional[str]) -> bool:
    """True for loopback, RFC 1918 / ULA private and link-local addresses."""
    if not addr:
        return False
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_link_local:
        return True
    if isinstance(ip, ipaddress.IPv4Address):
        return any(ip in net for net in (ipaddress.ip_network("10.0.0.0/8"),
                                         ipaddress.ip_network("172.16.0.0/12"),
                                         ipaddress.ip_network("192.168.0.0/16")))
    return ip in ipaddress.ip_network("fc00::/7")


def guess_lan_ip() -> Optional[str]:
    """The address of the interface that would reach the LAN/default route.

    A UDP "connect" sends no packets; it only asks the OS to pick a route.
    """
    candidates = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1, never routed anywhere real
            candidates.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(info[4][0])
    except OSError:
        pass
    for ip in candidates:
        if is_local_address(ip) and not ipaddress.ip_address(ip).is_loopback:
            return ip
    return None
