"""A private certificate authority for HTTPS on the home network.

``ensure_certificates`` creates, once, a CA (installed and trusted on the
iPad by the user) and then a server certificate for the PC's LAN address,
signed by that CA. The server certificate is re-issued automatically when the
LAN address changes or it nears expiry; the CA stays, so the iPad never needs
the CA again unless ``userdata/certs`` is deleted.

Apple requirements for TLS server certificates trusted through a
user-installed CA (Apple support article HT210176): RSA >= 2048 bits,
SHA-2 signature, DNS/IP names in Subject Alternative Name, Extended Key Usage
serverAuth, validity <= 825 days. We use 397 days to stay inside the stricter
398-day limit as well.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import ipaddress
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

SERVER_DAYS = 397
CA_DAYS = 3650
RENEW_BEFORE_DAYS = 30


@dataclass
class CertPaths:
    ca_cert: Path
    ca_key: Path
    ca_der: Path
    server_cert: Path
    server_key: Path


def paths(cert_dir: Path) -> CertPaths:
    return CertPaths(cert_dir / "openatc-ca.pem", cert_dir / "openatc-ca.key", cert_dir / "openatc-ca.cer",
                     cert_dir / "server.pem", cert_dir / "server.key")


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _write_key(path: Path, key) -> None:
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def fingerprint(cert: x509.Certificate) -> str:
    digest = cert.fingerprint(hashes.SHA256()).hex().upper()
    return " ".join(digest[i:i + 2] for i in range(0, len(digest), 2))


def _make_ca(p: CertPaths):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"OpenATC Local CA ({socket.gethostname()[:30]})"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "OpenATC (personal, local only)")])
    ski = x509.SubjectKeyIdentifier.from_public_key(key.public_key())
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(_now() - dt.timedelta(minutes=5))
            .not_valid_after(_now() + dt.timedelta(days=CA_DAYS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                         crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(ski, critical=False)
            .sign(key, hashes.SHA256()))
    _write_key(p.ca_key, key)
    p.ca_cert.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    p.ca_der.write_bytes(cert.public_bytes(serialization.Encoding.DER))
    return cert, key


def _san_names(ips: Iterable[str], dns: Iterable[str]):
    names = []
    for ip in ips:
        names.append(x509.IPAddress(ipaddress.ip_address(ip)))
    for d in dns:
        names.append(x509.DNSName(d))
    return names


def _server_ok(cert: x509.Certificate, ca: x509.Certificate, ips: list[str], dns: list[str]) -> bool:
    if cert.issuer != ca.subject:
        return False
    try:
        cert.verify_directly_issued_by(ca)
    except Exception:
        return False
    if cert.not_valid_after_utc - _now() < dt.timedelta(days=RENEW_BEFORE_DAYS):
        return False
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return False
    have_ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
    have_dns = set(san.get_values_for_type(x509.DNSName))
    return set(ips) <= have_ips and set(dns) <= have_dns


def _make_server(p: CertPaths, ca_cert, ca_key, ips: list[str], dns: list[str]):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cn = ips[0] if ips else (dns[0] if dns else "openatc")
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
            .issuer_name(ca_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(_now() - dt.timedelta(minutes=5))
            .not_valid_after(_now() + dt.timedelta(days=SERVER_DAYS))
            .add_extension(x509.SubjectAlternativeName(_san_names(ips, dns)), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    _write_key(p.server_key, key)
    # full chain: server first, then CA
    p.server_cert.write_bytes(cert.public_bytes(serialization.Encoding.PEM)
                              + ca_cert.public_bytes(serialization.Encoding.PEM))
    return cert


def ensure_certificates(cert_dir: Path, ips: list[str], dns: list[str]) -> tuple[CertPaths, x509.Certificate, bool]:
    """Returns (paths, ca_cert, server_was_reissued)."""
    cert_dir.mkdir(parents=True, exist_ok=True)
    p = paths(cert_dir)
    if p.ca_cert.exists() and p.ca_key.exists():
        ca_cert = x509.load_pem_x509_certificate(p.ca_cert.read_bytes())
        ca_key = serialization.load_pem_private_key(p.ca_key.read_bytes(), password=None)
        if not p.ca_der.exists():
            p.ca_der.write_bytes(ca_cert.public_bytes(serialization.Encoding.DER))
    else:
        ca_cert, ca_key = _make_ca(p)
    reissued = False
    ok = False
    if p.server_cert.exists() and p.server_key.exists():
        try:
            server = x509.load_pem_x509_certificates(p.server_cert.read_bytes())[0]
            ok = _server_ok(server, ca_cert, ips, dns)
        except ValueError:
            ok = False
    if not ok:
        _make_server(p, ca_cert, ca_key, ips, dns)
        reissued = True
    return p, ca_cert, reissued


def ca_fingerprint_sha256(ca_cert: x509.Certificate) -> str:
    return fingerprint(ca_cert)


def sha1_fingerprint(ca_cert: x509.Certificate) -> str:
    digest = hashlib.sha1(ca_cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper()
    return " ".join(digest[i:i + 2] for i in range(0, len(digest), 2))
