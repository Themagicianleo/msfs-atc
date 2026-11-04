import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatedWind, liveWind, parseMetarWind, windText } from '../js/weather.js';
import { buildLayout } from '../js/layout.js';

test('METAR wind parsing, units converted to knots', () => {
  assert.deepEqual(parseMetarWind('EGLL 290550Z 27015G25KT CAVOK'), { wind_dir: 270, wind_vrb: false, wind_kt: 15, gust_kt: 25 });
  assert.equal(parseMetarWind('ZBAA 290600Z 31008MPS 9999').wind_kt, 16);
  assert.equal(parseMetarWind('XXXX 290600Z VRB02KT').wind_dir, null);
  assert.equal(parseMetarWind('garbage'), null);
});

test('live wind: used when the fetch works, null when it fails or is blocked', async () => {
  const ok = async () => ({ ok: true, json: async () => [{ rawOb: 'EGLL 290550Z 24012KT 9999' }] });
  assert.deepEqual(await liveWind('EGLL', { fetchFn: ok }),
    { available: true, source: 'live METAR', raw: 'EGLL 290550Z 24012KT 9999', wind_dir: 240, wind_vrb: false, wind_kt: 12, gust_kt: null });
  assert.equal(await liveWind('EGLL', { fetchFn: async () => { throw new TypeError('CORS'); } }), null);
  assert.equal(await liveWind('EGLL', { fetchFn: async () => ({ ok: false }) }), null);
  assert.equal(await liveWind('EGLL', { fetchFn: async () => ({ ok: true, json: async () => [] }) }), null);
});

test('generated wind is stable for an airport and hour, and plausible', () => {
  const d = new Date('2026-11-05T01:30:00Z');
  const a = generatedWind('EGLL', d);
  assert.deepEqual(a, generatedWind('EGLL', new Date('2026-11-05T01:59:00Z')));
  assert.ok(a.wind_dir >= 10 && a.wind_dir <= 360 && a.wind_dir % 10 === 0);
  assert.ok(a.wind_kt >= 3 && a.wind_kt <= 18);
  assert.equal(a.source, 'generated');
  assert.match(windText(a), /^Wind \d{3}\/\d{2}(G\d+)?$/);
  assert.equal(windText({ wind_kt: 0 }), 'Wind calm');
});

test('the shipped demo airport builds a layout', () => {
  const demo = JSON.parse(readFileSync(new URL('../data/demo.json', import.meta.url)));
  const L = buildLayout(demo);
  assert.equal(L.runways.length, 2);
  assert.ok(L.gates.length >= 4);
});
