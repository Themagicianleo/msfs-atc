import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout } from '../js/layout.js';
import { unpackLayout } from '../js/osm.js';
import { World } from '../js/world.js';
import { chooseConfig, endWinds, runwayPlans } from '../js/ops.js';
import { parseInstruction, parseInstructionZh } from '../js/commands.js';
import { bigAirport } from './layout.test.mjs';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const PHR = json('../data/phraseology.json');
const PHR_ZH = json('../data/phraseology-zh.json');
const AIRLINES = json('../data/airlines.json');
const hq = (code) => ({ L: unpackLayout(json(`../data/hq/${code}.json`)), profile: json(`../data/traffic/${code}.json`) });
const wind = (dir, kt) => ({ available: true, wind_dir: dir, wind_kt: kt });

function seeded(seed = 3) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function newWorld(arr, dep) {
  const w = new World({ layout: buildLayout(bigAirport()), phr: PHR, airlines: AIRLINES, rng: seeded(), arrEnd: arr, depEnd: dep, traffic: 'off' });
  w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
  return w;
}

test('the recommended plan follows the wind, and its headwind is shown for every runway end', () => {
  const { L, profile } = hq('WSSS');
  assert.equal(chooseConfig(L, wind(20, 12), profile).name, 'North (02)');
  assert.equal(chooseConfig(L, wind(200, 10), profile).name, 'South (20)');
  const winds = endWinds(L, wind(20, 12));
  const e02 = winds.find((e) => e.ident === '02L');
  assert.ok(e02.headwind >= 10 && e02.crosswind <= 4, JSON.stringify(e02));
  assert.ok(winds.find((e) => e.ident === '20R').headwind < -9, 'the opposite end has a tailwind');
});

test('an airport with its own plans offers those; a plan into the wind is recommended when they have a tailwind', () => {
  const { L, profile } = hq('ZBAD');
  // a good wind: the published plan for it comes first
  const good = runwayPlans(L, wind(350, 12), profile);
  assert.ok(good.some((p) => /North flow/.test(p.name)) && good.some((p) => /South flow/.test(p.name)));
  assert.match(good[0].name, /North flow/);
  assert.deepEqual([good[0].arr, good[0].dep], [['35R', '01L'], ['35L']]);
  assert.match(runwayPlans(L, wind(170, 10), profile)[0].name, /South flow/);
  // an airport whose only published plan has a tailwind: a plan into the wind is recommended, and the published one stays on the list
  const only = { ...profile, configs: profile.configs.filter((c) => /North/.test(c.name)) };
  const plans = runwayPlans(L, wind(170, 9), only);
  assert.ok(plans[0].headwind >= 8 && /not a published plan/.test(plans[0].reason), JSON.stringify(plans[0]));
  const north = plans.find((p) => /North flow/.test(p.name));
  assert.ok(north && north.headwind < 0, 'the North flow is still there, with its tailwind');
  // every runway end can be chosen, with its wind
  assert.ok(endWinds(L, wind(170, 9)).find((e) => e.ident === '17L').headwind >= 8);
});

test('several runways at once: split and mixed plans for parallels', () => {
  const { L, profile } = hq('WSSS');
  const plans = runwayPlans(L, wind(30, 8), profile);
  assert.equal(plans[0].name, 'North (02)');
  assert.deepEqual([plans[0].arr, plans[0].dep], [['02L'], ['02C']]);
  const mixed = plans.find((p) => /mixed/.test(p.name));
  assert.deepEqual(mixed.arr, mixed.dep);
  assert.ok(mixed.arr.length >= 2 && /harder/.test(mixed.reason), 'every runway lands and departs, and says it is harder');
  const z = hq('ZBAD');
  const zp = runwayPlans(z.L, wind(180, 9), z.profile);
  assert.deepEqual([zp[0].arr, zp[0].dep], [['17L', '19R'], ['17R', '11L']]); // Daxing's South flow
  assert.ok(zp.some((p) => p.arr.length > 1 && p.dep.length > 1));
  // a wind from the north-west: no plan recommended has a tailwind
  assert.ok(runwayPlans(z.L, wind(290, 9), z.profile)[0].headwind >= 0);
});

test('departures alternate between the runways in use, and are told which to expect at pushback', () => {
  const w = newWorld('27R', ['27R', '27L']);
  const ends = [1, 2, 3, 4].map(() => w.spawnDeparture().end);
  assert.deepEqual([...new Set(ends)].sort(), ['27L', '27R']);
  const ac = w.spawnDeparture();
  ac.callAt = 0;
  const expected = ac.end;
  w.step(0.5);
  w.drain();
  const r = w.command(ac.id, { type: 'push' });
  assert.equal(r.ok, true);
  assert.match(r.text, new RegExp(`expect runway ${expected.replace(/^0/, '')}`), r.text);
  assert.equal(w.controllerText(ac, 'push'), `${ac.cs.t}, pushback approved, expect runway ${w.rwy(ac, ac.end).t} for departure.`);
});

test('the tower can name a different runway at pushback; an unknown runway is refused', () => {
  const w = newWorld('27R', ['27R', '27L']);
  const ac = w.spawnDeparture();
  const other = ac.end === '27R' ? '27L' : '27R';
  assert.deepEqual(w.pushRunways(ac).sort(), ['27L', '27R']);
  const bad = w.command(ac.id, { type: 'push', runway: '09' });
  assert.equal(bad.ok, false);
  assert.equal(ac.state, 'gate');
  const r = w.command(ac.id, { type: 'push', runway: other });
  assert.equal(r.ok, true);
  assert.equal(ac.end, other);
  assert.match(r.text, new RegExp(`runway ${other.replace(/^0/, '')}`));
});

test('changing the runways: aircraft still at the stand follow the new plan, others keep theirs', () => {
  const w = newWorld('27R', '27R');
  const atGate = w.spawnDeparture();
  const moving = w.spawnDeparture();
  moving.state = 'taxi_out';
  w.setRunways(['27L'], ['27L']);
  assert.equal(atGate.end, '27L');
  assert.equal(moving.end, '27R');
  assert.deepEqual([w.arrEnds, w.depEnds], [['27L'], ['27L']]);
});

test('"pushback approved, expect runway ..." is understood in English and Chinese', () => {
  const R = PHR.commands;
  const c = parseInstruction('speedbird 123 pushback approved expect runway 27 right for departure', R);
  assert.deepEqual([c.type, c.runway], ['push', '27R']);
  assert.deepEqual(parseInstruction('speedbird 123 pushback approved', R), { type: 'push' });
  const z = parseInstructionZh('南方三幺洞幺，可以推出，预计跑道17右起飞', PHR_ZH.commands);
  assert.deepEqual([z.type, z.runway], ['push', '17R']);
  const z2 = parseInstructionZh('可以退出，预计跑道幺七又起非', PHR_ZH.commands);
  assert.deepEqual([z2.type, z2.runway], ['push', '17R'], 'even misheard');
});

test('a departure lining up is not blocked by another holding at the same hold point (no deadlock)', () => {
  const w = newWorld('27R', '27R');
  const a = w.spawnDeparture();
  const b = w.spawnDeparture();
  const hp = w.L.holdPoints['27R'];
  for (const ac of [a, b]) {
    ac.state = 'holding';
    ac.p = [...w.L.graph.nodes[hp.h].p];
    ac.atNode = hp.h;
    ac.v = 0;
    ac.req = null;
  }
  assert.equal(w.command(a.id, { type: 'takeoff' }).ok, true);
  let rolled = false;
  for (let t = 0; t < 300 && !rolled; t += 0.5) {
    w.step(0.5);
    rolled = ['takeoff', 'climb'].includes(a.state);
  }
  assert.ok(rolled, `stuck in ${a.state}, blocked by ${a.blockedBy}`);
  assert.equal(b.state, 'holding', 'the other waits for the runway');
});
