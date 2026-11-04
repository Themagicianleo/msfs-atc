// End-to-end test of the static site in headless Chromium:
//   node tools/e2e.mjs
// Serves this folder with Python's built-in web server (like GitHub Pages
// would), builds sample airport data from tests/fixtures, then plays.

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const server = spawn(PY, ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
let page = null;

async function main() {
  await sleep(800);
  const browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // failed network loads (the unknown airport's 404, a blocked METAR fetch) are expected
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) console.log('network:', m.text());
    else errors.push(m.text());
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
  await page.waitForSelector('#start', { state: 'hidden' });
  console.log('TSTA:', (await page.textContent('#log')).slice(0, 200));
  await page.click('#new-shift');
  await page.fill('#start-icao', 'DEMO');
  await page.selectOption('#start-traffic', 'busy');
  await page.click('#start-form button[type=submit]');
  await page.waitForSelector('#start', { state: 'hidden' });
  console.log('DEMO:', await page.textContent('#log'));
  await page.click('.speed button[data-speed="4"]');

  await page.waitForFunction(() => window.towerGame.game.world.ac.some((a) => a.req), null, { timeout: 60000 });
  const r = await page.evaluate(() => window.towerGame.game.world.ac.filter((a) => a.req)
    .map((a) => ({ tel: a.tel, num: a.num, type: a.req.type, id: a.id, end: a.end }))[0]);
  const typed = { land: `runway ${r.end} cleared to land`, push: 'pushback approved',
    taxi: `taxi to holding point runway ${r.end} via alpha` }[r.type] || 'say again';
  await page.fill('#cmd-input', `${r.tel} ${r.num}, ${typed}`);
  await page.click('#cmd-form button');
  await page.waitForFunction((id) => !window.towerGame.game.world.find(id)?.req, r.id, { timeout: 5000 });
  console.log('typed:', await page.evaluate(() => [...document.querySelectorAll('#log .msg')].slice(-2).map((m) => m.textContent)));

  // set the wind by hand
  await page.click('details.settings summary');
  await page.fill('#wind-dir', '90');
  await page.fill('#wind-kt', '14');
  await page.click('#wind-form button');
  await page.waitForFunction(() => /Wind 090\/14/.test(document.querySelector('#wind').textContent));

  for (let i = 0; i < 40; i += 1) {
    const strip = await page.$('.strip.req');
    if (strip) {
      await strip.click();
      const btn = await page.$('#sel-buttons button.primary');
      if (btn) await btn.click();
    }
    await sleep(500);
  }
  console.log('stats:', JSON.stringify(await page.evaluate(() => ({ ...window.towerGame.game.world.stats, score: window.towerGame.game.world.score }))));
  await page.screenshot({ path: join(shots, 'landscape.png') });
  // Beijing Daxing: real OSM layout (if built), Chinese radio for Chinese airlines, metric units
  if (existsSync(join(ROOT, 'data', 'hq', 'ZBAD.json'))) {
    await page.click('#new-shift');
    await page.click('.featured button[data-code="ZBAD"]');
    await page.selectOption('#start-traffic', 'busy');
    await page.click('#start-form button[type=submit]');
    await page.waitForSelector('#start', { state: 'hidden' });
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
    await page.click('#chart');
    await sleep(300);
    await page.screenshot({ path: join(shots, 'zbad-chart.png') });
    await page.click('#chart');
    await page.screenshot({ path: join(shots, 'zbad.png') });
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
