import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutFromOsm, packLayout, unpackLayout } from '../js/osm.js';
import { makeProjection } from '../js/geo.js';
import { route, routeCrossings, routeNames, unknownVia } from '../js/layout.js';
import { World } from '../js/world.js';
import { report } from '../tools/build_hq.mjs';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const PHR = json('../data/phraseology.json');

// A small airport in OSM form: runway 09/27 (3000 m) on y=0, parallel taxiway
// A at y=-200 with connectors A1-A4 (shared nodes with the runway), holding
// positions on the connectors, an apron taxilane at y=-450 with 4 stands, and
// taxiway C that crosses a second runway 18/36 without a shared node.
export function osmFixture() {
  const proj = makeProjection(1.0, 104.0);
  let id = 1;
  const els = [];
  const nodes = new Map();
  const node = (x, y, tags) => {
    const n = { type: 'node', id: id++, lat: 0, lon: 0 };
    [n.lat, n.lon] = proj.toLatLon([x, y]);
    nodes.set(n.id, n);
    if (tags) { n.tags = tags; els.push(n); }
    return n;
  };
  const way = (ns, tags) => {
    const w = { type: 'way', id: id++, nodes: ns.map((n) => n.id), geometry: ns.map((n) => ({ lat: n.lat, lon: n.lon })), tags };
    els.push(w);
    return w;
  };
  const xs = [-1500, -1100, -300, 400, 1100, 1500];
  const rw = xs.map((x) => node(x, 0));
  way(rw, { aeroway: 'runway', ref: '09/27', width: '45' });
  const twy = xs.map((x) => node(x, -200));
  way(twy, { aeroway: 'taxiway', ref: 'A' });
  [0, 1, 4, 5].forEach((i, k) => {
    const hold = node(xs[i], -90, { aeroway: 'holding_position' });
    way([rw[i], hold, twy[i]], { aeroway: 'taxiway', ref: `A${k + 1}` });
  });
  // apron taxilane with stands, linked to A by J1/J2
  const lane = [-600, -300, 0, 300, 600].map((x) => node(x, -450));
  way(lane, { aeroway: 'taxilane' });
  way([twy[2], lane[1]], { aeroway: 'taxiway', ref: 'J1' });
  way([twy[3], lane[3]], { aeroway: 'taxiway', ref: 'J2' });
  [-450, -150, 150, 450].forEach((x, k) => node(x, -530, { aeroway: 'parking_position', ref: `${10 + k}` }));
  way([node(-700, -400), node(700, -400), node(700, -600), node(-700, -600), nodes.get(id - 4)].slice(0, 4).concat([]), { aeroway: 'apron' });
  // second runway 18/36 east of the field, reached by taxiway C that crosses it (no shared node)
  const r2 = [node(2200, 1200), node(2200, -1200)];
  way(r2, { aeroway: 'runway', ref: '18/36' });
  const c = [twy[5], node(2000, -200), node(2400, -200), node(2400, 900)];
  way(c, { aeroway: 'taxiway', ref: 'C' });
  const north = node(2400, 1100);
  way([c[3], north], { aeroway: 'taxiway', ref: 'C' });
  way([north, node(2300, 1100), r2[0]], { aeroway: 'taxiway', ref: 'C1' });
  way([c[2], node(2300, -1100), r2[1]], { aeroway: 'taxiway', ref: 'C2' });
  return { elements: els };
}

const META = { icao: 'ZZOS', name: 'OSM Test', municipality: 'Testville', tower: 'Testville Tower' };

test('runways, idents, taxiways and stands come from OSM', () => {
  const L = layoutFromOsm(osmFixture(), META);
  const r = L.runways.find((x) => x.id === '09/27');
  assert.ok(r, L.runways.map((x) => x.id).join());
  assert.ok(Math.abs(r.len - 3000) < 5);
  assert.ok(Math.abs(r.headingA - 90) < 1, 'runway 09 is the west end');
  assert.equal(r.width, 45);
  assert.deepEqual(L.gates.map((g) => g.id), ['10', '11', '12', '13']);
  for (const g of L.gates) assert.ok(g.maxSpan >= 24 && g.maxSpan <= 80);
  const names = new Set(L.graph.edges.map((e) => e.name));
  for (const n of ['A', 'A1', 'A4', 'J1', 'C']) assert.ok(names.has(n), n);
  assert.ok(L.aprons.length === 1 || L.aprons.length === 0);
  assert.ok(L.taxiLabels.some((l) => l.name === 'A'));
});

test('exits, departure entries and holding points', () => {
  const L = layoutFromOsm(osmFixture(), META);
  assert.equal(L.holdPoints['09'].name, 'A1');
  assert.equal(L.holdPoints['27'].name, 'A4');
  assert.equal(L.graph.nodes[L.holdPoints['09'].h].kind, 'hold');
  // landing on 27 (westbound) exits ahead of touchdown, in order
  const ex = L.exits['27'].map((e) => e.name);
  assert.deepEqual(ex, ['A2', 'A1']); // A3 is only 400 m past the threshold
  for (const e of L.exits['27']) assert.ok(e.path.length >= 3 && e.along > 600);
});

test('routing on the real network: via, unknown taxiways, runway crossing', () => {
  const L = layoutFromOsm(osmFixture(), META);
  const gate = L.gates[0];
  const toA1 = route(L, gate.lane, L.holdPoints['09'].h);
  assert.ok(toA1);
  assert.deepEqual(routeNames(L, toA1).filter((n) => n), ['J1', 'A', 'A1']);
  const viaJ2 = route(L, gate.lane, L.holdPoints['09'].h, { via: ['J2', 'A'] });
  assert.ok(routeNames(L, viaJ2).includes('J2'));
  assert.deepEqual(unknownVia(L, ['A', 'Q', 'J1']), ['Q']);
  // taxiway C crosses runway 18/36 without a shared node: the build makes a crossing node
  assert.ok(L.graph.nodes.some((n) => n.kind === 'rwyx' && n.runway === '18/36'));
  const to18 = L.holdPoints['18'] || L.holdPoints['36'];
  assert.ok(to18, 'runway 18/36 has an entry');
});

test('pack and unpack keep the layout, and the game plays on it', () => {
  const L = unpackLayout(JSON.parse(JSON.stringify(packLayout(layoutFromOsm(osmFixture(), META)))));
  const rep = report(L);
  assert.equal(rep.routesFailed, 0, rep.problems.join('; '));
  const w = new World({ layout: L, phr: PHR, airlines: { SIA: 'Singapore' }, rng: () => 0.3, arrEnd: '27', depEnd: '27', traffic: 'off' });
  w.nextArr = Infinity; w.nextDep = Infinity;
  const arr = w.spawnArrival(null, 4);
  w.command(arr.id, { type: 'land' });
  const run = (cond, limit = 1500) => { for (let t = 0; t < limit; t += 0.5) { w.step(0.5); if (cond()) return true; } return false; };
  assert.ok(run(() => arr.state === 'vacated'), `arrival stuck in ${arr.state}`);
  assert.equal(w.command(arr.id, { type: 'taxi', via: ['A'] }).ok, true);
  assert.ok(run(() => arr.state === 'parked'), `arrival stuck in ${arr.state}`);
  const dep = w.spawnDeparture();
  w.command(dep.id, { type: 'push' });
  assert.ok(run(() => dep.state === 'pushed'));
  const r = w.command(dep.id, { type: 'taxi', via: ['J2', 'A'] });
  assert.equal(r.ok, true, r.text);
  assert.ok(run(() => dep.state === 'holding'), `departure stuck in ${dep.state}`);
  w.command(dep.id, { type: 'takeoff' });
  assert.ok(run(() => dep.state === 'climb'));
  assert.equal(w.stats.conflicts, 0);
  void routeCrossings;
});
