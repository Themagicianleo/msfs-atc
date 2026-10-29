"""Live METAR from the free NOAA Aviation Weather Center data API.

API: https://aviationweather.gov/api/data/metar?ids=XXXX&format=json
No key needed. Results are cached for 10 minutes. When the PC is offline
or the station has no report, callers get ``{"available": False, ...}`` and
the web app falls back to the runway the pilot chose (or the longest one).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Optional

import aiohttp

LOG = logging.getLogger(__name__)

AWC_URL = "https://aviationweather.gov/api/data/metar"
CACHE_S = 600
FAIL_CACHE_S = 60

WIND_RE = re.compile(r"\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)\b")
QNH_RE = re.compile(r"\bQ(\d{4})\b")
ALT_RE = re.compile(r"\bA(\d{4})\b")
MPS_TO_KT = 1.943844


def parse_raw(raw: str) -> dict:
    """Wind and QNH from a raw METAR string."""
    out: dict = {}
    m = WIND_RE.search(raw or "")
    if m:
        factor = {"KT": 1.0, "MPS": MPS_TO_KT, "KMH": 0.539957}[m.group(4)]
        out["wind_dir"] = None if m.group(1) == "VRB" else int(m.group(1))
        out["wind_vrb"] = m.group(1) == "VRB"
        out["wind_kt"] = round(int(m.group(2)) * factor)
        out["gust_kt"] = round(int(m.group(3)) * factor) if m.group(3) else None
    q = QNH_RE.search(raw or "")
    if q:
        out["qnh_hpa"] = int(q.group(1))
    else:
        a = ALT_RE.search(raw or "")
        if a:
            out["altimeter_inhg"] = int(a.group(1)) / 100
            out["qnh_hpa"] = round(out["altimeter_inhg"] * 33.8639)
    return out


def parse_awc(item: dict) -> dict:
    """One element of the AWC JSON array -> our compact form.

    Raw-text parsing wins for wind/QNH because it keeps the station's own
    units (MPS in China/Russia, inHg in the US); JSON fields are a fallback.
    """
    raw = item.get("rawOb") or ""
    out = {"available": True, "icao": item.get("icaoId"), "raw": raw,
           "time": item.get("reportTime") or item.get("obsTime"), "source": "aviationweather.gov"}
    parsed = parse_raw(raw)
    if "wind_kt" not in parsed:
        wdir = item.get("wdir")
        if wdir is not None:
            parsed["wind_vrb"] = wdir == "VRB"
            parsed["wind_dir"] = None if wdir == "VRB" else int(wdir)
            parsed["wind_kt"] = int(item.get("wspd") or 0)
            parsed["gust_kt"] = int(item["wgst"]) if item.get("wgst") else None
    if "qnh_hpa" not in parsed and item.get("altim"):
        alt = float(item["altim"])
        parsed["qnh_hpa"] = round(alt * 33.8639) if alt < 40 else round(alt)
    out.update(parsed)
    return out


class MetarService:
    def __init__(self, offline: bool = False, timeout_s: float = 6.0):
        self.offline = offline
        self.timeout = aiohttp.ClientTimeout(total=timeout_s)
        self.cache: dict[str, tuple[float, dict]] = {}
        self._session: Optional[aiohttp.ClientSession] = None
        self._lock = asyncio.Lock()

    async def close(self) -> None:
        if self._session:
            await self._session.close()

    async def get(self, icao: str) -> dict:
        icao = icao.strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{3,4}", icao):
            return {"available": False, "icao": icao, "error": "invalid station id"}
        if self.offline:
            return {"available": False, "icao": icao, "error": "helper started with --offline"}
        now = time.time()
        hit = self.cache.get(icao)
        if hit and hit[0] > now:
            return hit[1]
        async with self._lock:
            result = await self._fetch(icao)
        ttl = CACHE_S if result.get("available") else FAIL_CACHE_S
        self.cache[icao] = (now + ttl, result)
        return result

    async def _fetch(self, icao: str) -> dict:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                timeout=self.timeout, headers={"User-Agent": "OpenATC/0.1 (personal flight-sim use)"})
        try:
            async with self._session.get(AWC_URL, params={"ids": icao, "format": "json"}) as resp:
                if resp.status == 204:
                    return {"available": False, "icao": icao, "error": "no recent METAR for this station"}
                if resp.status != 200:
                    return {"available": False, "icao": icao, "error": f"weather service HTTP {resp.status}"}
                data = await resp.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            LOG.info("METAR fetch for %s failed: %s", icao, exc)
            return {"available": False, "icao": icao, "error": "weather service unreachable (offline?)"}
        if not data:
            return {"available": False, "icao": icao, "error": "no recent METAR for this station"}
        return parse_awc(data[0])
