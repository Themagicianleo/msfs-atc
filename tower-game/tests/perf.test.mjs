import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceClass, drawInterval, pixelRatio, profileFor } from '../js/lib/perf.js';

test('a device is judged by what the browser says about it', () => {
  assert.equal(deviceClass({ cores: 2 }), 'low');
  assert.equal(deviceClass({ cores: 4 }), 'low'); // an old laptop
  assert.equal(deviceClass({ cores: 4, coarse: true }), 'normal'); // a phone or tablet with four cores is ordinary
  assert.equal(deviceClass({ cores: 8, memory: 2 }), 'low');
  assert.equal(deviceClass({ cores: 6, memory: 4 }), 'normal');
  assert.equal(deviceClass({ cores: 8 }), 'high'); // Safari does not say its memory
  assert.equal(deviceClass({ cores: 12, memory: 8 }), 'high');
  assert.equal(deviceClass(), 'low');
});

test('the three profiles: Sharp is everything, Balanced the default, Smooth for old and low-end devices', () => {
  const sharp = profileFor('sharp', 'low');
  const bal = profileFor('auto', 'normal');
  const smooth = profileFor('smooth', 'high');
  assert.equal(profileFor('auto', 'low').mode, 'smooth'); // automatic on a modest device
  assert.equal(profileFor('auto', 'high').mode, 'balanced');
  assert.equal(sharp.interval, 0); // every frame
  assert.equal(bal.interval, 33);
  assert.equal(smooth.interval, 50);
  assert.ok(sharp.budget2d > bal.budget2d && bal.budget2d > smooth.budget2d);
  assert.ok(sharp.budget3d > bal.budget3d && bal.budget3d > smooth.budget3d);
  assert.ok(smooth.maxDpr < bal.maxDpr);
  assert.equal(smooth.solid, true);
  assert.equal(smooth.antialias, false);
  assert.equal(bal.antialias, true);
  assert.ok(smooth.panelMs > bal.panelMs);
  assert.equal(profileFor(undefined, 'normal').mode, 'balanced');
});

test('a big screen is drawn with fewer pixels per point, a small one is not touched', () => {
  const bal = profileFor('auto', 'normal');
  // a 1440x900 retina laptop: 2x would be 5.2 million pixels, over the 4.2 million budget
  const mac = pixelRatio({ devicePixelRatio: 2, maxDpr: bal.maxDpr, cssW: 1440, cssH: 900, budget: bal.budget2d });
  assert.ok(mac < 2 && mac > 1.5, String(mac));
  assert.ok(Math.round(1440 * mac) * Math.round(900 * mac) <= bal.budget2d * 1.02);
  // a phone and a tablet stay at 2x
  assert.equal(pixelRatio({ devicePixelRatio: 3, maxDpr: bal.maxDpr, cssW: 430, cssH: 900, budget: bal.budget2d }), 2);
  assert.equal(pixelRatio({ devicePixelRatio: 2, maxDpr: bal.maxDpr, cssW: 1180, cssH: 820, budget: bal.budget2d }), 2);
  // Smooth on the same laptop: about 1.2x
  const smooth = profileFor('smooth');
  const low = pixelRatio({ devicePixelRatio: 2, maxDpr: smooth.maxDpr, cssW: 1440, cssH: 900, budget: smooth.budget2d });
  assert.ok(low >= 1.2 && low <= 1.25, String(low));
  // never below 1 (or the screen's own ratio), however big the screen, and no budget means no cut
  assert.equal(pixelRatio({ devicePixelRatio: 2, maxDpr: 2, cssW: 5000, cssH: 3000, budget: 1e6 }), 1);
  assert.equal(pixelRatio({ devicePixelRatio: 1, maxDpr: 2, cssW: 1920, cssH: 1080, budget: 1e5 }), 1);
  assert.equal(pixelRatio({ devicePixelRatio: 0.75, maxDpr: 2, cssW: 1920, cssH: 1080, budget: 1e5 }), 0.75);
  assert.equal(pixelRatio({ devicePixelRatio: 2, maxDpr: 2, cssW: 800, cssH: 600 }), 2);
  assert.equal(pixelRatio({ devicePixelRatio: 2, maxDpr: 2 }), 2);
});

test('pictures a second: a laptop by its profile, a touch device by its own pacing, a struggling device slower still', () => {
  const bal = profileFor('auto', 'normal');
  const sharp = profileFor('sharp');
  const smooth = profileFor('smooth');
  assert.equal(drawInterval({ profile: sharp }), 0);
  assert.equal(drawInterval({ profile: bal }), 33);
  assert.equal(drawInterval({ profile: smooth }), 50);
  assert.equal(drawInterval({ profile: bal, coarse: true, view: 'map', speed: 1 }), 50); // a normal-speed touch game
  assert.equal(drawInterval({ profile: bal, coarse: true, view: 'map', speed: 4 }), 33);
  assert.equal(drawInterval({ profile: bal, coarse: true, view: 'orbit', speed: 4 }), 50);
  assert.equal(drawInterval({ profile: smooth, coarse: true, view: 'map', speed: 4 }), 50);
  assert.equal(drawInterval({ profile: bal, forced: 66 }), 66);
  assert.equal(drawInterval({ profile: sharp, forced: 50 }), 50);
});
