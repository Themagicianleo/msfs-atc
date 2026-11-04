// End-to-end test of the tower game: helper + headless Chromium on the
// localhost port. Plays a few minutes with typed commands and buttons.
//   node tools/e2e-tower.mjs   (screenshots go to the temp folder it prints)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : '.venv/bin/python');
const dataDir = mkdtempSync(join(tmpdir(), 'openatc-tower-'));
const port = 19443 + Math.floor(Math.random() * 400);
const local = port + 1000;
const helper = spawn(PY, ['-m', 'openatc', '--no-sim', '--bind', '127.0.0.1', '--port', String(port), '--setup-port', '0',
  '--local-port', String(local), '--data-dir', dataDir, '--offline'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
helper.stdout.on('data', (d) => { out += d; });
helper.stderr.on('data', (d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;

async function main() {
  for (let i = 0; i < 50 && !out.includes('Pairing code'); i += 1) await sleep(200);
  if (!out.includes(`http://localhost:${local}/tower/`)) throw new Error(`helper did not start\n${out}`);
  const code = JSON.parse(readFileSync(join(dataDir, 'pairing.json'), 'utf8')).pairing_code;
  const browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${local}/tower/`);
  if (!(await page.evaluate(() => window.isSecureContext))) throw new Error('localhost page is not a secure context');
  await page.fill('#pair-code', code);
  await page.click('#pair-form button[type=submit]');
  await page.waitForSelector('#pair', { state: 'hidden' });
  await page.fill('#start-icao', 'XDEP');
  await page.selectOption('#start-traffic', 'busy');
  await page.click('#start-form button[type=submit]');
  await page.waitForSelector('#start', { state: 'hidden' });
  console.log('started:', await page.textContent('#log'));
  await page.click('.speed button[data-speed="4"]');

  // wait for the first call to the tower
  await page.waitForFunction(() => window.openatcTower.game.world.ac.some((a) => a.req), null, { timeout: 60000 });
  const reqs = await page.evaluate(() => window.openatcTower.game.world.ac.filter((a) => a.req).map((a) => ({ cs: a.callsign, tel: a.tel, num: a.num, type: a.req.type, id: a.id, end: a.end })));
  console.log('requests:', JSON.stringify(reqs));

  // answer one by typing, as speech would arrive
  const r = reqs[0];
  const typed = { land: `runway ${r.end} cleared to land`, push: 'pushback approved',
    taxi: `taxi to holding point runway ${r.end} via alpha` }[r.type] || 'say again';
  await page.fill('#cmd-input', `${r.tel} ${r.num}, ${typed}`);
  await page.click('#cmd-form button');
  await page.waitForFunction((id) => !window.openatcTower.game.world.find(id)?.req, r.id, { timeout: 5000 });
  console.log('typed command answered:', await page.evaluate(() => [...document.querySelectorAll('#log .msg')].slice(-2).map((m) => m.textContent)));

  // then play with the buttons for a while: select each caller from the strips and press the highlighted button
  for (let i = 0; i < 40; i += 1) {
    const strip = await page.$('.strip.req');
    if (strip) {
      await strip.click();
      const btn = await page.$('#sel-buttons button.primary');
      if (btn) await btn.click();
    }
    await sleep(500);
  }
  const stats = await page.evaluate(() => ({ ...window.openatcTower.game.world.stats, score: window.openatcTower.game.world.score, n: window.openatcTower.game.world.ac.length }));
  console.log('stats after play:', JSON.stringify(stats));
  await page.screenshot({ path: join(dataDir, 'tower-landscape.png') });
  await page.setViewportSize({ width: 820, height: 1180 });
  await sleep(500);
  await page.screenshot({ path: join(dataDir, 'tower-portrait.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('portrait layout scrolls sideways');
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
  console.log('screenshots in', dataDir);
  await browser.close();
  console.log('TOWER E2E OK');
}

main().then(() => { helper.kill(); process.exit(0); }, async (err) => {
  console.error(err.message);
  if (page) console.error(await page.evaluate(() => document.querySelector('#log')?.innerText).catch(() => ''));
  helper.kill();
  process.exit(1);
});
