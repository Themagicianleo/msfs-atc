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
    assert.ok(s.pitch >= 0.9 && s.pitch <= 1.12 && s.rate >= 0.95 && s.rate <= 1.09);
  }
  assert.ok(new Set(shapes.map((s) => s.pitch.toFixed(2))).size > 10);
});
