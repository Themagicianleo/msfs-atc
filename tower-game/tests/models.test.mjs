import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODEL_FILES, modelFor, placement, qualityFor } from '../js/lib/models.js';

const types = JSON.parse(readFileSync(new URL('../data/aircraft.json', import.meta.url)));

test('every model file the mapping names is shipped', () => {
  for (const f of MODEL_FILES) assert.ok(readFileSync(new URL(`../assets/models/${f}.glb`, import.meta.url)).length > 50000, f);
  for (const code of Object.keys(types).filter((c) => !c.startsWith('_'))) {
    const m = modelFor(code);
    assert.ok(m === null || MODEL_FILES.includes(m), code);
  }
});

test('big jets get a matching model, turboprops keep the built-in shape', () => {
  assert.equal(modelFor('A388'), 'A380');
  assert.equal(modelFor('b738'), 'B737');
  assert.equal(modelFor('A359'), 'A350');
  assert.equal(modelFor('A21N'), 'A320');
  assert.equal(modelFor('AT76'), null);
  assert.equal(modelFor(''), null);
});

test('a model is scaled to the real length, centred, and stands on the ground', () => {
  const p = placement({ min: [-21.9, -2.8, -17.7], max: [15.8, 8.5, 17.7] }, 37.7 * 2);
  assert.ok(Math.abs(p.scale - 2) < 0.01);
  assert.ok(Math.abs(p.offset[0] - 6.1) < 0.1);
  assert.ok(Math.abs(p.offset[1] - 2.8 * 2) < 0.01);
  assert.ok(Math.abs(p.offset[2]) < 1e-9);
});

test('3D quality: automatic means high in the Mac app only, and never on a weak device', () => {
  assert.equal(qualityFor('auto', { desktop: true }), 'high');
  assert.equal(qualityFor('auto', { desktop: false }), 'standard');
  assert.equal(qualityFor('auto', { desktop: true, device: 'low' }), 'standard');
  assert.equal(qualityFor('high', { desktop: false }), 'high');
  assert.equal(qualityFor('standard', { desktop: true }), 'standard');
});
