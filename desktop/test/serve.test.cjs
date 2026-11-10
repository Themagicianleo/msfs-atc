'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mimeFor, resolveAppPath } = require('../lib/serve');

const ROOT = path.resolve('/app/site');

test('the game\'s files are found inside the app folder; the folder itself and "/" give the page', () => {
  assert.equal(resolveAppPath(ROOT, '/'), path.join(ROOT, 'index.html'));
  assert.equal(resolveAppPath(ROOT, ''), path.join(ROOT, 'index.html'));
  assert.equal(resolveAppPath(ROOT, '/index.html'), path.join(ROOT, 'index.html'));
  assert.equal(resolveAppPath(ROOT, '/js/lib/voice.js'), path.join(ROOT, 'js/lib/voice.js'));
  assert.equal(resolveAppPath(ROOT, '/data/hq/ZBAD.json?v=3#x'), path.join(ROOT, 'data/hq/ZBAD.json'));
  assert.equal(resolveAppPath(ROOT, '/data/'), path.join(ROOT, 'data/index.html'));
  assert.equal(resolveAppPath(ROOT, '/%E5%A4%A7.json'), path.join(ROOT, '大.json'));
});

test('nothing outside the app folder can be read', () => {
  for (const bad of ['/../secret', '/..%2fsecret', '/%2e%2e/secret', '/js/../../secret', '//etc/passwd', '/a\0b', '/%00', '/..\\..\\x', '/%E0%A4%A']) {
    const r = resolveAppPath(ROOT, bad);
    assert.ok(r === null || r.startsWith(ROOT + path.sep), `${bad} -> ${r}`);
  }
  assert.equal(resolveAppPath(ROOT, '/../secret'), path.join(ROOT, 'secret')); // normalised inside the folder, never outside
  assert.equal(resolveAppPath(ROOT, '/%E0%A4%A'), null); // a broken escape
  assert.equal(resolveAppPath(ROOT, '/a\0b'), null);
});

test('files get the right type (modules and wasm need it)', () => {
  assert.match(mimeFor('app.js'), /^text\/javascript/);
  assert.equal(mimeFor('x.wasm'), 'application/wasm');
  assert.match(mimeFor('a.json'), /json/);
  assert.equal(mimeFor('m.glb'), 'model/gltf-binary');
  assert.equal(mimeFor('unknown.bin'), 'application/octet-stream');
});
