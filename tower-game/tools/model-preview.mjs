// node tools/model-preview.mjs A320 [iso|top|side] out.png : draws a model and prints its box
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 26100 + Math.floor(Math.random() * 90);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://127.0.0.1:${port}/tools/model-preview.html?m=${process.argv[2] || 'A320'}&v=${process.argv[3] || 'iso'}`);
await page.waitForFunction('window.done', null, { timeout: 30000 });
console.log(JSON.stringify(await page.evaluate('window.info')));
if (process.argv[4]) await page.screenshot({ path: process.argv[4] });
await browser.close(); server.kill();
