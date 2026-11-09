import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout } from '../js/layout.js';
import { World } from '../js/world.js';
import { Speaker, pilotVoiceShape, voiceGender } from '../js/lib/speech.js';
import { SPEAKER_GENDER, pilotVoice } from '../js/lib/neural.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const v = (name, lang = 'en-US') => ({ name, lang, localService: true, voiceURI: name });

test('pilots on a frequency are women and men, with voices to match (device voices)', () => {
  assert.equal(voiceGender(v('Samantha')), 'f');
  assert.equal(voiceGender(v('Daniel', 'en-GB')), 'm');
  assert.equal(voiceGender(v('Google UK English Male', 'en-GB')), 'm');
  assert.equal(voiceGender(v('Microsoft Aria Online (Natural) - English (United States)')), 'f');
  assert.equal(voiceGender(v('Something Unknown')), null);
  const s = Object.create(Speaker.prototype);
  s.settings = { varyVoices: true, accents: false };
  s.voices = [v('Samantha'), v('Karen', 'en-AU'), v('Moira', 'en-IE'), v('Tessa', 'en-ZA'), v('Daniel', 'en-GB'), v('Alex'), v('Aaron'), v('Fred')];
  const seen = { f: 0, m: 0 };
  for (let i = 0; i < 80; i += 1) seen[voiceGender(s.voiceFor(`ac${i}`, 'UAL'))] += 1;
  assert.ok(seen.f >= 25 && seen.m >= 25, JSON.stringify(seen));
});

test('pilots speak at quite different paces and pitches', () => {
  const shapes = Array.from({ length: 200 }, (_, i) => pilotVoiceShape(`ac${i}`));
  const rates = shapes.map((x) => x.rate);
  assert.ok(Math.min(...rates) < 0.92 && Math.max(...rates) > 1.22, `${Math.min(...rates)}..${Math.max(...rates)}`);
  const pitches = shapes.map((x) => x.pitch);
  assert.ok(Math.min(...pitches) < 0.87 && Math.max(...pitches) > 1.13);
});

test('built-in voices: women and men among the pilots of one airline, and a wide range of pace', () => {
  const configs = { intl: { speaker_id_map: Object.fromEntries(Object.keys(SPEAKER_GENDER.intl).map((n, i) => [n, i])) } };
  const have = new Set(['intl']);
  const byIndex = Object.fromEntries(Object.entries(configs.intl.speaker_id_map).map(([n, i]) => [i, n]));
  const seen = { f: 0, m: 0 };
  const rates = [];
  for (let i = 0; i < 100; i += 1) {
    const pv = pilotVoice(`ac${i}`, 'CCA', 'en', have, configs); // Chinese airline: the Mandarin-accented speakers
    seen[SPEAKER_GENDER.intl[byIndex[pv.speaker]]] += 1;
    rates.push(pv.rate);
  }
  assert.ok(seen.f >= 30 && seen.m >= 30, JSON.stringify(seen));
  assert.ok(Math.min(...rates) < 0.92 && Math.max(...rates) > 1.2);
});

test('every aircraft taxis in a way of its own: some brisk, some cautious, quick or slow to pick up speed', () => {
  let s = 3;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const w = new World({ layout: buildLayout(json('./fixtures/xdep.json')), phr: json('../data/phraseology.json'), airlines: json('../data/airlines.json'),
    rng, arrEnd: '27', depEnd: '27', traffic: 'off', wind: { available: true, wind_dir: 260, wind_kt: 10 } });
  w.nextArr = Infinity; w.nextDep = Infinity;
  const styles = [];
  for (let i = 0; i < 60; i += 1) { const a = w.makeAircraft('dep'); a.callsign = `TST${i}`; styles.push(a.taxi); }
  const a = w.makeAircraft('dep', { callsign: 'BAW123', code: 'BAW', tel: 'Speedbird', num: '123' });
  const same = w.makeAircraft('dep', { callsign: 'BAW123', code: 'BAW', tel: 'Speedbird', num: '123' });
  assert.deepEqual(a.taxi, same.taxi); // stable per aircraft
  const sp = Array.from({ length: 80 }, (_, i) => w.makeAircraft('dep', { callsign: `X${i}A`, code: 'XXX', tel: 'X', num: String(i) }).taxi.speed);
  const kt = (f) => 10 * f / 0.514444;
  assert.ok(kt(Math.min(...sp)) < 16 && kt(Math.max(...sp)) > 25, `${kt(Math.min(...sp))}..${kt(Math.max(...sp))} kt`);
  assert.ok(new Set(sp.map((x) => x.toFixed(2))).size > 40);
});

// ---------------------------------------------------------------- the route picker
import { unpackLayout } from '../js/osm.js';
import { nearestTaxiway, routeNames } from '../js/layout.js';

function daxing(callsign = null) {
  let s = 5;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const L = unpackLayout(json('../data/hq/ZBAD.json'));
  const w = new World({ layout: L, phr: json('../data/phraseology.json'), airlines: json('../data/airlines.json'), rng, arrEnd: ['17L'], depEnd: ['17R'],
    traffic: 'off', profile: json('../data/traffic/ZBAD.json'), types: json('../data/aircraft.json') });
  w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
  const g = L.graph;
  const ac = w.spawnDeparture();
  if (callsign) { ac.callsign = callsign; ac.taxi = undefined; }
  w.gateUse.delete(ac.gate);
  ac.gate = '166';
  w.gateUse.set('166', ac.id);
  ac.p = [...g.nodes[L.gates.find((x) => x.id === '166').node].p];
  ac.callAt = 0;
  w.step(0.5);
  w.command(ac.id, { type: 'push' });
  for (let t = 0; t < 400 && ac.state !== 'pushed'; t += 0.5) w.step(0.5);
  w.drain();
  return { w, L, ac };
}

test('route picker: a tap near a taxiway finds it by name, and the next taxiways offered are ones that join', () => {
  const { w, L, ac } = daxing();
  const g = L.graph;
  const e = g.edges.find((x) => x.kind === 'twy' && x.name && x.len > 20);
  const a = g.nodes[e.a].p; const b = g.nodes[e.b].p;
  const mid = [(a[0] + b[0]) / 2 + 12, (a[1] + b[1]) / 2 + 9]; // 15 m beside it: a fat finger
  assert.equal(nearestTaxiway(L, mid, 40)?.name, e.name);
  assert.equal(nearestTaxiway(L, [mid[0] + 9000, mid[1]], 40), null);
  const first = w.taxiOptions(ac, []);
  assert.ok(first.length >= 2, first.join());
  const reachable = first.find((n) => w.planTaxi(ac, { via: [n] }));
  assert.ok(reachable, 'one of the nearby taxiways makes a route');
  const next = w.taxiOptions(ac, [reachable]);
  assert.ok(!next.includes(reachable));
  // every offered next taxiway really meets the last one (they share a node)
  const nodesOf = (name) => new Set(g.edges.filter((x) => x.name === name).flatMap((x) => [x.a, x.b]));
  for (const n of next) assert.ok([...nodesOf(n)].some((id) => nodesOf(reachable).has(id)), `${n} joins ${reachable}`);
});

test('route picker: the route chosen by taxiway names is the route flown, and the pilot reads those names back', () => {
  const { w, L, ac } = daxing();
  const start = w.taxiOptions(ac, []);
  let chosen = null;
  for (const n of start) {
    for (const m of w.taxiOptions(ac, [n])) {
      const plan = w.planTaxi(ac, { via: [n, m] });
      if (plan && plan.via.includes(n) && plan.via.includes(m)) { chosen = [n, m]; break; }
    }
    if (chosen) break;
  }
  assert.ok(chosen, 'two taxiways that make a route');
  const plan = w.planTaxi(ac, { via: chosen });
  const r = w.command(ac.id, { type: 'taxi', via: chosen, runway: plan.runway, cross: plan.cross });
  assert.equal(r.ok, true, JSON.stringify(r));
  const flown = routeNames(L, ac.routeNodes);
  for (const n of chosen) assert.ok(flown.includes(n), `${n} in ${flown.join()}`);
  assert.deepEqual(flown, routeNames(L, plan.nodes)); // preview == flown
  assert.match(r.text, new RegExp(chosen[0]));
});

// ---------------------------------------------------------------- runway changes, and departures asking for the landing runway
const texts = (events) => events.filter((e) => e.kind === 'pilot').map((e) => e.text);

test('a departure may ask for the landing runway; the controller says yes by sending it there, and it takes off from it', () => {
  const probe = daxing().w;
  assert.deepEqual(probe.arrEnds, ['17L']);
  assert.deepEqual(probe.depEnds, ['17R']);
  const mine = Array.from({ length: 80 }, (_, i) => `TST${i}`).find((c) => probe.altRunway({ callsign: c }));
  assert.ok(mine, 'about a third of the pilots ask');
  assert.equal(probe.altRunway({ callsign: mine }), '17L'); // the landing runway, never the departure one
  assert.equal(probe.altRunway({ callsign: mine }), probe.altRunway({ callsign: mine })); // the same pilot always asks
  const asks = Array.from({ length: 300 }, (_, i) => probe.altRunway({ callsign: `ZZ${i}` })).filter(Boolean).length;
  assert.ok(asks > 60 && asks < 140, `${asks} of 300 ask`);
  // the request, in words, once it has pushed back
  const { w, ac, L } = daxing(mine);
  const heard = [];
  for (let t = 0; t < 40; t += 0.5) { w.step(0.5); heard.push(...texts(w.drain())); }
  assert.ok(heard.some((x) => /runway 17L/.test(x) && /taxi|depart/.test(x)), heard.join(' | '));
  assert.equal(ac.wants, '17L');
  assert.ok(w.taxiRunways(ac).includes('17L') && w.taxiRunways(ac).includes('17R'), 'both can be chosen');
  // approved: "taxi to holding point runway 17L"
  const r = w.command(ac.id, { type: 'taxi', runway: '17L' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ac.end, '17L');
  assert.equal(ac.req, null);
  for (let t = 0; t < 1800 && ac.state !== 'holding'; t += 0.5) { w.step(0.5); if (ac.waitingCross) w.command(ac.id, { type: 'cross' }); }
  assert.equal(ac.state, 'holding', `stuck in ${ac.state}`);
  assert.equal(ac.atNode, L.holdPoints['17L'].h);
  assert.equal(w.command(ac.id, { type: 'takeoff' }).ok, true);
  for (let t = 0; t < 300 && !['takeoff', 'climb'].includes(ac.state); t += 0.5) w.step(0.5);
  assert.ok(['takeoff', 'climb'].includes(ac.state), ac.state);
});

test('a departure that did not ask is not sent to the landing runway by itself, and one that asked can be refused', () => {
  const probe = daxing().w;
  const quiet = Array.from({ length: 80 }, (_, i) => `QQ${i}`).find((c) => !probe.altRunway({ callsign: c }));
  const { w, ac } = daxing(quiet);
  for (let t = 0; t < 40; t += 0.5) w.step(0.5);
  assert.equal(ac.wants, null);
  assert.equal(ac.end, '17R');
  const asker = Array.from({ length: 80 }, (_, i) => `TST${i}`).find((c) => probe.altRunway({ callsign: c }));
  const b = daxing(asker);
  for (let t = 0; t < 40; t += 0.5) b.w.step(0.5);
  b.w.command(b.ac.id, { type: 'taxi' }); // "no": taxi to the runway it was given
  assert.equal(b.ac.end, '17R');
});

test('the controller can change a taxiing departure to another runway, or to another route', () => {
  const { w, ac, L } = daxing();
  assert.equal(w.command(ac.id, { type: 'taxi' }).ok, true);
  for (let t = 0; t < 30; t += 0.5) w.step(0.5);
  assert.equal(ac.state, 'taxi_out');
  assert.equal(ac.end, '17R');
  assert.ok(w.available(ac).includes('taxi_out'), 'a button to change it');
  const r = w.command(ac.id, { type: 'taxi', runway: '17L' }); // "change runway, taxi to holding point runway 17L"
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ac.end, '17L');
  assert.equal(ac.state, 'taxi_out');
  assert.equal(ac.routeNodes.at(-1), L.holdPoints['17L'].h);
  // and a different route to the same runway
  const names = routeNames(L, ac.routeNodes);
  const other = w.taxiOptions(ac, []).find((n) => !names.includes(n) && w.planTaxi(ac, { via: [n], runway: '17L' })?.via.includes(n));
  assert.ok(other, 'another route to try');
  if (other) {
    assert.equal(w.command(ac.id, { type: 'taxi', via: [other], runway: '17L' }).ok, true);
    assert.ok(routeNames(L, ac.routeNodes).includes(other));
  }
  // a runway with no holding point is refused politely
  assert.equal(w.command(ac.id, { type: 'taxi', runway: '09' }).ok, false);
});

// ---------------------------------------------------------------- a runway named without its side ("35" for 35R): the recogniser often drops it
import { runwaysForArg } from '../js/layout.js';

test('"runway 17" with the side lost means the end the aircraft is on, or going to; with nothing to go by the pilot asks', () => {
  const { w, ac, L } = daxing();
  assert.deepEqual(runwaysForArg(L, '17').map((r) => r.id).sort(), ['17L/35R', '17R/35L']);
  assert.equal(runwaysForArg(L, '17L').length, 1);
  assert.deepEqual(runwaysForArg(L, '99'), []);
  assert.equal(w.resolveEnd(ac, '17'), '17R'); // it is a 17R departure
  assert.equal(w.resolveEnd(ac, '17L'), '17L'); // a full name is taken as said
  // a taxi instruction with the side missing goes where the aircraft is going
  const r = w.command(ac.id, { type: 'taxi', runway: '17' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ac.end, '17R');
  // an arrival on 17L is cleared to land "runway 17"
  const arr = w.spawnArrival(null, 6);
  assert.equal(arr.end, '17L');
  assert.equal(w.command(arr.id, { type: 'land', runway: '17' }).ok, true);
  assert.equal(arr.cleared.land, true);
  // 35: neither 35L nor 35R is in use, so there is nothing to go by: "which runway?"
  w.drain();
  const bad = w.command(ac.id, { type: 'taxi', runway: '35' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /which runway: runway 35[LR] or runway 35[LR]/);
  const ev = w.drain().find((e) => e.unable);
  assert.match(ev.speech, /runway three five (left|right)/);
  assert.equal(ac.end, '17R'); // and nothing changed
});
