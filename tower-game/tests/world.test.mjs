import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout } from '../js/layout.js';
import { SCORE, World } from '../js/world.js';
import { bigAirport } from './layout.test.mjs';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const XDEP = json('./fixtures/xdep.json');
const PHR = json('../data/phraseology.json');
const AIRLINES = json('../data/airlines.json');

function seeded(seed = 7) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function newWorld(airport = XDEP, arrEnd = '27', depEnd = '27') {
  const w = new World({ layout: buildLayout(airport), phr: PHR, airlines: AIRLINES, rng: seeded(), arrEnd, depEnd,
    traffic: 'off', wind: { available: true, wind_dir: 260, wind_kt: 10 } });
  w.nextArr = Infinity;
  w.nextDep = Infinity;
  w.variety = false; // the first wording of each phrase, so the texts can be checked
  return w;
}

// run the sim until cond() or a time limit (sim seconds)
function runUntil(w, cond, limit = 1200, dt = 0.5) {
  for (let t = 0; t < limit; t += dt) {
    w.step(dt);
    if (cond()) return true;
  }
  return false;
}

const texts = (evs, kind = 'pilot') => evs.filter((e) => e.kind === kind).map((e) => e.text);

test('a departure: push, taxi, take-off, frequency change', () => {
  const w = newWorld();
  const ac = w.spawnDeparture();
  ac.callAt = 0;
  w.step(0.5);
  let ev = w.drain();
  assert.match(texts(ev)[0], new RegExp(`Tower, ${ac.cs.t}, stand ${ac.gate}, request pushback\\.`));
  assert.equal(w.command(ac.id, { type: 'push' }).ok, true);
  assert.ok(runUntil(w, () => ac.state === 'pushed'));
  assert.ok(runUntil(w, () => ac.req?.type === 'taxi'));
  const r = w.command(ac.id, { type: 'taxi' });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Taxi to holding point runway 27, /);
  assert.ok(runUntil(w, () => ac.state === 'holding'), `stuck in ${ac.state}`);
  ev = w.drain();
  assert.ok(texts(ev).some((t) => /holding point runway 27, ready for departure/.test(t)));
  assert.match(w.command(ac.id, { type: 'takeoff' }).text, /Cleared for take-off runway 27/);
  assert.ok(runUntil(w, () => ac.state === 'climb'), `stuck in ${ac.state}`);
  assert.ok(runUntil(w, () => ac.req?.type === 'contact'));
  assert.equal(w.command(ac.id, { type: 'contact' }).ok, true);
  assert.ok(runUntil(w, () => !w.ac.includes(ac)));
  assert.equal(w.stats.departed, 1);
  assert.equal(w.score, SCORE.departed);
  assert.equal(w.stats.conflicts, 0);
});

test('the controller picks the taxi route on the map: the aircraft follows it and reads back the taxiways', () => {
  const w = newWorld();
  const ac = w.spawnDeparture();
  ac.callAt = 0;
  w.step(0.5);
  w.command(ac.id, { type: 'push' });
  assert.ok(runUntil(w, () => ac.state === 'pushed'));
  const plain = w.planTaxi(ac, {});
  assert.ok(plain?.nodes.length > 1 && plain.via.length);
  // a taxiway point the shortest route doesn't use
  const g = w.L.graph;
  const used = new Set(plain.nodes);
  const wp = g.nodes.findIndex((n, i) => n.kind === 'twy' && !used.has(i) && g.adj[i].some((k) => !plain.via.includes(g.edges[k].name) && g.edges[k].kind === 'twy'));
  assert.ok(wp >= 0);
  const plan = w.planTaxi(ac, { waypoints: [wp] });
  assert.ok(plan.nodes.includes(wp), 'route goes through the chosen point');
  assert.notDeepEqual(plan.via, plain.via);
  const text = w.taxiText(ac, plan, false);
  assert.match(text, new RegExp(`taxi to holding point runway 27 via ${plan.via.join(' ')}`));
  const r = w.command(ac.id, { type: 'taxi', waypoints: [wp], via: plan.via });
  assert.equal(r.ok, true, r.text);
  assert.ok(ac.routeNodes.includes(wp));
  assert.match(r.text, new RegExp(`via ${plan.via.join(' ')}`));
  assert.ok(runUntil(w, () => ac.state === 'holding'), `stuck in ${ac.state}`);
});

test('an arrival: landing clearance, exit, taxi to the stand', () => {
  const w = newWorld();
  const ac = w.spawnArrival(null, 6);
  let ev = w.drain();
  assert.match(texts(ev)[0], new RegExp(`Tower, ${ac.cs.t}, ILS runway 27, 6 miles\\.`));
  assert.equal(w.command(ac.id, { type: 'land' }).ok, true);
  assert.ok(runUntil(w, () => ac.state === 'vacated'), `stuck in ${ac.state}`);
  ev = w.drain();
  assert.ok(texts(ev).some((t) => new RegExp(`runway 27 vacated, request taxi to stand ${ac.gate}`).test(t)));
  assert.equal(w.command(ac.id, { type: 'taxi' }).ok, true);
  assert.ok(runUntil(w, () => ac.state === 'parked'), `stuck in ${ac.state}`);
  assert.equal(w.stats.arrived, 1);
  assert.equal(w.score, SCORE.arrived);
});

test('no landing clearance means a go-around and a penalty; the aircraft comes back', () => {
  const w = newWorld();
  const ac = w.spawnArrival(null, 4);
  assert.ok(runUntil(w, () => ac.state === 'go_around'));
  assert.equal(w.score, SCORE.goAroundNoClearance);
  const ev = w.drain();
  assert.ok(texts(ev).some((t) => /short final/.test(t)));
  assert.ok(texts(ev).some((t) => /going around/.test(t)));
  assert.ok(runUntil(w, () => w.ac.some((a) => a.callsign === ac.callsign && a.state === 'final'), 400));
});

test('landing on an occupied runway: the pilot goes around; a take-off into a landing aircraft is a conflict', () => {
  const w = newWorld();
  const dep = w.spawnDeparture();
  w.command(dep.id, { type: 'push' });
  runUntil(w, () => dep.state === 'pushed');
  w.command(dep.id, { type: 'taxi' });
  runUntil(w, () => dep.state === 'holding');
  w.command(dep.id, { type: 'lineup' });
  runUntil(w, () => dep.state === 'lined_up');
  const arr = w.spawnArrival(null, 3);
  w.command(arr.id, { type: 'land' });
  assert.ok(runUntil(w, () => arr.state === 'go_around'));
  assert.equal(w.score, SCORE.goAroundRunwayBusy);

  // second case: clear the departure for take-off with an arrival about to land behind it
  const w2 = newWorld();
  const d2 = w2.spawnDeparture();
  w2.command(d2.id, { type: 'push' });
  runUntil(w2, () => d2.state === 'pushed');
  w2.command(d2.id, { type: 'taxi' });
  runUntil(w2, () => d2.state === 'holding');
  const a2 = w2.spawnArrival(null, 0.6);
  w2.command(a2.id, { type: 'land' });
  w2.command(d2.id, { type: 'takeoff' }); // lines up in front of a landing aircraft
  runUntil(w2, () => w2.stats.conflicts > 0 || a2.state === 'go_around', 120);
  assert.ok(w2.stats.goArounds + w2.stats.conflicts > 0);
});

test('unanswered calls are repeated with a penalty; wrong-state commands are refused', () => {
  const w = newWorld();
  const ac = w.spawnDeparture();
  ac.callAt = 0;
  runUntil(w, () => w.stats.repeats === 1, 100);
  assert.equal(w.score, SCORE.repeatCall);
  const r = w.command(ac.id, { type: 'takeoff' });
  assert.equal(r.ok, false);
  assert.match(r.text, /^Unable, we are not at the runway, /);
  assert.equal(w.command(ac.id, { type: 'taxi' }).ok, false);
});

test('runway crossings: the aircraft holds short until cleared to cross', () => {
  const ap = bigAirport();
  const L = buildLayout(ap);
  // find a departure runway end that needs a crossing from the apron
  const w = new World({ layout: L, phr: PHR, airlines: AIRLINES, rng: seeded(3), arrEnd: '27R', depEnd: '27R', traffic: 'off' });
  w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
  const ac = w.spawnDeparture();
  w.command(ac.id, { type: 'push' });
  runUntil(w, () => ac.state === 'pushed');
  const ends = Object.keys(L.holdPoints);
  let crossingEnd = null;
  for (const end of ends) {
    w.command(ac.id, { type: 'taxi', runway: end });
    if (ac.crossings.length) { crossingEnd = end; break; }
  }
  assert.ok(crossingEnd, 'some runway needs a crossing');
  assert.ok(runUntil(w, () => ac.req?.type === 'cross'));
  const ev = w.drain();
  assert.ok(texts(ev).some((t) => /holding short runway/.test(t)));
  assert.ok(ac.v < 0.5);
  const first = ac.waitingCross;
  const r = w.command(ac.id, { type: 'cross' });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Cross runway /);
  assert.equal(first.cleared, true);
  // it moves on: either to the holding point or to the next crossing
  assert.ok(runUntil(w, () => ac.state === 'holding' || (ac.waitingCross && ac.waitingCross !== first), 900), `stuck in ${ac.state}`);
});

test('taxi with "cross runway" in the clearance does not stop at that crossing', () => {
  const L = buildLayout(bigAirport());
  const w = new World({ layout: L, phr: PHR, airlines: AIRLINES, rng: seeded(3), arrEnd: '27R', depEnd: '27R', traffic: 'off' });
  w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
  const ac = w.spawnDeparture();
  w.command(ac.id, { type: 'push' });
  runUntil(w, () => ac.state === 'pushed');
  for (const end of Object.keys(L.holdPoints)) {
    w.command(ac.id, { type: 'taxi', runway: end });
    if (ac.crossings.length) {
      const ids = ac.crossings.map((c) => L.runways.find((r) => r.id === c.runway).identA);
      const r = w.command(ac.id, { type: 'taxi', runway: end, cross: ids });
      assert.match(r.text, /cross runway/);
      assert.ok(ac.crossings.every((c) => c.cleared));
      assert.ok(runUntil(w, () => ac.state === 'holding', 1500), `stuck in ${ac.state}`);
      return;
    }
  }
  assert.fail('no crossing found');
});

test('a busy session runs without errors and keeps score', () => {
  const w = newWorld();
  w.setTraffic('busy');
  w.nextArr = 1; w.nextDep = 1;
  // an attentive controller: answer every request at once
  for (let t = 0; t < 3600; t += 1) {
    w.step(1);
    for (const ac of w.ac) {
      if (ac.state === 'holding' && !ac.cleared.takeoff) {
        const st = w.runwayStatus(w.L.runways[0]);
        if (!st.occupants.length && !((st.nextArrivalNm ?? 99) < 4)) w.command(ac.id, { type: 'takeoff' });
      }
      const want = ac.req?.type;
      if (!want) continue;
      if (want === 'land') w.command(ac.id, { type: 'land' });
      if (want === 'push') w.command(ac.id, { type: 'push' });
      if (want === 'taxi' || want === 'taxi_in') w.command(ac.id, { type: 'taxi' });
      if (want === 'takeoff') w.command(ac.id, { type: 'hold_short' }); // cleared above when safe
      if (want === 'contact') w.command(ac.id, { type: 'contact' });
      if (want === 'cross') w.command(ac.id, { type: 'cross' });
    }
    w.drain();
  }
  assert.ok(w.stats.arrived >= 5, `arrived ${w.stats.arrived}`);
  assert.ok(w.stats.departed >= 5, `departed ${w.stats.departed}`);
  assert.equal(w.stats.conflicts, 0, JSON.stringify(w.stats));
  assert.ok(w.score > 0, `score ${w.score} ${JSON.stringify(w.stats)}`);
});

test('ZBAD: Chinese airlines talk Chinese with metric units; others English in kilometres', () => {
  const profile = json('../data/traffic/ZBAD.json');
  const types = json('../data/aircraft.json');
  const phrZh = json('../data/phraseology-zh.json');
  const only = (code) => ({ ...profile, airlines: profile.airlines.filter((a) => a.code === code) });
  const make = (code) => {
    const w = new World({ layout: buildLayout(XDEP), phr: PHR, phrZh, airlines: AIRLINES, rng: seeded(5), arrEnd: '27', depEnd: '27',
      traffic: 'off', wind: { available: true, wind_dir: 260, wind_kt: 10 }, profile: only(code), types, unit: 'Daxing Tower' });
    w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
    return w;
  };
  const w = make('CSN');
  const ac = w.spawnArrival(null, 6);
  let ev = w.drain().filter((e) => e.kind === 'pilot');
  assert.match(ev[0].text, new RegExp(`^大兴塔台，南方${ac.num}，盲降跑道27，11公里。$`));
  assert.equal(ev[0].lang, 'zh');
  assert.match(ev[0].speech, /南方[幺两三四五六拐八九洞]+/);
  const r = w.command(ac.id, { type: 'land' });
  assert.equal(r.text, `跑道27，可以落地，南方${ac.num}。`);
  assert.match(w.controllerText(ac, 'land'), /地面风260度5米每秒，跑道27，可以落地/);
  const bad = w.command(ac.id, { type: 'push' });
  assert.equal(bad.text, `无法执行，我们不在停机位，南方${ac.num}。`);
  const e = make('AFL');
  const ru = e.spawnArrival(null, 6);
  ev = e.drain().filter((x) => x.kind === 'pilot');
  assert.match(ev[0].text, new RegExp(`^Daxing Tower, Aeroflot ${ru.num}, ILS runway 27, 11 kilometres\\.$`));
  assert.match(e.controllerText(ru, 'land'), /wind 260\/5MPS, runway 27, cleared to land/);
});

test('pilots word their calls in different ways, all with the callsign and the facts', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) {
    const w = newWorld();
    w.variety = true;
    const ac = w.spawnDeparture();
    ac.callAt = 0;
    w.step(0.5);
    const t = texts(w.drain())[0];
    assert.ok(t.includes(ac.cs.t) && t.includes(`stand ${ac.gate}`), t);
    seen.add(t.replace(ac.cs.t, 'CS').replace(`stand ${ac.gate}`, 'stand N'));
  }
  assert.ok(seen.size >= 3, [...seen].join(' | '));
});

test('the destination of aircraft on the ground: holding point for departures, stand for arrivals', async () => {
  const { taxiDestination, destinationPoint } = await import('../js/world.js');
  const w = newWorld();
  const dep = w.spawnDeparture();
  dep.state = 'pushed';
  assert.deepEqual(taxiDestination(dep), { kind: 'runway', id: '27', short: 'RWY 27', long: 'holding point runway 27' });
  assert.ok(destinationPoint(w.L, taxiDestination(dep)));
  dep.state = 'holding';
  assert.equal(taxiDestination(dep), null);
  const arr = { kind: 'arr', state: 'vacated', gate: w.L.gates[0].id, end: '27' };
  assert.equal(taxiDestination(arr).short, `STAND ${arr.gate}`);
  assert.deepEqual(destinationPoint(w.L, taxiDestination(arr)), w.L.graph.nodes[w.L.gates[0].node].p);
  assert.equal(taxiDestination({ ...arr, state: 'final' }), null);
});

test('a voiced route with "hold short of runway": the pilot reads it back and stops there', () => {
  const w = newWorld();
  const ac = w.spawnDeparture();
  ac.callAt = 0;
  w.step(0.5);
  w.command(ac.id, { type: 'push' });
  assert.ok(runUntil(w, () => ac.state === 'pushed'));
  const plain = w.planTaxi(ac, {});
  const r = w.command(ac.id, { type: 'taxi', via: plain.via.slice(0, 1), holdShort: ['09'] });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /hold short of runway 09/);
  assert.match(r.text, new RegExp(`via ${plain.via[0]}`));
});

// ---- real-world mechanics
test('wind: pilots refuse a runway with a strong tailwind or crosswind', () => {
  const w = newWorld(); // runway 27, wind from 260 at 10 kt
  w.wind = { available: true, wind_dir: 90, wind_kt: 18 }; // 18 kt straight down the runway: tailwind
  const ac = w.spawnArrival(null, 6);
  const r = w.command(ac.id, { type: 'land' });
  assert.equal(r.ok, false);
  assert.match(r.text, /tailwind 18 knots is above our limit/);
  assert.ok(!ac.cleared.land);
  w.wind = { available: true, wind_dir: 180, wind_kt: 35 }; // 35 kt across
  assert.match(w.command(ac.id, { type: 'land' }).text, /crosswind 35 knots/);
  w.wind = { available: true, wind_dir: 260, wind_kt: 12 };
  assert.equal(w.command(ac.id, { type: 'land' }).ok, true);
});

test('wind: a headwind slows the closing speed on final, and the approach slows down towards the runway', () => {
  const closing = (wind) => {
    const w = newWorld();
    w.wind = wind;
    const ac = w.spawnArrival(null, 10);
    const d0 = ac.dist;
    w.step(10);
    return (d0 - ac.dist) / 10;
  };
  const head = closing({ available: true, wind_dir: 270, wind_kt: 20 });
  const tail = closing({ available: true, wind_dir: 90, wind_kt: 8 });
  assert.ok(head < tail - 10, `headwind ${head.toFixed(1)} m/s vs tailwind ${tail.toFixed(1)} m/s`);
  const w = newWorld();
  const ac = w.spawnArrival(null, 10);
  w.step(1);
  const far = ac.v;
  const near = (() => { ac.dist = 2 * 1852; w.step(1); return ac.v; })();
  assert.ok(far > near + 8, 'faster at 10 NM than at 2 NM');
});

test('a departure cleared with an arrival inside 2 NM is penalised', () => {
  const w = newWorld();
  const dep = w.spawnDeparture();
  dep.callAt = 0;
  w.step(0.5);
  w.command(dep.id, { type: 'push' });
  assert.ok(runUntil(w, () => dep.state === 'pushed'));
  w.command(dep.id, { type: 'taxi' });
  assert.ok(runUntil(w, () => dep.state === 'holding'));
  const arr = w.spawnArrival(null, 1.5);
  const before = w.score;
  w.command(dep.id, { type: 'takeoff' });
  assert.ok(w.score <= before + SCORE.shortFinalDeparture, `score ${before} -> ${w.score}`);
  assert.ok(w.drain().some((e) => e.kind === 'score' && /keep 2 NM/.test(e.reason)));
  void arr;
});

test('taxiing aircraft slow down for corners', async () => {
  const { Path } = await import('../js/geo.js');
  const p = new Path([[0, 0], [100, 0], [100, 100]]);
  assert.deepEqual(p.turns().map((t) => [t.s, Math.round(t.angle)]), [[100, 90]]);
  const gentle = new Path([[0, 0], [100, 0], [200, 10]]);
  assert.equal(gentle.turns().length, 0);
  // a curve of small steps is one turn, not many
  const curve = new Path([[0, 0], [50, 0], [60, 5], [67, 13], [70, 22], [70, 70]]);
  assert.equal(curve.turns().length, 1);
});
