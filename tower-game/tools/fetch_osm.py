"""Download the airport layout (runways, taxiways with names, aprons, stands,
holding points, terminals) of the game's airports from OpenStreetMap, via the
public Overpass API, into data/osm/<ICAO>.json.

    python tools/fetch_osm.py            # all airports in AIRPORTS
    python tools/fetch_osm.py WSSS       # one airport

The data is (c) OpenStreetMap contributors and licensed under the Open Data
Commons Open Database License (ODbL); see data/osm/LICENSE.md. Standard
library only. Runs in a GitHub Action (the build machine has no access).
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# airport reference point and half-size of the box to download (degrees)
AIRPORTS = {"WSSS": (1.3644, 103.9915, 0.055), "ZBAD": (39.5098, 116.4105, 0.06)}
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
OUT = Path(__file__).resolve().parent.parent / "data" / "osm"

QUERY = """
[out:json][timeout:180][bbox:{bbox}];
(
  way["aeroway"~"^(runway|taxiway|taxilane|apron|parking_position|holding_position|gate|terminal|hangar)$"];
  node["aeroway"~"^(holding_position|parking_position|gate)$"];
  way["building"~"^(terminal|hangar|control_tower)$"];
  relation["aeroway"~"^(apron|terminal)$"];
);
out body geom qt;
"""


def fetch(icao: str) -> dict:
    lat, lon, d = AIRPORTS[icao]
    bbox = f"{lat - d},{lon - d * 1.3},{lat + d},{lon + d * 1.3}"
    data = urllib.parse.urlencode({"data": QUERY.replace("{bbox}", bbox)}).encode()
    last = None
    for attempt in range(3):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "tower-controller-game (github action)"})
                print(f"{icao}: asking {url}", flush=True)
                with urllib.request.urlopen(req, timeout=200) as resp:
                    out = json.loads(resp.read())
                if out.get("elements"):
                    return out
                last = f"{url}: no elements"
            except Exception as exc:  # network, 429 rate limit, 504 timeout
                last = f"{url}: {exc}"
        time.sleep(30 * (attempt + 1))
    raise RuntimeError(f"{icao}: {last}")


def main(codes: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for icao in codes:
        result = fetch(icao)
        result["fetched_for"] = icao
        (OUT / f"{icao}.json").write_text(json.dumps(result, separators=(",", ":")), "utf-8")
        kinds: dict = {}
        for el in result["elements"]:
            k = el.get("tags", {}).get("aeroway") or el.get("tags", {}).get("building") or "?"
            kinds[k] = kinds.get(k, 0) + 1
        print(icao, len(result["elements"]), "elements", kinds, flush=True)
        time.sleep(10)  # be gentle with the public server


if __name__ == "__main__":
    main(sys.argv[1:] or list(AIRPORTS))
