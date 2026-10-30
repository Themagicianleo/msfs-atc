"""HTTP(S) + WebSocket server for the iPad web app (aiohttp)."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import time
from pathlib import Path
from typing import Optional

from aiohttp import WSMsgType, web

from . import __version__
from .airports import AirportDB
from .auth import PairingStore
from .netutil import is_local_address
from .sim import SimState
from .weather import MetarService

LOG = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
PUBLIC_API = {"/api/pair", "/api/ping"}

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Hub:
    """Fans sim states out to connected, authenticated WebSocket clients."""

    def __init__(self):
        self.clients: set[web.WebSocketResponse] = set()
        self.latest: dict = SimState(message="starting").to_dict()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.source = None

    def publish_threadsafe(self, state: SimState) -> None:
        data = state.to_dict()
        if self.loop is None or self.loop.is_closed():
            self.latest = data
            return
        self.loop.call_soon_threadsafe(self._broadcast, data)

    def _broadcast(self, data: dict) -> None:
        self.latest = data
        msg = json.dumps({"type": "sim", "data": data})
        for ws in list(self.clients):
            if ws.closed:
                self.clients.discard(ws)
                continue
            asyncio.ensure_future(self._send(ws, msg))

    @staticmethod
    async def _send(ws, msg):
        try:
            await ws.send_str(msg)
        except (ConnectionError, RuntimeError):
            pass


def _token_from(request: web.Request) -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


@web.middleware
async def local_only(request: web.Request, handler):
    """Refuse anything that does not come from the local network."""
    peer = request.remote
    if not is_local_address(peer):
        LOG.warning("refused request from non-local address %s", peer)
        raise web.HTTPForbidden(text="OpenATC only answers devices on your local network.")
    return await handler(request)


@web.middleware
async def security_headers(request: web.Request, handler):
    try:
        resp = await handler(request)
    except web.HTTPException as exc:
        resp = exc
    host = request.host
    resp.headers.setdefault("Content-Security-Policy",
                            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
                            f"connect-src 'self' wss://{host} ws://{host}; object-src 'none'; "
                            "base-uri 'none'; frame-ancestors 'none'")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Cache-Control", "no-cache")
    if isinstance(resp, web.HTTPException) and resp.status >= 400:
        raise resp
    return resp


def make_auth_middleware(store: PairingStore):
    @web.middleware
    async def auth(request: web.Request, handler):
        path = request.path
        if path.startswith("/api/") and path not in PUBLIC_API:
            if not store.verify(_token_from(request)):
                raise web.HTTPUnauthorized(text=json.dumps({"error": "not paired"}),
                                           content_type="application/json")
        return await handler(request)
    return auth


def _safe_file(base: Path, rel: str) -> Optional[Path]:
    try:
        target = (base / rel).resolve()
    except (OSError, ValueError):
        return None
    if base.resolve() not in target.parents and target != base.resolve():
        return None
    return target if target.is_file() else None


def create_app(*, hub: Hub, store: PairingStore, airports: AirportDB, metar: MetarService,
               user_dir: Path, secure: bool) -> web.Application:
    app = web.Application(middlewares=[local_only, security_headers, make_auth_middleware(store)])
    routes = web.RouteTableDef()
    pair_lock = asyncio.Lock()

    @routes.get("/api/ping")
    async def ping(request):
        return web.json_response({"ok": True, "app": "OpenATC", "version": __version__, "secure": secure})

    @routes.post("/api/pair")
    async def pair(request):
        try:
            body = await request.json()
        except ValueError:
            raise web.HTTPBadRequest(text="expected JSON")
        async with pair_lock:
            if store.locked_out():
                return web.json_response({"error": "too many wrong codes, wait 10 minutes"}, status=429)
            token = store.pair(str(body.get("code", "")), str(body.get("device", "iPad")))
            if token is None:
                await asyncio.sleep(1.0)  # slow down guessing
                return web.json_response({"error": "wrong pairing code"}, status=403)
        LOG.info("paired a new device (%s) from %s", body.get("device", "iPad"), request.remote)
        return web.json_response({"token": token})

    @routes.get("/api/status")
    async def status(request):
        return web.json_response({"version": __version__, "sim": hub.latest,
                                  "airport_db": airports.has_ourairports, "secure": secure,
                                  "source": getattr(hub.source, "name", "none")})

    @routes.get("/api/airport/{code}")
    async def airport(request):
        code = request.match_info["code"]
        if not re.fullmatch(r"[A-Za-z0-9]{2,8}", code):
            raise web.HTTPBadRequest(text="bad airport code")
        info = await asyncio.get_running_loop().run_in_executor(None, airports.lookup, code)
        if info is None:
            hint = "" if airports.has_ourairports else " (OurAirports data not imported yet, run: python -m openatc import-airports)"
            return web.json_response({"error": f"unknown airport {code.upper()}{hint}"}, status=404)
        return web.json_response(info)

    @routes.get("/api/frequencies/near")
    async def frequencies_near(request):
        try:
            lat = float(request.query["lat"])
            lon = float(request.query["lon"])
            radius = min(float(request.query.get("radius", 250)), 600)
        except (KeyError, ValueError):
            raise web.HTTPBadRequest(text="lat, lon (and optional radius in NM) required")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise web.HTTPBadRequest(text="lat/lon out of range")
        roles = [r for r in request.query.get("roles", "APP,DEP,CTR").upper().split(",") if r]
        result = await asyncio.get_running_loop().run_in_executor(
            None, lambda: airports.nearby_frequencies(lat, lon, radius, roles))
        return web.json_response(result[:60])

    @routes.get("/api/metar/{code}")
    async def metar_route(request):
        return web.json_response(await metar.get(request.match_info["code"]))

    @routes.get("/ws")
    async def websocket(request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
        await ws.prepare(request)
        try:
            first = await ws.receive(timeout=10)
        except asyncio.TimeoutError:
            await ws.close(code=4401, message=b"auth timeout")
            return ws
        token = None
        if first.type == WSMsgType.TEXT:
            try:
                token = json.loads(first.data).get("token")
            except (ValueError, AttributeError):
                token = None
        if not store.verify(token):
            await ws.send_str(json.dumps({"type": "auth_failed"}))
            await ws.close(code=4401, message=b"not paired")
            return ws
        hub.clients.add(ws)
        await ws.send_str(json.dumps({"type": "hello", "version": __version__,
                                      "source": getattr(hub.source, "name", "none"), "secure": secure}))
        await ws.send_str(json.dumps({"type": "sim", "data": hub.latest}))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                kind = data.get("type")
                if kind == "ping":
                    await ws.send_str(json.dumps({"type": "pong", "t": time.time()}))
                elif kind == "mock" and hub.source is not None:
                    hub.source.command(data)
        finally:
            hub.clients.discard(ws)
        return ws

    async def static(request):
        rel = request.match_info.get("path") or "index.html"
        # user overrides for editable data (phraseology, airlines) win
        target = None
        if rel.startswith(("phraseology/", "data/")):
            target = _safe_file(user_dir, rel)
        target = target or _safe_file(WEB_DIR, rel)
        if target is None:
            raise web.HTTPNotFound()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return web.FileResponse(target, headers={"Content-Type": ctype})

    app.add_routes(routes)
    app.router.add_get("/", static)
    app.router.add_get("/{path:.+}", static)
    return app


SETUP_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenATC setup</title>
<style>body{{background:#0b0e12;color:#e8eaed;font:18px -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:720px}}
a{{color:#7cc4ff}} .btn{{display:block;padding:18px;margin:14px 0;background:#1d2a38;border-radius:12px;text-align:center;
text-decoration:none;font-size:20px}} code{{background:#1a1f26;padding:2px 6px;border-radius:6px;word-break:break-all}}
li{{margin:8px 0}}</style></head><body>
<h1>OpenATC setup</h1>
<p>This plain-HTTP page only hands out the certificate of your private OpenATC certificate authority,
so your iPad can trust the secure (HTTPS) app.</p>
<a class="btn" href="/openatc-ca.cer">1. Download the OpenATC certificate</a>
<ol>
<li>Tap <b>Allow</b> when Safari asks to download a configuration profile.</li>
<li>Open <b>Settings</b> &rarr; <b>Profile Downloaded</b> (near the top) &rarr; <b>Install</b> &rarr; enter passcode &rarr; <b>Install</b>.</li>
<li>Open <b>Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings</b> and switch on
<b>{ca_name}</b>.</li>
<li>Check the fingerprint in Settings &rarr; General &rarr; VPN &amp; Device Management &rarr; the profile &rarr; More Details. SHA-256 should be:<br><code>{fp}</code></li>
</ol>
<a class="btn" href="{https_url}">2. Open OpenATC (secure)</a>
<p>Address: <code>{https_url}</code></p>
</body></html>"""


def create_setup_app(*, ca_der: Path, ca_name: str, fingerprint: str, https_url: str) -> web.Application:
    app = web.Application(middlewares=[local_only])

    async def index(request):
        return web.Response(text=SETUP_PAGE.format(ca_name=ca_name, fp=fingerprint, https_url=https_url),
                            content_type="text/html")

    async def ca(request):
        return web.Response(body=ca_der.read_bytes(), headers={
            "Content-Type": "application/x-x509-ca-cert",
            "Content-Disposition": 'attachment; filename="openatc-ca.cer"'})

    app.router.add_get("/openatc-ca.cer", ca)
    app.router.add_get("/", index)
    app.router.add_get("/{tail:.*}", index)
    return app
