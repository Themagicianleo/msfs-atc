"""Airport, runway and frequency data from OurAirports plus manual entries.

OurAirports (https://ourairports.com/data/) publishes public-domain CSV files.
``import_ourairports`` downloads (or reads) them once and stores a compact
SQLite database in the data folder. Manual entries in
``airports_manual.json`` are merged on top and win over OurAirports.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import math
import sqlite3
import urllib.request
from pathlib import Path
from typing import Iterable, Optional

LOG = logging.getLogger(__name__)

OURAIRPORTS_BASE = "https://davidmegginson.github.io/ourairports-data/"
FILES = ("airports.csv", "runways.csv", "airport-frequencies.csv")

# OurAirports frequency "type" values vary a lot; map them to our roles.
FREQ_ROLES = {
    "DEL": "DEL", "CLD": "DEL", "CLNC": "DEL", "CLR": "DEL", "CD": "DEL", "DELIVERY": "DEL",
    "GND": "GND", "GRD": "GND", "GROUND": "GND", "GRND": "GND",
    "TWR": "TWR", "TOWER": "TWR", "AFIS": "TWR", "CTAF": "TWR", "UNIC": "TWR", "UNICOM": "TWR",
    "APP": "APP", "ARR": "APP", "APPR": "APP", "APPROACH": "APP", "A/D": "APP", "A/G": "TWR",
    "DEP": "DEP", "DEPARTURE": "DEP",
    "ATIS": "ATIS", "D-ATIS": "ATIS",
    "CTR": "CTR", "CNTR": "CTR", "ACC": "CTR", "CENTER": "CTR", "CENTRE": "CTR",
    "RDR": "APP", "RADAR": "APP", "TMA": "APP",
}

SCHEMA = """
CREATE TABLE airports(ident TEXT PRIMARY KEY, icao TEXT, gps TEXT, iata TEXT, type TEXT, name TEXT,
  municipality TEXT, country TEXT, lat REAL, lon REAL, elevation_ft REAL);
CREATE INDEX airports_icao ON airports(icao);
CREATE INDEX airports_gps ON airports(gps);
CREATE TABLE runways(airport TEXT, length_ft REAL, width_ft REAL, surface TEXT, closed INTEGER,
  le_ident TEXT, le_lat REAL, le_lon REAL, le_elev REAL, le_hdg REAL, le_disp REAL,
  he_ident TEXT, he_lat REAL, he_lon REAL, he_elev REAL, he_hdg REAL, he_disp REAL);
CREATE INDEX runways_airport ON runways(airport);
CREATE TABLE freqs(airport TEXT, type TEXT, description TEXT, mhz REAL);
CREATE INDEX freqs_airport ON freqs(airport);
"""


def _f(value) -> Optional[float]:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def _download(name: str, timeout: float = 60) -> str:
    req = urllib.request.Request(OURAIRPORTS_BASE + name, headers={"User-Agent": "OpenATC/0.1 (personal sim use)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def import_ourairports(db_path: Path, source_dir: Optional[Path] = None) -> dict:
    """Build the SQLite database. Reads CSVs from ``source_dir`` if given,
    otherwise downloads them. Returns row counts."""
    texts = {}
    for name in FILES:
        if source_dir:
            texts[name] = (source_dir / name).read_text("utf-8", errors="replace")
        else:
            LOG.info("downloading %s ...", name)
            texts[name] = _download(name)
    tmp = db_path.with_suffix(".building")
    if tmp.exists():
        tmp.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    counts = {"airports": 0, "runways": 0, "freqs": 0}
    for row in csv.DictReader(io.StringIO(texts["airports.csv"])):
        if row.get("type") == "closed":
            continue
        con.execute("INSERT OR REPLACE INTO airports VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
            row["ident"].upper(), (row.get("icao_code") or "").upper() or None,
            (row.get("gps_code") or "").upper() or None, row.get("iata_code") or None, row.get("type"),
            row.get("name"), row.get("municipality"), row.get("iso_country"),
            _f(row.get("latitude_deg")), _f(row.get("longitude_deg")), _f(row.get("elevation_ft"))))
        counts["airports"] += 1
    for row in csv.DictReader(io.StringIO(texts["runways.csv"])):
        con.execute("INSERT INTO runways VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            row["airport_ident"].upper(), _f(row.get("length_ft")), _f(row.get("width_ft")), row.get("surface"),
            1 if row.get("closed") == "1" else 0,
            row.get("le_ident"), _f(row.get("le_latitude_deg")), _f(row.get("le_longitude_deg")),
            _f(row.get("le_elevation_ft")), _f(row.get("le_heading_degT")), _f(row.get("le_displaced_threshold_ft")),
            row.get("he_ident"), _f(row.get("he_latitude_deg")), _f(row.get("he_longitude_deg")),
            _f(row.get("he_elevation_ft")), _f(row.get("he_heading_degT")), _f(row.get("he_displaced_threshold_ft"))))
        counts["runways"] += 1
    for row in csv.DictReader(io.StringIO(texts["airport-frequencies.csv"])):
        mhz = _f(row.get("frequency_mhz"))
        if mhz is None:
            continue
        con.execute("INSERT INTO freqs VALUES(?,?,?,?)", (
            row["airport_ident"].upper(), (row.get("type") or "").upper(), row.get("description"), mhz))
        counts["freqs"] += 1
    con.commit()
    con.close()
    tmp.replace(db_path)
    return counts


def _ident_heading(ident: str) -> Optional[float]:
    digits = "".join(c for c in (ident or "") if c.isdigit())
    if not digits:
        return None
    return (int(digits) % 36) * 10 or 360


def _bearing(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _runway_ends(r: dict) -> list[dict]:
    """Split one OurAirports runway row into its two usable ends."""
    ends = []
    for a, b in (("le", "he"), ("he", "le")):
        ident = (r.get(f"{a}_ident") or "").strip().upper()
        if not ident or ident.startswith("H"):
            continue
        hdg = r.get(f"{a}_hdg")
        if hdg is None and None not in (r.get(f"{a}_lat"), r.get(f"{a}_lon"), r.get(f"{b}_lat"), r.get(f"{b}_lon")):
            hdg = _bearing(r[f"{a}_lat"], r[f"{a}_lon"], r[f"{b}_lat"], r[f"{b}_lon"])
        heading_source = "true"
        if hdg is None:
            hdg = _ident_heading(ident)
            heading_source = "ident"  # magnetic-ish, from the runway number
        ends.append({
            "ident": ident, "opposite": (r.get(f"{b}_ident") or "").strip().upper(),
            "heading": round(hdg, 1) if hdg is not None else None, "heading_source": heading_source,
            "length_ft": r.get("length_ft"), "surface": r.get("surface"), "closed": bool(r.get("closed")),
            "lat": r.get(f"{a}_lat"), "lon": r.get(f"{a}_lon"), "elevation_ft": r.get(f"{a}_elev"),
            "displaced_ft": r.get(f"{a}_disp"),
        })
    return ends


def _manual_runway_ends(rw: dict) -> list[dict]:
    """Manual runways may be given either as ends or as le/he pairs."""
    if "ident" in rw:
        end = dict(rw)
        end["ident"] = str(end["ident"]).upper()
        if end.get("heading") is None:
            end["heading"] = _ident_heading(end["ident"])
            end["heading_source"] = "ident"
        else:
            end.setdefault("heading_source", "true")
        end.setdefault("closed", False)
        return [end]
    row = {
        "length_ft": rw.get("length_ft"), "surface": rw.get("surface"), "closed": rw.get("closed", False),
        "le_ident": rw.get("le_ident"), "le_lat": rw.get("le_lat"), "le_lon": rw.get("le_lon"),
        "le_elev": rw.get("le_elevation_ft"), "le_hdg": rw.get("le_heading"), "le_disp": None,
        "he_ident": rw.get("he_ident"), "he_lat": rw.get("he_lat"), "he_lon": rw.get("he_lon"),
        "he_elev": rw.get("he_elevation_ft"), "he_hdg": rw.get("he_heading"), "he_disp": None,
    }
    return _runway_ends(row)


def _fmt_mhz(mhz: float) -> str:
    return f"{mhz:.3f}"


class AirportDB:
    def __init__(self, db_path: Path, manual_paths: Iterable[Path] = ()):
        self.db_path = db_path
        self.manual_paths = list(manual_paths)
        self._manual_cache: tuple[float, dict] = (0.0, {})

    @property
    def has_ourairports(self) -> bool:
        return self.db_path.exists()

    def _manual(self) -> dict:
        """Merged manual entries; reloaded when a file changes."""
        stamp = sum(p.stat().st_mtime for p in self.manual_paths if p.exists())
        if stamp == self._manual_cache[0]:
            return self._manual_cache[1]
        merged: dict = {}
        for p in self.manual_paths:
            if not p.exists():
                continue
            try:
                data = json.loads(p.read_text("utf-8"))
            except (OSError, ValueError) as exc:
                LOG.error("could not read %s: %s", p, exc)
                continue
            for ident, entry in (data.get("airports") or {}).items():
                merged[ident.upper()] = entry
        self._manual_cache = (stamp, merged)
        return merged

    def lookup(self, code: str) -> Optional[dict]:
        code = (code or "").strip().upper()
        if not code or len(code) > 8:
            return None
        result = self._from_db(code)
        manual = self._manual().get(code)
        if manual:
            result = self._merge_manual(result, code, manual)
        return result

    def _from_db(self, code: str) -> Optional[dict]:
        if not self.db_path.exists():
            return None
        con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            row = con.execute("SELECT * FROM airports WHERE ident=? OR icao=? OR gps=? "
                              "ORDER BY ident=? DESC LIMIT 1", (code, code, code, code)).fetchone()
            if row is None:
                return None
            ident = row["ident"]
            runways = [e for r in con.execute("SELECT * FROM runways WHERE airport=?", (ident,))
                       for e in _runway_ends(dict(r))]
            freqs: dict = {}
            for f in con.execute("SELECT * FROM freqs WHERE airport=? ORDER BY mhz", (ident,)):
                role = FREQ_ROLES.get((f["type"] or "").upper())
                if role is None:
                    desc = (f["description"] or "").upper()
                    role = next((v for k, v in FREQ_ROLES.items() if len(k) > 3 and k in desc), None)
                if role:
                    freqs.setdefault(role, []).append({"mhz": _fmt_mhz(f["mhz"]), "description": f["description"]})
            return {
                "icao": row["icao"] or row["gps"] or ident, "ident": ident, "name": row["name"],
                "municipality": row["municipality"], "country": row["country"], "type": row["type"],
                "lat": row["lat"], "lon": row["lon"], "elevation_ft": row["elevation_ft"],
                "runways": runways, "frequencies": freqs, "names": {}, "source": "ourairports",
            }
        finally:
            con.close()

    @staticmethod
    def _merge_manual(base: Optional[dict], code: str, m: dict) -> dict:
        out = dict(base) if base else {
            "icao": code, "ident": code, "name": m.get("name", code), "municipality": m.get("municipality"),
            "country": m.get("country"), "type": "manual", "lat": None, "lon": None, "elevation_ft": None,
            "runways": [], "frequencies": {}, "names": {}, "source": "manual",
        }
        if base:
            out["source"] = "ourairports+manual"
        for key in ("name", "municipality", "country", "lat", "lon", "elevation_ft"):
            if m.get(key) is not None:
                out[key] = m[key]
        if m.get("runways"):
            out["runways"] = [e for rw in m["runways"] for e in _manual_runway_ends(rw)]
        freqs = dict(out.get("frequencies") or {})
        for role, value in (m.get("frequencies") or {}).items():
            values = value if isinstance(value, list) else [value]
            freqs[role.upper()] = [{"mhz": _fmt_mhz(float(v)), "description": "manual"} for v in values]
        out["frequencies"] = freqs
        out["names"] = {k.upper(): v for k, v in (m.get("names") or {}).items()}
        return out
