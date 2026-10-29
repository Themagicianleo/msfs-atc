"""Pairing code -> device token.

The helper shows a 6-digit pairing code in its console. The iPad sends it
once to ``/api/pair`` and receives a random token, which it keeps and sends
with every request. Only token hashes are stored on disk. Failed attempts are
rate limited so the code can't be guessed by another device on the network.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Optional


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class PairingStore:
    MAX_FAILURES = 5
    WINDOW_S = 600

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.failures: list[float] = []
        data = {}
        if path.exists():
            try:
                data = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                data = {}
        self.code: str = data.get("pairing_code") or self._new_code()
        self.devices: dict = data.get("devices", {})
        self._save()

    @staticmethod
    def _new_code() -> str:
        return f"{secrets.randbelow(1_000_000):06d}"

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"pairing_code": self.code, "devices": self.devices}, indent=2), "utf-8")
        tmp.replace(self.path)

    def locked_out(self, now: Optional[float] = None) -> bool:
        now = now or time.time()
        self.failures = [t for t in self.failures if now - t < self.WINDOW_S]
        return len(self.failures) >= self.MAX_FAILURES

    def pair(self, code: str, device: str = "iPad", now: Optional[float] = None) -> Optional[str]:
        """Return a new token, or None for a wrong code / during lockout."""
        with self.lock:
            now = now or time.time()
            if self.locked_out(now):
                return None
            if not hmac.compare_digest(str(code).strip(), self.code):
                self.failures.append(now)
                return None
            token = secrets.token_urlsafe(32)
            self.devices[_hash(token)] = {"name": str(device)[:40], "paired": int(now)}
            self._save()
            return token

    def verify(self, token: Optional[str]) -> bool:
        if not token:
            return False
        return _hash(token) in self.devices

    def reset(self) -> None:
        """New pairing code and forget every paired device."""
        with self.lock:
            self.code = self._new_code()
            self.devices = {}
            self.failures = []
            self._save()
