import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../js/vendor/three.module.min.js';
import { aircraftGeometry, tailColour } from '../js/scene3d.js';

const types = JSON.parse(readFileSync(new URL('../data/aircraft.json', import.meta.url)));

function box(code) {
  const b = new THREE.Box3();
  for (const { g } of aircraftGeometry({ code, ...types[code] })) { g.computeBoundingBox(); b.union(g.boundingBox); }
  return b;
}

test('low-poly aircraft have the real length and wingspan', () => {
  for (const code of ['A320', 'B77W', 'A388', 'B738']) {
    if (!types[code]) continue;
    const b = box(code);
    const len = b.max.x - b.min.x;
    const span = b.max.z - b.min.z;
    assert.ok(Math.abs(len - types[code].length) / types[code].length < 0.08, `${code} length ${len.toFixed(1)}`);
    assert.ok(Math.abs(span - types[code].span) / types[code].span < 0.03, `${code} span ${span.toFixed(1)}`);
    assert.ok(Math.abs(b.min.y) < 0.01, `${code} wheels on the ground (${b.min.y})`);
  }
});

test('four engines only on four-engine types', () => {
  const engines = (code) => aircraftGeometry({ code, ...types[code] }).filter((p) => p.mat === 'grey').length - 3;
  assert.equal(engines('A320'), 2);
  if (types.A388) assert.equal(engines('A388'), 4);
});

test('tail colour is stable per airline and differs between airlines', () => {
  assert.equal(tailColour('SIA').getHex(), tailColour('SIA').getHex());
  assert.notEqual(tailColour('SIA').getHex(), tailColour('UAL').getHex());
});
