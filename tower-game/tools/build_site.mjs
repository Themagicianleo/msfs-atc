// Copies the playable site into an output folder (default ../_site), leaving
// out tests, tools and raw data, then checks that every file the page and the
// service worker refer to is really there. Used by the GitHub Pages workflow
// and by the end-to-end test, so both see exactly the same site.
//   node tools/build_site.mjs [outDir]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['tests', 'tools', 'node_modules', 'package.json', 'package-lock.json', 'README.md', '.gitignore']);

export function buildSite(out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(ROOT)) {
    if (SKIP.has(name)) continue;
    cpSync(join(ROOT, name), join(out, name), { recursive: true });
  }
  // raw OpenStreetMap extracts are only needed to build data/hq
  for (const f of existsSync(join(out, 'data', 'osm')) ? readdirSync(join(out, 'data', 'osm')) : []) {
    if (f.endsWith('.json')) rmSync(join(out, 'data', 'osm', f));
  }
  return checkSite(out);
}

// every local file index.html links to, every module import, and the
// service worker's list must exist in the built site
export function checkSite(out) {
  const missing = [];
  const need = (rel, from) => { if (!existsSync(join(out, rel))) missing.push(`${rel} (from ${from})`); };
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"#?:]+)"/g)) need(m[1], 'index.html');
  const sw = readFileSync(join(out, 'sw.js'), 'utf8');
  for (const m of sw.match(/SHELL = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)) if (m[1] !== './') need(m[1], 'sw.js');
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (!existsSync(join(out, rel))) { missing.push(`${rel} (import)`); return; }
    const src = readFileSync(join(out, rel), 'utf8');
    for (const m of src.matchAll(/(?:from |import\()'(\.[^']+)'/g)) walk(join(dirname(rel), m[1]).replace(/\\/g, '/'));
  };
  walk('js/app.js');
  if (missing.length) throw new Error(`site is missing files:\n  ${missing.join('\n  ')}`);
  return { files: seen.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] || join(ROOT, '..', '_site'));
  const r = buildSite(out);
  console.log(`site built in ${out} (${r.files} modules checked)`);
}
