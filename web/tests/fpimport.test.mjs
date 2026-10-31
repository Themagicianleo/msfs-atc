import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePlan, encodePlan } from '../js/fpimport.js';

const plan = { callsign: 'cca1234', dep: 'zudc', arr: 'ZUNZ', cruise: 'FL320', star: 'ABC1D', region: 'china',
  route: 'DCH W78 TSTAF', depRunway: '16', depTransitionFt: 9800 };

test('reads a code, a link and a bare payload', () => {
  const code = encodePlan(plan);
  assert.ok(code.startsWith('OPENATC1:'));
  const want = { callsign: 'CCA1234', dep: 'ZUDC', arr: 'ZUNZ', cruise: 'FL320', star: 'ABC1D', region: 'china',
    route: 'DCH W78 TSTAF', depRunway: '16', depTransitionFt: '9800' };
  assert.deepEqual(decodePlan(code), want);
  assert.deepEqual(decodePlan(`https://192.168.1.50:8443/#fp=${code.slice(9)}`), want);
  assert.deepEqual(decodePlan(`  ${code.slice(9)}\n`), want);
});

test('keeps non-ASCII text such as Chinese names', () => {
  assert.equal(decodePlan(encodePlan({ ...plan, centerName: '成都区调 Chengdu Control' })).centerName, '成都区调 Chengdu Control');
});

test('drops unknown keys and invalid values', () => {
  const fp = decodePlan(encodePlan({ ...plan, evil: '<script>', approach: 'TELEPORT', region: 'mars',
    arrTransitionFt: '12a', callsign: 'X'.repeat(50), route: 'A\u0000B' }));
  assert.equal(fp.evil, undefined);
  assert.equal(fp.approach, undefined);
  assert.equal(fp.region, 'icao');
  assert.equal(fp.arrTransitionFt, undefined);
  assert.equal(fp.callsign.length, 12);
  assert.equal(fp.route, 'A B');
});

test('explains bad input', () => {
  assert.throws(() => decodePlan('hello world'), /not an OpenATC flight plan code/);
  assert.throws(() => decodePlan('OPENATC1:abcdefghijk'), /damaged/);
  assert.throws(() => decodePlan(encodePlan({ dep: 'ZUDC' })), /no departure or arrival/);
  assert.throws(() => decodePlan('OPENATC1:' + Buffer.from('{"v":2,"dep":"ZUDC","arr":"ZUNZ"}').toString('base64url')), /version/);
});
