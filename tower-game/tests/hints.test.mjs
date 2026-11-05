import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognitionHints, spellTaxiway } from '../js/lib/hints.js';
import { Speaker } from '../js/lib/speech.js';

test('hints: callsigns, ICAO words and taxiway names, in English and Chinese', () => {
  assert.equal(spellTaxiway('B1'), 'bravo one');
  assert.equal(spellTaxiway('WA'), 'whiskey alpha');
  assert.equal(spellTaxiway('B2', true), '布拉沃两');
  const ac = [{ tel: 'Speedbird', telZh: '', num: '123', callsign: 'BAW123' }, { tel: 'China Southern', telZh: '南方', num: '3101', callsign: 'CSN3101' }];
  const en = recognitionHints({ aircraft: ac, taxiways: ['A', 'B1'] }).map((h) => h.text);
  assert.ok(en.includes('Speedbird one two three') && en.includes('alpha') && en.includes('bravo one') && en.includes('cleared to land'));
  const zh = recognitionHints({ aircraft: ac, taxiways: ['A'], zh: true }).map((h) => h.text);
  assert.ok(zh.includes('南方三幺洞幺') && zh.includes('阿尔法') && zh.includes('经'));
  assert.ok(recognitionHints({ aircraft: ac, max: 5 }).length === 5);
});

test('radio: nobody is heard while the controller holds the key; waiting calls are played after', () => {
  const spoken = [];
  const sp = Object.create(Speaker.prototype);
  Object.assign(sp, { settings: { tts: true }, muted: false, held: [], gen: 0, chain: Promise.resolve(), supported: false,
    fx: { cut() { sp.cuts = (sp.cuts || 0) + 1; }, keyDown() {}, wake() {}, enabled: true } });
  const say = Speaker.prototype.speak;
  // record what is held, and what reaches the speakers when it is released
  sp.speak = function speak(text, ...rest) { if (!this.muted) spoken.push(text); return say.call(this, text, ...rest); };
  sp.speak('before', 'a', 'en');
  sp.mute();
  assert.equal(sp.muted, true);
  assert.equal(sp.gen, 1, 'whatever was queued before the key is dropped');
  assert.equal(sp.cuts, 1, 'and what is playing is cut off');
  sp.speak('during one', 'b', 'en');
  sp.speak('during two', 'c', 'en', { reply: true });
  assert.equal(sp.held.length, 2);
  assert.deepEqual(spoken, ['before'], 'nothing is played while muted');
  sp.release();
  assert.equal(sp.muted, false);
  assert.equal(sp.held.length, 0);
  assert.deepEqual(spoken, ['before', 'during one', 'during two'], 'the calls that waited are played once the key is released');
  sp.release(); // releasing twice does nothing
});
