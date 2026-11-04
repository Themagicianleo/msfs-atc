import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchCallsign, parseInstruction, understand } from '../js/commands.js';

const PHR = JSON.parse(readFileSync(new URL('../data/phraseology.json', import.meta.url)));
const R = PHR.commands;
const AC = [
  { id: 1, code: 'BAW', tel: 'Speedbird', num: '123', callsign: 'BAW123' },
  { id: 2, code: 'CCA', tel: 'Air China', num: '1234', callsign: 'CCA1234' },
  { id: 3, code: 'DAL', tel: 'Delta', num: '27', callsign: 'DAL27' },
  { id: 4, code: 'CCA', tel: 'Air China', num: '88', callsign: 'CCA88' },
];

test('callsigns: spoken, typed, numbers that are not callsigns', () => {
  assert.equal(matchCallsign('Speedbird 123, runway 27 cleared to land', AC).ac.id, 1);
  assert.equal(matchCallsign('speed bird one two three cleared to land', AC).ac.id, 1);
  assert.equal(matchCallsign('BAW123 push back approved', AC).ac.id, 1);
  assert.equal(matchCallsign('Air China 1234 taxi to stand bravo 4', AC).ac.id, 2);
  assert.equal(matchCallsign('Delta 27 taxi to stand 88', AC).ac.id, 3); // stand 88 is not Air China 88
  // "runway 27" is not Delta 27
  assert.equal(matchCallsign('Delta 27 cleared for take off runway 27', AC).ac.id, 3);
  assert.equal(matchCallsign('Speedbird 123, wind 270 degrees 27 knots, runway 27, cleared to land', AC).ac.id, 1);
  assert.equal(matchCallsign('cleared to land runway 27', AC).ac, null);
  // "Air China" alone matches two aircraft
  const amb = matchCallsign('Air China cleared to land', AC);
  assert.equal(amb.ac, null);
  assert.equal(amb.ambiguous.length, 2);
});

test('instructions and their details', () => {
  assert.deepEqual(parseInstruction('Speedbird 123 runway two seven left cleared to land', R), { type: 'land', runway: '27L' });
  assert.deepEqual(parseInstruction('runway 9 cleared for takeoff', R), { type: 'takeoff', runway: '09' });
  assert.deepEqual(parseInstruction('runway 27 line up and wait', R), { type: 'lineup', runway: '27' });
  assert.deepEqual(parseInstruction('go around', R), { type: 'go_around' });
  assert.deepEqual(parseInstruction('pushback approved', R), { type: 'push' });
  assert.deepEqual(parseInstruction('taxi to holding point runway 27 via alpha', R), { type: 'taxi', runway: '27', via: ['A'] });
  assert.deepEqual(parseInstruction('taxi to stand bravo 4 via b j2', R), { type: 'taxi', gate: 'B4', via: ['B', 'J2'] });
  assert.deepEqual(parseInstruction('taxi to stand twelve via bravo', R), { type: 'taxi', gate: '12', via: ['B'] });
  assert.deepEqual(parseInstruction('runway twenty seven left, cleared to land', R), { type: 'land', runway: '27L' });
  assert.equal(matchCallsign('Speedbird one twenty three, cleared to land', AC).ac.id, 1);
  assert.deepEqual(parseInstruction('taxi to stand 12 via bravo', R), { type: 'taxi', gate: '12', via: ['B'] });
  assert.deepEqual(parseInstruction('taxi to stand one two', R), { type: 'taxi', gate: '12' });
  assert.deepEqual(parseInstruction('taxi runway 27 via a cross runway 15', R), { type: 'taxi', runway: '27', via: ['A'], cross: ['15'] });
  assert.deepEqual(parseInstruction('cross runway 15', R), { type: 'cross', runway: '15', cross: ['15'] });
  assert.deepEqual(parseInstruction('hold short runway 27', R), { type: 'hold_short', runway: '27' });
  assert.deepEqual(parseInstruction('hold position', R), { type: 'hold_position' });
  assert.deepEqual(parseInstruction('continue taxi', R), { type: 'continue_taxi' });
  assert.deepEqual(parseInstruction('continue approach', R), { type: 'continue' });
  assert.deepEqual(parseInstruction('contact departure good day', R), { type: 'contact' });
  assert.deepEqual(parseInstruction('hello', R), { type: null });
});

test('understand: callsign + instruction, selected aircraft as fallback', () => {
  const u = understand('Air China 1234, taxi to stand bravo four', AC, R);
  assert.equal(u.ac.id, 2);
  assert.deepEqual(u.cmd, { type: 'taxi', gate: 'B4' });
  assert.equal(u.error, null);
  const sel = understand('cleared to land', AC, R, 3);
  assert.equal(sel.ac.id, 3);
  assert.match(understand('cleared to land', AC, R).error, /No callsign/);
  assert.match(understand('Air China, go around', AC, R).error, /Which one: CCA1234 or CCA88/);
  assert.match(understand('Speedbird 123 how are you', AC, R).error, /not understood/);
});

test('via with real multi-letter taxiway names', () => {
  const known = new Set(['A', 'B', 'B1', 'WA', 'WB', 'M', 'Z']);
  assert.deepEqual(parseInstruction('taxi to holding point runway 02C via whiskey alpha bravo one', R, known).via, ['WA', 'B1']);
  assert.deepEqual(parseInstruction('taxi runway 28L via alpha, bravo and mike', R, known).via, ['A', 'B', 'M']);
  assert.deepEqual(parseInstruction('taxi via wa b1', R, known).via, ['WA', 'B1']);
  // without a name list letters stay separate
  assert.deepEqual(parseInstruction('taxi via alpha bravo', R).via, ['A', 'B']);
});
