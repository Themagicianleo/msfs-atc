import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { understand } from '../js/commands.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const PHR = json('../data/phraseology.json');
const CORPUS = json('./fixtures/atc-corpus.json');
const known = new Set(CORPUS.known);
const aircraft = CORPUS.aircraft.map((a, id) => ({ id, ...a, callsign: a.code + a.num, telZh: null }));

for (const c of CORPUS.cases) {
  test(`real-style: ${c.say}`, () => {
    const u = understand(c.say, aircraft, PHR.commands, null, known);
    assert.equal(u.error, null, `${u.error} (${JSON.stringify(u.cmd)})`);
    assert.equal(u.ac.code, c.ac, 'callsign');
    assert.equal(u.cmd.type, c.type, `action (${JSON.stringify(u.cmd)})`);
    if (c.runway) assert.equal(u.cmd.runway, c.runway, 'runway');
    if (c.via) assert.deepEqual(u.cmd.via, c.via, 'taxiways');
    if (c.cross) assert.deepEqual(u.cmd.cross, c.cross, 'crossing');
    if (c.gate) assert.equal(u.cmd.gate, c.gate, 'stand');
  });
}

test('controllers shorten a callsign after first contact: airline name and the last three digits', () => {
  const two = [{ id: 0, code: 'DAL', tel: 'Delta', num: '1234', callsign: 'DAL1234', telZh: null },
    { id: 1, code: 'DAL', tel: 'Delta', num: '5678', callsign: 'DAL5678', telZh: null },
    { id: 2, code: 'UAL', tel: 'United', num: '234', callsign: 'UAL234', telZh: null }];
  assert.equal(understand('Delta 234 hold position', two, PHR.commands).ac.callsign, 'DAL1234');
  assert.equal(understand('Delta six seven eight cleared to land', two, PHR.commands).ac.callsign, 'DAL5678');
  assert.equal(understand('United 234 hold position', two, PHR.commands).ac.callsign, 'UAL234'); // the full number is United's
  assert.equal(understand('Delta 1234 hold position', two, PHR.commands).ac.callsign, 'DAL1234');
});

// Chinese tower calls (CAAC style), as a speech model writes them: digits or Chinese numerals, code words or letters
const PHR_ZH = json('../data/phraseology-zh.json');
const acz = [
  { id: 0, code: 'CSN', tel: 'China Southern', telZh: '南方', num: '3101', callsign: 'CSN3101' },
  { id: 1, code: 'CCA', tel: 'Air China', telZh: '国航', num: '1234', callsign: 'CCA1234' },
  { id: 2, code: 'CES', tel: 'China Eastern', telZh: '东方', num: '5309', callsign: 'CES5309' },
  { id: 3, code: 'CHH', tel: 'Hainan', telZh: '海南', num: '7501', callsign: 'CHH7501' },
];
const ZH = [
  ['南方3101，跑道27，风260度5米每秒，可以起飞。', 'CSN', 'takeoff'],
  ['南方三幺洞幺，进跑道27等待', 'CSN', 'lineup'],
  ['国航1234，联系进近119.7，再见', 'CCA', 'contact'],
  ['海南7501，原地等待', 'CHH', 'hold_position'],
  ['东方5309，跑道36左，可以落地', 'CES', 'land'],
  ['东方5309 复飞', 'CES', 'go_around'],
  ['南方3101，推出开车', 'CSN', 'push'],
  ['南方3101，经阿尔法，布拉沃滑到跑道27外等待点', 'CSN', 'taxi', { via: ['A', 'B'], runway: '27' }],
  ['南方3101，经A，穿越跑道15，滑到停机位12', 'CSN', 'taxi', { via: ['A'], gate: '12', cross: ['15'] }],
  ['国航1234，跑道15外等待', 'CCA', 'hold_short', { runway: '15' }],
  ['国航1234，穿越跑道15', 'CCA', 'cross', { runway: '15' }],
  ['国航一二三四，继续滑行', 'CCA', 'continue_taxi'],
];
for (const [say, ac, type, extra = {}] of ZH) {
  test(`real-style Chinese: ${say}`, () => {
    const u = understand(say, acz, PHR.commands, null, new Set(['A', 'B', 'C']), PHR_ZH.commands);
    assert.equal(u.error, null, `${u.error} ${JSON.stringify(u.cmd)}`);
    assert.equal(u.ac.code, ac);
    assert.equal(u.cmd.type, type, JSON.stringify(u.cmd));
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(u.cmd[k], v, k);
  });
}
