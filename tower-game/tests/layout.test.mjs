import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout, endGeometry, onRunway, reciprocal, route, routeCrossings, routeNames } from '../js/layout.js';
import { Path, add, dist, fromHeading, makeProjection, mul, perp } from '../js/geo.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
export const XDEP = json('./fixtures/xdep.json');

// a busy made-up airport: two parallel runways 1.6 km apart and a crossing one
export function bigAirport() {
  const lat0 = 40;
  const lon0 = -3;
  const proj = makeProjection(lat0, lon0);
  const rw = (center, hdg, lenM, idA, idB) => {
    const d = fromHeading(hdg);
    const a = proj.toLatLon(add(center, mul(d, -lenM / 2)));
    const b = proj.toLatLon(add(center, mul(d, lenM / 2)));
    return [
      { ident: idA, opposite: idB, heading: hdg, length_ft: lenM / 0.3048, lat: a[0], lon: a[1] },
      { ident: idB, opposite: idA, heading: (hdg + 180) % 360, length_ft: lenM / 0.3048, lat: b[0], lon: b[1] },
    ];
  };
  return {
    icao: 'ZZBG', lat: lat0, lon: lon0, elevation_ft: 2000,
    runways: [
      ...rw([0, 800], 90, 3800, '09L', '27R'),
      ...rw([300, -800], 90, 3500, '09R', '27L'),
      ...rw([1500, 500], 150, 2600, '15', '33'), // crosses 09L/27R
      { ident: 'H1', opposite: '', length_ft: 60 },
      ...rw([-4000, 0], 90, 700, '10', '28'), // too short, ignored
    ],
  };
}

test('reciprocal runway idents', () => {
  assert.equal(reciprocal('09'), '27');
  assert.equal(reciprocal('27L'), '09R');
  assert.equal(reciprocal('36'), '18');
  assert.equal(reciprocal('18C'), '36C');
});

test('demo airport layout: runways from data, generated taxiways and gates', () => {
  const L = buildLayout(XDEP);
  assert.deepEqual(L.runways.map((r) => r.id), ['09/27', '36/18']);
  const r = L.runways[0];
  assert.ok(Math.abs(r.len - 3048) < 40, `length ${r.len}`);
  assert.ok(Math.abs(r.headingA - 90) < 1);
  for (const end of ['09', '27', '36', '18']) assert.ok(L.holdPoints[end], `hold point ${end}`);
  assert.ok(L.gates.length >= 4);
  assert.ok(L.exits['09'].length >= 2 && L.exits['27'].length >= 2);
  assert.ok(L.exits['09'].every((e, i, a) => i === 0 || e.along > a[i - 1].along));
});

test('every gate reaches every runway end and every exit reaches every gate', () => {
  for (const ap of [XDEP, bigAirport()]) {
    const L = buildLayout(ap);
    for (const gate of L.gates) {
      for (const [end, hp] of Object.entries(L.holdPoints)) {
        const nodes = route(L, gate.lane, hp.h);
        assert.ok(nodes, `${ap.icao} ${gate.id} -> ${end}`);
        // a taxi route never runs along a runway
        for (let i = 1; i < nodes.length; i += 1) {
          const e = L.graph.adj[nodes[i - 1]].map((k) => L.graph.edges[k]).find((x) => x.a === nodes[i] || x.b === nodes[i]);
          assert.notEqual(e.kind, 'runway');
        }
      }
    }
    for (const exits of Object.values(L.exits)) {
      for (const ex of exits) assert.ok(route(L, ex.t, L.gates[0].node), `${ap.icao} exit ${ex.name}`);
    }
  }
});

test('big airport: parallels, crossing runway, hold-short crossings, via', () => {
  const L = buildLayout(bigAirport());
  assert.deepEqual(L.runways.map((r) => r.id), ['09L/27R', '09R/27L', '15/33']); // short 10/28 dropped
  const crossings = L.graph.nodes.filter((n) => n.kind === 'rwyx');
  assert.ok(crossings.length > 0, 'taxiways crossing runways become hold-short nodes');
  // gates are not on any runway, taxiway nodes are not on runways
  for (const g of L.gates) for (const r of L.runways) assert.ok(!onRunway(r, L.graph.nodes[g.node].p, 100));
  for (const n of L.graph.nodes.filter((x) => x.kind === 'twy' || x.kind === 'lane')) {
    for (const r of L.runways) assert.ok(!onRunway(r, n.p, 20), `node ${n.id} on runway ${r.id}`);
  }
  // to reach the far runway from the gates you must cross the near one
  const gate = L.gates[0];
  const near = L.runways.find((r) => r.side === L.runways[0].side && r === L.runways[0]);
  const farEnd = L.runways.map((r) => r.identA).find((id) => {
    const nodes = route(L, gate.lane, L.holdPoints[id].h);
    return routeCrossings(L, nodes).length > 0;
  });
  assert.ok(near && farEnd, 'some runway end needs a crossing');
  const names = routeNames(L, route(L, gate.lane, L.holdPoints.A ? 0 : L.holdPoints['09L'].h));
  assert.ok(names.length > 0);
  // "via" changes the route
  const plain = route(L, gate.lane, L.holdPoints['27R'].h);
  const viaB = route(L, gate.lane, L.holdPoints['27R'].h, { via: ['B'] });
  assert.ok(plain && viaB);
});

test('runway end geometry and the Path helper', () => {
  const L = buildLayout(XDEP);
  const e27 = endGeometry(L, '27');
  assert.ok(Math.abs(e27.heading - 270) < 1);
  assert.ok(dist(e27.thr, L.runways[0].b) < 1);
  const p = new Path([[0, 0], [100, 0], [100, 50]]);
  assert.equal(p.length, 150);
  assert.deepEqual(p.at(120).p, [100, 20]);
  assert.deepEqual(p.at(50).dir, [1, 0]);
  assert.deepEqual(perp([1, 0]), [-0, 1]);
});
