import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unpackLayout } from '../js/osm.js';
import { route, routeNames } from '../js/layout.js';
import { World } from '../js/world.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const hq = (code) => unpackLayout(json(`../data/hq/${code}.json`));
const L = hq('ZBAD');
const g = L.graph;
const gate = (id) => L.gates.find((x) => x.id === id);

// the one-way rule: no step of a route goes against an edge's direction
function backwards(nodes) {
  const bad = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const u = nodes[i - 1]; const v = nodes[i];
    const edges = g.adj[u].map((k) => g.edges[k]).filter((e) => (e.a === u && e.b === v) || (e.b === u && e.a === v));
    // a pair joined by two edges is fine if any may be used this way
    if (!edges.some((e) => !e.dir || (e.dir === 1 ? e.a === u : e.b === u))) bad.push(`${u}>${v}`);
  }
  return bad;
}

test('Daxing apron bays: one-way lanes are in the data, and the other airports have none', () => {
  const oneWay = g.edges.filter((e) => e.dir);
  assert.ok(oneWay.length > 150, `${oneWay.length} one-way segments`);
  const names = new Set(oneWay.map((e) => e.name));
  for (const n of ['Z8', 'Z9', 'Z7', 'Y7', 'Y8', 'Y6', 'Y2', 'Y3', 'Y1', 'Z2', 'Z1', 'Z3']) assert.ok(names.has(n), `${n} is one-way`);
  for (const code of ['WSSS', 'KSFO']) assert.equal(hq(code).graph.edges.filter((e) => e.dir).length, 0, code);
});

test('every Daxing stand can still be reached from the runway exits and can reach every runway', () => {
  const holds = Object.entries(L.holdPoints);
  const exits = Object.entries(L.exits).filter(([, list]) => list.length).map(([end, list]) => [end, list[0].t]);
  assert.ok(exits.length >= 4 && holds.length >= 4);
  for (const stand of L.gates) {
    for (const [end, t] of exits) assert.ok(route(L, t, stand.node), `exit of ${end} cannot reach stand ${stand.id}`);
    for (const [end, h] of holds) assert.ok(route(L, stand.lane, h.h), `stand ${stand.id} cannot reach runway ${end}`);
  }
});

test('arrivals come in on the straight lane and leave their stand along the loop, in each bay', () => {
  const exit = L.exits['17L'][0].t;
  const hold = L.holdPoints['17R'].h;
  // [stand, straight lane, loop arm]
  const cases = [['166', 'Z8', 'Z9'], ['164', 'Z8', 'Z9'], ['153', 'Z8', 'Z7'], ['110', 'Y7', 'Y8'], ['122', 'Y7', 'Y6'],
    ['134', 'Y2', 'Y3'], ['184', 'Y2', 'Y1'], ['143', 'Z2', 'Z3'], ['195', 'Z2', 'Z1']];
  for (const [id, straight, arm] of cases) {
    const inn = route(L, exit, gate(id).node);
    const names = routeNames(L, inn);
    assert.ok(names.includes(straight) && names.includes(arm), `${id} in: ${names.join(' ')}`);
    assert.ok(names.indexOf(straight) < names.lastIndexOf(arm), `${id}: the straight lane comes before the arm: ${names.join(' ')}`);
    assert.deepEqual(backwards(inn), [], `${id} in goes against a one-way lane`);
    const out = route(L, gate(id).lane, hold);
    const outNames = routeNames(L, out).slice(0, 3);
    assert.equal(outNames[0], arm, `${id} leaves on ${arm}: ${outNames.join(' ')}`);
    assert.ok(!outNames.includes(straight), `${id} out must not use ${straight}: ${outNames.join(' ')}`);
    assert.deepEqual(backwards(out), [], `${id} out goes against a one-way lane`);
  }
});

test('in the game: a departure pushes back onto the loop and taxis out the right way', () => {
  const PHR = json('../data/phraseology.json');
  let s = 5;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const w = new World({ layout: L, phr: PHR, airlines: json('../data/airlines.json'), rng, arrEnd: ['17L'], depEnd: ['17R'], traffic: 'off',
    profile: json('../data/traffic/ZBAD.json'), types: json('../data/aircraft.json') });
  w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
  const ac = w.spawnDeparture();
  // put it on stand 166
  w.gateUse.delete(ac.gate);
  ac.gate = '166';
  w.gateUse.set('166', ac.id);
  ac.p = [...g.nodes[gate('166').node].p];
  ac.callAt = 0;
  w.step(0.5);
  assert.equal(w.command(ac.id, { type: 'push' }).ok, true);
  for (let t = 0; t < 400 && ac.state !== 'pushed'; t += 0.5) w.step(0.5);
  assert.equal(ac.state, 'pushed');
  assert.equal(w.command(ac.id, { type: 'taxi' }).ok, true);
  assert.deepEqual(backwards(ac.routeNodes), []);
  assert.ok(!routeNames(L, ac.routeNodes).includes('Z8'), 'it does not taxi against the lane the arrivals use');
  for (let t = 0; t < 1500 && ac.state !== 'holding'; t += 0.5) {
    w.step(0.5);
    if (ac.waitingCross) w.command(ac.id, { type: 'cross' }); // runway crossings need a clearance
  }
  assert.equal(ac.state, 'holding', `stuck in ${ac.state}, waiting to cross ${ac.waitingCross?.runway}, blocked by ${ac.blockedBy}`);
});
