import datetime as dt
import json
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.x509.oid import ExtendedKeyUsageOID

from openatc.airports import AirportDB, import_ourairports
from openatc.auth import PairingStore
from openatc.certs import SERVER_DAYS, ensure_certificates
from openatc.netutil import is_local_address
from openatc.sim import MockSimSource, distance_nm
from openatc.simconnect_source import bco16_to_code, convert
from openatc.weather import parse_awc, parse_raw

FIX = Path(__file__).parent / "fixtures"


# ------------------------------------------------------------------ network
@pytest.mark.parametrize("addr,ok", [
    ("192.168.1.20", True), ("10.0.0.5", True), ("172.20.1.1", True), ("127.0.0.1", True),
    ("169.254.3.3", True), ("::1", True), ("fe80::1%en0", True), ("fd00::5", True),
    ("::ffff:192.168.1.9", True), ("8.8.8.8", False), ("100.64.1.1", False), ("172.32.0.1", False),
    ("2001:4860::8888", False), ("", False), (None, False), ("garbage", False),
])
def test_is_local_address(addr, ok):
    assert is_local_address(addr) is ok


# ------------------------------------------------------------------ pairing
def test_pairing_flow(tmp_path):
    store = PairingStore(tmp_path / "p.json")
    assert len(store.code) == 6 and store.code.isdigit()
    assert store.pair("000000" if store.code != "000000" else "111111") is None
    token = store.pair(store.code, "test iPad")
    assert token and store.verify(token)
    assert not store.verify("nope") and not store.verify(None)
    # persisted, and only the hash is on disk
    again = PairingStore(tmp_path / "p.json")
    assert again.verify(token) and again.code == store.code
    assert token not in (tmp_path / "p.json").read_text()
    again.reset()
    assert not again.verify(token)


def test_pairing_lockout(tmp_path):
    store = PairingStore(tmp_path / "p.json")
    wrong = "000000" if store.code != "000000" else "111111"
    for _ in range(PairingStore.MAX_FAILURES):
        assert store.pair(wrong, now=1000.0) is None
    # even the right code is refused during the lockout window
    assert store.pair(store.code, now=1001.0) is None
    assert store.pair(store.code, now=1000.0 + PairingStore.WINDOW_S + 1) is not None


# ------------------------------------------------------------------ certificates
def test_certificates_meet_apple_rules(tmp_path):
    p, ca, reissued = ensure_certificates(tmp_path, ["192.168.1.50", "127.0.0.1"], ["localhost", "pc.local"])
    assert reissued
    chain = x509.load_pem_x509_certificates(p.server_cert.read_bytes())
    server = chain[0]
    assert chain[1] == ca
    server.verify_directly_issued_by(ca)
    assert ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    assert server.public_key().key_size >= 2048
    days = (server.not_valid_after_utc - server.not_valid_before_utc) / dt.timedelta(days=1)
    assert days <= 398 and SERVER_DAYS <= 397
    eku = server.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ExtendedKeyUsageOID.SERVER_AUTH in list(eku)
    san = server.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert {str(i) for i in san.get_values_for_type(x509.IPAddress)} == {"192.168.1.50", "127.0.0.1"}
    assert p.ca_der.read_bytes()[:1] == b"\x30"  # DER sequence
    # unchanged IPs: reuse; new IP: new server cert but same CA
    _, ca2, reissued2 = ensure_certificates(tmp_path, ["192.168.1.50", "127.0.0.1"], ["localhost", "pc.local"])
    assert not reissued2 and ca2 == ca
    _, ca3, reissued3 = ensure_certificates(tmp_path, ["192.168.1.77", "127.0.0.1"], ["localhost", "pc.local"])
    assert reissued3 and ca3 == ca


# ------------------------------------------------------------------ airports
@pytest.fixture
def airport_db(tmp_path):
    db = tmp_path / "oa.sqlite"
    counts = import_ourairports(db, FIX)
    assert counts == {"airports": 3, "runways": 4, "freqs": 7}
    manual = tmp_path / "manual.json"
    manual.write_text(json.dumps({"airports": {
        "TSTB": {"frequencies": {"TWR": "118.250", "GND": ["121.600", "121.650"]}, "names": {"twr": "Bravo Tower"}},
        "ZZNEW": {"name": "Manual Strip", "lat": 1, "lon": 2, "elevation_ft": 50,
                  "runways": [{"ident": "05", "length_ft": 4000}, {"ident": "23", "heading": 228}]},
    }}))
    return AirportDB(db, [manual])


def test_airport_lookup(airport_db):
    a = airport_db.lookup("tsta")
    assert a["name"] == "Test Alpha International" and a["elevation_ft"] == 80
    idents = sorted(r["ident"] for r in a["runways"])
    assert idents == ["09L", "09R", "27L", "27R"]
    r27l = next(r for r in a["runways"] if r["ident"] == "27L")
    assert r27l["heading_source"] == "true" and 265 < r27l["heading"] < 275  # from coordinates
    assert a["frequencies"]["DEL"][0]["mhz"] == "121.975"
    assert a["frequencies"]["TWR"][0]["mhz"] == "118.700"
    assert airport_db.lookup("TSTC") is None  # closed airports are skipped
    assert airport_db.lookup("K9X9")["ident"] == "US-0001"  # found by gps code


def test_airport_manual_merge(airport_db):
    b = airport_db.lookup("TSTB")
    assert b["source"] == "ourairports+manual"
    assert b["frequencies"]["TWR"][0]["mhz"] == "118.250"
    assert [f["mhz"] for f in b["frequencies"]["GND"]] == ["121.600", "121.650"]
    assert b["frequencies"]["APP"][0]["mhz"] == "125.250"  # "Radar" in description
    assert b["names"]["TWR"] == "Bravo Tower"
    assert {r["ident"] for r in b["runways"]} == {"04", "22"}  # helipad dropped
    assert next(r for r in b["runways"] if r["ident"] == "04")["heading"] == 40
    n = airport_db.lookup("ZZNEW")
    assert n["source"] == "manual" and {r["ident"] for r in n["runways"]} == {"05", "23"}
    assert next(r for r in n["runways"] if r["ident"] == "23")["heading"] == 228


def test_shipped_manual_file_is_valid():
    db = AirportDB(Path("/nonexistent.sqlite"), [Path(__file__).parent.parent / "data" / "airports_manual.json"])
    dep = db.lookup("XDEP")
    assert dep and {r["ident"] for r in dep["runways"]} == {"09", "27", "18", "36"}
    r09 = next(r for r in dep["runways"] if r["ident"] == "09")
    assert abs(r09["heading"] - 90) < 1


# ------------------------------------------------------------------ weather
def test_parse_raw_metar():
    m = parse_raw("ZBAA 290600Z 31008MPS 9999 FEW040 12/M05 Q1021 NOSIG")
    assert m["wind_dir"] == 310 and m["wind_kt"] == 16 and m["qnh_hpa"] == 1021
    m = parse_raw("KJFK 290551Z 27015G25KT 10SM FEW250 15/03 A2992 RMK AO2")
    assert m["wind_dir"] == 270 and m["gust_kt"] == 25 and m["qnh_hpa"] == 1013
    m = parse_raw("EGLL 290550Z VRB02KT CAVOK 10/08 Q1008")
    assert m["wind_vrb"] and m["wind_dir"] is None and m["wind_kt"] == 2


def test_parse_awc_json_fallbacks():
    m = parse_awc({"icaoId": "TEST", "rawOb": "", "wdir": 180, "wspd": 7, "altim": 1015.2, "reportTime": "x"})
    assert m["wind_dir"] == 180 and m["wind_kt"] == 7 and m["qnh_hpa"] == 1015
    m = parse_awc({"icaoId": "TEST", "rawOb": "", "wdir": "VRB", "wspd": 3, "altim": 29.92})
    assert m["wind_vrb"] and m["qnh_hpa"] == 1013


# ------------------------------------------------------------------ sim
def test_bco16():
    assert bco16_to_code(0x1200) == "1200"
    assert bco16_to_code(0x7700) == "7700"
    assert bco16_to_code(0x0042) == "0042"
    assert bco16_to_code(0x1289) is None  # 8/9 are not transponder digits
    assert bco16_to_code(None) is None


def test_convert_types():
    c = convert({"on_ground": 1.0, "parking_brake": 0.0, "xpdr": float(0x4721), "com1_active": 118.69999,
                 "flaps_index": 2.0, "alt_ft": 1234.56, "lat": 51.123456789, "gear_down": None})
    assert c == {"on_ground": True, "parking_brake": False, "xpdr": "4721", "com1_active": 118.7,
                 "flaps_index": 2, "alt_ft": 1234.6, "lat": 51.123456789, "gear_down": None}


def test_mock_flies_a_whole_flight():
    states = []
    mock = MockSimSource(states.append)
    mock.command({"cmd": "setup", "dep": {"lat": 10, "lon": 150, "elevation_ft": 100},
                  "arr": {"lat": 10.5, "lon": 150.8, "elevation_ft": 50}, "cruise_ft": 12000})
    mock.command({"cmd": "tune", "freq": "121.9"})
    mock.command({"cmd": "squawk", "code": "4721"})
    s = mock.snapshot()
    assert s.com1_active == 121.9 and s.xpdr == "4721" and s.on_ground and s.parking_brake
    seen = set()
    mock.command({"cmd": "phase", "phase": "takeoff"})
    for _ in range(20000):
        mock.step(1.0)
        seen.add(mock.phase)
        if mock.phase == "arrived":
            break
    assert {"climb", "cruise", "descent", "approach", "rollout", "taxi_in", "arrived"} <= seen
    end = mock.snapshot()
    assert end.on_ground and end.gs_kt == 0
    assert distance_nm(end.lat, end.lon, 10.5, 150.8) < 3
