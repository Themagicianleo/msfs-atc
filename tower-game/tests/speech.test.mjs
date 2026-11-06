import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankVoices, pilotVoiceShape, voiceScore } from '../js/lib/speech.js';

const v = (name, lang = 'en-US', localService = true) => ({ name, lang, localService, voiceURI: name });

test('novelty voices are never used; better voices come first', () => {
  const voices = [v('Bells'), v('Zarvox'), v('Bad News'), v('Fred'), v('Grandpa (English (US))'), v('Samantha'),
    v('Ava (Premium)'), v('Google UK English Male', 'en-GB', false), v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false),
    v('Tingting', 'zh-CN')];
  const ranked = rankVoices(voices, 'en').map((x) => x.name);
  for (const bad of ['Bells', 'Zarvox', 'Bad News', 'Fred', 'Grandpa (English (US))']) assert.ok(!ranked.includes(bad), bad);
  assert.ok(ranked.indexOf('Ava (Premium)') < ranked.indexOf('Samantha'));
  assert.ok(ranked.indexOf('Microsoft Aria Online (Natural) - English (United States)') < ranked.indexOf('Samantha'));
  assert.deepEqual(rankVoices(voices, 'zh').map((x) => x.name), ['Tingting']);
  assert.ok(voiceScore(v('Daniel', 'en-GB')) > voiceScore(v('Some Voice')));
});

test('each pilot keeps a slightly different, stable pitch and pace', () => {
  const a = pilotVoiceShape('ac1');
  assert.deepEqual(pilotVoiceShape('ac1'), a);
  const shapes = Array.from({ length: 40 }, (_, i) => pilotVoiceShape(`ac${i}`));
  for (const s of shapes) {
    assert.ok(s.pitch >= 0.8 && s.pitch <= 1.2 && s.rate >= 0.85 && s.rate <= 1.3);
  }
  assert.ok(new Set(shapes.map((s) => s.pitch.toFixed(2))).size > 10);
});

test('pilots from abroad get a voice from home when the device has one', async () => {
  const { Speaker, accentFor } = await import('../js/lib/speech.js');
  const s = Object.create(Speaker.prototype);
  s.settings = { varyVoices: true, accents: true };
  s.voices = [v('Samantha'), v('Daniel', 'en-GB'), v('Karen', 'en-AU'), v('Anna', 'de-DE'), v('Kyoko', 'ja-JP'), v('Bells')];
  assert.equal(s.voiceFor('ac1', 'BAW').name, 'Daniel');
  assert.equal(s.voiceFor('ac2', 'QFA').name, 'Karen');
  assert.equal(s.voiceFor('ac3', 'DLH').name, 'Anna');
  assert.equal(s.voiceFor('ac4', 'JAL').name, 'Kyoko');
  assert.notEqual(s.voiceFor('ac5', 'KAL').name, 'Bells'); // no Korean voice: an English one
  s.settings.accents = false;
  assert.ok(!['Anna', 'Kyoko'].includes(s.voiceFor('ac3', 'DLH').name));
  assert.deepEqual(accentFor('XXX'), []);
});

test('each aircraft radio sounds different', async () => {
  const { radioCharacter } = await import('../js/lib/radio.js');
  const all = Array.from({ length: 64 }, (_, i) => radioCharacter(`ac${i}`));
  assert.deepEqual(radioCharacter('ac1'), radioCharacter('ac1'));
  assert.ok(new Set(all.map((c) => Math.round(c.band / 50))).size > 10);
  const whistles = all.filter((c) => c.whistle).length;
  assert.ok(whistles > 0 && whistles < 20, `${whistles} whistles`);
});

test('efficient voices: compact voices first, Premium and Enhanced ones last', () => {
  const voices = [v('Ava (Premium)'), v('Samantha (Enhanced)'), v('Samantha'), v('Daniel', 'en-GB'), v('Karen', 'en-AU')];
  const best = rankVoices(voices, 'en').map((x) => x.name);
  assert.ok(best.indexOf('Ava (Premium)') < best.indexOf('Samantha'));
  const eff = rankVoices(voices, 'en', true).map((x) => x.name);
  assert.ok(eff.indexOf('Samantha') < eff.indexOf('Ava (Premium)'));
  assert.ok(eff.indexOf('Daniel') < eff.indexOf('Samantha (Enhanced)'));
  assert.ok(voiceScore(v('Ava (Premium)'), true) < voiceScore(v('Samantha'), true));
});
