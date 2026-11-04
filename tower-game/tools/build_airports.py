"""Build the game's airport data from OurAirports (public domain).

    python tools/build_airports.py                 # download and build
    python tools/build_airports.py --from-dir DIR  # use airports.csv + runways.csv from DIR

Writes data/airports/index.json (search list) and data/airports/<CODE>.json
(runway ends) for every open airport with at least one runway of 1200 m or
more that has coordinates for both ends. Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import shutil
import urllib.request
from pathlib import Path

BASE = "https://davidmegginson.github.io/ourairports-data/"
MIN_LENGTH_FT = 3937  # 1200 m
OUT = Path(__file__).resolve().parent.parent / "data" / "airports"
CODE_RE = re.compile(r"^[A-Z0-9]{3,4}$")


def fetch(name: str, src: Path | None) -> str:
    if src:
        return (src / name).read_text("utf-8", errors="replace")
    req = urllib.request.Request(BASE + name, headers={"User-Agent": "tower-controller-game data build"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8", errors="replace")


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def build(src: Path | None, out: Path) -> dict:
    airports = {r["ident"]: r for r in csv.DictReader(io.StringIO(fetch("airports.csv", src)))
                if r.get("type") in ("large_airport", "medium_airport", "small_airport")}
    runways: dict[str, list] = {}
    for r in csv.DictReader(io.StringIO(fetch("runways.csv", src))):
        if r.get("closed") == "1" or r["airport_ident"] not in airports:
            continue
        ends = (r.get("le_ident"), r.get("he_ident"))
        if not all(ends) or any(e.upper().startswith("H") for e in ends):
            continue
        le = (num(r.get("le_latitude_deg")), num(r.get("le_longitude_deg")))
        he = (num(r.get("he_latitude_deg")), num(r.get("he_longitude_deg")))
        if None in le + he:
            continue
        length = num(r.get("length_ft"))
        runways.setdefault(r["airport_ident"], []).append({
            "le": ends[0].upper(), "he": ends[1].upper(), "length_ft": length,
            "le_lat": le[0], "le_lon": le[1], "he_lat": he[0], "he_lon": he[1],
            "le_hdg": num(r.get("le_heading_degT")), "he_hdg": num(r.get("he_heading_degT")),
        })
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    index = []
    for ident, rwys in runways.items():
        if not any((r["length_ft"] or 0) >= MIN_LENGTH_FT for r in rwys):
            continue
        a = airports[ident]
        code = next((c for c in ((a.get("icao_code") or "").upper(), (a.get("gps_code") or "").upper(), ident.upper())
                     if CODE_RE.match(c)), None)
        if not code or (out / f"{code}.json").exists():
            continue
        ends = []
        for r in rwys:
            for me, other, p in (("le", "he", "le"), ("he", "le", "he")):
                ends.append({"ident": r[me], "opposite": r[other], "length_ft": r["length_ft"],
                             "heading": r[f"{p}_hdg"], "lat": r[f"{p}_lat"], "lon": r[f"{p}_lon"]})
        data = {"icao": code, "name": a.get("name"), "municipality": a.get("municipality") or "",
                "country": a.get("iso_country"), "lat": num(a.get("latitude_deg")), "lon": num(a.get("longitude_deg")),
                "elevation_ft": num(a.get("elevation_ft")), "runways": ends}
        (out / f"{code}.json").write_text(json.dumps(data, separators=(",", ":")), "utf-8")
        longest = max(r["length_ft"] or 0 for r in rwys)
        index.append([code, a.get("name") or "", a.get("municipality") or "", a.get("iso_country") or "", round(longest)])
    index.sort(key=lambda x: (-x[4], x[0]))  # big airports first
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), "utf-8")
    return {"airports": len(index)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-dir", type=Path)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    print(f"built {build(args.from_dir, args.out)['airports']} airports into {args.out}")
