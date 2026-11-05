// Where does the time go while playing?   node tools/profile.mjs [ICAO] [cpuSlowdown] [seconds] [map|3d]
// Plays a busy shift at 4x speed in headless Chromium with the CPU slowed down
// (4 is about a recent phone, 6 an older iPad), answering calls like a player,
// and prints the frame rate, how busy the main thread was, and the functions
// that took the most time.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from './build_site.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [code = 'ZBAD', slow = '4', secs = '20', view = 'map', effects = ''] = process.argv.slice(2);
const SITE = mkdtempSync(join(tmpdir(), 'prof-site-'));
buildSite(SITE);
const port = 27000 + Math.floor(Math.random() * 900);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', SITE], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch();
// DESKTOP=1: a laptop-style browser (mouse, big screen) instead of a phone
const ctx = await browser.newContext(process.env.DESKTOP ? { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }
  : { viewport: { width: 430, height: 900 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(`http://127.0.0.1:${port}/`);
await page.click(`.featured button[data-code="${code}"]`);
await page.selectOption('#start-traffic', 'busy');
const t0 = Date.now();
await page.click('#start-form button[type=submit]');
await page.waitForSelector('#rwy-step:not([hidden])');
const loaded = Date.now() - t0;
await page.click('#rwy-begin');
await page.waitForSelector('#start', { state: 'hidden' });
console.log(`${code}: airport loaded and runway step shown after ${loaded} ms (no CPU slowdown yet)`);
if (effects === 'solid') await page.evaluate(() => document.documentElement.classList.add('solid'));
if (effects === 'noanim') await page.addStyleTag({ content: '.ambient { animation: none !important; }' });
if (effects === 'noblur') await page.addStyleTag({ content: '* { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }' });
if (effects === 'lightblur') await page.addStyleTag({ content: '.ambient { animation: none !important; } .map-tools *, .map-config, .plan-bar, .map-wrap .glass-ctl { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; } * { -webkit-backdrop-filter: blur(8px) !important; backdrop-filter: blur(8px) !important; }' });
if (view !== 'map') { await page.click(`#view button[data-view="${view}"]`); await sleep(500); }
await page.click(`.speed button[data-speed="${process.env.SPEED || 4}"]`);
// time the operations we suspect, and keep the slowest few
await page.evaluate(() => {
  const { game, renderer } = window.towerGame;
  const w = game.world;
  window.__ops = {};
  const wrap = (obj, name, label) => {
    const orig = obj[name].bind(obj);
    obj[name] = (...a) => { const t = performance.now(); const r = orig(...a); const d = performance.now() - t; const o = (window.__ops[label] ||= { n: 0, sum: 0, max: 0 }); o.n += 1; o.sum += d; o.max = Math.max(o.max, d); return r; };
  };
  wrap(renderer, 'drawBase', 'drawBase (redraw the whole map)');
  wrap(renderer, 'draw', 'renderer.draw (whole frame)');
  // the slowest frames: was the map redrawn in them?
  window.__slow = [];
  const d0 = renderer.draw; let base = 0;
  const b0 = renderer.drawBase; renderer.drawBase = (...a) => { base += 1; return b0(...a); };
  renderer.draw = (...a) => { const before = base; const t = performance.now(); const r = d0(...a); const d = performance.now() - t; if (d > 60) window.__slow.push({ ms: Math.round(d), redrewMap: base > before, aircraft: w.ac.length }); return r; };
  wrap(w, 'step', 'world.step (one 0.2 s step)');
  wrap(w, 'routeFromHere', 'routeFromHere (taxi route)');
  wrap(w, 'planTaxi', 'planTaxi (route preview)');
  wrap(w, 'drain', 'world.drain');
});
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(slow) });
await page.evaluate(() => {
  window.__frames = []; let last = performance.now();
  const tick = (now) => { window.__frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__long = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
});
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');
await cdp.send('Performance.enable');
const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const end = Date.now() + Number(secs) * 1000;
let i = 0;
while (Date.now() < end) {
  try {
    const strip = await page.$('.strip.req');
    if (strip) { await strip.click({ timeout: 1500 }); const b = await page.$('#sel-buttons button.primary'); if (b) await b.click({ timeout: 1500 }); }
    // now and then pan and zoom the map like a player
    if (view === 'map' && i % 6 === 0) {
      const box = await (await page.$('#map')).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, i % 12 === 0 ? -250 : 250);
    }
  } catch { /* the element went away */ }
  i += 1;
  await sleep(500);
}
const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const { profile } = await cdp.send('Profiler.stop');
const frames = await page.evaluate(() => window.__frames.slice(5));
const long = await page.evaluate(() => window.__long);
const wall = (m1.Timestamp - m0.Timestamp);
const busy = (k) => ((m1[k] - m0[k]) / wall * 100).toFixed(0);
if (view !== 'map') console.log('building the 3D scene again, with the CPU slowed:', await page.evaluate(() => { const sc = window.towerGame.scene3d; const t = performance.now(); sc.build(sc.L, true); return Math.round(performance.now() - t) + ' ms'; }));
if (view !== 'map') console.log('3D triangles by part:', JSON.stringify(await page.evaluate(() => {
  const sc = window.towerGame.scene3d; const out = [];
  sc.static.traverse((o) => { if (o.geometry) { const n = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; out.push([o.renderOrder + ':' + (o.material.color ? '#' + o.material.color.getHexString() : 'pts'), Math.round(n)]); } });
  return out.sort((a, b) => b[1] - a[1]).slice(0, 8);
})));
if (view !== 'map') console.log('3D scene:', JSON.stringify(await page.evaluate(() => { const i = window.towerGame.scene3d.gl.info; return { drawCalls: i.render.calls, triangles: i.render.triangles, points: i.render.points, geometries: i.memory.geometries, textures: i.memory.textures }; })));
const ops = await page.evaluate(() => window.__ops);
console.log('operation timings (ms, with the CPU slowed):');
for (const [k, o] of Object.entries(ops)) console.log(`  ${k.padEnd(34)} ${String(o.n).padStart(5)} calls  avg ${(o.sum / o.n).toFixed(1).padStart(6)}  max ${o.max.toFixed(1).padStart(6)}`);
console.log('what the game did about it:', JSON.stringify(await page.evaluate(() => ({ solid: document.documentElement.classList.contains('solid'), note: document.querySelector('#fx-note').textContent, messages: [...document.querySelectorAll('#log .msg.sys')].map((m) => m.textContent).filter((t) => /struggling|resolution|pictures/.test(t)) }))));
console.log('slow frames (over 60 ms):', JSON.stringify(await page.evaluate(() => window.__slow)));
const sorted = [...frames].sort((a, b) => a - b);
console.log(`frames: ${(frames.length / wall).toFixed(1)} per second, median ${sorted[sorted.length >> 1].toFixed(0)} ms, 95th percentile ${sorted[Math.floor(sorted.length * 0.95)].toFixed(0)} ms, worst ${sorted.at(-1).toFixed(0)} ms`);
console.log(`main thread busy: ${busy('TaskDuration')}%  (script ${busy('ScriptDuration')}%, layout ${busy('LayoutDuration')}%, style ${busy('RecalcStyleDuration')}%)`);
console.log(`long tasks (over 50 ms): ${long.length}${long.length ? ', longest ' + Math.max(...long) + ' ms' : ''}`);
// self time per function
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
profile.samples.forEach((id, k) => {
  const n = byId.get(id);
  const key = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + (profile.timeDeltas[k] || 0));
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log('top functions by self time:');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`);
// inclusive time: the function and everything it called
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const incl = new Map();
profile.samples.forEach((id, k) => {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const n = byId.get(cur);
    const key = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
    if (!seen.has(key)) { seen.add(key); incl.set(key, (incl.get(key) || 0) + (profile.timeDeltas[k] || 0)); }
  }
});
console.log('top functions including what they call (our code only):');
for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).filter(([k]) => /js\//.test(k)).slice(0, 14)) console.log(`  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`);
await browser.close();
server.kill();
