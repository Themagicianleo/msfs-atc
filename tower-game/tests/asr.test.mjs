import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout } from '../js/layout.js';
import { World } from '../js/world.js';
import { zhSpell } from '../js/zh.js';
import { understand } from '../js/commands.js';
import { Speaker, splitLanguages } from '../js/lib/speech.js';
import { correctTranscript, recognitionPrompt, similarity, soundKey, toSimplified } from '../js/lib/asr-correct.js';
import { recognitionHints } from '../js/lib/hints.js';
import { EndOfSpeech, resample, rms } from '../js/lib/whisper.js';
import { Listener } from '../js/lib/voice.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const XDEP = json('./fixtures/xdep.json');
const PHR = json('../data/phraseology.json');
const PHR_ZH = json('../data/phraseology-zh.json');
const AIRLINES = json('../data/airlines.json');

function world(code) {
  let s = 5;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const profile = json('../data/traffic/ZBAD.json');
  const w = new World({ layout: buildLayout(XDEP), phr: PHR, phrZh: PHR_ZH, airlines: AIRLINES, rng, arrEnd: '27', depEnd: '27', traffic: 'off',
    wind: { available: true, wind_dir: 260, wind_kt: 10 }, profile: { ...profile, airlines: profile.airlines.filter((a) => a.code === code) },
    types: json('../data/aircraft.json'), unit: 'Daxing Tower' });
  w.nextArr = Infinity; w.nextDep = Infinity; w.variety = false;
  return w;
}

// ---------------------------------------------------------------- taxiway letters are said as code words
test('Chinese radio says taxiway letters as the English code words (digits stay Chinese), never a bare letter', () => {
  assert.equal(zhSpell('A'), 'alpha');
  assert.equal(zhSpell('WB1'), 'whiskey bravo 幺');
  assert.equal(zhSpell('A12'), 'alpha 幺两');
  assert.equal(zhSpell('X'), 'x-ray');
  assert.equal(zhSpell('3101'), '三幺洞幺');
  const w = world('CSN');
  const ac = w.spawnArrival(null, 6);
  const via = w.viaText({ via: ['A', 'B1', 'X'] }, ac);
  assert.equal(via.t, 'A、B1、X'); // shown as written
  assert.equal(via.s, 'alpha、bravo 幺、x-ray'); // spoken as code words
  assert.ok(!/(^|[^a-z-])[a-zA-Z]($|[^a-z-])/.test(via.s), 'no bare letter');
});

test('English radio says taxiway letters as FAA/ICAO code words', () => {
  const w = world('AFL');
  const ac = w.spawnArrival(null, 6);
  assert.equal(w.viaText({ via: ['A', 'B1', 'WA'] }, ac).s, 'alpha, bravo one, whiskey alpha');
  assert.equal(w.viaText({ via: ['A', 'B1', 'WA'] }, ac).t, 'A B1 WA');
});

test('what the pilot says in Chinese or English is understood back as the same taxiways', () => {
  const known = new Set(['A', 'B1', 'WA']);
  const ac = [{ id: 1, tel: 'Aeroflot', telZh: null, code: 'AFL', num: '123', callsign: 'AFL123' }];
  const en = understand('Aeroflot 123 taxi to stand 12 via alpha, bravo one, whiskey alpha', ac, PHR.commands, null, known);
  assert.deepEqual(en.cmd.via, ['A', 'B1', 'WA']);
  const acz = [{ id: 2, tel: 'China Southern', telZh: '南方', code: 'CSN', num: '3101', callsign: 'CSN3101' }];
  const zh = understand(`南方3101，经${['A', 'B1', 'WA'].map(zhSpell).join('、')}滑到停机位12`, acz, PHR.commands, null, known, PHR_ZH.commands);
  assert.deepEqual(zh.cmd.via, ['A', 'B1', 'WA']);
});

// ---------------------------------------------------------------- the transcript is fitted to the radio
const AC = [
  { tel: 'Speedbird', num: '123', code: 'BAW' }, { tel: 'Shenzhen', num: '4567', code: 'CSZ' },
  { tel: 'Loong Air', num: '88', code: 'GLG' }, { tel: 'Tianfu', num: '9', code: 'TFU' }, { tel: 'Air China', num: '1234', code: 'CCA' },
];

test('callsigns that are not English words are found by sound', () => {
  const fix = (t) => correctTranscript(t, { aircraft: AC });
  assert.equal(fix('Speed bird 123 runway 27 cleared to land'), 'Speedbird 123 runway 27 cleared to land');
  assert.equal(fix('Chen Jen 4567 taxi to stand 12'), 'Shenzhen 4567 taxi to stand 12');
  assert.equal(fix('Long air 88, hold position'), 'Loong Air 88, hold position');
  assert.equal(fix('Tien foo 9 continue approach'), 'Tianfu 9 continue approach');
  assert.equal(fix('Speedbird 123 cleared to land'), 'Speedbird 123 cleared to land'); // already right: untouched
  assert.equal(fix('Aer China 1234 go around'), 'Air China 1234 go around');
});

test('ordinary words are not turned into callsigns', () => {
  const fix = (t) => correctTranscript(t, { aircraft: AC });
  assert.equal(fix('hold position'), 'hold position');
  assert.equal(fix('cleared for take-off runway 27'), 'cleared for take-off runway 27');
  assert.equal(fix('the speed is fine'), 'the speed is fine');
  assert.equal(fix('cross runway 15'), 'cross runway 15');
});

test('the corrected transcript finds the aircraft; the raw one does not', () => {
  const ac = AC.map((a, id) => ({ ...a, id, callsign: a.code + a.num, telZh: null }));
  const raw = 'Chen Jen 4567 taxi to holding point runway 27 via alpha';
  const before = understand(raw, ac.filter((a) => a.code !== 'CSZ' || true).map((a) => ({ ...a, num: a.code === 'CSZ' ? '4567' : a.num })), PHR.commands);
  assert.equal(before.ac?.code, 'CSZ'); // the number alone matches here...
  const two = ac.map((a) => (a.code === 'CCA' ? { ...a, num: '4567' } : a)); // ...but a second 4567 makes it ambiguous
  assert.ok(understand(raw, two, PHR.commands).error);
  const fixed = understand(correctTranscript(raw, { aircraft: two }), two, PHR.commands);
  assert.equal(fixed.error, null);
  assert.equal(fixed.ac.code, 'CSZ');
});

test('taxiway code words misheard inside a route are snapped to the alphabet, elsewhere left alone', () => {
  const fix = (t) => correctTranscript(t, { aircraft: AC });
  assert.equal(fix('Speedbird 123 taxi via bravoh, charly, then fox trot'), 'Speedbird 123 taxi via bravo, charlie, then fox trot');
  assert.equal(fix('Speedbird 123 taxi via alpha, cross runway 15, then victoria'), 'Speedbird 123 taxi via alpha, cross runway 15, then victor');
  assert.equal(fix('Speedbird 123 hold position, wait for traffic'), 'Speedbird 123 hold position, wait for traffic');
});

test('command words are fixed when the model is close', () => {
  assert.equal(correctTranscript('Speedbird 123 runaway 27 cleared to land', { aircraft: AC }), 'Speedbird 123 runway 27 cleared to land');
  assert.equal(correctTranscript('Speedbird 123 pushbak approved', { aircraft: AC }), 'Speedbird 123 pushback approved');
});

test('Chinese transcripts in traditional characters are turned into simplified ones', () => {
  assert.equal(toSimplified('南方3101，經阿爾法滑到停機位12'), '南方3101，经阿尔法滑到停机位12');
  assert.equal(correctTranscript('經A滑到跑道27外等待點', { aircraft: AC, zh: true }), '经A滑到跑道27外等待点');
  assert.equal(correctTranscript('   ', {}), '');
});

test('sound keys: spellings of the same sound agree, different names do not', () => {
  assert.equal(soundKey('Shenzhen'), soundKey('Chen Jen'));
  assert.equal(soundKey('Speedbird'), soundKey('speed bird'));
  assert.ok(similarity(soundKey('Speedbird'), soundKey('Shenzhen')) < 0.5);
  assert.equal(similarity('abc', 'abc'), 1);
});

test('the model is told the callsigns first, then the alphabet and phrases, within its prompt size', () => {
  const hints = recognitionHints({ aircraft: [{ tel: 'Speedbird', num: '123', callsign: 'BAW123' }], taxiways: ['A', 'B1'] });
  const p = recognitionPrompt(hints);
  assert.ok(p.startsWith('Air traffic control radio. Speedbird one two three'));
  assert.ok(p.includes('bravo one') && p.includes('cleared to land'));
  assert.ok(recognitionPrompt(hints, { maxChars: 120 }).length <= 120);
  const zh = recognitionPrompt(recognitionHints({ aircraft: [], taxiways: ['A'], zh: true }), { zh: true });
  assert.ok(zh.startsWith('空中交通管制无线电通话。') && zh.includes('阿尔法'));
});

// ---------------------------------------------------------------- the microphone side
test('audio is brought to 16 kHz and the end of a transmission is found from the loudness', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10) * 0.5);
  const r = resample(tone, 48000);
  assert.equal(r.length, 16000);
  assert.ok(Math.abs(rms(r) - rms(tone)) < 0.08);
  assert.equal(resample(tone, 16000), tone);
  const v = new EndOfSpeech();
  const seen = [];
  for (let i = 0; i < 4; i += 1) seen.push(v.push(0.001, 85)); // the room
  for (let i = 0; i < 6; i += 1) seen.push(v.push(0.1, 85)); // talking
  assert.ok(seen.slice(4).every((x) => x === 'speech'));
  let end = null;
  for (let i = 0; i < 20 && end !== 'end'; i += 1) end = v.push(0.001, 85);
  assert.equal(end, 'end');
  const v2 = new EndOfSpeech();
  let nothing = null;
  for (let i = 0; i < 200 && nothing !== 'nothing'; i += 1) nothing = v2.push(0.001, 85);
  assert.equal(nothing, 'nothing');
});

test('the listener uses the AI model when it is ready: hears, fits to the radio, sends; falls back when it fails', async () => {
  globalThis.window = { SpeechRecognition: function SR() {}, isSecureContext: true, matchMedia: () => ({ matches: false }), navigator: {} };
  try {
    const got = [];
    const states = [];
    let aborted = false;
    const rec = { heard: () => true, stop: async () => new Float32Array(16000), abort: () => { aborted = true; } };
    let fire = null;
    const ai = {
      status: 'ready', usable() { return this.status === 'ready'; },
      record: async (cb) => { fire = cb; return rec; },
      transcribe: async (audio, o) => { ai.last = o; return 'Chen Jen 4567 taxi via bravoh'; },
    };
    const l = new Listener({ lang: 'en-US', ai, onFinal: (t, alts) => got.push([t, alts]), onState: (s) => states.push(s),
      getHints: () => [{ text: 'Shenzhen four five six seven', boost: 10 }],
      correct: (t) => correctTranscript(t, { aircraft: AC }) });
    l.start();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(l.active, true);
    assert.deepEqual(states, ['listening']);
    fire('end'); // the end of the transmission was heard
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(l.active, false);
    assert.equal(got.length, 1);
    assert.equal(got[0][0], 'Shenzhen 4567 taxi via bravo');
    assert.deepEqual(got[0][1], ['Shenzhen 4567 taxi via bravo', 'Chen Jen 4567 taxi via bravoh']);
    assert.equal(ai.last.language, 'english');
    assert.match(ai.last.prompt, /Shenzhen four five six seven/);
    // the model fails: the browser's recogniser takes over
    ai.transcribe = async () => { throw new Error('out of memory'); };
    l.start();
    await new Promise((r) => setTimeout(r, 5));
    l.stop();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ai.status, 'error');
    assert.equal(ai.usable(), false);
    assert.equal(aborted, false);
    assert.equal(got.length, 1);
  } finally { delete globalThis.window; }
});

test('"unable" replies say taxiway letters, runways and stands the radio way too (the written text is unchanged)', () => {
  const zh = world('CSN');
  const a = zh.spawnArrival(null, 6);
  zh.drain();
  const r = zh.unable(a, "we can't find taxiway T, G6");
  assert.match(r.text, /找不到滑行道T, G6/);
  const ev = zh.drain().find((e) => e.kind === 'pilot' && e.unable);
  assert.match(ev.speech, /找不到滑行道tango、golf 六/);
  assert.ok(!/[A-Z]/.test(ev.speech), ev.speech);
  zh.unable(a, 'stand A12 is occupied');
  assert.match(zh.drain().find((e) => e.unable).speech, /停机位alpha 幺两被占用/);
  zh.unable(a, 'runway 35R is not available');
  assert.match(zh.drain().find((e) => e.unable).speech, /跑道三五右不可用|跑道三拐?五右/);
  const en = world('AFL');
  const b = en.spawnArrival(null, 6);
  en.drain();
  en.unable(b, "we can't find taxiway T, G6");
  const e2 = en.drain().find((e) => e.unable);
  assert.match(e2.text, /taxiway T, G6/);
  assert.match(e2.speech, /taxiway tango, golf six/);
  en.unable(b, 'stand A12 is occupied');
  assert.match(en.drain().find((e) => e.unable).speech, /stand alpha one two is occupied/);
});

// ---------------------------------------------------------------- taxiway names as people (and recognisers) really give them
import { unpackLayout } from '../js/osm.js';
import { taxiwayNames } from '../js/layout.js';

test('Daxing: one route, said many ways in Chinese and English, is understood as the same taxiways', () => {
  const known = taxiwayNames(unpackLayout(json('../data/hq/ZBAD.json')));
  const ac = [{ id: 1, code: 'CUA', tel: 'China United', telZh: '联航', num: '5720', callsign: 'CUA5720' }];
  const via = (say) => understand(say, ac, PHR.commands, null, known, PHR_ZH.commands).cmd.via;
  const want = ['Z1', 'T6', 'G', 'C1'];
  for (const say of [
    '联航5720经z1 t6 g c1滑到跑道35右外等待点',
    '联航5720经祖鲁幺探戈六高尔夫查理幺滑到跑道35右外等待点',
    '联航5720，经Z一、T六、G、C一滑到跑道35右外等待点',
    '联航5720经 z 1 t 6 g c 1 滑到跑道35右外等待点',
    '联航5720 经祖鲁1，探戈6，高尔夫，查理1，滑到跑道35右外等待点',
    '联航5720经Zulu1 Tango6 Golf Charlie1滑到跑道35右外等待点',
    '联航5720经泽德幺踢六吉西幺滑到跑道35右外等待点',
    'China United 5720 taxi to holding point runway 35 right via zulu one, tango six, golf, charlie one',
    'China United 5720 taxi via zulu 1 tango 6 golf charlie 1 to holding point runway 35 right',
  ]) assert.deepEqual(via(say), want, say);
  // what the recogniser wrote in the screenshot: digit stuck to the wrong letter (there is no taxiway T, but there is T6)
  assert.deepEqual(via('联航无拐2栋滑行经过tg六'), ['T6', 'G']);
  assert.deepEqual(via('China United 5720 taxi via t g 6'), ['T6', 'G']);
  // and names that really are what was said are left alone
  assert.deepEqual(via('联航5720经G6、T滑到跑道35右外等待点'), ['G6', 'T']);
});

test('a Chinese call with English code words is said by a Chinese voice and an English voice, in order', () => {
  assert.deepEqual(splitLanguages('经alpha、bravo 幺、whiskey alpha滑到跑道两拐外等待点，南方三幺六六。'), [
    { text: '经', lang: 'zh' }, { text: 'alpha, bravo', lang: 'en' }, { text: ' 幺、', lang: 'zh' },
    { text: 'whiskey alpha', lang: 'en' }, { text: '滑到跑道两拐外等待点，南方三幺六六。', lang: 'zh' }]);
  assert.deepEqual(splitLanguages('跑道三五右，可以起飞'), [{ text: '跑道三五右，可以起飞', lang: 'zh' }]);
  assert.deepEqual(splitLanguages('taxi via alpha', 'en'), [{ text: 'taxi via alpha', lang: 'en' }]);
  // the speaker hands each part to the right voice (muted here, so the parts are only queued)
  const sp = Object.create(Speaker.prototype);
  Object.assign(sp, { settings: { tts: true }, muted: true, held: [] });
  sp.speak('经alpha、bravo 幺滑到跑道两拐外等待点，南方三幺六六。', 'ac1', 'zh', { reply: true, airline: 'CSN' });
  assert.deepEqual(sp.held.map((h) => [h.args[0], h.args[2]]), [['经', 'zh'], ['alpha, bravo', 'en'], [' 幺滑到跑道两拐外等待点，南方三幺六六。', 'zh']]);
  assert.equal(sp.held[0].args[3].reply, true); // only the first part waits like a reply
  assert.equal(sp.held[1].args[3].reply, false);
  assert.equal(sp.held[1].args[3].airline, 'CSN'); // the English words take the pilot's own accent (Chinese airline: Mandarin-accented English)
});
