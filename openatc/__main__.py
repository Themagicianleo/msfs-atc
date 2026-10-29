"""Command line entry point: ``python -m openatc --help``."""

from __future__ import annotations

import argparse
import asyncio
import logging
import socket
import ssl
import sys
from pathlib import Path

from aiohttp import web

from . import __version__
from .airports import AirportDB, import_ourairports
from .auth import PairingStore
from .netutil import guess_lan_ip, is_local_address
from .server import Hub, create_app, create_setup_app
from .sim import MockSimSource, NullSimSource
from .weather import MetarService

ROOT = Path(__file__).resolve().parent.parent
LOG = logging.getLogger("openatc")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m openatc", description="OpenATC helper for MSFS")
    p.add_argument("command", nargs="?", default="run",
                   choices=["run", "import-airports", "show-pairing", "reset-pairing"])
    p.add_argument("--data-dir", type=Path, default=ROOT / "userdata", help="where settings, certs and data live")
    p.add_argument("--bind", help="LAN IP address to listen on (default: auto-detect)")
    p.add_argument("--port", type=int, default=8443, help="HTTPS port for the app (default 8443)")
    p.add_argument("--setup-port", type=int, default=8080,
                   help="plain-HTTP port that only serves the CA certificate (default 8080, 0 = off)")
    p.add_argument("--no-https", action="store_true",
                   help="serve the app over plain HTTP (voice input will NOT work in Safari)")
    p.add_argument("--mock", action="store_true", help="use a simulated aircraft instead of MSFS")
    p.add_argument("--mock-speed", type=float, default=1.0, help="time multiplier for --mock")
    p.add_argument("--no-sim", action="store_true", help="do not connect to any simulator")
    p.add_argument("--rate", type=float, default=1.0, help="sim reads per second (0.2-5, default 1)")
    p.add_argument("--simconnect-dll", help="path to SimConnect.dll (e.g. from the MSFS 2024 SDK)")
    p.add_argument("--offline", action="store_true", help="never fetch METAR from the internet")
    p.add_argument("--from-dir", type=Path, help="import-airports: read CSV files from this folder")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    data = args.data_dir
    data.mkdir(parents=True, exist_ok=True)

    if args.command == "import-airports":
        counts = import_ourairports(data / "ourairports.sqlite", args.from_dir)
        print(f"Imported {counts['airports']} airports, {counts['runways']} runways, "
              f"{counts['freqs']} frequencies into {data / 'ourairports.sqlite'}")
        return 0

    store = PairingStore(data / "pairing.json")
    if args.command == "show-pairing":
        print(f"Pairing code: {store.code}   ({len(store.devices)} paired device(s))")
        return 0
    if args.command == "reset-pairing":
        store.reset()
        print(f"All devices forgotten. New pairing code: {store.code}")
        return 0

    try:
        asyncio.run(serve(args, store))
    except KeyboardInterrupt:
        pass
    return 0


async def serve(args, store: PairingStore) -> None:
    data = args.data_dir
    lan_ip = args.bind or guess_lan_ip()
    if lan_ip and not is_local_address(lan_ip):
        sys.exit(f"Refusing to listen on {lan_ip}: not a private/local network address.")
    if not lan_ip:
        LOG.warning("No local network address found; listening on 127.0.0.1 only (the iPad can't connect).")
    hosts = [h for h in dict.fromkeys([lan_ip, "127.0.0.1"]) if h]

    hub = Hub()
    hub.loop = asyncio.get_running_loop()
    if args.mock:
        source = MockSimSource(hub.publish_threadsafe, args.rate, speed=args.mock_speed)
    elif args.no_sim:
        source = NullSimSource(hub.publish_threadsafe, args.rate)
    else:
        from .simconnect_source import SimConnectSource
        source = SimConnectSource(hub.publish_threadsafe, args.rate, dll_path=args.simconnect_dll)
    hub.source = source

    airports = AirportDB(data / "ourairports.sqlite", [ROOT / "data" / "airports_manual.json",
                                                       data / "airports_manual.json"])
    if not airports.has_ourairports:
        LOG.warning("OurAirports data not imported. Run once: python -m openatc import-airports")
    metar = MetarService(offline=args.offline)
    secure = not args.no_https
    app = create_app(hub=hub, store=store, airports=airports, metar=metar,
                     user_dir=data, secure=secure)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()

    ssl_ctx = None
    fp = ca_name = None
    if secure:
        from .certs import ensure_certificates, fingerprint
        hostname = socket.gethostname()
        dns = list(dict.fromkeys(["localhost", f"{hostname}.local".lower()]))
        paths, ca_cert, reissued = ensure_certificates(data / "certs", hosts, dns)
        if reissued:
            LOG.info("issued a new server certificate for %s", ", ".join(hosts + dns))
        ssl_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ssl_ctx.load_cert_chain(paths.server_cert, paths.server_key)
        fp = fingerprint(ca_cert)
        ca_name = ca_cert.subject.rfc4514_string().split(",")[0].replace("CN=", "")

    for host in hosts:
        await web.TCPSite(runner, host, args.port, ssl_context=ssl_ctx).start()
    scheme = "https" if secure else "http"
    main_host = lan_ip or "127.0.0.1"
    app_url = f"{scheme}://{main_host}:{args.port}/"

    setup_runner = None
    if secure and args.setup_port:
        setup_app = create_setup_app(ca_der=paths.ca_der, ca_name=ca_name, fingerprint=fp, https_url=app_url)
        setup_runner = web.AppRunner(setup_app, access_log=None)
        await setup_runner.setup()
        for host in hosts:
            await web.TCPSite(setup_runner, host, args.setup_port).start()

    source.start()
    bar = "=" * 64
    print(f"\n{bar}\n OpenATC helper {__version__}  (simulation use only)\n{bar}")
    print(f" App on the iPad:   {app_url}")
    if setup_runner:
        print(f" First-time setup:  http://{main_host}:{args.setup_port}/   (install the certificate)")
        print(f" CA fingerprint:    SHA-256 {fp}")
    print(f" Pairing code:      {store.code}")
    print(f" Sim source:        {source.name}{'  (mock aircraft)' if args.mock else ''}")
    print(f" Listening only on: {', '.join(hosts)} (local network)")
    print(f"{bar}\n Press Ctrl+C to stop.\n")

    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        source.stop()
        await metar.close()
        await runner.cleanup()
        if setup_runner:
            await setup_runner.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
