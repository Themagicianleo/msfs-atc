// The cached map must equal a fresh redraw, also after pan, zoom, theme and chart changes: node tools/perf-check.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from './build_site.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SITE = mkdtempSync(join(tmpdir(), 'perf-site-'));
buildSite(SITE);
const port = 25000 + Math.floor(Math.random() * 900);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', SITE], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 })).newPage();
await page.goto(`http://127.0.0.1:${port}/`);
await page.click('.featured button[data-code="ZBAD"]');
await page.click('#start-form button[type=submit]');
await page.waitForSelector('#rwy-step:not([hidden])');
await page.click('#rwy-begin');
await page.waitForSelector('#start', { state: 'hidden' });
await page.click('.speed button[data-speed="0"]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function same(label) {
  await sleep(500); // let the picture settle
  const r = await page.evaluate(() => {
    const { game, renderer } = window.towerGame;
    renderer.draw(game.world, { selectedId: null, now: 0 }); // same clock for both, so a blinking ring can't differ
    const cached = renderer.cv.toDataURL();
    renderer.cache = null; // force a full redraw
    renderer.draw(game.world, { selectedId: null, now: 0 });
    const fresh = renderer.cv.toDataURL();
    return { same: cached === fresh, len: [cached.length, fresh.length] };
  });
  console.log(label, JSON.stringify(r));
  return r.same;
}
let ok = await same('fit');
const box = await (await page.$('#map')).boundingBox();
const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -300); // zoom in
ok = (await same('after zoom in')) && ok;
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy + 80, { steps: 8 }); await page.mouse.up(); // pan
ok = (await same('after pan')) && ok;
await page.evaluate(() => { const { renderer } = window.towerGame; renderer.chart = true; });
ok = (await same('chart style')) && ok;
await page.evaluate(() => { const { renderer } = window.towerGame; renderer.chart = false; renderer.theme = 'light'; });
ok = (await same('light theme')) && ok;
// during a gesture the old picture is moved and scaled; check it looks right
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -200);
await page.screenshot({ path: process.argv[2] || '/tmp/perf-gesture.png' });
console.log(ok ? 'CACHE OK' : 'CACHE DIFFERS');
await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
