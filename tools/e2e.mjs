// End-to-end smoke test: starts the helper with the mock aircraft over HTTPS,
// opens the app in headless Chromium, pairs, loads the demo flight plan and
// flies the departure with the phrase buttons up to radar contact.
//
//   node tools/e2e.mjs            (needs Python deps and Playwright installed)
//
// Chromium is not Safari: this checks the app logic and the network/pairing
// path, not iPad-specific speech or certificate behaviour.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : '.venv/bin/python');
const dataDir = mkdtempSync(join(tmpdir(), 'openatc-e2e-'));
const port = 18443 + Math.floor(Math.random() * 500);
const helper = spawn(PY, ['-m', 'openatc', '--mock', '--mock-speed', '20', '--bind', '127.0.0.1', '--port', String(port),
  '--setup-port', '0', '--data-dir', dataDir, '--offline', '--rate', '4'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
helper.stdout.on('data', (d) => { out += d; });
helper.stderr.on('data', (d) => { out += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { throw new Error(`${msg}\n--- helper output ---\n${out}`); };

async function main() {
  for (let i = 0; i < 50 && !out.includes('Pairing code'); i += 1) await sleep(200);
  if (!out.includes('Pairing code')) fail('helper did not start');
  const code = JSON.parse(readFileSync(join(dataDir, 'pairing.json'), 'utf8')).pairing_code;

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1180, height: 820 } })).newPage();
  pageRef = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // the service worker refuses a certificate that is ignored rather than trusted (test-only)
  page.on('console', (m) => { if (m.type() === 'error' && !/SSL certificate error/.test(m.text())) errors.push(m.text()); });
  await page.goto(`https://127.0.0.1:${port}/`);
  await page.click('#start-btn');
  await page.fill('#pair-code', code);
  await page.click('#pair-form button[type=submit]');
  await page.waitForSelector('#st-helper.good');
  await page.waitForSelector('#st-sim.good');
  console.log('paired, helper and mock sim connected');

  await page.click('.tab[data-view=data]');
  await page.waitForFunction(() => document.querySelector('#data-table').textContent.includes('COM1'));
  console.log('live data table:', (await page.textContent('#data-table')).replace(/\s+/g, ' ').slice(0, 120));

  await page.click('.tab[data-view=flight]');
  await page.click('#fp-demo');
  await page.click('#fp-form button[type=submit]');
  await page.waitForSelector('#view-radio.active');
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('Flight plan loaded'));

  const lastAtc = () => page.evaluate(() => [...document.querySelectorAll('.msg.atc .body')].map((e) => e.textContent).pop() || '');
  const tuneAndPress = async (expect) => {
    if (await page.isVisible('#hint-tune')) {
      await page.click('#hint-tune button');
      await page.waitForSelector('#hint-tune', { state: 'hidden' });
    }
    await page.click('#actions button.primary');
    await page.waitForFunction((re) => {
      const last = [...document.querySelectorAll('.msg.atc .body')].map((e) => e.textContent).pop() || '';
      return new RegExp(re).test(last);
    }, expect, { timeout: 8000 });
    console.log('ATC:', await lastAtc());
  };
  await tuneAndPress('cleared to XARR');
  await tuneAndPress('readback correct');
  await tuneAndPress('push and start approved');
  await page.click('#actions button.primary'); // read back pushback (no ATC reply expected)
  await page.waitForFunction(() => document.querySelector('#actions button.primary')?.textContent.includes('taxi'));
  await tuneAndPress('taxi to holding point');
  await page.click('#actions button.primary'); // readback taxi
  // typed input path: the mock aircraft taxis to the runway (follows ATC); skip to the holding point
  await page.click('.tab[data-view=data]');
  await page.click('[data-mock=next]'); // taxi -> holding
  await page.click('.tab[data-view=radio]');
  await page.fill('#type-input', 'holding point runway 27');
  await page.click('#type-form button');
  await page.waitForFunction(() => /contact Demo Tower/.test([...document.querySelectorAll('.msg.atc .body')].map((e) => e.textContent).pop() || ''));
  console.log('ATC:', await lastAtc());
  await page.click('#actions button.primary'); // readback 118.7
  await tuneAndPress('cleared for take-off');
  await page.click('#actions button.primary'); // readback take-off, mock starts the take-off roll
  await page.waitForFunction(() => /contact Demo Departure/.test([...document.querySelectorAll('.msg.atc .body')].map((e) => e.textContent).pop() || ''), null, { timeout: 30000 });
  console.log('ATC:', await lastAtc());
  await page.click('#actions button.primary'); // readback departure frequency
  await tuneAndPress('radar contact');
  await page.screenshot({ path: join(dataDir, 'radio.png') });
  console.log('screenshot:', join(dataDir, 'radio.png'));

  // reload: the flight survives
  await page.reload();
  await page.click('#start-btn');
  await page.waitForSelector('#st-helper.good');
  const phase = await page.textContent('#st-phase');
  if (!/Departure/.test(phase)) fail(`phase after reload is "${phase}"`);
  await page.setViewportSize({ width: 820, height: 1180 }); // iPad portrait
  await page.screenshot({ path: join(dataDir, 'portrait.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) fail('portrait layout scrolls sideways');
  if (errors.length) fail(`browser errors: ${errors.join(' | ')}`);
  await browser.close();
  console.log('E2E OK');
}

let pageRef = null;
main().then(() => { helper.kill(); process.exit(0); }, async (err) => {
  console.error(err.message);
  if (pageRef) console.error('--- log ---\n' + await pageRef.evaluate(() => [...document.querySelectorAll('.msg')].map((m) => m.textContent).join('\n')).catch(() => ''));
  helper.kill(); process.exit(1);
});
