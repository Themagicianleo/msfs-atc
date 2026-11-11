// How does the game run on a slow device? node tools/perf-throttle.mjs [ICAO] [laptop|phone]
// Busy shift at 4x speed, on a retina-size screen, with the CPU slowed 1x, 4x and 6x (what an old laptop or a low-end phone
// is like next to a fast one), in the map and in the 3D view: frames a second, the longest stall, and how much of the time
// the main thread is blocked. (Headless Chromium draws without a GPU, so 3D numbers are on the pessimistic side; compare
// before and after, not against a device.)
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
const port = 25900 + Math.floor(Math.random() * 90);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', SITE], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch();
const code = process.argv[2] || 'ZBAD';
const rows = [];
const only = process.argv[3] || 'laptop';
const DEVICES = [['laptop 1440x900 @2x', { width: 1440, height: 900 }, 2, false], ['phone 430x900 @3x', { width: 430, height: 900 }, 3, true]].filter((d) => d[0].startsWith(only));
for (const [name, vp, dpr, mobile] of DEVICES) {
  for (const mode of ['sharp', 'auto', 'smooth']) { // sharp is what the game did before the Performance setting
    for (const view of ['map', 'orbit']) {
      for (const rate of [1, 4, 6]) {
        const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.click(`.featured button[data-code="${code}"]`);
        await page.click('#start-form button[type=submit]');
        await page.waitForSelector('#rwy-step:not([hidden])');
        await page.click('#rwy-begin');
        await page.waitForSelector('#start', { state: 'hidden' });
        await page.evaluate(() => { const g = window.towerGame.game; g.world.setTraffic('busy'); });
        await page.click(`#perfmode button[data-perf="${mode}"]`, { force: true }).catch(() => page.evaluate((m) => document.querySelector(`#perfmode button[data-perf="${m}"]`).click(), mode));
        if (view === 'orbit') await page.click('#view button[data-view="orbit"]');
        await page.click('.speed button[data-speed="4"]');
        await page.evaluate(() => { const w = window.towerGame.game.world; for (let i = 0; i < 400; i += 1) w.step(0.5); });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        await page.waitForTimeout(1500);
        const r = await page.evaluate(() => new Promise((resolve) => {
          const gaps = []; let last = performance.now(); let long = 0; let frames = 0;
          const st = window.towerGame.stats; const d0 = st.draws; const j0 = st.jsMs;
          const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long += e.duration; });
          try { po.observe({ entryTypes: ['longtask'] }); } catch { /* not supported */ }
          const t0 = performance.now();
          const tick = (now) => { gaps.push(now - last); last = now; frames += 1; if (now - t0 < 5000) requestAnimationFrame(tick); else {
            po.disconnect(); gaps.sort((a, b) => a - b); const secs = (now - t0) / 1000;
            resolve({ pictures: +((st.draws - d0) / secs).toFixed(1), gameMainThreadPct: +((st.jsMs - j0) / (now - t0) * 100).toFixed(0), blockedPct: +(long / (now - t0) * 100).toFixed(0), p95gap: +gaps[Math.floor(gaps.length * 0.95)].toFixed(0), maxgap: +gaps[gaps.length - 1].toFixed(0),
              pixelRatio: +(window.towerGame.renderer.cv.width / window.towerGame.renderer.w).toFixed(2), aircraft: window.towerGame.game.world.ac.length }); } };
          requestAnimationFrame(tick);
        }));
        rows.push({ device: name.split(' ')[0], mode: mode === 'sharp' ? 'sharp (before)' : mode, view, cpu: `${rate}x slower`, ...r });
        await ctx.close();
      }
    }
  }
}
console.log(JSON.stringify(rows, null, 0).replace(/\},\{/g, '},\n{'));
await browser.close();
server.kill();
