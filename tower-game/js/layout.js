// Builds a playable airport from real runway data.
//
// Runways (position, length, heading) are real, from OurAirports. OurAirports
// has no taxiways, gates or buildings, so those are GENERATED: a parallel
// taxiway beside each runway with entry/exit connectors and holding points,
// an apron with gates beside the main runway, links between runways, and a
// planarisation step that turns every crossing into a graph node (crossings of
// a runway become "hold short" points). The layout is plausible, not a copy of
// the real airport's taxiways.

import {
  add, dist, dot, makeProjection, mul, norm, perp, segmentIntersection, sub, headingOf, fromHeading,
  pointSegmentDistance, cross,
} from './geo.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const TWY_OFFSET = 200; // runway centreline to parallel taxiway, metres
// the main runway gets two parallels (A inner, B outer) so inbound and
// outbound traffic can pass; other runways get one (C, D)
const MAIN_TWY = [{ off: 190, letter: 'A' }, { off: 290, letter: 'B' }];
const HOLD_OFFSET = 90; // runway centreline to holding point
const LANE_OFFSET = 420; // apron taxilane
const GATE_OFFSET = 490; // gate (aircraft parking position)
const TERMINAL = [545, 625]; // terminal building band
const GATE_SPACING = 75;

export function reciprocal(ident) {
  const m = String(ident).toUpperCase().match(/^(\d{1,2})([LRC]?)$/);
  if (!m) return `${ident}R`;
  const n = ((Number(m[1]) + 17) % 36) + 1;
  const side = { L: 'R', R: 'L', C: 'C', '': '' }[m[2]];
  return `${String(n).padStart(2, '0')}${side}`;
}

function identHeading(ident) {
  const n = Number(String(ident).match(/\d+/)?.[0] || 36);
  return (n % 36) * 10;
}

// pair OurAirports runway ends ("09L" + "27R") into runways in metres
function pairRunways(airport, proj) {
  const ends = (airport.runways || []).filter((e) => !e.closed && e.ident && !/^H/i.test(e.ident));
  const used = new Set();
  const out = [];
  for (const e of ends) {
    if (used.has(e.ident)) continue;
    used.add(e.ident);
    const o = ends.find((x) => !used.has(x.ident) && x.ident === e.opposite);
    if (o) used.add(o.ident);
    const lengthM = (e.length_ft || o?.length_ft || 8000) * 0.3048;
    let a; let b;
    const coords = e.lat != null && e.lon != null && o && o.lat != null && o.lon != null;
    if (coords) {
      a = proj.toXY(e.lat, e.lon);
      b = proj.toXY(o.lat, o.lon);
      if (dist(a, b) < 300) a = null; // bad data
    }
    let synthetic = false;
    if (!a) {
      const dir = fromHeading(e.heading ?? identHeading(e.ident));
      a = mul(dir, -lengthM / 2);
      b = mul(dir, lengthM / 2);
      synthetic = true;
    }
    out.push({ identA: e.ident.toUpperCase(), identB: (o?.ident || reciprocal(e.ident)).toUpperCase(), a, b, synthetic,
      surface: e.surface || '' });
  }
  // runways without coordinates all sit on the reference point: spread them out
  out.filter((r) => r.synthetic).forEach((r, k) => {
    const shift = mul(perp(norm(sub(r.b, r.a))), 700 * k);
    r.a = add(r.a, shift);
    r.b = add(r.b, shift);
  });
  for (const r of out) {
    r.dir = norm(sub(r.b, r.a));
    r.len = dist(r.a, r.b);
    r.mid = mul(add(r.a, r.b), 0.5);
    r.id = `${r.identA}/${r.identB}`;
    r.width = r.len > 2400 ? 60 : 45;
    r.headingA = headingOf(r.dir);
    r.headingB = (r.headingA + 180) % 360;
  }
  return out;
}

class Graph {
  constructor() {
    this.nodes = [];
    this.edges = [];
  }

  node(p, kind, extra = {}) {
    const id = this.nodes.length;
    this.nodes.push({ id, p, kind, ...extra });
    return id;
  }

  edge(a, b, name, kind, extra = {}) {
    if (a === b) return;
    this.edges.push({ a, b, name, kind, ...extra });
  }

  // split every edge at every proper crossing so the network is connected
  // where lines cross; crossings of a runway become 'rwyx' nodes
  planarize() {
    const splits = this.edges.map(() => []);
    for (let i = 0; i < this.edges.length; i += 1) {
      const e = this.edges[i];
      for (let j = i + 1; j < this.edges.length; j += 1) {
        const f = this.edges[j];
        if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
        if (e.kind === 'runway' && f.kind === 'runway' && e.runway === f.runway) continue;
        const x = segmentIntersection(this.nodes[e.a].p, this.nodes[e.b].p, this.nodes[f.a].p, this.nodes[f.b].p);
        if (!x) continue;
        const rw = e.kind === 'runway' ? e : (f.kind === 'runway' ? f : null);
        let kind = 'x';
        const extra = {};
        if (e.kind === 'runway' && f.kind === 'runway') kind = 'rwyint';
        else if (rw) { kind = 'rwyx'; extra.runway = rw.runway; }
        const id = this.node(x.p, kind, extra);
        splits[i].push({ t: x.t, id });
        splits[j].push({ t: x.u, id });
      }
    }
    const out = [];
    this.edges.forEach((e, i) => {
      const cuts = splits[i].sort((m, n) => m.t - n.t);
      let prev = e.a;
      for (const c of cuts) { out.push({ ...e, a: prev, b: c.id }); prev = c.id; }
      out.push({ ...e, a: prev, b: e.b });
    });
    this.edges = out;
  }

  finish() {
    this.adj = this.nodes.map(() => []);
    this.edges.forEach((e, i) => {
      e.id = i;
      e.len = dist(this.nodes[e.a].p, this.nodes[e.b].p);
      this.adj[e.a].push(i);
      this.adj[e.b].push(i);
    });
  }
}

// sorted unique values, merging values closer than tol
function mergeSorted(values, tol) {
  const s = [...values].sort((x, y) => x - y);
  const out = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

function clearanceOnSide(r, side, others) {
  const n = mul(perp(r.dir), side);
  let best = Infinity;
  for (let k = 0.15; k <= 0.85; k += 0.1) {
    const p = add(add(r.a, mul(r.dir, r.len * k)), mul(n, (LANE_OFFSET + TERMINAL[1]) / 2));
    for (const o of others) best = Math.min(best, pointSegmentDistance(p, o.a, o.b).d);
  }
  return best;
}

export function buildLayout(airport, { maxRunways = 3, minLengthM = 1200 } = {}) {
  if (airport.lat == null || airport.lon == null) throw new Error(`${airport.icao}: no airport position`);
  const proj = makeProjection(airport.lat, airport.lon);
  let runways = pairRunways(airport, proj).sort((x, y) => y.len - x.len);
  if (!runways.length) throw new Error(`${airport.icao}: no usable runways in the data`);
  const long = runways.filter((r) => r.len >= minLengthM);
  runways = (long.length ? long : runways.slice(0, 1)).slice(0, maxRunways);

  const g = new Graph();
  const primary = runways[0];
  const others = runways.slice(1);
  // apron side of the main runway: the side with room, preferring the side of
  // the airport reference point (often where the terminal is)
  const towardRef = Math.sign(cross(primary.dir, sub([0, 0], primary.mid))) || 1;
  const room = { 1: clearanceOnSide(primary, 1, others), [-1]: clearanceOnSide(primary, -1, others) };
  let apronSide = towardRef;
  if (room[towardRef] < 900 && room[-towardRef] > room[towardRef]) apronSide = -towardRef;

  // nothing generated may sit on another runway
  const clearOf = (r, p, margin = 60) => !runways.some((o) => o !== r && onRunway(o, p, margin));
  const atOn = (r, side, s, off) => add(add(r.a, mul(r.dir, s)), mul(mul(perp(r.dir), side), off));

  const apronStart = Math.max(150, primary.len * 0.2);
  const apronEnd = Math.min(primary.len - 150, primary.len * 0.8);
  const span = Math.max(300, apronEnd - apronStart);
  const nSlots = Math.max(4, Math.min(24, Math.floor(span / GATE_SPACING)));
  const gateS = Array.from({ length: nSlots }, (_, i) => apronStart + ((i + 0.5) * span) / nSlots)
    .filter((s) => [LANE_OFFSET, GATE_OFFSET, TERMINAL[1]].every((off) => clearOf(primary, atOn(primary, apronSide, s, off), 80)));
  if (gateS.length < 2) throw new Error(`${airport.icao}: no room for an apron beside the main runway`);
  const nGates = gateS.length;
  const linkIdx = [...new Set([0, Math.floor(nGates / 2), nGates - 1])];

  const info = { runways, holdPoints: {}, exits: {}, gates: [], lanes: [] };
  const twyNodes = []; // per runway: every parallel taxiway node [{s, id}]
  const runwayOuter = []; // per runway: outermost parallel taxiway nodes

  runways.forEach((r, k) => {
    const parallels = k === 0 ? MAIN_TWY : [{ off: TWY_OFFSET, letter: LETTERS[k + 1] }];
    const letter = parallels[0].letter;
    let side;
    if (k === 0) side = apronSide;
    else {
      side = Math.sign(cross(r.dir, sub(primary.mid, r.mid))) || 1;
      const blocked = (sd) => runways.some((o) => o !== r && Math.abs(dot(o.dir, r.dir)) > 0.96
        && pointSegmentDistance(add(r.mid, mul(perp(r.dir), sd * TWY_OFFSET)), o.a, o.b).d < 250);
      if (blocked(side) && !blocked(-side)) side = -side;
    }
    r.side = side;
    r.letter = letter;
    const n = mul(perp(r.dir), side);
    const at = (s, off) => add(add(r.a, mul(r.dir, s)), mul(n, off));

    // exits for landings from each end, plus both runway ends
    const exitFrac = [0.42, 0.58, 0.75];
    const fromA = exitFrac.map((f) => Math.min(r.len - 250, Math.max(900, r.len * f)));
    const fromB = fromA.map((s) => r.len - s);
    const free = (s) => [0, HOLD_OFFSET, ...parallels.map((x) => x.off)].every((off) => clearOf(r, at(s, off)));
    // runway-end connectors must exist: slide them inward until clear
    const slide = (start, step) => {
      for (let s = start, i = 0; i < 6; i += 1, s += step) if (free(s)) return s;
      return start;
    };
    const s0 = slide(0, 100);
    const s1 = slide(r.len, -100);
    const connS = mergeSorted([s0, s1, ...fromA, ...fromB].filter((s) => s >= s0 && s <= s1), 160)
      .filter((s, i, all) => i === 0 || i === all.length - 1 || free(s));
    const extraS = k === 0 ? linkIdx.map((i) => gateS[i]) : [];
    const twyS = mergeSorted([...connS, ...extraS], 40);

    const rwyNode = {};
    connS.forEach((s) => { rwyNode[s] = g.node(at(s, 0), 'rwy', { runway: r.id }); });
    const lines = parallels.map((par) => twyS.map((s) => ({ s, id: g.node(at(s, par.off), 'twy') })));
    const twyId = lines[lines.length - 1]; // outermost: links and apron join here
    twyNodes.push(lines.flat());
    runwayOuter.push(twyId);
    // runway centreline
    for (let i = 1; i < connS.length; i += 1) g.edge(rwyNode[connS[i - 1]], rwyNode[connS[i]], r.id, 'runway', { runway: r.id });
    // parallel taxiway
    lines.forEach((line, j) => {
      for (let i = 1; i < line.length; i += 1) g.edge(line[i - 1].id, line[i].id, parallels[j].letter, 'twy');
    });
    // connectors with holding points
    const exitsA = [];
    const exitsB = [];
    connS.forEach((s, i) => {
      const name = `${letter}${i + 1}`;
      const h = g.node(at(s, HOLD_OFFSET), 'hold', { runway: r.id, name });
      const near = (line) => line.reduce((best, x) => (Math.abs(x.s - s) < Math.abs(best.s - s) ? x : best)).id;
      g.edge(rwyNode[s], h, name, 'conn', { runway: r.id });
      let prev = h;
      for (const line of lines) { const id = near(line); g.edge(prev, id, name, 'conn'); prev = id; }
      const t = near(lines[0]); // first taxiway node clear of the runway
      const ex = { s, r: rwyNode[s], h, t, name };
      if (s > 600) exitsA.push({ ...ex, along: s });
      if (r.len - s > 600) exitsB.push({ ...ex, along: r.len - s });
      if (i === 0) info.holdPoints[r.identA] = { h, r: rwyNode[s], name, runway: r.id };
      if (i === connS.length - 1) info.holdPoints[r.identB] = { h, r: rwyNode[s], name, runway: r.id };
    });
    info.exits[r.identA] = exitsA.sort((x, y) => x.along - y.along);
    info.exits[r.identB] = exitsB.sort((x, y) => x.along - y.along);
  });

  // apron, gates and terminal beside the main runway
  {
    const r = primary;
    const n = mul(perp(r.dir), r.side);
    const at = (s, off) => add(add(r.a, mul(r.dir, s)), mul(n, off));
    const lane = gateS.map((s) => g.node(at(s, LANE_OFFSET), 'lane'));
    for (let i = 1; i < lane.length; i += 1) g.edge(lane[i - 1], lane[i], 'APRON', 'lane');
    linkIdx.forEach((i, j) => {
      const t = runwayOuter[0].find((x) => Math.abs(x.s - gateS[i]) < 1).id;
      g.edge(t, lane[i], `J${j + 1}`, 'link');
    });
    // stands are numbered (letters would clash with taxiway names like A1)
    gateS.forEach((s, i) => {
      const id = String(i + 1);
      const node = g.node(at(s, GATE_OFFSET), 'gate', { gate: id });
      g.edge(lane[i], node, id, 'stand');
      info.gates.push({ id, node, lane: lane[i], heading: headingOf(n) });
    });
    const s0 = gateS[0] - GATE_SPACING / 2;
    const s1 = gateS[nGates - 1] + GATE_SPACING / 2;
    info.apron = [at(s0, LANE_OFFSET - 40), at(s1, LANE_OFFSET - 40), at(s1, TERMINAL[0]), at(s0, TERMINAL[0])];
    info.terminal = [at(s0, TERMINAL[0]), at(s1, TERMINAL[0]), at(s1, TERMINAL[1]), at(s0, TERMINAL[1])];
    info.towerPos = at((s0 + s1) / 2, TERMINAL[1] + 60);
  }

  // join every other runway's taxiway to the main network at the closest point
  for (let k = 1; k < runways.length; k += 1) {
    const mine = twyNodes[k].map((x) => x.id);
    const theirs = g.nodes.filter((nd) => (nd.kind === 'twy' || nd.kind === 'lane') && !mine.includes(nd.id)
      && !twyNodes.slice(k + 1).some((list) => list.some((x) => x.id === nd.id)));
    let best = null;
    for (const a of mine) {
      for (const b of theirs) {
        const d = dist(g.nodes[a].p, b.p);
        if (!best || d < best.d) best = { a, b: b.id, d };
      }
    }
    if (best) g.edge(best.a, best.b, `${LETTERS[k]}L`, 'link');
  }

  g.planarize();
  g.finish();
  return { airport, proj, graph: g, ...info };
}

// ------------------------------------------------------------------ routing

// Dijkstra over taxiways. Runway centrelines are never used for taxiing and
// runway nodes only as start/end. "via" taxiway names are preferred.
// ------------------------------------------------------------------ routing

// small binary min-heap of [priority, value]
// a binary heap in two plain arrays (no object per entry: the route search is
// the busiest code in the game)
class Heap {
  constructor() { this.keys = []; this.vals = []; this.top = 0; }
  get size() { return this.keys.length; }
  push(k, v) {
    const keys = this.keys; const vals = this.vals;
    let i = keys.length;
    keys.push(k); vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p]; vals[i] = vals[p];
      i = p;
    }
    keys[i] = k; vals[i] = v;
  }
  // removes the smallest; its key is in .topKey, and it is returned
  pop() {
    const keys = this.keys; const vals = this.vals;
    const topVal = vals[0];
    this.topKey = keys[0];
    const k = keys.pop(); const v = vals.pop();
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r] < keys[l] ? r : l;
        if (keys[m] >= k) break;
        keys[i] = keys[m]; vals[i] = vals[m];
        i = m;
      }
      keys[i] = k; vals[i] = v;
    }
    return topVal;
  }
}

// shortest path from `from` to the first node accepted by isTarget
// Shortest path. With a heuristic (the straight-line distance to the one
// target, which never overestimates because every weight is at least the
// segment's length) it is A*: it looks mostly toward the target and examines a
// fraction of the layout (Daxing has 15,000 nodes).
function search(g, from, isTarget, weight, passable, heuristic = null) {
  const n = g.nodes.length;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const h = heuristic || (() => 0);
  best[from] = 0;
  heap.push(h(from), from);
  while (heap.size) {
    const u = heap.pop();
    const f = heap.topKey;
    if (f > best[u] + h(u) + 1e-9) continue; // an outdated entry
    const d = best[u];
    if (u !== from && isTarget(u)) {
      const nodes = [];
      for (let v = u; v >= 0; v = prev[v]) nodes.unshift(v);
      return nodes;
    }
    for (const ei of g.adj[u]) {
      const e = g.edges[ei];
      if (e.kind === 'runway') continue;
      // a one-way lane (dir 1: a to b, -1: b to a) can only be entered at its start
      if ((e.dir === 1 && e.a !== u) || (e.dir === -1 && e.b !== u)) continue;
      const v = e.a === u ? e.b : e.a;
      if (!passable(v)) continue;
      const w = weight(e, u, v);
      if (d + w < best[v]) { best[v] = d + w; prev[v] = u; heap.push(d + w + h(v), v); }
    }
  }
  return null;
}

// taxiway names a layout knows (for "via" and for the parser)
export function taxiwayNames(layout) {
  if (!layout._names) {
    layout._names = new Set(layout.graph.edges.filter((e) => e.kind === 'twy' || e.kind === 'conn' || e.kind === 'link')
      .map((e) => e.name).filter(Boolean));
  }
  return layout._names;
}

export function unknownVia(layout, via = []) {
  const names = taxiwayNames(layout);
  return via.map((v) => v.toUpperCase()).filter((v) => !names.has(v));
}

// Taxi route over taxiways: runway centrelines are never used for taxiing,
// runway and stand nodes only as start or end. "via" taxiways are followed
// in the given order. prefer: 'A' or 'B' biases the generated main parallels.
// traffic(u, v): extra cost factor for driving u -> v (e.g. against other traffic)
export function route(layout, from, to, { via = [], prefer = null, traffic = null } = {}) {
  const g = layout.graph;
  if (from === to) return [from];
  const passable = (v) => {
    const k = g.nodes[v].kind;
    return v === to || (k !== 'rwy' && k !== 'gate');
  };
  const names = via.map((v) => v.toUpperCase()).filter((v) => taxiwayNames(layout).has(v));
  const preferW = (e) => (prefer && e.kind === 'twy' && (e.name === 'A' || e.name === 'B') && e.name !== prefer ? 1.6 : 1);
  const tf = traffic || (() => 1);
  const tp = g.nodes[to].p;
  const toward = (v) => { const p = g.nodes[v].p; const dx = p[0] - tp[0]; const dy = p[1] - tp[1]; return Math.sqrt(dx * dx + dy * dy); }; // (Math.hypot is slow)
  if (!names.length) return search(g, from, (v) => v === to, (e, u, v) => e.len * preferW(e) * tf(u, v), passable, toward);
  // follow each named taxiway in turn: get onto it, then use it towards the next
  const touching = (name) => {
    const cache = layout._touching || (layout._touching = new Map());
    if (!cache.has(name)) {
      const set = new Set();
      for (const e of g.edges) if (e.name === name) { set.add(e.a); set.add(e.b); }
      cache.set(name, set);
    }
    return cache.get(name);
  };
  let path = [from];
  let cur = from;
  for (let i = 0; i < names.length; i += 1) {
    const on = touching(names[i]);
    if (on.has(cur)) continue;
    const ok = new Set([names[i - 1], names[i]]);
    const leg = search(g, cur, (v) => on.has(v), (e) => e.len * (ok.has(e.name) || e.kind === 'stand' ? 1 : 4), passable);
    if (!leg) return null;
    path = path.concat(leg.slice(1));
    cur = leg[leg.length - 1];
  }
  const lastName = names[names.length - 1];
  const leg = search(g, cur, (v) => v === to, (e) => e.len * (e.name === lastName || e.kind === 'stand' ? 1 : 3), passable, toward);
  if (!leg) return null;
  return path.concat(leg.slice(1));
}

// names of the taxiways a node route uses, in order, without repeats
export function routeNames(layout, nodes) {
  const g = layout.graph;
  const names = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const e = g.adj[nodes[i - 1]].map((k) => g.edges[k]).find((x) => x.a === nodes[i] || x.b === nodes[i]);
    if (!e || e.kind === 'stand' || e.kind === 'lane') continue;
    if (names[names.length - 1] !== e.name) names.push(e.name);
  }
  return names;
}

// runways crossed by a node route: [{runway, index}] (index of the crossing node)
export function routeCrossings(layout, nodes) {
  const out = [];
  nodes.forEach((id, i) => {
    const nd = layout.graph.nodes[id];
    if (nd.kind === 'rwyx' && !out.some((c) => c.runway === nd.runway && i - c.index < 3)) out.push({ runway: nd.runway, index: i });
  });
  return out;
}

export function runwayForEnd(layout, ident) {
  const id = String(ident).toUpperCase();
  return layout.runways.find((r) => r.identA === id || r.identB === id) || null;
}

// threshold point and landing/take-off direction for a runway end
export function endGeometry(layout, ident) {
  const r = runwayForEnd(layout, ident);
  if (!r) return null;
  const isA = r.identA === String(ident).toUpperCase();
  return { runway: r, thr: isA ? r.a : r.b, far: isA ? r.b : r.a, dir: isA ? r.dir : mul(r.dir, -1),
    heading: isA ? r.headingA : r.headingB, ident: isA ? r.identA : r.identB };
}

// is a point on the runway surface (with a margin)?
export function onRunway(r, p, margin = 0) {
  const rel = sub(p, r.a);
  const along = dot(rel, r.dir);
  const across = Math.abs(cross(r.dir, rel));
  return along > -margin && along < r.len + margin && across < r.width / 2 + 25 + margin;
}
