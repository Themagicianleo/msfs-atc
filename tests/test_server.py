import asyncio
import json
import threading
import time

import pytest
from aiohttp.test_utils import TestClient, TestServer

from openatc import simconnect_source
from openatc.airports import AirportDB
from openatc.auth import PairingStore
from openatc.server import Hub, create_app, create_setup_app
from openatc.sim import SimState
from openatc.weather import MetarService


@pytest.fixture
async def ctx(tmp_path):
    store = PairingStore(tmp_path / "pairing.json")
    hub = Hub()
    hub.loop = asyncio.get_running_loop()
    (tmp_path / "phraseology").mkdir()
    (tmp_path / "phraseology" / "icao.json").write_text('{"override": true}')
    airports = AirportDB(tmp_path / "none.sqlite", [tmp_path.parent / "missing.json"])
    app = create_app(hub=hub, store=store, airports=airports, metar=MetarService(offline=True),
                     user_dir=tmp_path, secure=True)
    client = TestClient(TestServer(app, host="127.0.0.1"))
    await client.start_server()
    yield client, store, hub
    await client.close()


async def test_static_and_security_headers(ctx):
    client, _, _ = ctx
    r = await client.get("/")
    assert r.status == 200 and "OpenATC" in await r.text()
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]
    r = await client.get("/js/main.js")
    assert r.status == 200 and r.headers["Content-Type"].startswith("text/javascript")
    assert (await client.get("/../openatc/auth.py")).status == 404
    assert (await client.get("/%2e%2e/openatc/auth.py")).status == 404
    r = await client.get("/phraseology/icao.json")  # user override wins
    assert json.loads(await r.text()) == {"override": True}


async def test_api_requires_pairing(ctx):
    client, store, _ = ctx
    assert (await client.get("/api/status")).status == 401
    assert (await client.get("/api/ping")).status == 200
    r = await client.post("/api/pair", json={"code": "999999" if store.code != "999999" else "111111"})
    assert r.status == 403
    r = await client.post("/api/pair", json={"code": store.code, "device": "pytest"})
    token = (await r.json())["token"]
    r = await client.get("/api/status", headers={"Authorization": f"Bearer {token}"})
    assert r.status == 200 and (await r.json())["airport_db"] is False
    r = await client.get("/api/metar/EGLL", headers={"Authorization": f"Bearer {token}"})
    assert (await r.json())["available"] is False
    r = await client.get("/api/airport/XXXX", headers={"Authorization": f"Bearer {token}"})
    assert r.status == 404 and "import-airports" in (await r.json())["error"]


async def test_websocket_auth_and_broadcast(ctx):
    client, store, hub = ctx
    ws = await client.ws_connect("/ws")
    await ws.send_str(json.dumps({"token": "bad"}))
    msg = await ws.receive(timeout=5)
    assert json.loads(msg.data)["type"] == "auth_failed"
    await ws.close()

    token = store.pair(store.code)
    ws = await client.ws_connect("/ws")
    await ws.send_str(json.dumps({"token": token}))
    assert json.loads((await ws.receive(timeout=5)).data)["type"] == "hello"
    assert json.loads((await ws.receive(timeout=5)).data)["type"] == "sim"
    # a state published from another thread reaches the client
    threading.Thread(target=hub.publish_threadsafe,
                     args=(SimState(connected=True, in_flight=True, source="test", com1_active=118.7),)).start()
    data = json.loads((await ws.receive(timeout=5)).data)
    assert data["type"] == "sim" and data["data"]["com1_active"] == 118.7
    await ws.send_str(json.dumps({"type": "ping"}))
    assert json.loads((await ws.receive(timeout=5)).data)["type"] == "pong"
    await ws.close()


async def test_non_local_clients_refused(tmp_path):
    store = PairingStore(tmp_path / "p.json")
    app = create_app(hub=Hub(), store=store, airports=AirportDB(tmp_path / "x", []),
                     metar=MetarService(offline=True), user_dir=tmp_path, secure=True)
    from aiohttp.test_utils import make_mocked_request
    from aiohttp import web
    req = make_mocked_request("GET", "/", app=app,
                              transport=type("T", (), {"get_extra_info": lambda self, k, d=None:
                                                       ("8.8.8.8", 1234) if k == "peername" else d})())
    from openatc.server import local_only
    with pytest.raises(web.HTTPForbidden):
        await local_only(req, lambda r: None)


async def test_setup_app_serves_ca(tmp_path):
    der = tmp_path / "ca.cer"
    der.write_bytes(b"\x30\x82fake")
    app = create_setup_app(ca_der=der, ca_name="OpenATC Local CA", fingerprint="AA BB", https_url="https://x/")
    client = TestClient(TestServer(app, host="127.0.0.1"))
    await client.start_server()
    r = await client.get("/openatc-ca.cer")
    assert r.status == 200 and r.headers["Content-Type"] == "application/x-x509-ca-cert"
    assert await r.read() == b"\x30\x82fake"
    r = await client.get("/anything")
    assert "Certificate Trust Settings" in await r.text()
    await client.close()


# -------------------------------------------------- SimConnect reconnect logic
class FakeClient:
    def __init__(self):
        self.quit = 0


class FakeBlock:
    calls = 0

    def __init__(self, sm, simvars):
        self.sm, self.failed = sm, False

    def read(self, timeout):
        FakeBlock.calls += 1
        if FakeBlock.calls == 3:
            self.sm.quit = 1  # simulator closed
        return {"lat": 1.0, "lon": 2.0, "on_ground": 1.0, "xpdr": float(0x1200), "com1_active": 118.7}


def test_simconnect_source_reconnects(monkeypatch):
    opens = {"n": 0}

    def fake_open(path):
        opens["n"] += 1
        if opens["n"] == 1:
            raise ConnectionError("sim not running")
        return FakeClient()

    lib = type("Lib", (), {})()
    lib.open, lib.close, lib.Block, lib.PerVar = fake_open, lambda c: None, FakeBlock, None
    monkeypatch.setattr(simconnect_source, "_load_library", lambda: lib)
    states = []
    src = simconnect_source.SimConnectSource(states.append, rate_hz=5, retry_s=0.05)
    src.start()
    deadline = time.time() + 5
    while opens["n"] < 3 and time.time() < deadline:
        time.sleep(0.02)
    src.stop()
    assert opens["n"] >= 3, "should reopen after the first failure and after the sim quit"
    assert any(s.message.startswith("waiting for the simulator") for s in states)
    live = [s for s in states if s.in_flight]
    assert live and live[0].xpdr == "1200" and live[0].on_ground is True
