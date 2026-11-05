// Real airport layout from OpenStreetMap data (Overpass JSON, "out body geom").
//
// Runways, named taxiways and taxilanes, holding positions, stands (parking
// positions), aprons and terminals come from OSM. The result has the same
// shape as layout.js's generated airports, so the simulation and the map use
// it unchanged. Used at build time (tools/build_hq.mjs) and in tests.

import { add, cross, dist, dot, headingOf, makeProjection, mul, norm, perp, pointSegmentDistance, segmentIntersection, sub } from './geo.js';

const HOLD_MIN = 75; // a synthesised holding point is at least this far from the centreline (m)
const CLEAR_OF_RUNWAY = 105; // where a vacating aircraft stops, from the centreline (m)
const STAND_LINK_MAX = 150; // a stand further than this from any taxilane is dropped (m)

function tagsOf(e) { return e.tags || {}; }
function firstRef(t) { return String(t.ref || '').split(';')[0].trim().toUpperCase(); }
const isClosed = (w) => w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1];

class Net {
  constructor() { this.nodes = []; this.edges = []; this.byOsm = new Map(); }

  node(p, kind, extra = {}) {
    const id = this.nodes.length;
    this.nodes.push({ id, p, kind, ...extra });
    return id;
  }

  osmNode(osmId, p) {
    let id = this.byOsm.get(osmId);
    if (id === undefined) { id = this.node(p, 'twy', { osm: osmId }); this.byOsm.set(osmId, id); }
    return id;
  }

  edge(a, b, name, kind, extra = {}) {
    if (a !== b) this.edges.push({ a, b, name, kind, ...extra });
  }

  // split edges where they cross without a shared node (spatial grid, so it stays fast)
  planarize(cell = 200) {
    const P = (i) => this.nodes[i].p;
    const grid = new Map();
    this.edges.forEach((e, i) => {
      const [x1, y1] = P(e.a); const [x2, y2] = P(e.b);
      for (let gx = Math.floor(Math.min(x1, x2) / cell); gx <= Math.floor(Math.max(x1, x2) / cell); gx += 1) {
        for (let gy = Math.floor(Math.min(y1, y2) / cell); gy <= Math.floor(Math.max(y1, y2) / cell); gy += 1) {
          const k = `${gx},${gy}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
      }
    });
    const splits = this.edges.map(() => []);
    const seen = new Set();
    for (const list of grid.values()) {
      for (let x = 0; x < list.length; x += 1) {
        for (let y = x + 1; y < list.length; y += 1) {
          const i = list[x]; const j = list[y];
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const e = this.edges[i]; const f = this.edges[j];
          if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
          if ((e.layer || 0) !== (f.layer || 0)) continue; // bridges
          if (e.kind === 'runway' && f.kind === 'runway' && e.runway === f.runway) continue;
          if (e.kind === 'holdline' && f.kind === 'holdline') continue;
          const hit = segmentIntersection(P(e.a), P(e.b), P(f.a), P(f.b));
          if (!hit) continue;
          let kind = 'x';
          const extra = {};
          const rw = e.kind === 'runway' ? e : (f.kind === 'runway' ? f : null);
          const hl = e.kind === 'holdline' ? e : (f.kind === 'holdline' ? f : null);
          if (e.kind === 'runway' && f.kind === 'runway') kind = 'rwyint';
          else if (hl) { kind = 'hold'; extra.name = hl.name; }
          else if (rw) { kind = 'rwyx'; extra.runway = rw.runway; }
          const id = this.node(hit.p, kind, extra);
          splits[i].push({ t: hit.t, id });
          splits[j].push({ t: hit.u, id });
        }
      }
    }
    const out = [];
    this.edges.forEach((e, i) => {
      let prev = e.a;
      for (const c of splits[i].sort((m, n) => m.t - n.t)) { out.push({ ...e, a: prev, b: c.id }); prev = c.id; }
      out.push({ ...e, a: prev, b: e.b });
    });
    this.edges = out;
  }

  finish() {
    this.edges = this.edges.filter((e) => e.kind !== 'holdline');
    this.adj = this.nodes.map(() => []);
    this.edges.forEach((e, i) => {
      e.id = i;
      e.len = dist(this.nodes[e.a].p, this.nodes[e.b].p);
      this.adj[e.a].push(i);
      this.adj[e.b].push(i);
    });
  }
}

function polygonOf(way, proj) {
  return way.geometry.map((g) => proj.toXY(g.lat, g.lon));
}

function relationRings(rel, proj) {
  return (rel.members || []).filter((m) => m.role !== 'inner' && m.geometry)
    .map((m) => m.geometry.filter(Boolean).map((g) => proj.toXY(g.lat, g.lon))).filter((r) => r.length > 2);
}

// runway ends: which end is "02L" and which "20R"
function runwayFromPoints(ref, pts, width) {
  let best = [pts[0], pts[0]];
  let bestD = -1;
  // farthest pair (runway ways are few points; fine)
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const d = dist(pts[i], pts[j]);
      if (d > bestD) { bestD = d; best = [pts[i], pts[j]]; }
    }
  }
  const idents = ref.split('/').map((s) => s.trim().toUpperCase());
  let [a, b] = best;
  const hdgAB = headingOf(sub(b, a));
  const want = Number((idents[0].match(/\d+/) || ['0'])[0]) * 10;
  const diff = Math.abs(((hdgAB - want + 540) % 360) - 180);
  if (diff > 90) [a, b] = [b, a]; // a is the threshold of idents[0]
  const r = { identA: idents[0], identB: idents[1] || idents[0], a, b };
  r.dir = norm(sub(b, a));
  r.len = dist(a, b);
  r.mid = mul(add(a, b), 0.5);
  r.id = `${r.identA}/${r.identB}`;
  r.width = width || (r.len > 2400 ? 60 : 45);
  r.headingA = headingOf(r.dir);
  r.headingB = (r.headingA + 180) % 360;
  return r;
}

export function layoutFromOsm(osm, meta) {
  const els = osm.elements || [];
  const ways = els.filter((e) => e.type === 'way' && e.geometry && e.nodes);
  // origin: middle of the runways
  const rwyWays = ways.filter((w) => tagsOf(w).aeroway === 'runway' && tagsOf(w).ref && !isClosed(w) && tagsOf(w).area !== 'yes');
  if (!rwyWays.length) throw new Error(`${meta.icao}: no runways in the OpenStreetMap data`);
  const allRw = rwyWays.flatMap((w) => w.geometry);
  const lat0 = allRw.reduce((s, g) => s + g.lat, 0) / allRw.length;
  const lon0 = allRw.reduce((s, g) => s + g.lon, 0) / allRw.length;
  const proj = makeProjection(lat0, lon0);
  const net = new Net();
  const xy = (g) => proj.toXY(g.lat, g.lon);

  // runways
  const byRef = new Map();
  for (const w of rwyWays) {
    const ref = String(tagsOf(w).ref).toUpperCase().replace(/\s+/g, '');
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(w);
  }
  const runways = [];
  for (const [ref, list] of byRef) {
    const width = Number(String(tagsOf(list[0]).width || '').replace(/[^\d.]/g, '')) || null;
    const r = runwayFromPoints(ref, list.flatMap((w) => w.geometry.map(xy)), width);
    if (r.len < 800) continue;
    runways.push(r);
    for (const w of list) {
      for (let i = 1; i < w.nodes.length; i += 1) {
        const a = net.osmNode(w.nodes[i - 1], xy(w.geometry[i - 1]));
        const b = net.osmNode(w.nodes[i], xy(w.geometry[i]));
        net.nodes[a].kind = 'rwy'; net.nodes[a].runway = r.id;
        net.nodes[b].kind = 'rwy'; net.nodes[b].runway = r.id;
        net.edge(a, b, r.id, 'runway', { runway: r.id });
      }
    }
  }
  runways.sort((x, y) => y.len - x.len);

  // taxiways and taxilanes
  const taxiNodes = new Set();
  for (const w of ways) {
    const t = tagsOf(w);
    if (t.aeroway !== 'taxiway' && t.aeroway !== 'taxilane') continue;
    if (isClosed(w) && t.area === 'yes') continue;
    const kind = t.aeroway === 'taxilane' ? 'lane' : 'twy';
    const name = firstRef(t) || (t.name ? String(t.name).toUpperCase() : '');
    const layer = Number(t.layer || 0) || 0;
    for (let i = 1; i < w.nodes.length; i += 1) {
      const a = net.osmNode(w.nodes[i - 1], xy(w.geometry[i - 1]));
      const b = net.osmNode(w.nodes[i], xy(w.geometry[i]));
      taxiNodes.add(a); taxiNodes.add(b);
      net.edge(a, b, name, kind, { layer });
    }
  }
  // runway nodes that taxiways use are crossings/entries
  for (const id of taxiNodes) if (net.nodes[id].kind === 'rwy') net.nodes[id].kind = 'rwyx';

  // holding positions: tagged nodes on taxiways, or lines across them
  for (const e of els) {
    const t = tagsOf(e);
    if (t.aeroway !== 'holding_position') continue;
    if (e.type === 'node' && net.byOsm.has(e.id)) {
      const n = net.nodes[net.byOsm.get(e.id)];
      if (n.kind === 'twy') { n.kind = 'hold'; n.name = firstRef(t) || ''; }
    } else if (e.type === 'way' && e.geometry) {
      for (let i = 1; i < e.nodes.length; i += 1) {
        const a = net.node(xy(e.geometry[i - 1]), 'tmp');
        const b = net.node(xy(e.geometry[i]), 'tmp');
        net.edge(a, b, firstRef(t), 'holdline');
      }
    }
  }
  net.planarize();
  net.finish();

  const L = { airport: meta, proj, graph: net, runways, holdPoints: {}, exits: {}, gates: [], aprons: [], terminals: [], buildings: [] };
  // a runway holding point belongs to the nearest runway if it is close to it
  for (const n of net.nodes) {
    if (n.kind !== 'hold') continue;
    let best = null;
    for (const r of runways) {
      const d = pointSegmentDistance(n.p, r.a, r.b).d;
      if (!best || d < best.d) best = { r, d };
    }
    if (best && best.d < 160) n.runway = best.r.id; else n.kind = 'twy';
  }

  // aprons, terminals, buildings
  for (const e of els) {
    const t = tagsOf(e);
    const rings = e.type === 'way' && e.geometry ? (isClosed(e) ? [polygonOf(e, proj)] : [])
      : (e.type === 'relation' ? relationRings(e, proj) : []);
    if (!rings.length) continue;
    if (t.aeroway === 'apron') L.aprons.push(...rings);
    else if (t.aeroway === 'terminal' || t.building === 'terminal') L.terminals.push(...rings);
    else if (t.building === 'hangar' || t.aeroway === 'hangar' || t.building === 'control_tower') L.buildings.push(...rings);
  }
  const apronCentre = L.aprons.length
    ? mul(L.aprons.flat().reduce((s, p) => add(s, p), [0, 0]), 1 / L.aprons.flat().length) : [0, 0];

  addExitsAndHolds(L, apronCentre);
  addStands(L, els, proj, meta);
  pruneToNetwork(L);
  L.taxiLabels = taxiLabels(L);
  return L;
}

// From a runway node, leaving along a given taxiway edge: the shortest way to a
// point clear of the runway (searching, since OSM taxiway lines near a runway
// are dense and curvy). The holding point is the first OSM holding position on
// the way, or the first point at least HOLD_MIN from the centreline.
function walkOut(L, r, start, firstEdge) {
  const g = L.graph;
  const off = (id) => pointSegmentDistance(g.nodes[id].p, r.a, r.b).d;
  const first = firstEdge.a === start ? firstEdge.b : firstEdge.a;
  const blocked = (v) => (g.nodes[v].kind === 'rwy' || g.nodes[v].kind === 'rwyx') && g.nodes[v].runway === r.id;
  if (blocked(first)) return null;
  const best = new Map([[first, firstEdge.len]]);
  const prev = new Map([[first, start]]);
  const queue = [[firstEdge.len, first]];
  let goal = null;
  while (queue.length) {
    queue.sort((x, y) => x[0] - y[0]);
    const [d, u] = queue.shift();
    if (d > best.get(u)) continue;
    if (off(u) >= CLEAR_OF_RUNWAY) { goal = u; break; }
    if (d > 900) break;
    for (const k of g.adj[u]) {
      const e = g.edges[k];
      if (e.kind === 'runway') continue;
      const v = e.a === u ? e.b : e.a;
      if (v === start || blocked(v)) continue;
      const nd = d + e.len;
      if (nd < (best.get(v) ?? Infinity)) { best.set(v, nd); prev.set(v, u); queue.push([nd, v]); }
    }
  }
  if (goal === null) return null;
  const path = [];
  for (let v = goal; v !== undefined; v = prev.get(v)) path.unshift(v);
  const hold = path.find((v) => (g.nodes[v].kind === 'hold' && off(v) >= 40) || off(v) >= HOLD_MIN) ?? goal;
  return { path, hold, clear: goal };
}

// nodes reachable over taxiways (not runways) from a start node
function component(g, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop();
    for (const k of g.adj[u]) {
      const e = g.edges[k];
      if (e.kind === 'runway') continue;
      const v = e.a === u ? e.b : e.a;
      if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
  }
  return seen;
}

// keep what the main taxi network (the one with the most stands) can reach
function pruneToNetwork(L) {
  const g = L.graph;
  let main = new Set();
  const done = new Set();
  for (const gate of L.gates) {
    if (done.has(gate.lane)) continue;
    const c = component(g, gate.lane);
    c.forEach((id) => done.add(id));
    const stands = L.gates.filter((x) => c.has(x.lane)).length;
    const best = L.gates.filter((x) => main.has(x.lane)).length;
    if (stands > best) main = c;
  }
  L.gates = L.gates.filter((x) => main.has(x.lane));
  for (const end of Object.keys(L.exits)) {
    const seen = new Set();
    L.exits[end] = L.exits[end].filter((x) => main.has(x.t)).filter((x) => {
      const k = `${x.r}:${x.t}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  for (const [end, list] of Object.entries(L.entryCandidates || {})) {
    if (L.holdPoints[end] && main.has(L.holdPoints[end].h)) continue;
    delete L.holdPoints[end];
    const en = list.find((x) => main.has(x.h));
    if (en) {
      L.holdPoints[end] = { h: en.h, r: en.r, name: en.name, runway: g.nodes[en.r].runway,
        path: [...en.path.slice(0, en.path.indexOf(en.h) + 1)].reverse() };
      const hn = g.nodes[en.h];
      if (hn.kind === 'twy') { hn.kind = 'hold'; hn.runway = g.nodes[en.r].runway; hn.name = hn.name || en.name; }
    }
  }
  delete L.entryCandidates;
  // a runway nothing can reach is not in use (closed, under construction, or not mapped)
  L.closedRunways = L.runways.filter((r) => ![r.identA, r.identB].some((e) => L.holdPoints[e] || (L.exits[e] || []).length));
  L.runways = L.runways.filter((r) => !L.closedRunways.includes(r));
}

function addExitsAndHolds(L, apronCentre) {
  const g = L.graph;
  for (const r of L.runways) {
    const ends = [
      { ident: r.identA, thr: r.a, dir: r.dir },
      { ident: r.identB, thr: r.b, dir: mul(r.dir, -1) },
    ];
    // every taxiway that leaves this runway
    const links = [];
    for (const n of g.nodes) {
      if (n.kind !== 'rwyx' || n.runway !== r.id) continue;
      for (const k of g.adj[n.id]) {
        const e = g.edges[k];
        if (e.kind === 'runway') continue;
        const w = walkOut(L, r, n.id, e);
        if (!w) continue;
        const out = norm(sub(g.nodes[w.path[1]].p, n.p));
        let name = e.name;
        for (let i = 1; !name && i < w.path.length; i += 1) {
          const k2 = g.adj[w.path[i - 1]].find((k3) => { const f = g.edges[k3]; return f.a === w.path[i] || f.b === w.path[i]; });
          if (k2 !== undefined) name = g.edges[k2].name;
        }
        links.push({ r: n.id, p: n.p, out, path: w.path, h: w.hold, t: w.clear, name,
          side: Math.sign(cross(r.dir, sub(g.nodes[w.clear].p, r.a))) });
      }
    }
    const apronSide = Math.sign(cross(r.dir, sub(apronCentre, r.a))) || 1;
    for (const end of ends) {
      const along = (p) => dot(sub(p, end.thr), end.dir);
      // exits: ahead of the touchdown zone and not pointing back against the landing direction
      L.exits[end.ident] = links
        .filter((l) => along(l.p) > 600 && dot(l.out, end.dir) > -0.35)
        .map((l) => ({ along: along(l.p), r: l.r, h: l.h, t: l.t, name: l.name, path: l.path, side: l.side }))
        .sort((x, y) => x.along - y.along || (y.side === apronSide) - (x.side === apronSide));
      // departure entry: near the threshold, on the terminal side if possible
      const entries = links.filter((l) => along(l.p) > -100 && along(l.p) < 900)
        .sort((x, y) => (y.side === apronSide) - (x.side === apronSide) || (!!y.name - !!x.name) || along(x.p) - along(y.p));
      L.entryCandidates = L.entryCandidates || {};
      L.entryCandidates[end.ident] = entries;
      const en = entries[0];
      if (en) {
        L.holdPoints[end.ident] = { h: en.h, r: en.r, name: en.name, runway: r.id, path: [...en.path.slice(0, en.path.indexOf(en.h) + 1)].reverse() };
        const hn = g.nodes[en.h];
        if (hn.kind === 'twy') { hn.kind = 'hold'; hn.runway = r.id; hn.name = hn.name || en.name; }
      }
    }
  }
}

// Stands: OSM parking_position lines (lead-in lines from the taxilane to the
// stop point) with a stand number. The line's connection to the taxiway
// network is used as drawn; the parking spot is its free end. Boarding gates
// (aeroway=gate, e.g. "B21/B22") are terminal gates, not stands, so they are
// not used. Stands without a number are drawn but get no traffic.
function addStands(L, els, proj, meta = {}) {
  const g = L.graph;
  const taxi = (id) => id !== undefined && ['twy', 'lane', 'hold', 'x'].includes(g.nodes[id].kind);
  const taxiEdges = g.edges.filter((e) => e.kind === 'lane' || e.kind === 'twy');
  const nearestEdge = (p) => {
    let best = null;
    for (const e of taxiEdges) {
      const a = g.nodes[e.a].p; const b = g.nodes[e.b].p;
      if (Math.abs(a[0] - p[0]) > STAND_LINK_MAX + 400 && Math.abs(b[0] - p[0]) > STAND_LINK_MAX + 400) continue;
      const q = pointSegmentDistance(p, a, b);
      if (!best || q.d < best.q.d) best = { e, q };
    }
    return best;
  };
  const stands = [];
  L.otherStands = [];
  // numbers OSM gives a stand that the airport's published chart does not have
  // (data/traffic/<ICAO>.json meta.not_stands): drawn, but not used for traffic
  const notStands = new Set((meta.not_stands || []).map((x) => String(x).toUpperCase()));
  for (const e of els) {
    const t = tagsOf(e);
    if (t.aeroway !== 'parking_position') continue;
    // "D64/D65" (a stand that can be used as two) -> "D64"
    let ref = (firstRef(t) || '').split('/')[0].trim();
    if (notStands.has(ref)) ref = '';
    if (e.type === 'node') {
      const p = proj.toXY(e.lat, e.lon);
      if (ref) stands.push({ ref, stop: p, pts: [p], attach: null, dir: null });
      else L.otherStands.push(p);
      continue;
    }
    if (e.type !== 'way' || !e.geometry) continue;
    const pts = e.geometry.map((q) => proj.toXY(q.lat, q.lon));
    const ids = e.nodes.map((id) => g.byOsm.get(id));
    const shared = ids.map((id, k) => (taxi(id) ? k : -1)).filter((k) => k >= 0);
    let stopIdx; let attachIdx = null;
    if (shared.length) {
      const n = ids.length - 1;
      if (!taxi(ids[0])) { stopIdx = 0; attachIdx = Math.min(...shared); }
      else if (!taxi(ids[n])) { stopIdx = n; attachIdx = Math.max(...shared); }
      else continue; // both ends on taxiways: not a stand lead-in
    } else {
      // not connected: the parking spot is the end further from the taxiways
      const da = nearestEdge(pts[0])?.q.d ?? 0;
      const db = nearestEdge(pts[pts.length - 1])?.q.d ?? 0;
      stopIdx = da > db ? 0 : pts.length - 1;
    }
    const stop = pts[stopIdx];
    if (!ref) { L.otherStands.push(stop); continue; }
    const step = stopIdx === 0 ? -1 : 1;
    const from = attachIdx ?? (stopIdx === 0 ? pts.length - 1 : 0);
    const line = [];
    for (let k = from; k !== stopIdx + step; k += step) line.push(k);
    stands.push({ ref, stop, attach: attachIdx === null ? null : ids[attachIdx],
      pts: line.map((k) => pts[k]), dir: pts.length > 1 ? sub(stop, pts[stopIdx - step]) : null });
  }
  // the same number twice: keep the first
  const seen = new Set();
  const unique = stands.filter((s) => (seen.has(s.ref) ? false : (seen.add(s.ref), true)));
  // stand size from the spacing to every neighbouring stand (numbered or not)
  const allStops = [...unique.map((s) => s.stop), ...L.otherStands];
  for (const s of unique) {
    let near = Infinity;
    for (const o of allStops) if (o !== s.stop) near = Math.min(near, dist(o, s.stop));
    s.maxSpan = Math.max(24, Math.min(80, near + 4));
  }
  // stands not drawn connected: join the start of the line to the nearest taxiway
  const cuts = new Map();
  for (const s of unique) {
    if (s.attach !== null) continue;
    const best = nearestEdge(s.pts[0]);
    if (!best || best.q.d > STAND_LINK_MAX) { s.skip = true; continue; }
    s.link = best;
    if (!cuts.has(best.e.id)) cuts.set(best.e.id, []);
    cuts.get(best.e.id).push(s);
  }
  if (cuts.size) {
    const newEdges = [];
    for (const e of g.edges) {
      const list = cuts.get(e.id);
      if (!list) { newEdges.push(e); continue; }
      list.sort((x, y) => x.link.q.t - y.link.q.t);
      let prev = e.a;
      for (const s of list) {
        const id = g.node(add(g.nodes[e.a].p, mul(sub(g.nodes[e.b].p, g.nodes[e.a].p), s.link.q.t)), 'lane');
        s.attach = id;
        newEdges.push({ ...e, a: prev, b: id });
        prev = id;
      }
      newEdges.push({ ...e, a: prev, b: e.b });
    }
    g.edges = newEdges;
  }
  for (const s of unique) {
    if (s.skip || s.attach === null) continue;
    // lead-in line: attach node -> (bends) -> stop point
    let prev = s.attach;
    const push = [s.attach];
    for (let k = 1; k < s.pts.length - 1; k += 1) {
      const id = g.node(s.pts[k], 'lane');
      g.edge(prev, id, s.ref, 'stand');
      prev = id;
      push.push(id);
    }
    const node = g.node(s.stop, 'gate', { gate: s.ref });
    g.edge(prev, node, s.ref, 'stand');
    push.push(node);
    const dir = s.dir || sub(s.stop, g.nodes[s.attach].p);
    L.gates.push({ id: s.ref, node, lane: s.attach, heading: headingOf(dir), maxSpan: s.maxSpan,
      push: push.reverse() });
  }
  L.gates.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  g.finish();
}

// where to write taxiway names on the chart: along each named taxiway, spaced out
function taxiLabels(L) {
  const g = L.graph;
  const out = [];
  const edges = g.edges.filter((e) => (e.kind === 'twy' || e.kind === 'lane') && e.name).sort((a, b) => b.len - a.len);
  for (const e of edges) {
    if (e.len < 40) continue;
    const p = mul(add(g.nodes[e.a].p, g.nodes[e.b].p), 0.5);
    const gap = e.kind === 'lane' ? 300 : 450;
    if (out.some((l) => l.name === e.name && dist(l.p, p) < gap)) continue;
    let ang = Math.atan2(g.nodes[e.b].p[1] - g.nodes[e.a].p[1], g.nodes[e.b].p[0] - g.nodes[e.a].p[0]);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    out.push({ name: e.name, p, ang, lane: e.kind === 'lane' });
  }
  return out;
}

// ------------------------------------------------------------------ compact storage

export function packLayout(L) {
  const g = L.graph;
  const names = [...new Set(g.edges.map((e) => e.name || ''))];
  const kinds = ['twy', 'lane', 'rwy', 'rwyx', 'rwyint', 'hold', 'gate', 'x', 'tmp'];
  const ekinds = ['twy', 'lane', 'runway', 'stand', 'conn', 'link'];
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    v: 1, airport: L.airport, origin: L.proj.toLatLon([0, 0]), names,
    nodes: g.nodes.map((n) => [r1(n.p[0]), r1(n.p[1]), kinds.indexOf(n.kind), n.runway || 0, n.name || n.gate || 0]),
    edges: g.edges.map((e) => [e.a, e.b, names.indexOf(e.name || ''), ekinds.indexOf(e.kind), e.runway || 0]),
    runways: L.runways.map((r) => ({ identA: r.identA, identB: r.identB, a: r.a.map(r1), b: r.b.map(r1), width: r.width })),
    closedRunways: (L.closedRunways || []).map((r) => ({ identA: r.identA, identB: r.identB, a: r.a.map(r1), b: r.b.map(r1), width: r.width })),
    holdPoints: L.holdPoints, exits: L.exits, gates: L.gates,
    aprons: L.aprons.map((ring) => ring.map((p) => p.map(r1))),
    terminals: L.terminals.map((ring) => ring.map((p) => p.map(r1))),
    buildings: L.buildings.map((ring) => ring.map((p) => p.map(r1))),
    taxiLabels: L.taxiLabels.map((l) => ({ ...l, p: l.p.map(r1), ang: Math.round(l.ang * 1000) / 1000 })),
    otherStands: (L.otherStands || []).map((p) => p.map(r1)),
    kinds, ekinds,
  };
}

export function unpackLayout(d) {
  const proj = makeProjection(d.origin[0], d.origin[1]);
  const net = new Net();
  for (const [x, y, k, rw, nm] of d.nodes) {
    const extra = {};
    if (rw) extra.runway = rw;
    if (nm) { if (d.kinds[k] === 'gate') extra.gate = nm; else extra.name = nm; }
    net.node([x, y], d.kinds[k], extra);
  }
  for (const [a, b, n, k, rw] of d.edges) net.edge(a, b, d.names[n], d.ekinds[k], rw ? { runway: rw } : {});
  net.finish();
  const mk = (r) => {
    const o = { ...r };
    o.dir = norm(sub(o.b, o.a));
    o.len = dist(o.a, o.b);
    o.mid = mul(add(o.a, o.b), 0.5);
    o.id = `${o.identA}/${o.identB}`;
    o.headingA = headingOf(o.dir);
    o.headingB = (o.headingA + 180) % 360;
    return o;
  };
  const runways = d.runways.map(mk);
  const closedRunways = (d.closedRunways || []).map(mk);
  // keep the generated-layout fields the map uses: one apron/terminal for "fit"
  return { airport: d.airport, proj, graph: net, runways, closedRunways, holdPoints: d.holdPoints, exits: d.exits, gates: d.gates,
    aprons: d.aprons, terminals: d.terminals, buildings: d.buildings, taxiLabels: d.taxiLabels, real: true,
    otherStands: d.otherStands || [],
    terminal: d.terminals.flat().length ? d.terminals.flat() : null };
}

export { perp };
