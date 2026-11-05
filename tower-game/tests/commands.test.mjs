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

test('Chinese instructions (ZBAD): callsigns, numbers, runways, via, stands', async () => {
  const { understand, parseInstructionZh } = await import('../js/commands.js');
  const ZH = JSON.parse(readFileSync(new URL('../data/phraseology-zh.json', import.meta.url))).commands;
  const ac = [
    { id: 11, code: 'CSN', tel: 'China Southern', telZh: '南方', num: '3101', callsign: 'CSN3101' },
    { id: 12, code: 'CES', tel: 'China Eastern', telZh: '东方', num: '5147', callsign: 'CES5147' },
    { id: 13, code: 'AFL', tel: 'Aeroflot', num: '206', callsign: 'AFL206' },
  ];
  let u = understand('南方三幺洞幺，跑道三五右，可以落地', ac, R, null, null, ZH);
  assert.equal(u.ac.id, 11);
  assert.deepEqual(u.cmd, { type: 'land', runway: '35R' });
  u = understand('东方5147，经A B2滑到跑道17右外等待点', ac, R, null, null, ZH);
  assert.equal(u.ac.id, 12);
  assert.deepEqual(u.cmd, { type: 'taxi', runway: '17R', via: ['A', 'B2'] });
  u = understand('南方3101，滑到停机位201', ac, R, null, null, ZH);
  assert.deepEqual(u.cmd, { type: 'taxi', gate: '201' });
  assert.deepEqual(parseInstructionZh('穿越跑道幺七左', ZH), { type: 'cross', runway: '17L', cross: ['17L'] });
  assert.deepEqual(parseInstructionZh('跑道17右外等待', ZH), { type: 'hold_short', runway: '17R' });
  assert.deepEqual(parseInstructionZh('跑道17右，进跑道等待', ZH), { type: 'lineup', runway: '17R' });
  assert.deepEqual(parseInstructionZh('可以推出', ZH), { type: 'push' });
  assert.deepEqual(parseInstructionZh('联系离场，再见', ZH), { type: 'contact' });
  assert.deepEqual(parseInstructionZh('原地等待', ZH), { type: 'hold_position' });
  assert.match(understand('可以落地', ac, R, null, null, ZH).error, /没有听到呼号/);
  // English still works at the same airport (Aeroflot)
  assert.equal(understand('Aeroflot 206 cleared to land runway 35R', ac, R, null, null, ZH).ac.id, 13);
});

// ---- Chinese speech recognition: what the browser really writes down
test('Chinese: misheard digits, command words and callsign names are understood', async () => {
  const { understand, understandBest } = await import('../js/commands.js');
  const ZH = JSON.parse(readFileSync(new URL('../data/phraseology-zh.json', import.meta.url))).commands;
  const ac = [
    { id: 21, code: 'CSC', tel: 'Sichuan', telZh: '四川', num: '8975', callsign: 'CSC8975' },
    { id: 22, code: 'CDG', tel: 'Shandong', telZh: '山东', num: '3101', callsign: 'CDG3101' },
    { id: 23, code: 'CES', tel: 'China Eastern', telZh: '东方', num: '5147', callsign: 'CES5147' },
  ];
  const run = (t) => understand(t, ac, [], null, null, ZH);
  // the real transcripts from the iPad: 五 heard as 舞, 九 as 角, 推出 as 退出
  for (const t of ['四川八九拐舞可以退出', '四川八角拐舞可以退出', '死川八九拐五，可以推出']) {
    const u = run(t);
    assert.equal(u.ac?.callsign, 'CSC8975', t);
    assert.equal(u.cmd.type, 'push', t);
  }
  // airline names made of digit-sounding words are not read as numbers; 东方 is China Eastern, not "0方"
  assert.equal(run('山东三幺洞幺，跑道幺七右，可以落地').ac.callsign, 'CDG3101');
  assert.equal(run('东方五幺四拐，可以起非').ac.callsign, 'CES5147');
  assert.equal(run('东方五幺四拐，可以起非').cmd.type, 'takeoff');
  // a clear call by airline and last three digits
  assert.equal(run('山东幺洞幺可以推出').ac.callsign, 'CDG3101');
  // runway sides said wrongly, numbers with a comma, 跑到
  let u = run('山东 3,101 跑到三五又 进近跑道 可以落地');
  assert.equal(u.ac.callsign, 'CDG3101');
  assert.deepEqual([u.cmd.type, u.cmd.runway], ['land', '35R']);
  // the stand number is not a flight number
  u = run('东方5147，滑到停机位三幺洞');
  assert.deepEqual([u.ac.callsign, u.cmd.type, u.cmd.gate], ['CES5147', 'taxi', '310']);
  // nothing recognised: say so, and show how it was read
  u = run('四川八九拐舞');
  assert.equal(u.ac.callsign, 'CSC8975');
  assert.ok(u.error && u.heard === '四川8975');
  // the recogniser's other guesses: the first complete one wins
  const best = understandBest(['四川八九拐舞可以吃出', '四川八九拐舞可以推出', '四川八九拐舞'], ac, [], null, null, ZH);
  assert.equal(best.cmd.type, 'push');
  assert.equal(best.text, '四川八九拐舞可以推出');
});

test('Chinese taxiway letters: said as Chinese letter names, code words or Latin letters', async () => {
  const { parseInstructionZh } = await import('../js/commands.js');
  const { zhTaxiwayTokens } = await import('../js/zh.js');
  const ZH = JSON.parse(readFileSync(new URL('../data/phraseology-zh.json', import.meta.url))).commands;
  const known = new Set(['A', 'B', 'B2', 'C', 'C1', 'E', 'M', 'T6', 'WA', 'W', 'X', 'Z0', 'Z3', 'Y5']);
  const via = (t) => parseInstructionZh(t, ZH, known).via;
  assert.deepEqual(via('经A、B2滑到跑道17右外等待点'), ['A', 'B2']);
  assert.deepEqual(via('经诶 比二 滑到跑道17右外等待点'), ['A', 'B2']);
  assert.deepEqual(via('经阿尔法 布拉沃二 查理幺滑到跑道17右外等待点'), ['A', 'B2', 'C1']);
  assert.deepEqual(via('经滑行道艾克斯，西，伊，滑到跑道17右外等待点'), ['X', 'C', 'E']);
  assert.deepEqual(via('经a b2 c1滑到跑道17右外等待点'), ['A', 'B2', 'C1']);
  assert.deepEqual(via('经AB2滑到跑道17右外等待点'), ['A', 'B2'], 'letters run together are split into real taxiway names');
  assert.deepEqual(via('京贼洞 贼三 滑到跑道17右外等待点'), ['Z0', 'Z3'], '京 for 经, 贼 for Z');
  assert.deepEqual(via('经威士忌 阿尔法 滑到跑道17右外等待点'), ['WA'], 'W then A is the taxiway WA');
  assert.deepEqual(zhTaxiwayTokens('艾克斯 达布留 歪5'), ['X', 'W', 'Y5']);
  // via is read even when the pilot is told to taxi to a stand
  assert.deepEqual(parseInstructionZh('经T6，滑到停机位133', ZH, known).via, ['T6']);
});

test('Chinese voice: all guesses of the recogniser are kept, in order', async () => {
  const { Listener } = await import('../js/lib/voice.js');
  const l = Object.create(Listener.prototype);
  l.final = '四川八九拐舞可以退出';
  l.interim = '';
  l.segments = [['四川八九拐舞可以退出', '四川八九拐五可以推出', '四川八九拐舞可以退出']];
  assert.deepEqual(l.alternatives(), ['四川八九拐舞可以退出', '四川八九拐五可以推出']);
  l.segments = [['四川', '死川'], ['八九拐五', '八九拐舞']]; // two parts: the k-th guess of each is joined
  l.final = '四川八九拐五';
  assert.deepEqual(l.alternatives(), ['四川八九拐五', '死川八九拐舞']);
});
