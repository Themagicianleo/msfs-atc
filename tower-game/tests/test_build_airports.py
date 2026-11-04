"""python -m unittest discover -s tests   (standard library only)"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class BuildAirports(unittest.TestCase):
    def test_build_from_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "airports"
            subprocess.run([sys.executable, str(HERE.parent / "tools" / "build_airports.py"),
                            "--from-dir", str(HERE / "fixtures"), "--out", str(out)], check=True, capture_output=True)
            index = json.loads((out / "index.json").read_text())
            # TSTB has no runway coordinates, TSTC is closed, US-0001 has no runways
            self.assertEqual([a[0] for a in index], ["TSTA"])
            data = json.loads((out / "TSTA.json").read_text())
            self.assertEqual(data["icao"], "TSTA")
            idents = sorted(e["ident"] for e in data["runways"])
            self.assertEqual(idents, ["09L", "09R", "27L", "27R"])
            end = next(e for e in data["runways"] if e["ident"] == "09L")
            self.assertEqual((end["opposite"], end["lat"], end["lon"]), ("27R", 51.5, -0.55))


if __name__ == "__main__":
    unittest.main()
