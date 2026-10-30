import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Formatter, callsignOf, parseLevel, render } from '../js/atc/format.js';
import { compact, detectIntent, missingItems, normalize } from '../js/atc/parser.js';
import { selectRunway } from '../js/atc/runway.js';
import { deepMerge, loadPhraseology, validatePhraseology } from '../js/atc/phraseology.js';
import { carrierMHz, designator, is833Channel, isComChannel, readbackTokens, sameFrequency } from '../js/atc/frequency.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const load = (id) => loadPhraseology(id, async (x) => json(`../phraseology/${x}.json`));

test('frequencies, runways, squawks', () => {
  const f = new Formatter({});
  assert.deepEqual(f.freq(121.9), { t: '121.9', s: 'one two one decimal niner', mhz: 121.9 });
  assert.equal(f.freq('118.700').t, '118.7');
  assert.equal(f.freq(124.35).t, '124.350'); // ICAO: six digits unless the last two are zero
  assert.equal(f.freq(124.35).s, 'one two four decimal three five zero');
  assert.equal(new Formatter({ units: { freqStyle: 'trim' } }).freq(124.35).t, '124.35');
  assert.equal(f.freq(118.705).s, 'one one eight decimal seven zero five');
  assert.deepEqual(f.runway('27L'), { t: '27L', s: 'two seven left' });
  assert.equal(f.runway('4').t, '04');
  assert.equal(f.digits('4721').s, 'four seven two one');
});

test('levels in feet and meters', () => {
  const f = new Formatter({ units: { transitionAltitudeFt: 5000 } });
  assert.deepEqual(f.level(35000), { t: 'FL350', s: 'flight level three five zero', ft: 35000 });
  assert.equal(f.level(5000).s, 'five thousand feet');
  assert.equal(f.level(3500).s, 'three thousand five hundred feet');
  assert.equal(f.level(11000, { transitionAltitudeFt: 18000 }).s, 'one one thousand feet');
  assert.equal(f.levelToken(35000), '350');
  assert.equal(f.levelToken(5000), '5000');
  const china = json('../phraseology/china.json');
  const m = new Formatter(china);
  assert.equal(m.level(900 * 3.28084).t, '900 m');
  assert.equal(m.level(900 * 3.28084).s, 'niner hundred meters');
  assert.equal(m.level(33100).t, '10100 m');
  assert.equal(m.level(33100).s, 'one zero thousand one hundred meters');
  assert.equal(m.level(35000).t, '10700 m'); // FL350 -> nearest metric level
  assert.equal(parseLevel('10100m', m), 33100);
  assert.equal(parseLevel('S1010', m), 33100);
  assert.equal(parseLevel('FL350', m), 35000);
  assert.equal(parseLevel('350', m), 35000);
  assert.equal(parseLevel('24000', m), 24000);
  assert.equal(parseLevel('banana', m), null);
});

test('wind and callsigns', () => {
  const f = new Formatter({});
  assert.deepEqual(f.wind({ available: true, wind_dir: 270, wind_kt: 12 }),
    { t: '270/12', s: 'two seven zero degrees, one two knots' });
  assert.equal(f.wind({ available: true, wind_dir: null, wind_kt: 3 }).s, 'variable, three knots');
  assert.equal(f.wind({ available: true, wind_dir: 90, wind_kt: 0 }).t, 'calm');
  assert.equal(f.wind({ available: false }), null);
  const airlines = { CCA: 'Air China' };
  assert.deepEqual(callsignOf({ callsign: 'CCA1234' }, airlines, f), { t: 'Air China 1234', s: 'Air China one two three four' });
  assert.equal(callsignOf({ callsign: 'N123AB' }, airlines, f).s, 'november one two three alpha bravo');
  assert.equal(callsignOf({ callsign: 'XYZ1', callsignSpoken: 'Foxy 1' }, airlines, f).s, 'Foxy one');
});

test('render optional parts and alternatives', () => {
  const tpl = '{cs}, cleared[ via {sid} departure], runway {rwy}[, QNH {qnh}].';
  assert.equal(render(tpl, { cs: 'ABC', rwy: { t: '27', s: 'two seven' } }).text, 'ABC, cleared, runway 27.');
  const r = render(tpl, { cs: 'ABC', sid: 'LAM3A', rwy: { t: '27', s: 'two seven' }, qnh: '1013' });
  assert.equal(r.text, 'ABC, cleared via LAM3A departure, runway 27, QNH 1013.');
  assert.equal(r.speech, 'ABC, cleared via LAM3A departure, runway two seven, QNH 1013.');
  assert.equal(render('taxi to [stand {stand}|the apron].', {}).text, 'taxi to the apron.');
  assert.equal(render('taxi to [stand {stand}|the apron].', { stand: 'A12' }).text, 'taxi to stand A12.');
});

test('normalizing spoken numbers', () => {
  assert.equal(normalize('Climb flight level three five zero, squawk 4 7 2 1'), 'climb flight level 350 squawk 4721');
  assert.equal(compact('one two one decimal niner'), '1219');
  assert.equal(compact('runway two seven left'), 'runway27l');
  assert.equal(compact('three thousand five hundred feet'), '3500feet');
  assert.equal(compact('one one thousand'), '11000');
  assert.equal(compact('Climb 5,000 ft'), 'climb5000ft');
  const items = [{ token: '27l' }, { token: '5000' }, { token: '4721' }];
  assert.deepEqual(missingItems('cleared runway 27 left climb five thousand squawk four seven two one', items), []);
  assert.deepEqual(missingItems('runway 27L, 5000', items), [{ token: '4721' }]);
});

test('intent detection with the ICAO rules', async () => {
  const p = await load('icao');
  const i = (t) => detectIntent(t, p.intents);
  assert.equal(i('Demo Delivery, CCA123, request IFR clearance to XARR'), 'request_clearance');
  assert.equal(i('request push and start'), 'request_pushback');
  assert.equal(i('Ground, request taxi'), 'request_taxi');
  assert.equal(i('holding point runway 27, ready for departure'), 'ready_departure');
  assert.equal(i('Demo Ground, Air China 1234, holding point runway 09.'), 'ready_departure');
  assert.equal(compact('one two one point niner'), '1219');
  assert.equal(i('passing 2500 climbing 5000'), 'check_in');
  assert.equal(i('request descent'), 'request_descent');
  assert.equal(i('established ILS runway 22'), 'report_established');
  assert.equal(i('going around'), 'go_around');
  assert.equal(i('say again'), 'say_again');
  assert.equal(i('radio check on 118.7'), 'radio_check');
  assert.equal(i('runway vacated'), 'runway_vacated');
  assert.equal(i('hello there'), null);
});

test('runway selection', () => {
  const rwys = [
    { ident: '09', heading: 90, length_ft: 10000 }, { ident: '27', heading: 270, length_ft: 10000 },
    { ident: '18', heading: 180, length_ft: 7000 }, { ident: '36', heading: 0, length_ft: 7000, closed: true },
  ];
  assert.equal(selectRunway(rwys, { available: true, wind_dir: 250, wind_kt: 15 }).ident, '27');
  assert.equal(selectRunway(rwys, { available: true, wind_dir: 170, wind_kt: 20 }).ident, '18');
  assert.equal(selectRunway(rwys, { available: true, wind_dir: 350, wind_kt: 20 }).ident, '27'); // 36 closed
  const calm = selectRunway(rwys, { available: true, wind_dir: 170, wind_kt: 2 });
  assert.equal(calm.ident, '09'); assert.match(calm.reason, /calm/);
  assert.match(selectRunway(rwys, null).reason, /no live weather/);
  assert.equal(selectRunway(rwys, { available: true, wind_dir: 90, wind_kt: 20 }, { preferred: '27' }).ident, '27');
  assert.equal(selectRunway([], null), null);
  const w = selectRunway(rwys, { available: true, wind_dir: 240, wind_kt: 20 });
  assert.equal(w.headwind, 17); assert.equal(w.crosswind, 10);
});

test('phraseology files load, extend and validate', async () => {
  const icao = await load('icao');
  const china = await load('china');
  assert.deepEqual(validatePhraseology(icao), []);
  assert.deepEqual(validatePhraseology(china), []);
  assert.equal(china.units.altitude, 'meters');
  assert.equal(china.atc.takeoff, icao.atc.takeoff); // inherited
  assert.notEqual(china.atc.clearance, icao.atc.clearance); // overridden
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { c: 3 }, l: [2] }), { a: { b: 1, c: 3 }, l: [2] });
  // every pilot/readback/atc key used by the engine exists
  for (const key of ['clearance', 'readback_correct_next', 'readback_wrong', 'readback_required', 'pushback', 'taxi',
    'taxi_handoff', 'takeoff', 'departure_handoff', 'radar_contact', 'climb_handoff', 'center_climb', 'center_maintain',
    'descent', 'approach_handoff', 'approach_checkin', 'approach_clearance', 'final_handoff', 'landing', 'vacate',
    'taxi_in', 'go_around', 'go_around_app', 'wrong_unit', 'radio_check', 'say_again', 'standby', 'contact_now']) {
    assert.ok(icao.atc[key], `atc.${key}`);
  }
});

test('VHF COM channel rules (25 kHz and 8.33 kHz)', () => {
  assert.ok(isComChannel(118.0) && isComChannel('136.975') && isComChannel(121.655) && isComChannel(136.99));
  assert.ok(!isComChannel(117.95) && !isComChannel(257.8) && !isComChannel(137.0) && !isComChannel(121.62));
  assert.ok(isComChannel(121.66) && !isComChannel(121.67) && !isComChannel('abc'));
  assert.ok(is833Channel(118.705) && !is833Channel(118.725));
  assert.ok(Math.abs(carrierMHz(118.705) - 118.7) < 1e-9);
  assert.ok(Math.abs(carrierMHz(118.71) - 118.708333) < 1e-6);
  assert.ok(Math.abs(carrierMHz(118.715) - 118.716667) < 1e-6);
  assert.ok(sameFrequency(118.7, 118.705));       // same carrier
  assert.ok(sameFrequency(118.71, 118.70833));     // channel name vs carrier
  assert.ok(!sameFrequency(118.71, 118.715) && !sameFrequency(118.7, 118.725));
  assert.equal(designator(121.9), '121.9');
  assert.equal(designator(118.05), '118.050');
  assert.equal(designator(132.005), '132.005');
  assert.deepEqual(readbackTokens(124.35).sort(), ['12435', '124350']);
});
