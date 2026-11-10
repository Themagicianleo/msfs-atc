import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout } from '../js/layout.js';
import { World } from '../js/world.js';
import { understand } from '../js/commands.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const PHR = json('../data/phraseology.json');
const PHR_ZH = json('../data/phraseology-zh.json');
const XDEP = json('./fixtures/xdep.json');
const texts = (ev) => ev.filter((e) => e.kind === 'pilot').map((e) => e.text);

function world(events = true) {
  let s = 7;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const w = new World({ layout: buildLayout(XDEP), phr: PHR, airlines: json('../data/airlines.json'), rng, arrEnd: '27', depEnd: '27', traffic: 'off',
    wind: { available: true, wind_dir: 260, wind_kt: 10 }, events });
  w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
  return w;
}
// a callsign for which an event does (or does not) happen: events are taken from the callsign
const pick = (w, tag, pct, want = true) => Array.from({ length: 4000 }, (_, i) => `TST${i}`).find((c) => w.chance({ callsign: c }, tag, pct) === want);
const base = (callsign) => ({ callsign, code: 'TST', tel: 'Test', num: callsign.slice(3) });

test('events are off unless asked for, and each flight always behaves the same way', () => {
  const off = world(false);
  assert.equal(off.chance({ callsign: 'TST1' }, 'uns', 100), false);
  const on = world();
  assert.equal(on.chance({ callsign: 'TST1' }, 'uns', 100), true);
  const share = Array.from({ length: 2000 }, (_, i) => on.chance({ callsign: `AB${i}` }, 'uns', 5)).filter(Boolean).length;
  assert.ok(share > 60 && share < 150, `${share} of 2000 at 5%`);
  assert.equal(on.chance({ callsign: 'AB7' }, 'uns', 5), on.chance({ callsign: 'AB7' }, 'uns', 5));
});

test('some pilots go around by themselves (unstable approach): no blame, and they come back for another approach', () => {
  const w = world();
  const cs = pick(w, 'uns', 5) && Array.from({ length: 4000 }, (_, i) => `TST${i}`).find((c) => w.chance({ callsign: c }, 'uns', 5) && !w.chance({ callsign: c }, 'pri', 4));
  const ac = w.spawnArrival(null, 6);
  Object.assign(ac, { callsign: cs, unstable: true, priority: false });
  w.command(ac.id, { type: 'land' });
  w.drain();
  const heard = [];
  for (let t = 0; t < 200 && ac.state === 'final'; t += 0.5) { w.step(0.5); heard.push(...w.drain()); }
  assert.equal(ac.state, 'go_around');
  assert.ok(texts(heard).some((x) => /unstable approach/.test(x)), texts(heard).join('|'));
  assert.equal(w.score, 0, 'not the controller\'s doing');
  assert.equal(w.stats.goArounds, 1);
  assert.equal(w.requeue.length, 1); // it will be back
});

test('a priority arrival says so on first call, and making it go around is flagged', () => {
  const w = world();
  const ac = w.spawnArrival(null, 6);
  w.drain();
  ac.priority = true;
  w.request(ac, 'land', 'arr_priority');
  assert.match(texts(w.drain())[0], /PAN PAN, medical emergency/);
  const ev = [];
  for (let t = 0; t < 300 && ac.state === 'final'; t += 0.5) { w.step(0.5); ev.push(...w.drain()); } // never cleared to land
  assert.equal(ac.state, 'go_around');
  assert.ok(ev.some((e) => e.kind === 'alert' && /Priority aircraft/.test(e.text)));
});

test('a departure that is not ready says so at the holding point, refuses a clearance, then calls ready', () => {
  const w = world();
  const cs = pick(w, 'nrdy', 7);
  const ac = w.makeAircraft('dep', base(cs));
  const quiet = w.makeAircraft('dep', base(pick(w, 'nrdy', 7, false)));
  for (const a of [ac, quiet]) { a.end = '27'; a.state = 'taxi_out'; a.atNode = w.L.holdPoints['27'].h; const p = w.L.graph.nodes[a.atNode].p; w.setPath(a, [[p[0] - 30, p[1]], p]); }
  quiet.ghostUntil = Infinity; ac.ghostUntil = Infinity;
  const heard = [];
  for (let t = 0; t < 30; t += 0.5) { w.step(0.5); heard.push(...w.drain()); }
  assert.equal(ac.state, 'holding');
  assert.ok(texts(heard).some((x) => x.includes(ac.cs.t) && /need two minutes/.test(x)), texts(heard).join('|'));
  assert.ok(texts(heard).some((x) => x.includes(quiet.cs.t) && /ready for departure/.test(x)), 'the other one is ready at once');
  assert.equal(ac.req, null);
  const r = w.command(ac.id, { type: 'takeoff' });
  assert.equal(r.ok, false);
  assert.match(r.text, /not ready yet/);
  heard.length = 0;
  for (let t = 0; t < 140; t += 0.5) { w.step(0.5); heard.push(...w.drain()); }
  assert.ok(texts(heard).some((x) => x.includes(ac.cs.t) && /ready for departure/.test(x)));
  assert.equal(w.command(ac.id, { type: 'takeoff' }).ok, true);
});

test('a take-off clearance can be cancelled before the roll; not once rolling', () => {
  const w = world(false);
  const ac = w.makeAircraft('dep', base('TST1'));
  ac.end = '27'; ac.state = 'lined_up'; ac.linedAt = 0;
  assert.match(w.command(ac.id, { type: 'cancel_takeoff' }).text, /no take-off clearance/);
  ac.cleared.takeoff = true;
  assert.deepEqual(w.available(ac), ['cancel_takeoff']);
  const r = w.command(ac.id, { type: 'cancel_takeoff' });
  assert.equal(r.ok, true);
  assert.match(r.text, /take-off clearance cancelled/);
  assert.equal(ac.cleared.takeoff, false);
  assert.deepEqual(w.available(ac), ['takeoff']);
  ac.cleared.takeoff = true; ac.state = 'takeoff';
  assert.match(w.command(ac.id, { type: 'cancel_takeoff' }).text, /already rolling/);
  // said in English and Chinese
  const list = [{ id: 1, code: 'CSN', tel: 'China Southern', telZh: '南方', num: '3101', callsign: 'CSN3101' }];
  assert.equal(understand('China Southern 3101 hold position, cancel take-off clearance', list, PHR.commands).cmd.type, 'cancel_takeoff');
  assert.equal(understand('China Southern 3101 cancel takeoff', list, PHR.commands).cmd.type, 'cancel_takeoff');
  assert.equal(understand('China Southern 3101 runway 27 cleared for take-off', list, PHR.commands).cmd.type, 'takeoff');
  assert.equal(understand('南方3101，取消起飞许可，原地等待', list, PHR.commands, null, null, PHR_ZH.commands).cmd.type, 'cancel_takeoff');
  assert.equal(understand('南方3101，跑道27，可以起飞', list, PHR.commands, null, null, PHR_ZH.commands).cmd.type, 'takeoff');
});

test('the wind shifts during a shift, by a believable amount, and says so', () => {
  const w = world();
  const seen = [];
  const start = { ...w.wind };
  for (let t = 0; t < 3600; t += 1) { w.step(1); seen.push(...w.drain().filter((e) => e.kind === 'wind').map((e) => ({ turn: e.turn, dir: e.wind.wind_dir, kt: e.wind.wind_kt }))); }
  assert.ok(seen.length >= 2 && seen.length <= 8, `${seen.length} shifts in an hour`);
  for (const e of seen) assert.ok(Math.abs(e.turn) >= 10 && Math.abs(e.turn) <= 35);
  assert.ok(w.wind.wind_kt >= 2 && w.wind.wind_kt <= 28 && w.wind.wind_dir >= 10 && w.wind.wind_dir <= 360 && w.wind.wind_dir % 10 === 0);
  assert.ok(seen.some((e) => e.dir !== start.wind_dir), JSON.stringify(seen));
  const calm = world(false);
  for (let t = 0; t < 3600; t += 1) calm.step(1);
  assert.equal(calm.wind.wind_dir, 260); // off: the wind stays
});

test('how long pilots wait for an answer is kept for the shift summary', () => {
  const w = world(false);
  const ac = w.spawnArrival(null, 8);
  for (let t = 0; t < 20; t += 0.5) w.step(0.5);
  w.command(ac.id, { type: 'land' });
  assert.equal(w.stats.waits, 1);
  assert.ok(w.stats.waitSum >= 19 && w.stats.waitSum <= 21, String(w.stats.waitSum));
});

test('a busy hour with events on runs clean: aircraft still land, depart and park', () => {
  let s = 11;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const w = new World({ layout: buildLayout(XDEP), phr: PHR, airlines: json('../data/airlines.json'), rng, arrEnd: '27', depEnd: '27', traffic: 'normal',
    wind: { available: true, wind_dir: 260, wind_kt: 8 }, events: true });
  for (let t = 0; t < 3600; t += 0.5) {
    w.step(0.5);
    w.drain();
    for (const a of w.ac) {
      if (!a.req) continue;
      const type = { land: 'land', push: 'push', taxi: 'taxi', takeoff: 'takeoff', taxi_in: 'taxi', cross: 'cross' }[a.req.type];
      if (type) w.command(a.id, { type });
    }
    for (const a of w.ac) if (a.state === 'climb' && !a.cleared.contact) w.command(a.id, { type: 'contact' });
  }
  assert.ok(w.stats.arrived >= 4 && w.stats.departed >= 4, JSON.stringify(w.stats));
});
