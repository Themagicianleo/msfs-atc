// End-to-end test of the static site in headless Chromium:
//   node tools/e2e.mjs
// Serves this folder with Python's built-in web server (like GitHub Pages
// would), builds sample airport data from tests/fixtures, then plays.

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from './build_site.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const shots = mkdtempSync(join(tmpdir(), 'tower-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hadData = existsSync(join(ROOT, 'data', 'airports'));
if (!hadData) {
  spawnSync(PY, [join(ROOT, 'tools', 'build_airports.py'), '--from-dir', join(ROOT, 'tests', 'fixtures')], { stdio: 'inherit' });
}
const port = 20000 + Math.floor(Math.random() * 2000);
// serve exactly what GitHub Pages gets
const SITE = mkdtempSync(join(tmpdir(), 'tower-site-'));
buildSite(SITE);
const server = spawn(PY, ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', SITE], { stdio: 'ignore' });
let page = null;

// the start sheet: airport and traffic, then the runway step with the recommended plan
async function beginShift() {
  await page.click('#start-form button[type=submit]');
  await page.waitForSelector('#rwy-step:not([hidden])');
  await page.click('#rwy-begin');
  await page.waitForSelector('#start', { state: 'hidden' });
}

async function main() {
  await sleep(800);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  // built-in voices: TOWER_TEST_VOICES is a folder with local copies of the
  // speech runtime and voice model files (by file name); others are "offline"
  const VOICES = process.env.TOWER_TEST_VOICES;
  if (VOICES) {
    await page.route(/^https:\/\//, (route) => {
      const f = join(VOICES, route.request().url().split('/').pop());
      if (existsSync(f)) return route.fulfill({ body: readFileSync(f), headers: { 'access-control-allow-origin': '*' } });
      return route.fulfill({ status: 404, body: 'offline' });
    });
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // failed network loads (the unknown airport's 404, a blocked METAR fetch) are expected
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) console.log('network:', m.text());
    else errors.push(m.text());
  });
  // a stand-in for the browser's speech recogniser: hears "<callsign> pushback approved"
  await page.addInitScript(() => {
    window.__heard = 'say again';
    class FakeRec {
      start() { setTimeout(() => this.onstart?.(), 20); }
      stop() {
        setTimeout(() => {
          const guesses = [window.__heard, ...(window.__heardAlts || [])].map((transcript) => ({ transcript }));
          this.onresult?.({ resultIndex: 0, results: [Object.assign(guesses, { isFinal: true })] });
          this.onend?.();
        }, 20);
      }
      abort() { this.onend?.(); }
    }
    for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
      Object.defineProperty(window, name, { value: FakeRec, configurable: true, writable: true });
    }
  });
  await page.goto(`http://127.0.0.1:${port}/`);

  // airport search from the built index
  await page.fill('#start-icao', 'alpha');
  await page.waitForSelector('#suggest button');
  const sug = await page.textContent('#suggest');
  if (!/TSTA/.test(sug)) throw new Error(`search did not find TSTA: ${sug}`);
  await page.fill('#start-icao', 'NOPE');
  await page.click('#start-form button[type=submit]');
  await page.waitForFunction(() => /not in the game's data/.test(document.querySelector('#start-error').textContent));

  // a real-data airport (sample) and then the demo
  await page.fill('#start-icao', 'TSTA');
  await page.click('#start-form button[type=submit]');
  // the runway step: wind, a recommended plan, every runway end with its wind, several runways at once
  await page.waitForSelector('#rwy-step:not([hidden])');
  const step = await page.evaluate(() => ({
    wind: document.querySelector('#rwy-wind').textContent,
    plans: [...document.querySelectorAll('#rwy-plans .plan')].map((b) => b.textContent),
    rec: document.querySelector('#rwy-plans .plan[aria-pressed="true"]')?.textContent,
    arr: [...document.querySelectorAll('#rwy-arr .chip')].map((b) => `${b.dataset.end}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`),
    dep: [...document.querySelectorAll('#rwy-dep .chip[aria-pressed="true"]')].map((b) => b.dataset.end),
  }));
  console.log('runway step:', JSON.stringify(step));
  if (!/^Recommended/.test(step.plans[0]) || !step.rec?.startsWith('Recommended')) throw new Error('the recommended plan should be first and selected');
  if (!/Wind \d{3}\/\d+/.test(step.wind)) throw new Error(`runway step should show the wind: ${step.wind}`);
  // starting with no departure runway is refused
  for (const b of await page.$$('#rwy-dep .chip[aria-pressed="true"]')) await b.click();
  await page.click('#rwy-begin');
  if (!/at least one runway/.test(await page.textContent('#rwy-error'))) throw new Error('should refuse a shift without a departure runway');
  // a plan using several runways at once
  await page.click('#rwy-plans .plan:nth-child(2)');
  await page.click('#rwy-begin');
  await page.waitForSelector('#start', { state: 'hidden' });
  const both = await page.evaluate(() => ({ arr: window.towerGame.game.world.arrEnds, dep: window.towerGame.game.world.depEnds }));
  console.log('TSTA runways:', JSON.stringify(both), await page.textContent('#rwy-open'));
  if (both.arr.length + both.dep.length < 3) throw new Error(`expected a plan with more than one runway: ${JSON.stringify(both)}`);
  console.log('TSTA:', (await page.textContent('#log')).slice(0, 200));
  await page.click('#new-shift');
  await page.fill('#start-icao', 'DEMO');
  await page.selectOption('#start-traffic', 'busy');
  await beginShift();
  console.log('DEMO:', await page.textContent('#log'));
  await page.click('.speed button[data-speed="4"]');

  if (VOICES) {
    // switch built-in voices on: what's available loads, pilots then talk with it through the radio filter
    await page.evaluate(() => {
      const fx = window.towerGame.speaker.fx;
      const play = fx.play.bind(fx);
      window.__plays = [];
      fx.play = (pcm, rate, o) => { window.__plays.push(pcm.length / rate); return play(pcm, rate, o); };
      document.querySelector('#set-builtin').click();
    });
    await page.waitForFunction(() => window.towerGame.speaker.neural.ready.size > 0, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__plays.length > 0, null, { timeout: 90000 });
    await page.waitForFunction(() => /Missing/.test(document.querySelector('#builtin-status').textContent), null, { timeout: 60000 });
    console.log('built-in voices:', await page.textContent('#builtin-status'), '| played', await page.evaluate(() => window.__plays.map((s) => `${s.toFixed(1)} s`)));
    // off again: generating speech nonstop slows this test machine down
    await page.evaluate(() => document.querySelector('#set-builtin').click());
  }

  await page.waitForFunction(() => window.towerGame.game.world.ac.some((a) => a.req), null, { timeout: 60000 });
  const r = await page.evaluate(() => window.towerGame.game.world.ac.filter((a) => a.req)
    .map((a) => ({ tel: a.tel, num: a.num, type: a.req.type, id: a.id, end: a.end }))[0]);
  const typed = { land: `runway ${r.end} cleared to land`, push: 'pushback approved',
    taxi: `taxi to holding point runway ${r.end} via alpha` }[r.type] || 'say again';
  await page.fill('#cmd-input', `${r.tel} ${r.num}, ${typed}`);
  await page.click('#cmd-form button');
  await page.waitForFunction((id) => !window.towerGame.game.world.find(id)?.req, r.id, { timeout: 5000 });
  console.log('typed:', await page.evaluate(() => [...document.querySelectorAll('#log .msg')].slice(-2).map((m) => m.textContent)));

  // talk button: tap to start, tap again to stop and send
  await page.waitForFunction(() => window.towerGame.game.world.ac.some((a) => a.req?.type === 'push'), null, { timeout: 90000 });
  const caller2 = await page.evaluate(() => window.towerGame.game.world.ac.find((a) => a.req?.type === 'push'));
  {
    await page.evaluate((t) => { window.__heard = t; }, `${caller2.tel} ${caller2.num} pushback approved`);
    if ((await page.textContent('#ptt-label')) !== 'Start talking') throw new Error('talk button should say Start talking');
    await page.click('#ptt');
    await page.waitForFunction(() => document.querySelector('#ptt-label').textContent === 'Stop and send');
    await page.click('#ptt');
    await page.waitForFunction((id) => !window.towerGame.game.world.find(id)?.req, caller2.id, { timeout: 5000 });
    const said = await page.evaluate(() => [...document.querySelectorAll('#log .msg')].slice(-2).map((m) => m.textContent));
    console.log('voice (simulated):', said);
    if (!/runway \d/i.test(said[1])) throw new Error(`the pushback readback should name the runway to expect: ${said[1]}`);
    const sel = await page.evaluate(() => getComputedStyle(document.querySelector('#ptt')).webkitUserSelect || getComputedStyle(document.querySelector('#ptt')).userSelect);
    if (sel !== 'none') throw new Error(`talk button text is selectable (${sel})`);
  }

  // choose the taxi route on the map for the aircraft that just pushed back
  {
    // aircraft waiting for a taxi clearance would block the lane: send them on their way while this one pushes back
    for (let i = 0; i < 200; i += 1) {
      const state = await page.evaluate((id) => {
        const w = window.towerGame.game.world;
        for (const o of w.ac) if (o.id !== id && o.state === 'pushed' && o.req?.type === 'taxi') w.command(o.id, { type: 'taxi' });
        return w.find(id)?.state;
      }, caller2.id);
      if (state === 'pushed') break;
      if (i === 199) throw new Error(`the pushback never finished (${state})`);
      await sleep(500);
    }
    await page.click('.speed button[data-speed="0"]');
    await page.evaluate((id) => { window.towerGame.game.selected = id; }, caller2.id);
    await page.waitForSelector('#sel-buttons button[data-type="plan"]');
    await page.click('#sel-buttons button[data-type="plan"]');
    await page.waitForSelector('#plan:not([hidden])');
    const before = await page.textContent('#plan-text');
    // a taxiway point off the default route, away from the holding points
    const tap = await page.evaluate((id) => {
      const { game, renderer } = window.towerGame;
      const w = game.world; const L = w.L; const g = L.graph;
      const plain = w.planTaxi(w.find(id), {});
      const used = new Set(plain.nodes);
      const holds = Object.values(L.holdPoints).map((h) => renderer.toScreen(g.nodes[h.h].p));
      const cands = [];
      g.nodes.forEach((n, i) => {
        if (n.kind !== 'twy' || used.has(i)) return;
        const s = renderer.toScreen(n.p);
        if (s[0] < 40 || s[1] < 140 || s[0] > renderer.w - 40 || s[1] > renderer.h - 80) return;
        if (holds.some((h) => Math.hypot(h[0] - s[0], h[1] - s[1]) < 45)) return;
        const near = g.nodes.some((m, j) => j !== i && m.kind !== 'rwy' && Math.hypot(...[0, 1].map((k) => renderer.toScreen(m.p)[k] - s[k])) < 3);
        if (!near && w.planTaxi(w.find(id), { waypoints: [i] })) cands.push({ i, x: s[0], y: s[1] });
      });
      return cands[Math.floor(cands.length / 2)];
    }, caller2.id);
    if (!tap) throw new Error('no taxiway point to tap');
    await page.click('#map', { position: { x: tap.x, y: tap.y } });
    const planned = await page.evaluate(() => ({ wp: window.towerGame.game.plan.waypoints, nodes: window.towerGame.game.plan.result.nodes }));
    if (planned.wp[0] !== tap.i || !planned.nodes.includes(tap.i)) throw new Error(`tap did not set the route: ${JSON.stringify(planned.wp)} vs ${tap.i}`);
    const after = await page.textContent('#plan-text');
    await page.screenshot({ path: join(shots, 'route-plan.png') });
    await page.click('#plan-send');
    await page.waitForFunction((id) => window.towerGame.game.world.find(id)?.state === 'taxi_out', caller2.id);
    const onRoute = await page.evaluate(([id, n]) => window.towerGame.game.world.find(id).routeNodes.includes(n), [caller2.id, tap.i]);
    if (!onRoute) throw new Error('aircraft is not taxiing the chosen route');
    console.log('route plan:', before, '->', after, '|', await page.evaluate(() => [...document.querySelectorAll('#log .msg')].slice(-2).map((m) => m.textContent)));
    await page.click('.speed button[data-speed="4"]');
  }

  // set the wind by hand
  await page.click('details.settings summary');
  await page.fill('#wind-dir', '90');
  await page.fill('#wind-kt', '14');
  await page.click('#wind-form button');
  await page.waitForFunction(() => /Wind 090\/14/.test(document.querySelector('#wind').textContent));

  for (let i = 0; i < 40; i += 1) {
    // strips are redrawn all the time: a click can miss one that just went away
    try {
      const strip = await page.$('.strip.req');
      if (strip) {
        await strip.click({ timeout: 2000 });
        const btn = await page.$('#sel-buttons button.primary');
        if (btn) await btn.click({ timeout: 2000 });
      }
    } catch { /* try again next round */ }
    await sleep(500);
  }
  console.log('stats:', JSON.stringify(await page.evaluate(() => ({ ...window.towerGame.game.world.stats, score: window.towerGame.game.world.score }))));
  await page.screenshot({ path: join(shots, 'landscape.png') });
  await check3d('demo');
  // Beijing Daxing: real OSM layout (if built), Chinese radio for Chinese airlines, metric units
  if (existsSync(join(ROOT, 'data', 'hq', 'ZBAD.json'))) {
    await page.click('#new-shift');
    await page.click('.featured button[data-code="ZBAD"]');
    await page.selectOption('#start-traffic', 'busy');
    await beginShift();
    await page.click('.speed button[data-speed="4"]');
    await page.waitForFunction(() => [...document.querySelectorAll('#log .msg')].some((m) => /大兴塔台/.test(m.textContent)), null, { timeout: 60000 });
    const zh = await page.evaluate(() => [...document.querySelectorAll('#log .msg')].map((m) => m.textContent).filter((t) => /塔台/.test(t))[0]);
    console.log('ZBAD:', zh, '|', await page.textContent('#wind'));
    if (!/m\/s/.test(await page.textContent('#wind'))) throw new Error('ZBAD wind should be in m/s');
    const caller = await page.evaluate(() => window.towerGame.game.world.ac.find((a) => a.req && a.lang === 'zh'));
    if (caller) {
      const say = { land: `${caller.telZh}${caller.num}，跑道${caller.end}，可以落地`, push: `${caller.telZh}${caller.num}，可以推出` }[caller.req.type];
      if (say) {
        await page.fill('#cmd-input', say);
        await page.click('#cmd-form button');
        await page.waitForFunction((id) => !window.towerGame.game.world.find(id)?.req, caller.id, { timeout: 5000 });
        console.log('ZBAD typed:', await page.evaluate(() => [...document.querySelectorAll('#log .msg')].slice(-1)[0].textContent));
      }
    }
    // Chinese by voice, as the iPad hears it: 五 as 舞, 九 as 角, 推出 as 退出
    await page.waitForFunction(() => window.towerGame.game.world.ac.some((a) => a.lang === 'zh' && a.req?.type === 'push'), null, { timeout: 120000 });
    const zp = await page.evaluate(() => { const a = window.towerGame.game.world.ac.find((x) => x.lang === 'zh' && x.req?.type === 'push'); return { id: a.id, telZh: a.telZh, num: a.num, end: a.end }; });
    const READ = { 0: '洞', 1: '幺', 2: '两', 3: '三', 4: '四', 5: '舞', 6: '六', 7: '拐', 8: '八', 9: '角' };
    const spoken = `${zp.telZh}${[...zp.num].map((d) => READ[d]).join('')}`;
    await page.evaluate((t) => { window.__heard = t; window.__heardAlts = []; }, `${spoken}可以退出`);
    await page.click('#ptt');
    await page.waitForFunction(() => document.querySelector('#ptt-label').textContent === 'Stop and send');
    await page.click('#ptt');
    await page.waitForFunction((id) => !window.towerGame.game.world.find(id)?.req, zp.id, { timeout: 5000 });
    const zv = await page.evaluate(() => [...document.querySelectorAll('#log .msg')].slice(-2).map((m) => m.textContent));
    console.log('ZBAD voice (misheard):', zv);
    if (!/跑道/.test(zv[1])) throw new Error(`Chinese pushback readback should name the runway: ${zv[1]}`);
    // the recogniser's first guess is nonsense, the second is right
    await page.waitForFunction(() => window.towerGame.game.world.ac.some((a) => a.lang === 'zh' && a.req?.type === 'push'), null, { timeout: 120000 });
    const z2 = await page.evaluate(() => { const a = window.towerGame.game.world.ac.find((x) => x.lang === 'zh' && x.req?.type === 'push'); return { id: a.id, telZh: a.telZh, num: a.num }; });
    await page.evaluate(([c, n]) => { window.__heard = '嗯嗯'; window.__heardAlts = [`${c}${n}可以推出`]; }, [z2.telZh, z2.num]);
    await page.click('#ptt');
    await page.waitForFunction(() => document.querySelector('#ptt-label').textContent === 'Stop and send');
    await page.click('#ptt');
    await page.waitForFunction((id) => !window.towerGame.game.world.find(id)?.req, z2.id, { timeout: 5000 });
    await page.evaluate(() => { window.__heard = 'say again'; window.__heardAlts = []; });
    await page.click('#chart');
    await sleep(300);
    await page.screenshot({ path: join(shots, 'zbad-chart.png') });
    await page.click('#chart');
    await page.screenshot({ path: join(shots, 'zbad.png') });
    await check3d('zbad');
  }
  await page.setViewportSize({ width: 820, height: 1180 });
  await sleep(400);
  await page.screenshot({ path: join(shots, 'portrait.png') });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('portrait scrolls sideways');
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
  await browser.close();
  console.log('screenshots in', shots);
  console.log('E2E OK');
}

// the tower cab and orbit views: three.js loads, draws something, shows tags, taps select
async function check3d(name) {
  await page.click('#view button[data-view="tower"]');
  await page.waitForFunction(() => window.towerGame.scene3d && !document.querySelector('.map3d').hidden);
  await sleep(600);
  const pressed = await page.evaluate(() => [...document.querySelectorAll('#view button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.view).join());
  if (pressed !== 'tower') throw new Error(`view switch shows ${pressed}, expected tower`);
  const tags = await page.evaluate(() => [...document.querySelectorAll('.tag3d')].filter((t) => !t.hidden).length);
  const shot = await page.screenshot({ path: join(shots, `${name}-tower.png`) });
  console.log(`${name} tower view: ${tags} aircraft tags, screenshot ${shot.length} bytes`);
  if (shot.length < 20000) throw new Error('tower view looks empty');
  const q = await page.evaluate(() => window.towerGame.game.world.ac.length > 0);
  await page.click('#view button[data-view="orbit"]');
  await page.evaluate(() => { const g = window.towerGame.game; g.selected = g.world.ac.find((a) => a.state !== 'final')?.id ?? g.world.ac[0]?.id; });
  await page.click('#follow');
  await sleep(1200);
  await page.screenshot({ path: join(shots, `${name}-orbit.png`) });
  const selTag = await page.evaluate(() => !!document.querySelector('.tag3d.sel:not([hidden])'));
  console.log(`${name} orbit view, following the selected aircraft: tag shown ${selTag}`, q ? '' : '(no aircraft)');
  if (q && !selTag) throw new Error('selected aircraft not shown in the orbit view');
  await page.click('#follow');
  await page.click('#view button[data-view="map"]');
  await page.waitForFunction(() => !document.querySelector('#map').hidden && document.querySelector('.map3d').hidden);
}

function cleanup() {
  server.kill();
  if (!hadData) rmSync(join(ROOT, 'data', 'airports'), { recursive: true, force: true });
}

main().then(() => { cleanup(); process.exit(0); }, async (err) => {
  console.error(err.message);
  if (page) console.error(await page.evaluate(() => document.querySelector('#log')?.innerText).catch(() => ''));
  cleanup();
  process.exit(1);
});
