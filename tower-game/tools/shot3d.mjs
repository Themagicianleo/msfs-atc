// node tools/shot3d.mjs [ICAO] [standard|high] [tower|orbit] [out.png] [dark|light]: a picture of the 3D view
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from './build_site.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [code = 'ZBAD', quality = 'high', view = 'orbit', out = 'shot.png', theme = 'light'] = process.argv.slice(2);
const SITE = mkdtempSync(join(tmpdir(), 'shot-site-'));
buildSite(SITE);
const port = 26300 + Math.floor(Math.random() * 90);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', SITE], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.click(`.featured button[data-code="${code}"]`);
await page.click('#start-form button[type=submit]');
await page.waitForSelector('#rwy-step:not([hidden])');
await page.click('#rwy-begin');
await page.waitForSelector('#start', { state: 'hidden' });
await page.evaluate(() => window.towerGame.game.world.setTraffic('busy'));
await page.evaluate((t) => document.querySelector(`#appearance button[data-theme="${t}"]`)?.click(), theme);
await page.evaluate((q) => document.querySelector(`#quality3d button[data-q3="${q}"]`).click(), quality);
await page.click('.speed button[data-speed="4"]');
await page.click(`#view button[data-view="${view}"]`);
await page.waitForTimeout(Number(process.env.WAIT || 25000));
if (view === 'orbit' && process.env.FOLLOW) {
  await page.evaluate(() => { const g = window.towerGame.game; const a = g.world.ac[0]; if (a) g.selected = a.id; document.querySelector('#follow')?.click(); });
  await page.waitForTimeout(3000);
}
await page.screenshot({ path: out });
console.log(await page.evaluate(() => JSON.stringify({ q: window.towerGame.scene3d?.quality, pack: Object.keys(window.towerGame.scene3d?.pack || {}), ac: window.towerGame.game.world.ac.length })));
await browser.close(); server.kill();
