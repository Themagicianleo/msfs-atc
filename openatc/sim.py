"""Aircraft state model, the sim-source interface and a mock source.

A sim source runs in its own thread and calls ``on_state(SimState)`` at the
configured rate. The server forwards each state to the paired iPad.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Callable, Optional

LOG = logging.getLogger(__name__)

EARTH_NM = 3440.065


@dataclass
class SimState:
    """One snapshot of the user aircraft. ``None`` means "not available"."""

    connected: bool = False          # helper is connected to the simulator
    in_flight: bool = False          # an aircraft is loaded (data arriving)
    source: str = "none"             # "simconnect" | "mock" | "none"
    lat: Optional[float] = None
    lon: Optional[float] = None
    alt_ft: Optional[float] = None       # MSL (true altitude)
    alt_agl_ft: Optional[float] = None
    ind_alt_ft: Optional[float] = None   # altimeter reading
    hdg_mag: Optional[float] = None
    hdg_true: Optional[float] = None
    gs_kt: Optional[float] = None
    ias_kt: Optional[float] = None
    vs_fpm: Optional[float] = None
    on_ground: Optional[bool] = None
    com1_active: Optional[float] = None
    com1_standby: Optional[float] = None
    com2_active: Optional[float] = None
    com2_standby: Optional[float] = None
    xpdr: Optional[str] = None           # "1200"
    parking_brake: Optional[bool] = None
    flaps_index: Optional[int] = None
    gear_down: Optional[bool] = None
    message: str = ""                    # human-readable status
    t: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)


StateCallback = Callable[[SimState], None]


class SimSource:
    """Base class. Subclasses implement ``_run`` and honour ``self._stop``."""

    name = "none"

    def __init__(self, on_state: StateCallback, rate_hz: float = 1.0):
        self.on_state = on_state
        self.period = 1.0 / max(0.2, min(rate_hz, 5.0))
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run_safe, name=f"sim-{self.name}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def command(self, cmd: dict) -> None:
        """Commands from the web app. Only the mock source uses them."""

    def _run_safe(self) -> None:
        try:
            self._run()
        except Exception:  # never let the thread die silently
            LOG.exception("sim source crashed")
            self.on_state(SimState(source=self.name, message="sim source crashed, see helper console"))

    def _run(self) -> None:
        raise NotImplementedError


# ---------------------------------------------------------------- geometry

def distance_nm(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_NM * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def move(lat, lon, brg_deg, dist_nm):
    d = dist_nm / EARTH_NM
    b = math.radians(brg_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


# ---------------------------------------------------------------- mock sim

class MockSimSource(SimSource):
    """A scripted aircraft for testing the iPad app without MSFS.

    It flies from ``dep`` to ``arr`` through simple phases. The web app can
    tune radios and step phases with ``command``. ``speed`` multiplies time.
    """

    name = "mock"
    PHASES = ["parked", "pushback", "taxi", "holding", "takeoff", "climb",
              "cruise", "descent", "approach", "rollout", "taxi_in", "arrived"]

    def __init__(self, on_state: StateCallback, rate_hz: float = 1.0, speed: float = 1.0):
        super().__init__(on_state, rate_hz)
        self.speed = speed
        self.lock = threading.Lock()
        self.dep = {"lat": 0.0, "lon": 0.0, "elevation_ft": 0.0}
        self.arr = {"lat": 0.5, "lon": 1.5, "elevation_ft": 0.0}
        self.cruise_ft = 24000.0
        self.auto = True
        self.reset()

    def reset(self) -> None:
        self.phase = "parked"
        self.phase_t = 0.0
        self.lat, self.lon = self.dep["lat"], self.dep["lon"]
        self.alt = self.dep["elevation_ft"]
        self.gs = 0.0
        self.vs = 0.0
        self.hdg = bearing_deg(self.dep["lat"], self.dep["lon"], self.arr["lat"], self.arr["lon"])
        self.com1, self.com1_sb = 122.800, 121.500
        self.com2, self.com2_sb = 121.500, 122.800
        self.xpdr = "2000"
        self.pbrake = True

    def command(self, cmd: dict) -> None:
        with self.lock:
            c = cmd.get("cmd")
            if c == "setup":
                for key in ("dep", "arr"):
                    if isinstance(cmd.get(key), dict) and cmd[key].get("lat") is not None:
                        v = cmd[key]
                        setattr(self, key, {"lat": float(v["lat"]), "lon": float(v["lon"]),
                                            "elevation_ft": float(v.get("elevation_ft") or 0)})
                if cmd.get("cruise_ft"):
                    self.cruise_ft = float(cmd["cruise_ft"])
                self.reset()
            elif c == "tune":
                radio = cmd.get("radio", "com1")
                freq = round(float(cmd["freq"]), 3)
                if radio == "com2":
                    self.com2 = freq
                else:
                    self.com1 = freq
            elif c == "squawk":
                code = str(cmd.get("code", ""))
                if len(code) == 4 and all(ch in "01234567" for ch in code):
                    self.xpdr = code
            elif c == "next":
                self._set_phase(self._next_phase())
            elif c == "phase" and cmd.get("phase") in self.PHASES:
                self._set_phase(cmd["phase"])
            elif c == "auto":
                self.auto = bool(cmd.get("on", True))
            elif c == "speed":
                self.speed = max(0.5, min(float(cmd.get("value", 1)), 20.0))
            elif c == "reset":
                self.reset()

    def _next_phase(self) -> str:
        i = self.PHASES.index(self.phase)
        return self.PHASES[min(i + 1, len(self.PHASES) - 1)]

    def _set_phase(self, phase: str) -> None:
        self.phase, self.phase_t = phase, 0.0
        if phase in ("pushback", "taxi", "takeoff"):
            self.pbrake = False
        if phase == "approach":
            # jump to a sensible approach position if we got here by command
            dist = distance_nm(self.lat, self.lon, self.arr["lat"], self.arr["lon"])
            if dist > 30:
                brg = bearing_deg(self.arr["lat"], self.arr["lon"], self.lat, self.lon)
                self.lat, self.lon = move(self.arr["lat"], self.arr["lon"], brg, 30)
                self.alt = max(self.alt if self.alt < 10000 else 10000, self.arr["elevation_ft"] + 3000)
        if phase == "arrived":
            self.gs, self.pbrake = 0.0, True

    def step(self, dt: float) -> None:
        """Advance the mock aircraft by ``dt`` simulated seconds."""
        with self.lock:
            self.phase_t += dt
            p = self.phase
            arr_dist = distance_nm(self.lat, self.lon, self.arr["lat"], self.arr["lon"])
            elev_arr = self.arr["elevation_ft"]
            target_gs, target_vs = 0.0, 0.0
            if p == "pushback":
                target_gs = 3
                if self.auto and self.phase_t > 40:
                    self._set_phase("taxi")
            elif p == "taxi":
                target_gs = 15
                if self.auto and self.phase_t > 90:
                    self._set_phase("holding")
            elif p == "takeoff":
                target_gs = 160
                if self.gs > 140:
                    target_vs = 2000
                if self.alt > self.dep["elevation_ft"] + 1500:
                    self._set_phase("climb")
            elif p == "climb":
                target_gs, target_vs = 300 if self.alt > 10000 else 250, 2200
                if self.alt >= self.cruise_ft:
                    self.alt = self.cruise_ft
                    self._set_phase("cruise")
            elif p == "cruise":
                target_gs = 450
                tod = (self.alt - elev_arr) / 1000 * 3 + 10
                if self.auto and arr_dist < tod:
                    self._set_phase("descent")
            elif p == "descent":
                target_gs, target_vs = 320, -2200
                if self.alt <= elev_arr + 4000:
                    target_vs = 0
                if self.auto and (arr_dist < 25 or self.alt <= elev_arr + 4000):
                    self._set_phase("approach")
            elif p == "approach":
                target_gs = 150
                glide_alt = elev_arr + max(0.0, arr_dist) * 318  # ~3 degree path
                target_vs = max(-1500, min(0, (glide_alt - self.alt) * 2))
                if arr_dist < 0.3 or self.alt <= elev_arr + 5:
                    self.alt = elev_arr
                    self._set_phase("rollout")
            elif p == "rollout":
                target_gs = 15
                if self.gs < 20:
                    self._set_phase("taxi_in")
            elif p == "taxi_in":
                target_gs = 15
                if self.auto and self.phase_t > 90:
                    self._set_phase("arrived")
            # integrate
            accel = 3.0 if p not in ("rollout",) else 6.0
            if self.gs < target_gs:
                self.gs = min(target_gs, self.gs + accel * dt)
            else:
                self.gs = max(target_gs, self.gs - accel * dt)
            if self.phase == "arrived":
                self.gs = 0.0
            self.vs = target_vs
            ground_phases = ("parked", "pushback", "taxi", "holding", "rollout", "taxi_in", "arrived")
            if p in ("climb", "cruise", "descent", "approach") or (p == "takeoff" and target_vs > 0):
                self.alt += self.vs / 60 * dt
                self.hdg = bearing_deg(self.lat, self.lon, self.arr["lat"], self.arr["lon"])
            if p in ground_phases:
                self.alt = self.dep["elevation_ft"] if p in ("parked", "pushback", "taxi", "holding") else elev_arr
            direction = self.hdg + (180 if p == "pushback" else 0)
            if p not in ("approach",) or arr_dist > 0.2:
                self.lat, self.lon = move(self.lat, self.lon, direction, self.gs * dt / 3600)

    def snapshot(self) -> SimState:
        with self.lock:
            ground = self.phase in ("parked", "pushback", "taxi", "holding", "rollout", "taxi_in", "arrived") \
                or (self.phase == "takeoff" and self.alt <= self.dep["elevation_ft"] + 1)
            elev = self.arr["elevation_ft"] if self.PHASES.index(self.phase) >= 6 else self.dep["elevation_ft"]
            return SimState(
                connected=True, in_flight=True, source="mock",
                lat=self.lat, lon=self.lon, alt_ft=round(self.alt, 1),
                alt_agl_ft=round(max(0.0, self.alt - elev), 1), ind_alt_ft=round(self.alt, 1),
                hdg_mag=round(self.hdg, 1), hdg_true=round(self.hdg, 1),
                gs_kt=round(self.gs, 1), ias_kt=round(self.gs, 1), vs_fpm=round(self.vs),
                on_ground=ground, com1_active=self.com1, com1_standby=self.com1_sb,
                com2_active=self.com2, com2_standby=self.com2_sb, xpdr=self.xpdr,
                parking_brake=self.pbrake, flaps_index=1 if self.phase in ("takeoff", "approach") else 0,
                gear_down=self.phase not in ("climb", "cruise", "descent"),
                message=f"mock aircraft, phase {self.phase}",
            )

    def _run(self) -> None:
        last = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            self.step((now - last) * self.speed)
            last = now
            self.on_state(self.snapshot())
            self._stop.wait(self.period)


class NullSimSource(SimSource):
    """Used with ``--no-sim``: reports "not connected" forever."""

    name = "none"

    def _run(self) -> None:
        while not self._stop.is_set():
            self.on_state(SimState(message="no simulator source (started with --no-sim)"))
            self._stop.wait(2.0)
