"""SimConnect source for MSFS 2020/2024 (Windows only).

Uses the ``SimConnect`` package from PyPI (Python-SimConnect, v0.4.26) for
loading ``SimConnect.dll``, opening the connection and the dispatch thread.
On top of that we register ONE data definition holding every variable we need
and request it once per poll, so the sim answers with a single packet per
poll instead of one round trip per variable. If the sim rejects that block
(for example an unknown variable name in a future sim version) we fall back
to the library's per-variable requests, which skip only the bad variable.

Compatibility with MSFS 2024: Microsoft states that SimConnect clients built
for MSFS 2020 keep working in MSFS 2024, and the package ships the MSFS 2020
SDK DLL. This could NOT be verified from the development machine (no Windows,
no simulator). If it fails, pass ``--simconnect-dll`` with the path to the
SimConnect.dll from the MSFS 2024 SDK (``<SDK>\\SimConnect SDK\\lib\\SimConnect.dll``).
"""

from __future__ import annotations

import ctypes
import logging
import threading
import time
from typing import Optional

from .sim import SimSource, SimState

LOG = logging.getLogger(__name__)

# (key, SimVar name, units). Units are SimConnect unit strings.
SIMVARS = [
    ("lat", "PLANE LATITUDE", "degrees"),
    ("lon", "PLANE LONGITUDE", "degrees"),
    ("alt_ft", "PLANE ALTITUDE", "feet"),
    ("alt_agl_ft", "PLANE ALT ABOVE GROUND", "feet"),
    ("ind_alt_ft", "INDICATED ALTITUDE", "feet"),
    ("hdg_mag", "PLANE HEADING DEGREES MAGNETIC", "degrees"),
    ("hdg_true", "PLANE HEADING DEGREES TRUE", "degrees"),
    ("gs_kt", "GROUND VELOCITY", "knots"),
    ("ias_kt", "AIRSPEED INDICATED", "knots"),
    ("vs_fpm", "VERTICAL SPEED", "feet per minute"),
    ("on_ground", "SIM ON GROUND", "bool"),
    ("com1_active", "COM ACTIVE FREQUENCY:1", "MHz"),
    ("com1_standby", "COM STANDBY FREQUENCY:1", "MHz"),
    ("com2_active", "COM ACTIVE FREQUENCY:2", "MHz"),
    ("com2_standby", "COM STANDBY FREQUENCY:2", "MHz"),
    ("xpdr", "TRANSPONDER CODE:1", "BCO16"),
    ("parking_brake", "BRAKE PARKING POSITION", "bool"),
    ("flaps_index", "FLAPS HANDLE INDEX", "number"),
    ("gear_down", "GEAR HANDLE POSITION", "bool"),
]


def bco16_to_code(value: Optional[float]) -> Optional[str]:
    """Transponder BCO16 (BCD in hex digits, 0x1200 = 4608) -> "1200"."""
    if value is None:
        return None
    try:
        code = f"{int(value):04x}"
    except (TypeError, ValueError, OverflowError):
        return None
    if len(code) == 4 and all(c in "01234567" for c in code):
        return code
    return None


def convert(raw: dict) -> dict:
    """Turn raw floats from SimConnect into SimState fields."""
    out: dict = {}
    for key, value in raw.items():
        if value is None:
            out[key] = None
        elif key in ("on_ground", "parking_brake", "gear_down"):
            out[key] = value >= 0.5
        elif key == "xpdr":
            out[key] = bco16_to_code(value)
        elif key == "flaps_index":
            out[key] = int(round(value))
        elif key.startswith("com"):
            out[key] = round(value, 3)
        elif key in ("lat", "lon"):
            out[key] = value
        else:
            out[key] = round(value, 1)
    return out


class SimConnectSource(SimSource):
    name = "simconnect"

    def __init__(self, on_state, rate_hz: float = 1.0, dll_path: Optional[str] = None,
                 retry_s: float = 5.0):
        super().__init__(on_state, rate_hz)
        self.dll_path = dll_path
        self.retry_s = retry_s

    # ------------------------------------------------------------ main loop
    def _run(self) -> None:
        try:
            lib = _load_library()
        except Exception as exc:  # ImportError on non-Windows, missing package
            LOG.error("SimConnect library not available: %s", exc)
            while not self._stop.is_set():
                self.on_state(SimState(source=self.name,
                                       message=f"SimConnect library not available: {exc}"))
                self._stop.wait(5)
            return

        while not self._stop.is_set():
            sm = None
            try:
                sm = lib.open(self.dll_path)
                LOG.info("connected to the simulator")
                self._poll_until_lost(sm, lib)
            except ConnectionError:
                self.on_state(SimState(source=self.name, message="waiting for the simulator..."))
            except Exception as exc:
                LOG.exception("SimConnect error")
                self.on_state(SimState(source=self.name, message=f"SimConnect error: {exc}"))
            finally:
                if sm is not None:
                    lib.close(sm)
            self._stop.wait(self.retry_s)

    def _poll_until_lost(self, sm, lib) -> None:
        block = lib.Block(sm, SIMVARS)
        per_var = None  # created lazily if the block request fails
        misses = 0
        while not self._stop.is_set():
            if sm.quit:
                LOG.info("simulator closed the connection")
                return
            raw = None
            if per_var is None:
                raw = block.read(timeout=1.0)
                if raw is None:
                    misses += 1
                    if misses >= 3 and block.failed:
                        LOG.warning("block request rejected by the sim; using per-variable requests")
                        per_var = lib.PerVar(sm, SIMVARS)
                else:
                    misses = 0
            else:
                raw = per_var.read()
                if raw is not None and all(v is None for v in raw.values()):
                    raw = None
            if raw is None:
                # connected, but no user aircraft (main menu, loading screen)
                self.on_state(SimState(connected=True, source=self.name,
                                       message="connected, waiting for a flight to load"))
            else:
                self.on_state(SimState(connected=True, in_flight=True, source=self.name,
                                       message="connected", **convert(raw)))
            self._stop.wait(self.period)


def _load_library():
    """Import lazily so the helper still starts (mock mode) on any OS."""
    import ctypes.wintypes

    import SimConnect as sc  # noqa: N813  (package name)
    from SimConnect.Constants import SIMCONNECT_UNUSED
    from SimConnect.Enum import SIMCONNECT_DATATYPE, SIMCONNECT_SIMOBJECT_TYPE
    from SimConnect.SimConnect import _library_path as default_dll

    class Client(sc.SimConnect):
        """Library client with two fixes: a dead connection ends the
        dispatch loop instead of printing an error every 2 ms, and our
        multi-variable block gets all of its values, not just the first."""

        def __init__(self, library_path):
            self.blocks = {}
            super().__init__(auto_connect=False, library_path=library_path)

        def _run(self):
            while self.quit == 0:
                try:
                    self.dll.CallDispatch(self.hSimConnect, self.my_dispatch_proc_rd, None)
                except OSError:
                    self.quit = 1
                    break
                time.sleep(0.01)

        def handle_simobject_event(self, ObjData):  # noqa: N802,N803 (library API)
            block = self.blocks.get(ObjData.dwRequestID)
            if block is None:
                return super().handle_simobject_event(ObjData)
            values = ctypes.cast(ObjData.dwData, ctypes.POINTER(ctypes.c_double * block.count)).contents
            block.receive(list(values))

        def handle_exception_event(self, exc):
            for block in self.blocks.values():
                if exc.dwSendID in block.packet_ids:
                    block.failed = True
            return super().handle_exception_event(exc)

    class Block:
        def __init__(self, sm, simvars):
            self.sm = sm
            self.keys = [k for k, _, _ in simvars]
            self.count = len(simvars)
            self.def_id = sm.new_def_id()
            self.req_id = sm.new_request_id()
            self.packet_ids = set()
            self.failed = False
            self._event = threading.Event()
            self._values = None
            for _, name, units in simvars:
                sm.dll.AddToDataDefinition(sm.hSimConnect, self.def_id.value, name.encode(),
                                           units.encode(), SIMCONNECT_DATATYPE.SIMCONNECT_DATATYPE_FLOAT64,
                                           0, SIMCONNECT_UNUSED)
                self._remember_packet()
            sm.blocks[self.req_id.value] = self

        def _remember_packet(self):
            pid = ctypes.wintypes.DWORD(0)
            self.sm.dll.GetLastSentPacketID(self.sm.hSimConnect, pid)
            self.packet_ids.add(pid.value)

        def receive(self, values):
            self._values = values
            self._event.set()

        def read(self, timeout: float):
            self._event.clear()
            self.sm.dll.RequestDataOnSimObjectType(
                self.sm.hSimConnect, self.req_id.value, self.def_id.value, 0,
                SIMCONNECT_SIMOBJECT_TYPE.SIMCONNECT_SIMOBJECT_TYPE_USER)
            self._remember_packet()
            if not self._event.wait(timeout):
                return None
            return dict(zip(self.keys, self._values))

    class PerVar:
        def __init__(self, sm, simvars):
            self.requests = {k: sc.Request((name.encode(), units.encode()), sm, _time=0, _attemps=20)
                             for k, name, units in simvars}

        def read(self):
            out = {}
            for key, req in self.requests.items():
                try:
                    out[key] = req.value
                except Exception:
                    out[key] = None
            return out

    class Lib:
        pass

    lib = Lib()
    lib.Block, lib.PerVar = Block, PerVar

    def open_client(dll_path):
        path = dll_path or default_dll
        client = Client(path)
        opened = threading.Event()
        errors = []

        def _connect():
            try:
                client.connect()
                opened.set()
            except Exception as exc:  # ConnectionError when the sim is not running
                errors.append(exc)
                opened.set()

        # connect() busy-waits for the OPEN packet; run it in a thread so a
        # half-started simulator can't block us forever.
        threading.Thread(target=_connect, daemon=True).start()
        if not opened.wait(15) or errors or not client.ok:
            client.quit = 1
            client.ok = True  # releases the busy-wait if it is still spinning
            raise ConnectionError(str(errors[0]) if errors else "simulator did not answer")
        return client

    def close_client(client):
        try:
            client.quit = 1
            thread = getattr(client, "timerThread", None)
            if thread is not None:
                thread.join(timeout=2)
            client.dll.Close(client.hSimConnect)
        except Exception:
            pass

    lib.open, lib.close = open_client, close_client
    return lib
