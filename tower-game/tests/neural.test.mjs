import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, modelsFor, pilotVoice } from '../js/lib/neural.js';

const configs = {
  intl: { speaker_id_map: Object.fromEntries('TXHC THV SVBI ZHAA PNV TLV ERMS MBMPS HQTV TNI ASI HJK LXC NCC YKWK YDCK HKK NJS YBAA RRBI BWC ABA EBVS SKA'.split(' ').map((n, i) => [n, i])) },
  uk: { speaker_id_map: Object.fromEntries(Array.from({ length: 109 }, (_, i) => [`p${225 + i}`, i])) },
  us: { speaker_id_map: Object.fromEntries(Array.from({ length: 904 }, (_, i) => [String(i * 7), i])) },
  zh: { speaker_id_map: {} },
};
const all = new Set(['us', 'uk', 'intl', 'zh']);

test('each airport downloads only the voice models its airlines need', () => {
  assert.deepEqual(modelsFor([{ code: 'UAL' }, { code: 'SWA' }]), ['us']);
  assert.deepEqual(modelsFor([{ code: 'CSN', lang: 'zh' }, { code: 'AFL' }]), ['uk', 'zh']);
  assert.deepEqual(modelsFor([{ code: 'SIA' }, { code: 'BAW' }]), ['uk', 'intl']);
  assert.ok(modelsFor([{ code: 'SIA' }], { extras: true }).includes('mix'));
  for (const k of ['us', 'uk', 'intl', 'mix', 'zh']) assert.ok(MODELS[k].mb > 20);
});

test('pilots get a voice matching their airline, stable per pilot, and differing between pilots', () => {
  const l1 = (v) => Object.entries(configs.intl.speaker_id_map).find(([, i]) => i === v.speaker)[0];
  const kor = pilotVoice('ac1', 'KAL', 'en', all, configs);
  assert.equal(kor.model, 'intl');
  assert.ok(['HJK', 'HKK', 'YDCK', 'YKWK'].includes(l1(kor)));
  assert.ok(['BWC', 'LXC', 'NCC', 'TXHC'].includes(l1(pilotVoice('ac2', 'CCA', 'en', all, configs))));
  assert.equal(pilotVoice('ac3', 'UAL', 'en', all, configs).model, 'us');
  assert.deepEqual(pilotVoice('ac3', 'UAL', 'en', all, configs), pilotVoice('ac3', 'UAL', 'en', all, configs));
  const voices = new Set(Array.from({ length: 50 }, (_, i) => pilotVoice(`ac${i}`, 'UAL', 'en', all, configs).speaker));
  assert.ok(voices.size > 30);
  assert.equal(pilotVoice('ac4', 'CSN', 'zh', all, configs).model, 'zh');
});

test('without the right model a pilot uses another downloaded one, or the device voice', () => {
  assert.equal(pilotVoice('ac1', 'UAL', 'en', new Set(['uk']), configs).model, 'uk');
  assert.equal(pilotVoice('ac1', 'CSN', 'zh', new Set(['uk']), configs), null);
  assert.equal(pilotVoice('ac1', 'UAL', 'en', new Set(), configs), null);
  const p = pilotVoice('ac9', 'CSN', 'zh', all, configs);
  assert.ok(p.pitch >= 0.83 && p.pitch <= 1.17);
});
