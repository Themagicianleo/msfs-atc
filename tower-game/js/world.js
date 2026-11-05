// The tower game simulation: traffic, aircraft behaviour, conflicts, score.
// Pure logic (no DOM), so it runs in Node for tests. The UI calls step(dt)
// every frame and command() for every controller instruction, and reads the
// radio/score/alert events from drain().

import { Formatter, render } from './lib/format.js';
import { M_PER_NM, KT, Path, add, dist, dot, headingOf, mul, norm, sub, fromHeading, angleDiff } from './geo.js';
import { endGeometry, onRunway, route, routeCrossings, routeNames, runwayForEnd, taxiwayNames, unknownVia } from './layout.js';
import { zhDigits, zhReason, zhRunway, zhWind } from './zh.js';

// Generic aircraft performance (approach speed and rotation speed in knots).
// Used when an airport has no traffic profile (data/traffic/<ICAO>.json).
export const AIRCRAFT_TYPES = [
  { code: 'A320', wake: 'M', span: 35.8, length: 37.6, vapp: 136, vr: 145 },
  { code: 'B738', wake: 'M', span: 35.8, length: 39.5, vapp: 144, vr: 150 },
  { code: 'A21N', wake: 'M', span: 35.8, length: 44.5, vapp: 140, vr: 150 },
  { code: 'E190', wake: 'M', span: 28.7, length: 36.2, vapp: 130, vr: 135 },
  { code: 'AT76', wake: 'M', span: 27.1, length: 27.2, vapp: 115, vr: 110 },
  { code: 'B789', wake: 'H', span: 60.1, length: 62.8, vapp: 145, vr: 155 },
  { code: 'A359', wake: 'H', span: 64.8, length: 66.8, vapp: 140, vr: 150 },
  { code: 'B77W', wake: 'H', span: 64.8, length: 73.9, vapp: 150, vr: 165 },
];

// ICAO wake turbulence separation. Final approach (NM), leader -> follower;
// anything not listed uses the minimum radar spacing.
const WAKE_NM = { J: { H: 6, M: 7, L: 8 }, H: { H: 4, M: 5, L: 6 }, M: { L: 5 } };
const MIN_RADAR_NM = 3;
// Departures from the same runway (seconds after the leader starts its roll)
const WAKE_DEP_S = { J: { H: 120, M: 180, L: 180 }, H: { M: 120, L: 120 }, M: { L: 120 } };
export function wakeSpacingNm(leader, follower) { return WAKE_NM[leader]?.[follower] || MIN_RADAR_NM; }

export const TRAFFIC_LEVELS = {
  off: { arrPerHour: 0, depPerHour: 0, label: 'No new traffic' },
  calm: { arrPerHour: 8, depPerHour: 8, label: 'Calm' },
  normal: { arrPerHour: 16, depPerHour: 16, label: 'Normal' },
  busy: { arrPerHour: 26, depPerHour: 26, label: 'Busy' },
};

const SPAWN_NM = 10;
const GAME_SPACING_NM = 1; // added to the separation minimum so there is room to work
const TAXI_SPEED = 10; // m/s, about 20 kt
const REPEAT_S = { takeoff: 120, cross: 90, default: 45 }; // pilots call again after this long
const GROUND = new Set(['gate', 'pushback', 'pushed', 'taxi_out', 'holding', 'lineup', 'lined_up', 'takeoff',
  'rollout', 'vacated', 'taxi_in', 'parked']);
const MOVING_ON_TAXIWAYS = new Set(['pushback', 'taxi_out', 'taxi_in', 'lineup', 'rollout']);

export const SCORE = {
  arrived: 50, departed: 50, departedNoHandoff: 15, goAroundNoClearance: -100, goAroundRunwayBusy: -150,
  runwayConflict: -250, groundConflict: -200, repeatCall: -10, gridlock: -30, wake: -75,
};

export class World {
  // profile: data/traffic/<ICAO>.json (real airlines and fleets), types: data/aircraft.json
  constructor({ layout, phr, airlines = {}, rng = Math.random, arrEnd, depEnd, traffic = 'normal', wind = null, unit,
    profile = null, types = null, phrZh = null }) {
    this.L = layout;
    // where the tower is, for how strong a pilot sounds on the radio
    { const t = layout.terminals?.length ? layout.terminals.flat() : (layout.terminal || []); this.towerAt = layout.towerPos || (t.length ? [t.reduce((s, p) => s + p[0], 0) / t.length, t.reduce((s, p) => s + p[1], 0) / t.length] : [0, 0]); }
    this.phr = phr;
    this.rng = rng;
    this.f = new Formatter({ units: { freqStyle: 'icao' } });
    this.airlines = Object.entries(airlines).filter(([k]) => /^[A-Z]{3}$/.test(k));
    if (!this.airlines.length) this.airlines = [['OAT', 'Open Air']];
    this.profile = profile;
    this.types = types;
    this.phrZh = phrZh;
    this.metric = profile?.meta?.units === 'metric';
    this.unitZh = profile?.meta?.tower_zh || null;
    this.arrIdx = 0;
    this.depIdx = 0;
    this.lastRoll = {};
    this.unit = unit || `${layout.airport.municipality || layout.airport.icao} Tower`;
    this.wind = wind;
    this.t = 0;
    this.ac = [];
    this.out = [];
    this.score = 0;
    this.stats = { arrived: 0, departed: 0, goArounds: 0, conflicts: 0, repeats: 0 };
    this.nextId = 1;
    this.requeue = [];
    this.conflictPairs = new Set();
    this.gateUse = new Map();
    this.setRunways(arrEnd, depEnd);
    this.setTraffic(traffic);
    this.nextArr = 25;
    this.nextDep = 4;
  }

  // one runway end or a list (e.g. ['28L', '28R']); arrivals and departures alternate
  setRunways(arrEnd, depEnd) {
    this.arrEnds = [].concat(arrEnd).filter(Boolean);
    this.depEnds = [].concat(depEnd).filter(Boolean);
    this.arrEnd = this.arrEnds[0];
    this.depEnd = this.depEnds[0];
  }

  setTraffic(level) {
    this.traffic = TRAFFIC_LEVELS[level] ? level : 'normal';
  }

  // ---------------------------------------------------------------- radio
  // the aircraft's language: Chinese airlines at Chinese airports use Chinese
  zh(ac) { return ac.lang === 'zh' && !!this.phrZh; }
  phrOf(ac) { return this.zh(ac) ? this.phrZh : this.phr; }

  rwy(ac, id) { return id ? (this.zh(ac) ? zhRunway(id) : this.f.runway(id)) : null; }

  distanceText(ac) {
    if (!ac.dist) return null;
    if (this.zh(ac)) { const km = Math.max(1, Math.round(ac.dist / 1000)); return { t: `${km}公里`, s: `${km}公里` }; }
    if (this.metric) { const km = Math.max(1, Math.round(ac.dist / 1000)); return `${km} kilometres`; }
    return `${Math.max(1, Math.round(ac.dist / M_PER_NM))} miles`;
  }

  windValue(ac) {
    if (this.zh(ac)) return zhWind(this.wind);
    if (this.metric && this.wind?.wind_kt != null) {
      const mps = Math.round(this.wind.wind_kt / 1.943844);
      if (!mps) return { t: 'calm', s: 'calm' };
      const d = this.wind.wind_dir == null ? null : this.f.heading(this.wind.wind_dir);
      return d ? { t: `${d.t}/${mps}MPS`, s: `${d.s} degrees, ${this.f.spell(String(mps))} metres per second` }
        : { t: `variable ${mps}MPS`, s: `variable, ${this.f.spell(String(mps))} metres per second` };
    }
    return this.f.wind(this.wind);
  }

  values(ac, extra = {}) {
    const end = ac.end;
    const zh = this.zh(ac);
    const gate = ac.gate ? { t: ac.gate, s: zh ? zhDigits(ac.gate) : (/^\d+$/.test(ac.gate) ? ac.gate : this.f.spell(ac.gate)) } : null;
    return {
      unit: zh && this.unitZh ? this.unitZh : this.unit,
      callsign: ac.cs,
      runway: this.rwy(ac, end),
      gate,
      approach: 'ILS',
      distance: this.distanceText(ac),
      wind: this.windValue(ac),
      ...extra,
    };
  }

  emit(ev) { this.out.push({ t: this.t, ...ev }); }

  // a phrase can have several wordings (an array): pilots don't all say it the same way
  pickWording(tpl) {
    if (!Array.isArray(tpl)) return tpl;
    return this.variety === false ? tpl[0] : tpl[Math.floor(Math.random() * tpl.length)];
  }

  // what the sound needs: who is talking (airline accent) and how far away (radio static)
  radioInfo(ac) {
    const range = ac.state === 'final' || ac.state === 'go_around' || ac.state === 'climb' ? (ac.dist || 0) + (ac.alt || 0) * 0.3
      : dist(ac.p, this.towerAt || [0, 0]);
    return { voice: ac.voice, airline: ac.code, range: Math.round(range) };
  }

  say(ac, key, extra) {
    const { text, speech } = render(this.pickWording(this.phrOf(ac).pilot[key]), this.values(ac, extra));
    this.emit({ kind: 'pilot', ac: ac.id, callsign: ac.callsign, text, speech, ...this.radioInfo(ac), lang: ac.lang || 'en' });
  }

  readback(ac, key, extra) {
    const { text, speech } = render(this.pickWording(this.phrOf(ac).readback[key]), this.values(ac, extra));
    this.emit({ kind: 'pilot', ac: ac.id, callsign: ac.callsign, text, speech, ...this.radioInfo(ac), readback: true, lang: ac.lang || 'en' });
    return { ok: true, text };
  }

  unable(ac, reason) {
    const said = this.zh(ac) ? zhReason(reason, this.phrZh.reasons) : reason;
    const { text, speech } = render(this.pickWording(this.phrOf(ac).readback.unable), this.values(ac, { reason: said }));
    this.emit({ kind: 'pilot', ac: ac.id, callsign: ac.callsign, text, speech, ...this.radioInfo(ac), unable: true, lang: ac.lang || 'en' });
    return { ok: false, text, reason };
  }

  request(ac, type, key, extra) {
    ac.req = { type, key, extra, t: this.t };
    this.say(ac, key, extra);
  }

  points(delta, reason, ac) {
    this.score += delta;
    this.emit({ kind: 'score', delta, reason, ac: ac?.id, callsign: ac?.callsign });
  }

  alert(text, ac) { this.emit({ kind: 'alert', text, ac: ac?.id }); }

  drain() {
    const o = this.out;
    this.out = [];
    return o;
  }

  // ---------------------------------------------------------------- traffic
  pick(weights) {
    const entries = Object.entries(weights);
    let r = this.rng() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
    return entries[entries.length - 1][0];
  }

  newCallsign() {
    if (this.profile && this.types) {
      const airlines = this.profile.airlines;
      for (let i = 0; i < 50; i += 1) {
        const al = airlines[Number(this.pick(Object.fromEntries(airlines.map((a, k) => [k, a.weight]))))];
        const [lo, hi] = al.numbers;
        const num = String(lo + Math.floor(this.rng() * (hi - lo + 1)));
        const code = this.pick(al.types);
        const t = this.types[code];
        if (!t || this.ac.some((a) => a.num === num || a.callsign === al.code + num)) continue;
        const other = al.destinations[Math.floor(this.rng() * al.destinations.length)];
        return { code: al.code, tel: al.callsign, num, callsign: al.code + num, other, lang: al.lang || 'en', telZh: al.callsign_zh || null,
          type: { code, ...t } };
      }
    }
    for (let i = 0; i < 50; i += 1) {
      const [code, tel] = this.airlines[Math.floor(this.rng() * this.airlines.length)];
      const num = String(10 + Math.floor(this.rng() * 1990));
      const cs = code + num;
      if (!this.ac.some((a) => a.callsign === cs || (a.num === num))) return { code, tel, num, callsign: cs };
    }
    const num = String(this.nextId + 100);
    return { code: 'OAT', tel: 'Open Air', num, callsign: `OAT${num}` };
  }

  makeAircraft(kind, base = null) {
    const c = base || this.newCallsign();
    const type = c.type || AIRCRAFT_TYPES[Math.floor(this.rng() * AIRCRAFT_TYPES.length)];
    const ac = {
      id: this.nextId++, kind, callsign: c.callsign, code: c.code, tel: c.tel, num: c.num, type, other: c.other || null,
      lang: c.lang && this.phrZh ? c.lang : 'en', telZh: c.telZh || null,
      cs: c.lang === 'zh' && c.telZh && this.phrZh ? { t: `${c.telZh}${c.num}`, s: `${c.telZh}${zhDigits(c.num)}` }
        : { t: `${c.tel} ${c.num}`, s: `${c.tel} ${this.f.spell(c.num)}` },
      voice: Math.floor(this.rng() * 1000), p: [0, 0], hdg: 0, alt: 0, v: 0,
      cleared: {}, flags: {}, crossings: [], hold: false, req: null, born: this.t,
    };
    this.ac.push(ac);
    return ac;
  }

  // a free stand big enough for the wingspan (real stands have a size limit)
  freeGate(span = 0) {
    const free = this.L.gates.filter((g) => !this.gateUse.has(g.id) && (!g.maxSpan || g.maxSpan >= span));
    return free.length ? free[Math.floor(this.rng() * free.length)] : null;
  }

  // the last arrival on final for a runway end, if any
  lastOnFinal(end) {
    const finals = this.ac.filter((a) => a.state === 'final' && a.end === end);
    return finals.length ? finals.reduce((m, a) => (a.dist > m.dist ? a : m)) : null;
  }

  // can a new arrival join the final at SPAWN_NM behind the last one?
  finalHasRoom(end, wake) {
    const last = this.lastOnFinal(end);
    if (!last) return true;
    return last.dist <= (SPAWN_NM - wakeSpacingNm(last.type.wake, wake) - GAME_SPACING_NM) * M_PER_NM;
  }

  spawnArrival(base = null, distNm = SPAWN_NM) {
    const c = base || this.newCallsign();
    const type = c.type || AIRCRAFT_TYPES[Math.floor(this.rng() * AIRCRAFT_TYPES.length)];
    const ends = this.arrEnds.length ? this.arrEnds : [this.arrEnd];
    let end = null;
    for (let k = 0; k < ends.length && !end; k += 1) {
      const cand = ends[(this.arrIdx + k) % ends.length];
      if (distNm < SPAWN_NM || this.finalHasRoom(cand, type.wake)) end = cand;
    }
    const gate = this.freeGate(type.span);
    const e = end && endGeometry(this.L, end);
    if (!gate || !e) return null;
    this.arrIdx += 1;
    const ac = this.makeAircraft('arr', { ...c, type });
    ac.end = e.ident;
    ac.gate = gate.id;
    this.gateUse.set(gate.id, ac.id);
    ac.state = 'final';
    ac.dist = distNm * M_PER_NM;
    ac.v = ac.type.vapp * KT;
    this.placeOnFinal(ac);
    this.request(ac, 'land', 'arr_checkin');
    return ac;
  }

  spawnDeparture() {
    const groundDeps = this.ac.filter((a) => a.kind === 'dep' && GROUND.has(a.state)).length;
    if (groundDeps >= Math.max(2, Math.floor(this.L.gates.length / 2))) return null;
    const c = this.newCallsign();
    const type = c.type || AIRCRAFT_TYPES[Math.floor(this.rng() * AIRCRAFT_TYPES.length)];
    const gate = this.freeGate(type.span);
    if (!gate) return null;
    const ac = this.makeAircraft('dep', { ...c, type });
    const ends = this.depEnds.length ? this.depEnds : [this.depEnd];
    ac.end = ends[this.depIdx++ % ends.length];
    ac.gate = gate.id;
    this.gateUse.set(gate.id, ac.id);
    ac.state = 'gate';
    ac.p = [...this.L.graph.nodes[gate.node].p];
    ac.hdg = gate.heading;
    ac.callAt = this.t + 4 + this.rng() * 20;
    return ac;
  }

  spawner(dt) {
    const lvl = TRAFFIC_LEVELS[this.traffic];
    this.nextArr -= dt;
    this.nextDep -= dt;
    const due = this.requeue.find((r) => r.at <= this.t);
    if (due) {
      if (this.spawnArrival(due.base)) this.requeue.splice(this.requeue.indexOf(due), 1);
    } else if (this.nextArr <= 0) {
      if (this.spawnArrival()) this.nextArr = this.interval(lvl.arrPerHour);
    }
    if (this.nextDep <= 0) {
      this.spawnDeparture();
      this.nextDep = this.interval(lvl.depPerHour);
    }
  }

  // random gap, average 3600/rate seconds, never shorter than 40 % of it
  interval(perHour) {
    if (perHour <= 0) return Infinity;
    const mean = 3600 / perHour;
    return mean * (0.4 + 0.6 * -Math.log(1 - this.rng() * 0.95));
  }

  // ---------------------------------------------------------------- movement
  placeOnFinal(ac) {
    const e = endGeometry(this.L, ac.end);
    ac.p = sub(e.thr, mul(e.dir, ac.dist));
    ac.hdg = e.heading;
    ac.alt = Math.max(0, (ac.dist * Math.tan((3 * Math.PI) / 180)) / 0.3048);
  }

  setPath(ac, points, { speed = TAXI_SPEED, backwards = false, nodes = null } = {}) {
    ac.path = new Path(points);
    ac.ps = 0;
    ac.pathSpeed = speed;
    ac.backwards = backwards;
    ac.routeNodes = nodes;
    ac.crossings = [];
    if (nodes) {
      // where each runway crossing is along the path; hold 70 m before it
      for (const c of routeCrossings(this.L, nodes)) {
        const p = this.L.graph.nodes[nodes[c.index]].p;
        const k = ac.path.pts.findIndex((q) => dist(q, p) < 0.5);
        const at = k >= 0 ? ac.path.cum[k] : 0;
        ac.crossings.push({ runway: c.runway, at: Math.max(0, at - 70), cleared: false, called: false });
      }
    }
  }

  // nodes and points for a route from where the aircraft is now
  routeFromHere(ac, to, opts) {
    let start = null;
    let lead = [];
    if (ac.routeNodes && ac.path) {
      // next node ahead on the current route
      const nodes = ac.routeNodes;
      for (const id of nodes) {
        const p = this.L.graph.nodes[id].p;
        const k = ac.path.pts.findIndex((q) => dist(q, p) < 0.5);
        if (k >= 0 && ac.path.cum[k] >= ac.ps - 1) { start = id; break; }
      }
      lead = [ac.p];
    }
    if (start === null) start = ac.atNode;
    if (start === null || start === undefined) return null;
    let nodes;
    if (opts.waypoints?.length) {
      // the controller's own route: through each chosen point in turn
      nodes = [start];
      for (const wp of [...opts.waypoints, to]) {
        const cur = nodes[nodes.length - 1];
        if (wp === cur) continue;
        const leg = route(this.L, cur, wp, {});
        if (!leg) return null;
        nodes = nodes.concat(leg.slice(1));
      }
    } else {
      nodes = route(this.L, start, to, { ...opts, traffic: this.trafficCost(ac) });
    }
    if (!nodes) return null;
    return { nodes, points: [...lead, ...nodes.map((id) => this.L.graph.nodes[id].p)] };
  }

  // Default routes avoid taxiways other aircraft are using in the other
  // direction (as a ground controller would); explicit "via" is still obeyed.
  trafficCost(me) {
    const flows = new Map();
    for (const o of this.ac) {
      if (o === me || !o.routeNodes || !['taxi_out', 'taxi_in', 'pushed', 'holding', 'vacated'].includes(o.state)) continue;
      const nodes = o.routeNodes;
      for (let i = 1; i < nodes.length; i += 1) flows.set(`${nodes[i - 1]}>${nodes[i]}`, true);
    }
    if (!flows.size) return null;
    return (u, v) => (flows.has(`${v}>${u}`) ? 8 : 1);
  }

  // Anyone on the next stretch of our own route (so corners are seen)?
  // At an intersection the lower-numbered aircraft has priority; nose to
  // nose on one taxiway nobody can pass: that is gridlock, see follow().
  trafficAhead(ac, P, decel) {
    if (ac.ghostUntil > this.t) return null;
    const look = Math.max(60, (ac.v ** 2) / (2 * decel) + 45);
    const pts = [];
    for (let d = 8; d <= look; d += 12) {
      if (ac.ps + d > P.length + 10) break;
      pts.push(P.at(ac.ps + d).p);
    }
    const here = P.at(ac.ps).dir;
    for (const o of this.ac) {
      if (o === ac || !GROUND.has(o.state) || o.state === 'gate' || o.state === 'parked') continue;
      if (o.state === 'takeoff' || o.state === 'rollout') continue; // on the runway: crossings handle those
      if (dist(o.p, ac.p) > look + 40) continue;
      // a pushback swings its tail across the lane: keep more room
      const room = o.state === 'pushback' || ac.state === 'pushback' ? 55 : 32;
      if (!pts.some((q) => dist(q, o.p) < room)) continue;
      const oDir = o.moveDir || (o.path ? o.path.at(o.ps).dir : null);
      const headOn = oDir && dot(oDir, here) < -0.7;
      const theyYield = !headOn && o.blockedBy === ac.id && ac.id < o.id && dist(o.p, ac.p) > 45;
      if (!theyYield) return o;
    }
    return null;
  }

  // is the runway free for a departure or landing? used by the UI and tests
  runwayStatus(r) {
    const busy = this.ac.filter((o) => (GROUND.has(o.state) && o.state !== 'gate' && o.state !== 'parked' && onRunway(r, o.p))
      || (o.state === 'climb' && o.alt < 400 && onRunway(r, o.p, 200))
      // cleared onto this runway but not there yet
      || (o.kind === 'dep' && (o.cleared.lineup || o.cleared.takeoff) && ['taxi_out', 'holding', 'lineup', 'lined_up'].includes(o.state)
        && runwayForEnd(this.L, o.end) === r));
    const finals = this.ac.filter((o) => o.state === 'final' && runwayForEnd(this.L, o.end) === r)
      .sort((a, b) => a.dist - b.dist);
    return { clear: busy.length === 0, occupants: busy.map((o) => o.callsign), nextArrivalNm: finals.length ? finals[0].dist / M_PER_NM : null };
  }

  // follow the current path; returns true when the end is reached
  follow(ac, dt, { accel = 1.0, decel = 2.0 } = {}) {
    const P = ac.path;
    let stopAt = P.length;
    const nextCross = ac.crossings.find((c) => !c.cleared && c.at >= ac.ps - 2);
    if (nextCross) stopAt = Math.min(stopAt, nextCross.at);
    const remain = stopAt - ac.ps;
    const here = P.at(ac.ps);
    const moveDir = here.dir; // the direction of travel (also when pushed back tail first)
    ac.moveDir = ac.v > 0.2 ? moveDir : null;
    let target = Math.min(ac.pathSpeed, Math.sqrt(2 * decel * Math.max(0, remain - 0.5)));
    // landing roll: keep rolling, braking to reach the exit at turn-off speed
    if (ac.exitAt !== undefined && ac.ps < ac.exitAt) {
      target = Math.min(target, Math.max(ac.exitSpeed, Math.sqrt(ac.exitSpeed ** 2 + 2 * ac.brake * (ac.exitAt - ac.ps))));
    } else if (ac.exitAt !== undefined) target = Math.min(target, ac.exitSpeed);
    const blocker = MOVING_ON_TAXIWAYS.has(ac.state) && ac.state !== 'rollout' ? this.trafficAhead(ac, P, decel) : null;
    ac.blockedBy = blocker?.id || null;
    if (ac.hold || blocker) target = 0;
    if (ac.v < target) ac.v = Math.min(target, ac.v + accel * dt);
    else ac.v = Math.max(target, ac.v - decel * dt);
    ac.ps = Math.min(stopAt, ac.ps + ac.v * dt);
    const now = P.at(ac.ps);
    ac.p = now.p;
    if (ac.v > 0.2) ac.hdg = headingOf(ac.backwards ? mul(now.dir, -1) : now.dir);
    if (nextCross && stopAt - ac.ps < 1 && ac.v < 0.3 && !nextCross.called) {
      nextCross.called = true;
      const r = this.L.runways.find((x) => x.id === nextCross.runway);
      this.request(ac, 'cross', 'hold_short', { runway: this.rwy(ac, r.identA) });
      ac.waitingCross = nextCross;
    }
    // blocked for a long time by someone who is blocked by us: gridlock
    if (blocker) {
      ac.blockedFor = (ac.blockedFor || 0) + dt;
      if (ac.blockedFor > 40 && !ac.flags.blockedCall) {
        ac.flags.blockedCall = true;
        this.say(ac, 'blocked');
      }
      if (ac.blockedFor > 60 && blocker.blockedBy === ac.id) {
        this.points(SCORE.gridlock, `gridlock: ${ac.callsign} and ${blocker.callsign} blocked each other`, ac);
        ac.ghostUntil = this.t + 25; // they squeeze past each other
        ac.blockedFor = 0;
      }
    } else {
      ac.blockedFor = 0;
      ac.flags.blockedCall = false;
    }
    return ac.ps >= P.length - 0.5 && stopAt === P.length;
  }

  // ---------------------------------------------------------------- per state
  step(dt) {
    this.t += dt;
    this.spawner(dt);
    for (const ac of [...this.ac]) this.update(ac, dt);
    this.checkConflicts();
    for (const ac of this.ac) {
      if (ac.req && this.t - ac.req.t > (REPEAT_S[ac.req.type] || REPEAT_S.default)) {
        ac.req.t = this.t;
        this.stats.repeats += 1;
        this.points(SCORE.repeatCall, `${ac.callsign} had to call again`, ac);
        this.say(ac, ac.req.key, ac.req.extra);
      }
    }
    this.ac = this.ac.filter((a) => !a.remove);
  }

  update(ac, dt) {
    switch (ac.state) {
      case 'final': return this.updateFinal(ac, dt);
      case 'rollout': {
        if (!ac.flags.vacated && ac.ps >= ac.holdLineAt) ac.flags.vacated = true;
        if (this.follow(ac, dt, { decel: ac.brake || 2 })) {
          ac.exitAt = undefined;
          ac.state = 'vacated';
          ac.atNode = ac.exit.t;
          this.request(ac, 'taxi_in', 'vacated');
        }
        return null;
      }
      case 'taxi_in': {
        if (this.follow(ac, dt)) {
          ac.state = 'parked';
          ac.parkedAt = this.t;
          ac.hdg = this.L.gates.find((g) => g.id === ac.gate).heading;
          this.stats.arrived += 1;
          this.points(SCORE.arrived, `${ac.callsign} parked at ${ac.gate}`, ac);
        }
        return null;
      }
      case 'parked':
        if (this.t - ac.parkedAt > 25) { ac.remove = true; this.gateUse.delete(ac.gate); }
        return null;
      case 'gate':
        if (ac.callAt != null && this.t >= ac.callAt) { ac.callAt = null; this.request(ac, 'push', 'push'); }
        return null;
      case 'pushback':
        if (this.follow(ac, dt, { accel: 0.3, decel: 0.5 })) {
          ac.state = 'pushed';
          ac.atNode = this.L.gates.find((g) => g.id === ac.gate).lane;
          this.gateUse.delete(ac.gate);
          ac.callAt = this.t + 3 + this.rng() * 8;
        }
        return null;
      case 'pushed':
        if (ac.callAt != null && this.t >= ac.callAt) { ac.callAt = null; this.request(ac, 'taxi', 'taxi'); }
        return null;
      case 'taxi_out':
        if (this.follow(ac, dt)) {
          ac.state = 'holding';
          ac.v = 0;
          ac.atNode = this.L.holdPoints[ac.end].h;
          if (ac.cleared.lineup || ac.cleared.takeoff) this.startLineup(ac);
          else this.request(ac, 'takeoff', 'ready');
        }
        return null;
      case 'lineup':
        if (this.follow(ac, dt, { decel: 1.0 })) {
          ac.state = 'lined_up';
          ac.linedAt = this.t;
        }
        return null;
      case 'lined_up':
        if (ac.cleared.takeoff && this.t - ac.linedAt > 3 && this.runwayAheadClear(ac)) this.startRoll(ac);
        return null;
      case 'takeoff': return this.updateTakeoff(ac, dt);
      case 'climb': return this.updateClimb(ac, dt);
      case 'go_around': {
        ac.v = Math.min(ac.v + dt, 80);
        ac.alt += 12 / 0.3048 * dt;
        ac.p = add(ac.p, mul(fromHeading(ac.hdg), ac.v * dt));
        if (this.t - ac.goAt > 50) ac.remove = true;
        return null;
      }
      default: return null;
    }
  }

  updateFinal(ac, dt) {
    ac.dist -= ac.v * dt;
    this.placeOnFinal(ac);
    const e = endGeometry(this.L, ac.end);
    if (!ac.cleared.land) {
      if (ac.dist < 2.5 * M_PER_NM && !ac.flags.shortCall) {
        ac.flags.shortCall = true;
        ac.req = { type: 'land', key: 'arr_short_final', t: this.t };
        this.say(ac, 'arr_short_final');
      }
      if (ac.dist < 0.9 * M_PER_NM) return this.goAround(ac, 'no landing clearance', SCORE.goAroundNoClearance);
    } else if (ac.dist < 0.3 * M_PER_NM && ac.dist > 0 && this.runwayBusy(e.runway, ac)) {
      return this.goAround(ac, 'runway not clear', SCORE.goAroundRunwayBusy);
    }
    if (ac.dist <= -300) this.startRollout(ac);
    return null;
  }

  startRollout(ac) {
    const e = endGeometry(this.L, ac.end);
    ac.state = 'rollout';
    ac.alt = 0;
    // first exit the aircraft can make with normal braking (about 2 m/s2) at turn-off speed
    const exitSpeed = 15; // m/s, about 30 kt
    ac.brake = 2.0;
    const need = 300 + (ac.v ** 2 - exitSpeed ** 2) / (2 * ac.brake);
    const exits = this.L.exits[ac.end];
    const ex = exits.find((x) => x.along >= need) || exits[exits.length - 1];
    ac.exit = ex;
    const nodes = this.L.graph.nodes;
    // real exits follow the taxiway's curve; generated ones are straight
    const ids = ex.path || [ex.r, ex.h, ex.t];
    this.setPath(ac, [ac.p, ...ids.map((id) => nodes[id].p)], { speed: 80 });
    ac.exitSpeed = exitSpeed;
    ac.exitAt = ac.path.cum[1];
    const k = ac.path.pts.findIndex((q) => dist(q, nodes[ex.h].p) < 0.5);
    ac.holdLineAt = k >= 0 ? ac.path.cum[k] : ac.path.cum[Math.min(2, ac.path.cum.length - 1)];
    void e;
  }

  startLineup(ac) {
    const hp = this.L.holdPoints[ac.end];
    const e = endGeometry(this.L, ac.end);
    const nodes = this.L.graph.nodes;
    const rp = nodes[hp.r].p;
    ac.state = 'lineup';
    ac.req = null;
    const ids = hp.path || [hp.h, hp.r];
    this.setPath(ac, [ac.p, ...ids.map((id) => nodes[id].p), add(rp, mul(e.dir, 80))], { speed: 6 });
  }

  // what a pilot lined up can see: nobody ahead on the runway, and the
  // previous departure past the runway end or high enough
  runwayAheadClear(ac) {
    const e = endGeometry(this.L, ac.end);
    return !this.ac.some((o) => o !== ac && dot(sub(o.p, ac.p), e.dir) > 0
      && ((GROUND.has(o.state) && onRunway(e.runway, o.p))
        || (o.state === 'climb' && o.alt < 400 && onRunway(e.runway, o.p, 200))));
  }

  startRoll(ac) {
    ac.state = 'takeoff';
    // wake turbulence: too soon behind a heavier departure from the same runway?
    const rw = runwayForEnd(this.L, ac.end)?.id;
    const prev = this.lastRoll[rw];
    const need = prev && WAKE_DEP_S[prev.wake]?.[ac.type.wake];
    if (need && this.t - prev.t < need) {
      this.points(SCORE.wake, `wake turbulence: ${ac.callsign} (${ac.type.wake}) rolled ${Math.round(this.t - prev.t)} s after ${prev.callsign} (${prev.wake}); needs ${need / 60} min`, ac);
      this.alert(`Wake turbulence: ${ac.callsign} departed too soon behind ${prev.callsign}`, ac);
    }
    this.lastRoll[rw] = { t: this.t, wake: ac.type.wake, callsign: ac.callsign };
  }

  updateTakeoff(ac, dt) {
    const e = endGeometry(this.L, ac.end);
    ac.v += 2.2 * dt;
    ac.p = add(ac.p, mul(e.dir, ac.v * dt));
    ac.hdg = e.heading;
    if (ac.v >= ac.type.vr * KT) { ac.state = 'climb'; ac.climbFrom = [...e.thr]; }
    return null;
  }

  updateClimb(ac, dt) {
    ac.v = Math.min(ac.v + 1.5 * dt, 90);
    ac.alt += 11 / 0.3048 * dt;
    ac.p = add(ac.p, mul(fromHeading(ac.hdg), ac.v * dt));
    const d = dist(ac.p, ac.climbFrom);
    if (!ac.cleared.contact && d > 3 * M_PER_NM && !ac.flags.askedHandoff) {
      ac.flags.askedHandoff = true;
      this.request(ac, 'contact', 'handoff');
    }
    if (d > 6 * M_PER_NM || (ac.cleared.contact && ac.alt > 3000)) {
      ac.remove = true;
      this.stats.departed += 1;
      if (ac.cleared.contact) this.points(SCORE.departed, `${ac.callsign} departed`, ac);
      else this.points(SCORE.departedNoHandoff, `${ac.callsign} departed (no frequency change given)`, ac);
    }
    return null;
  }

  goAround(ac, reason, penalty) {
    ac.state = 'go_around';
    ac.goAt = this.t;
    ac.req = null;
    ac.v = Math.max(ac.v, 70);
    this.stats.goArounds += 1;
    this.say(ac, 'go_around');
    if (penalty) this.points(penalty, `${ac.callsign} went around: ${reason}`, ac);
    this.gateUse.delete(ac.gate);
    this.requeue.push({ at: this.t + 120, base: { callsign: ac.callsign, code: ac.code, tel: ac.tel, num: ac.num, type: ac.type } });
    return null;
  }

  // ---------------------------------------------------------------- safety
  runwayBusy(r, except) {
    return this.ac.some((o) => o !== except && GROUND.has(o.state) && o.state !== 'gate' && onRunway(r, o.p));
  }

  checkConflicts() {
    const ground = this.ac.filter((a) => GROUND.has(a.state) && a.state !== 'gate' && a.state !== 'parked');
    for (let i = 0; i < ground.length; i += 1) {
      for (let j = i + 1; j < ground.length; j += 1) {
        const a = ground[i];
        const b = ground[j];
        // aircraft squeezing past after a gridlock were already penalised
        if (a.ghostUntil > this.t || b.ghostUntil > this.t) continue;
        if (dist(a.p, b.p) < 30) this.conflict(a, b, 'ground', SCORE.groundConflict);
      }
    }
    for (const r of this.L.runways) {
      const on = this.ac.filter((a) => (GROUND.has(a.state) && a.state !== 'gate' && onRunway(r, a.p))
        || (a.state === 'final' && runwayForEnd(this.L, a.end) === r && a.dist < 0.25 * M_PER_NM)
        || (a.state === 'climb' && a.alt < 400 && onRunway(r, a.p, 200)));
      const fast = on.filter((a) => a.state === 'takeoff' || a.state === 'climb' || a.state === 'final'
        || (a.state === 'rollout' && a.v > 25));
      for (const a of fast) {
        const dir = fromHeading(a.hdg);
        for (const b of on) {
          if (a === b) continue;
          if (a.state === 'climb' && b.state === 'final') continue;
          if (a.state === 'final' && b.state === 'climb') continue;
          // only traffic ahead of the fast one counts: lining up behind a
          // departing or landing aircraft is normal
          if (a.state !== 'final' && dot(sub(b.p, a.p), dir) < -50) continue;
          // traffic using a crossing (or parallel) runway only conflicts near the intersection
          const own = (x) => (x.state === 'taxi_out' || x.state === 'taxi_in' ? r : (x.end && runwayForEnd(this.L, x.end)));
          if ((own(a) !== r || own(b) !== r) && dist(a.p, b.p) > 700) continue;
          this.conflict(a, b, 'runway', SCORE.runwayConflict, r);
        }
      }
    }
  }

  conflict(a, b, kind, penalty, r) {
    const key = [a.id, b.id].sort((x, y) => x - y).join('-') + kind;
    if (this.conflictPairs.has(key)) return;
    this.conflictPairs.add(key);
    this.stats.conflicts += 1;
    const where = kind === 'runway' ? `on runway ${r.id}` : 'on the ground';
    this.alert(`Conflict ${where}: ${a.callsign} and ${b.callsign}`, a);
    this.points(penalty, `conflict ${where}: ${a.callsign} / ${b.callsign}`, a);
  }

  // ---------------------------------------------------------------- commands
  find(id) { return this.ac.find((a) => a.id === id); }

  // what the controller can tell this aircraft now (for the buttons)
  available(ac) {
    const s = ac.state;
    const list = [];
    if (s === 'final') list.push('land', 'continue', 'go_around');
    if (s === 'gate') list.push('push');
    if (s === 'pushed') list.push('taxi_out');
    if (s === 'taxi_out') list.push('lineup', 'takeoff', ac.hold ? 'continue_taxi' : 'hold_position');
    if (s === 'holding') list.push('lineup', 'takeoff', 'hold_short', 'taxi_out');
    if (s === 'lineup' || s === 'lined_up') list.push('takeoff');
    if (s === 'vacated') list.push('taxi_in');
    if (s === 'taxi_in') list.push(ac.hold ? 'continue_taxi' : 'hold_position', 'taxi_in');
    if (s === 'pushback') list.push(ac.hold ? 'continue_taxi' : 'hold_position');
    if ((s === 'taxi_out' || s === 'taxi_in') && ac.crossings.some((c) => !c.cleared)) list.push('cross');
    if (s === 'climb') list.push('contact');
    return list;
  }

  // cmd = {type, runway?, gate?, via?: [], cross?: [], holdShort?}
  command(id, cmd) {
    const ac = this.find(id);
    if (!ac) return { ok: false, text: 'No such aircraft.' };
    const s = ac.state;
    const runwayArg = cmd.runway ? String(cmd.runway).toUpperCase() : null;
    const done = (key, extra) => { ac.req = null; return this.readback(ac, key, extra); };
    switch (cmd.type) {
      case 'land':
        if (s !== 'final') return this.unable(ac, 'we are not on final');
        if (runwayArg && runwayArg !== ac.end) return this.unable(ac, `we are lined up for runway ${ac.end}`);
        ac.cleared.land = true;
        return done('land');
      case 'continue':
        if (s !== 'final') return this.unable(ac, 'we are not on approach');
        ac.req = null;
        return this.readback(ac, 'continue');
      case 'go_around':
        if (s !== 'final') return this.unable(ac, 'we are not on approach');
        this.goAround(ac, 'instructed by tower', 0);
        return { ok: true };
      case 'push':
        if (s !== 'gate') return this.unable(ac, 'we are not at the stand');
        ac.state = 'pushback';
        {
          const g = this.L.gates.find((x) => x.id === ac.gate);
          const nodes = this.L.graph.nodes;
          // push back along the stand's lead-in line (real stands), or straight out
          const ids = g.push || [g.node, g.lane];
          this.setPath(ac, ids.map((id) => nodes[id].p), { speed: 1.5, backwards: true });
        }
        return done('push');
      case 'taxi':
      case 'taxi_out':
      case 'taxi_in':
        return ac.kind === 'dep' ? this.taxiOut(ac, cmd, runwayArg, done) : this.taxiIn(ac, cmd, done);
      case 'hold_position':
        if (!MOVING_ON_TAXIWAYS.has(s) && s !== 'pushed' && s !== 'holding' && s !== 'vacated') return this.unable(ac, 'we are not taxiing');
        ac.hold = true;
        return this.readback(ac, 'hold_position');
      case 'continue_taxi':
        if (!GROUND.has(s)) return this.unable(ac, 'we are airborne');
        ac.hold = false;
        return this.readback(ac, 'continue_taxi');
      case 'hold_short': {
        if (s === 'holding' && (!runwayArg || runwayArg === ac.end)) {
          // "hold short runway 27" answers the ready call without a clearance
          ac.req = null;
          return this.readback(ac, 'hold_short', { runway: this.rwy(ac, ac.end) });
        }
        const c = this.crossingFor(ac, runwayArg);
        if (!c) return this.unable(ac, 'no runway crossing on our route');
        c.cleared = false;
        return this.readback(ac, 'hold_short', { runway: this.rwy(ac, runwayArg || this.crossIdent(c)) });
      }
      case 'cross': {
        const c = this.crossingFor(ac, runwayArg);
        if (!c) return this.unable(ac, 'no runway crossing on our route');
        c.cleared = true;
        if (ac.waitingCross === c) { ac.waitingCross = null; ac.req = null; }
        return this.readback(ac, 'cross', { runway: this.rwy(ac, runwayArg || this.crossIdent(c)) });
      }
      case 'lineup':
      case 'takeoff': {
        if (!['taxi_out', 'holding', 'lineup', 'lined_up'].includes(s)) return this.unable(ac, 'we are not at the runway');
        if (runwayArg && runwayArg !== ac.end) return this.unable(ac, `we are taxiing for runway ${ac.end}`);
        ac.cleared.lineup = true;
        if (cmd.type === 'takeoff') ac.cleared.takeoff = true;
        if (s === 'holding') this.startLineup(ac);
        return done(cmd.type === 'takeoff' ? 'takeoff' : 'lineup');
      }
      case 'contact':
        if (s !== 'climb') return this.unable(ac, 'we are not airborne yet');
        ac.cleared.contact = true;
        return done('contact');
      default:
        return this.readback(ac, 'say_again');
    }
  }

  crossIdent(c) {
    return this.L.runways.find((r) => r.id === c.runway)?.identA || '';
  }

  crossingFor(ac, ident) {
    const pending = ac.crossings.filter((c) => c.at >= ac.ps - 2);
    if (!ident) return pending[0] || null;
    const r = runwayForEnd(this.L, ident);
    return pending.find((c) => r && c.runway === r.id) || null;
  }

  applyCrossClearances(ac, cross = []) {
    for (const ident of cross) {
      const r = runwayForEnd(this.L, ident);
      for (const c of ac.crossings) if (r && c.runway === r.id) c.cleared = true;
    }
  }

  // "WA B1" is read as "whiskey alpha, bravo one"
  viaText(cmd, ac) {
    if (!cmd.via?.length) return null;
    const names = cmd.via.map((v) => v.toUpperCase());
    if (ac && this.zh(ac)) return { t: names.join('、'), s: names.map(zhDigits).join('、') };
    return { t: names.join(' '), s: names.map((v) => this.f.spell(v)).join(', ') };
  }

  crossText(cmd, ac) {
    if (!cmd.cross?.length) return null;
    if (ac && this.zh(ac)) { const r = cmd.cross.map(zhRunway); return { t: r.map((x) => x.t).join('、'), s: r.map((x) => x.s).join('、') }; }
    const r = cmd.cross.map((id) => this.f.runway(id));
    return { t: r.map((x) => x.t).join(', '), s: r.map((x) => x.s).join(', ') };
  }

  // a taxi route through points the controller picked on the map, for the
  // preview and the instruction: {nodes, points, via, cross, runway|gate}
  planTaxi(ac, { waypoints = [], runway = null, gate = null } = {}) {
    const dep = ac.kind === 'dep';
    if (dep ? !['pushed', 'taxi_out', 'holding'].includes(ac.state) : !['vacated', 'taxi_in'].includes(ac.state)) return null;
    const end = runway || ac.end;
    const g = dep ? null : this.L.gates.find((x) => x.id === (gate || ac.gate));
    const to = dep ? this.L.holdPoints[end]?.h : g?.node;
    if (to === undefined || to === null) return null;
    const r = this.routeFromHere(ac, to, { waypoints });
    if (!r) return null;
    const known = taxiwayNames(this.L);
    const via = routeNames(this.L, r.nodes).filter((n) => known.has(n));
    const cross = routeCrossings(this.L, r.nodes).map((c) => this.L.runways.find((x) => x.id === c.runway)?.identA).filter(Boolean);
    return { ...r, via, cross: [...new Set(cross)], runway: dep ? end : null, gate: dep ? null : g.id };
  }

  taxiOut(ac, cmd, runwayArg, done) {
    if (!['pushed', 'taxi_out', 'holding'].includes(ac.state)) {
      return this.unable(ac, ac.state === 'gate' ? 'we need pushback first' : 'not able to taxi now');
    }
    const end = runwayArg || ac.end;
    if (!this.L.holdPoints[end]) return this.unable(ac, `runway ${end} is not available`);
    const unknown = cmd.waypoints ? [] : unknownVia(this.L, cmd.via);
    if (unknown.length) return this.unable(ac, `we can't find taxiway ${unknown.join(', ')}`);
    const r = this.routeFromHere(ac, this.L.holdPoints[end].h, { via: cmd.via || [], prefer: 'A', waypoints: cmd.waypoints });
    if (!r) return this.unable(ac, 'no taxi route');
    ac.end = end;
    ac.state = 'taxi_out';
    ac.hold = false;
    ac.cleared = {};
    this.setPath(ac, r.points, { nodes: r.nodes });
    this.applyCrossClearances(ac, cmd.cross);
    return done('taxi_out', { via: this.viaText(cmd, ac), cross: this.crossText(cmd, ac) });
  }

  taxiIn(ac, cmd, done) {
    if (!['vacated', 'taxi_in'].includes(ac.state)) return this.unable(ac, 'not able to taxi now');
    let gate = this.L.gates.find((g) => g.id === (cmd.gate || ac.gate).toUpperCase());
    if (!gate) return this.unable(ac, `there is no stand ${cmd.gate}`);
    const user = this.gateUse.get(gate.id);
    if (user && user !== ac.id) return this.unable(ac, `stand ${gate.id} is occupied`);
    if (gate.maxSpan && gate.maxSpan < ac.type.span) return this.unable(ac, `stand ${gate.id} is too small for us`);
    const unknown = cmd.waypoints ? [] : unknownVia(this.L, cmd.via);
    if (unknown.length) return this.unable(ac, `we can't find taxiway ${unknown.join(', ')}`);
    if (gate.id !== ac.gate) { this.gateUse.delete(ac.gate); this.gateUse.set(gate.id, ac.id); ac.gate = gate.id; }
    const r = this.routeFromHere(ac, gate.node, { via: cmd.via || [], prefer: 'B', waypoints: cmd.waypoints });
    if (!r) return this.unable(ac, 'no taxi route');
    ac.state = 'taxi_in';
    ac.hold = false;
    this.setPath(ac, r.points, { nodes: r.nodes });
    this.applyCrossClearances(ac, cmd.cross);
    gate = null;
    return done('taxi_in', { via: this.viaText(cmd, ac), cross: this.crossText(cmd, ac) });
  }

  // what the controller says for a planned route (see planTaxi)
  taxiText(ac, plan, withCross) {
    const extra = { runway: this.rwy(ac, plan.runway || ac.end), via: this.viaText({ via: plan.via }, ac),
      cross: withCross ? this.crossText({ cross: plan.cross }, ac) : null };
    if (plan.gate) extra.gate = { t: plan.gate, s: this.zh(ac) ? zhDigits(plan.gate) : (/^\d+$/.test(plan.gate) ? plan.gate : this.f.spell(plan.gate)) };
    return this.controllerText(ac, 'taxi', extra);
  }

  // controller text for a command button
  controllerText(ac, type, extra = {}) {
    const key = type === 'taxi' ? (ac.kind === 'dep' ? 'taxi_out' : 'taxi_in') : type;
    const tpl = this.phrOf(ac).controller[key];
    if (!tpl) return '';
    const crossing = type === 'cross' ? this.crossingFor(ac, null) : null;
    return render(tpl, this.values(ac, {
      runway: this.rwy(ac, crossing ? this.crossIdent(crossing) : ac.end),
      ...extra,
    })).text;
  }
}

export function angleOk(a, b, tol) { return angleDiff(a, b) <= tol; }
