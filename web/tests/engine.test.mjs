import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AtcEngine } from '../js/atc/engine.js';
import { loadPhraseology } from '../js/atc/phraseology.js';
import { distanceNm } from '../js/atc/runway.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const load = (id) => loadPhraseology(id, async (x) => json(`../phraseology/${x}.json`));
const XDEP = json('./fixtures/xdep.json');
const XARR = json('./fixtures/xarr.json');
const AIRLINES = json('../data/airlines.json');

function seeded(seed = 42) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

const FP = {
  callsign: 'CCA1234', dep: 'XDEP', arr: 'XARR', cruise: 'FL240', sid: 'DEMO1A', star: 'HARB2B',
  approach: 'ILS', arrStand: 'B7',
};
const METAR_DEP = { available: true, wind_dir: 260, wind_kt: 12, qnh_hpa: 1015, time: '2026-10-29T07:00:00Z' };
const METAR_ARR = { available: true, wind_dir: 30, wind_kt: 9, qnh_hpa: 1012, time: '2026-10-29T08:00:00Z' };

function makeSim(over = {}) {
  return {
    connected: true, in_flight: true, lat: XDEP.lat, lon: XDEP.lon, alt_ft: 120, alt_agl_ft: 0, ind_alt_ft: 120,
    gs_kt: 0, vs_fpm: 0, on_ground: true, com1_active: 122.8, com2_active: 121.5, xpdr: '2000',
    parking_brake: true, ...over,
  };
}

// Where to put the aircraft so the phase's automatic event happens.
function simFor(engine, sim) {
  const end = (which) => engine.runwayEnd(which);
  const arrEnd = end('arr');
  const towards = (nm) => ({ lat: arrEnd.lat - nm / 60, lon: arrEnd.lon });
  switch (engine.s.phase) {
    case 'taxiing': return { ...sim, lat: end('dep').lat, lon: end('dep').lon, gs_kt: 0, parking_brake: false };
    case 'takeoff': return { ...sim, on_ground: false, alt_agl_ft: 1000, ind_alt_ft: 1120, gs_kt: 170 };
    case 'departure_climb': return { ...sim, on_ground: false, ind_alt_ft: engine.s.cleared - 1000 };
    case 'cruise': return { ...sim, on_ground: false, ind_alt_ft: 24000, ...towards(60) };
    case 'descent': return { ...sim, on_ground: false, ind_alt_ft: 11000, ...towards(35) };
    case 'approach': return { ...sim, on_ground: false, ind_alt_ft: 3000, ...towards(15) };
    case 'final': return { ...sim, on_ground: false, ind_alt_ft: 2500, ...towards(8) };
    case 'tower_checkin': return { ...sim, on_ground: false, ind_alt_ft: 1000, ...towards(3) };
    case 'landing': return { ...sim, on_ground: true, gs_kt: 30, ind_alt_ft: 40, ...towards(0) };
    case 'taxi_in': return { ...sim, gs_kt: 0, parking_brake: true };
    default: return sim;
  }
}

async function newEngine(region = 'icao', options = {}) {
  const phr = await load(region);
  const e = new AtcEngine({ phraseology: phr, airlines: AIRLINES, rng: seeded(), options });
  let t = 1_000_000;
  const now = () => (t += 5000);
  e.setFlightPlan(FP, XDEP, XARR, now());
  e.setWeather('dep', METAR_DEP);
  e.setWeather('arr', METAR_ARR);
  return { e, now };
}

// Fly the whole flight like a pilot who follows the hints and presses buttons.
function flyWholeFlight(e, now) {
  let sim = makeSim();
  const log = [];
  const push = (evs) => {
    for (const ev of evs) {
      log.push(ev);
      if (ev.kind === 'effect' && ev.mock.cmd === 'squawk') sim = { ...sim, xpdr: ev.mock.code };
    }
  };
  push(e.updateSim(sim, now()));
  for (let i = 0; i < 200 && e.s.phase !== 'done'; i += 1) {
    const hint = e.getHint();
    if (hint.tune) {
      sim = { ...sim, com1_active: Number(hint.tune.freq) };
      push(e.updateSim(sim, now()));
      continue;
    }
    const primary = e.getActions().find((a) => a.primary);
    if (primary) {
      push(e.pilotSays(primary.text, { intent: primary.intent === 'readback' ? null : primary.intent, now: now() }));
      continue;
    }
    sim = simFor(e, sim);
    push(e.updateSim(sim, now()));
    push(e.updateSim(sim, now())); // second tick: "stopped for 4 s" style conditions
  }
  return log;
}

test('a whole IFR flight, departure to parking, ICAO phraseology', async () => {
  const { e, now } = await newEngine();
  const log = flyWholeFlight(e, now);
  assert.equal(e.s.phase, 'done', `stuck in ${e.s.phase}`);
  const atc = log.filter((m) => m.kind === 'atc');
  const tpls = atc.map((m) => m.tpl);
  assert.deepEqual(tpls, [
    'clearance', 'readback_correct_next', 'pushback', 'taxi', 'taxi_handoff', 'takeoff', 'departure_handoff',
    'radar_contact', 'climb_handoff', 'center_climb', 'descent', 'approach_handoff', 'approach_checkin',
    'approach_clearance', 'final_handoff', 'landing', 'vacate', 'taxi_in',
  ]);
  for (const m of atc) {
    assert.ok(m.heard, `${m.tpl} should be heard on the right frequency`);
    assert.doesNotMatch(m.text + m.speech, /[{}[\]]|undefined|null|NaN/, m.text);
  }
  const text = (tpl) => atc.find((m) => m.tpl === tpl).text;
  assert.match(text('clearance'), /^Air China 1234, Demo Delivery, cleared to XARR via DEMO1A departure, flight planned route, runway 27, climb 5000 ft, squawk [0-7]{4}\.$/);
  assert.match(atc.find((m) => m.tpl === 'clearance').speech, /cleared to Harbour Town .* runway two seven, climb five thousand feet/);
  assert.match(text('readback_correct_next'), /contact Demo Ground on 121\.9/);
  assert.match(text('taxi'), /taxi to holding point runway 27, QNH 1015\.$/);
  assert.match(text('takeoff'), /wind 260\/12, runway 27, cleared for take-off/);
  assert.match(text('departure_handoff'), /contact Demo Departure on 124\.35, good day/);
  assert.match(text('radar_contact'), /radar contact, climb FL150/);
  assert.match(text('center_climb'), /Oceanic Control, identified, climb FL240/);
  assert.match(text('descent'), /descend FL100, HARB2B arrival, expect ILS approach runway 04/);
  assert.match(text('approach_checkin'), /information I is current, descend altitude 3000 ft, QNH 1012, expect ILS approach runway 04/);
  assert.match(text('landing'), /wind 030\/09, runway 04, cleared to land/);
  assert.match(text('taxi_in'), /taxi to stand B7/);
  assert.ok(log.some((m) => m.kind === 'system' && /Flight complete/.test(m.text)));
  const effects = log.filter((m) => m.kind === 'effect').map((m) => m.mock.phase || m.mock.cmd);
  assert.deepEqual(effects, ['squawk', 'pushback', 'taxi', 'takeoff']);
});

test('China region: metric levels and readbacks', async () => {
  const { e, now } = await newEngine('china');
  e.fp.cruise = '10100m';
  const log = flyWholeFlight(e, now);
  assert.equal(e.s.phase, 'done');
  const atc = log.filter((m) => m.kind === 'atc');
  const byTpl = (t) => atc.find((m) => m.tpl === t);
  assert.match(byTpl('clearance').text, /initial climb 900 m, squawk/);
  assert.match(byTpl('clearance').speech, /initial climb niner hundred meters/);
  assert.match(byTpl('radar_contact').text, /climb to 6000 m/);
  assert.match(byTpl('center_climb').text, /climb to 10100 m/);
  assert.match(byTpl('center_climb').speech, /one zero thousand one hundred meters/);
  assert.match(byTpl('descent').text, /descend to 3600 m/);
  assert.match(byTpl('approach_checkin').text, /descend to 900 m on QNH 1012/);
});

test('frequency check: wrong frequency, wrong unit, missed calls', async () => {
  const { e, now } = await newEngine();
  e.updateSim(makeSim({ com1_active: 123.45 }), now());
  let ev = e.pilotSays('Demo Delivery, Air China 1234, request IFR clearance', { now: now() });
  assert.equal(ev.length, 2);
  assert.match(ev[1].text, /No reply: no controller on 123\.45\. Tune Demo Delivery 121\.65/);
  e.updateSim(makeSim({ com1_active: 118.7 }), now()); // tower
  ev = e.pilotSays('request IFR clearance', { now: now() });
  assert.equal(ev[1].tpl, 'wrong_unit');
  assert.match(ev[1].text, /Demo Tower, contact Demo Delivery on 121\.65/);
  // radios unknown (sim not connected): no frequency check
  e.updateSim({ connected: false, in_flight: false }, now());
  ev = e.pilotSays('request IFR clearance', { now: now() });
  assert.equal(ev[1].tpl, 'clearance');
});

test('readback is checked and corrected', async () => {
  const { e, now } = await newEngine();
  e.updateSim(makeSim({ com1_active: 121.65 }), now());
  e.pilotSays('request clearance', { now: now() });
  const sq = e.s.squawk;
  let ev = e.pilotSays('cleared XARR runway 27 climb 5000', { now: now() });
  assert.equal(ev[1].tpl, 'readback_wrong');
  assert.match(ev[1].text, new RegExp(`I say again: squawk ${sq}\\.`));
  assert.equal(e.s.phase, 'clearance');
  ev = e.pilotSays('request taxi', { now: now() });
  assert.equal(ev[1].tpl, 'readback_required');
  const spoken = sq.split('').map((d) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][Number(d)]).join(' ');
  ev = e.pilotSays(`cleared to XARR, runway two seven, climb five thousand feet, squawk ${spoken}`, { now: now() });
  assert.equal(ev[1].tpl, 'readback_correct_next');
  assert.equal(e.s.phase, 'startup');
  ev = e.pilotSays('say again', { now: now() });
  assert.equal(ev[1].tpl, 'readback_correct_next');
});

test('a call made while tuned elsewhere is repeated once you tune in', async () => {
  const { e, now } = await newEngine();
  const t = now();
  e.s.phase = 'takeoff';
  e.s.depRunway = { ident: '27' };
  let ev = e.updateSim(makeSim({ com1_active: 121.9, on_ground: false, alt_agl_ft: 900 }), t);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].tpl, 'departure_handoff');
  assert.equal(ev[0].heard, false);
  assert.match(e.getHint().missed, /Demo Tower is calling you on 118\.7/);
  ev = e.updateSim(makeSim({ com1_active: 118.7, on_ground: false, alt_agl_ft: 1200 }), t + 2000);
  assert.equal(ev[0].tpl, 'departure_handoff');
  assert.equal(ev[0].heard, true);
  assert.equal(e.s.missed, null);
});

test('go-around from tower goes back to approach', async () => {
  const { e, now } = await newEngine();
  Object.assign(e.s, { phase: 'landing' });
  e.updateSim(makeSim({ com1_active: 118.3, on_ground: false, alt_agl_ft: 300 }), now());
  const go = e.getActions().find((a) => a.id === 'go_around');
  let ev = e.pilotSays(go.text, { intent: 'go_around', now: now() });
  assert.equal(ev[1].tpl, 'go_around');
  assert.match(ev[1].text, /climb 3000 ft, contact Harbour Approach on 120\.8/);
  const rb = e.getActions().find((a) => a.id === 'readback');
  ev = e.pilotSays(rb.text, { now: now() });
  assert.equal(e.s.phase, 'approach_checkin');
});

test('skip works without a simulator, and state survives a reload', async () => {
  const { e, now } = await newEngine();
  e.updateSim({ connected: false, in_flight: false }, now());
  for (const a of ['request_clearance', 'readback', 'request_pushback', 'readback', 'request_taxi', 'readback']) {
    const act = e.getActions().find((x) => x.id === a);
    assert.ok(act, `button ${a} in ${e.s.phase}`);
    e.pilotSays(act.text, { intent: act.intent === 'readback' ? null : act.intent, now: now() });
  }
  assert.equal(e.s.phase, 'taxiing');
  assert.ok(e.canSkip());
  const ev = e.skip(now());
  assert.equal(ev[0].tpl, 'taxi_handoff');
  const saved = e.serialize();
  const phr = await load('icao');
  const e2 = new AtcEngine({ phraseology: phr, airlines: AIRLINES });
  e2.restore(saved);
  assert.equal(e2.s.phase, 'taxiing');
  assert.equal(e2.getActions()[0].id, 'readback');
  assert.match(e2.getActions()[0].text, /^118\.7, Air China 1234\.$/);
});

test('airport without frequencies falls back sensibly', async () => {
  const phr = await load('icao');
  const bare = { ...XDEP, frequencies: { TWR: [{ mhz: '119.100' }] }, names: {} };
  const e = new AtcEngine({ phraseology: phr, airlines: AIRLINES, rng: seeded() });
  const ev = e.setFlightPlan({ ...FP }, bare, { ...XARR, frequencies: {}, names: {} }, 1);
  assert.equal(e.units.dep_DEL.freq, '119.100');
  assert.equal(e.units.dep_GND.freq, '119.100');
  assert.equal(e.units.dep_DEP.freq, '127.500'); // no DEP/APP/CTR anywhere: region default centre
  assert.ok(ev.some((m) => /No TWR frequency known for XARR/.test(m.text)));
  assert.equal(e.units.dep_DEL.name, 'Demo City Delivery');
});

test('distance helper', () => {
  assert.ok(Math.abs(distanceNm(0, 0, 1, 0) - 60.04) < 0.1);
});
