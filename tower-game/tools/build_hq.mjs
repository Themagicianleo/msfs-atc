// Turns data/osm/<ICAO>.json (OpenStreetMap extracts) into the game's
// detailed airports data/hq/<ICAO>.json and prints a quality report:
//   node tools/build_hq.mjs [ICAO ...]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFromOsm, packLayout, unpackLayout } from '../js/osm.js';
import { route } from '../js/layout.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OSM = join(ROOT, 'data', 'osm');
const OUT = join(ROOT, 'data', 'hq');

export function report(L) {
  const g = L.graph;
  const names = new Set(g.edges.filter((e) => e.kind === 'twy').map((e) => e.name).filter(Boolean));
  const problems = [];
  const ends = L.runways.flatMap((r) => [r.identA, r.identB]);
  for (const end of ends) {
    if (!L.holdPoints[end]) problems.push(`no departure entry for runway ${end}`);
    if (!(L.exits[end] || []).length) problems.push(`no exits for landings on ${end}`);
  }
  // sample stands: can they reach every runway entry, and every exit reach them?
  // (every stand when there are one-way lanes: a stand can become unreachable)
  const sample = L.flowReport?.length ? L.gates : L.gates.filter((_, i) => i % Math.max(1, Math.floor(L.gates.length / 12)) === 0);
  let routes = 0; let failed = 0;
  for (const gate of sample) {
    for (const end of ends) {
      if (!L.holdPoints[end]) continue;
      routes += 1;
      if (!route(L, gate.lane, L.holdPoints[end].h)) { failed += 1; problems.push(`stand ${gate.id} cannot reach runway ${end}`); }
    }
    for (const end of ends) {
      const ex = (L.exits[end] || [])[0];
      if (!ex) continue;
      routes += 1;
      if (!route(L, ex.t, gate.node)) { failed += 1; problems.push(`exit ${ex.name} (${end}) cannot reach stand ${gate.id}`); }
    }
  }
  return {
    runways: L.runways.map((r) => `${r.id} ${Math.round(r.len)}m`), taxiways: names.size, nodes: g.nodes.length,
    edges: g.edges.length, stands: L.gates.length, holds: g.nodes.filter((n) => n.kind === 'hold').length,
    crossings: g.nodes.filter((n) => n.kind === 'rwyx').length,
    exits: Object.fromEntries(ends.map((e) => [e, (L.exits[e] || []).map((x) => `${x.name}@${Math.round(x.along)}`).join(' ')])),
    entries: Object.fromEntries(ends.map((e) => [e, L.holdPoints[e] ? (L.holdPoints[e].name || '(unnamed)') : 'NONE'])),
    oneWayBays: L.flowReport?.length ? L.flowReport : undefined,
    routesChecked: routes, routesFailed: failed, problems: [...new Set(problems)].slice(0, 30),
  };
}

function main(codes) {
  mkdirSync(OUT, { recursive: true });
  const list = codes.length ? codes : readdirSync(OSM).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  for (const icao of list) {
    const metaPath = join(ROOT, 'data', 'traffic', `${icao}.json`);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')).meta : { icao };
    const osm = JSON.parse(readFileSync(join(OSM, `${icao}.json`), 'utf8'));
    const t0 = Date.now();
    const L = layoutFromOsm(osm, { icao, ...meta });
    const packed = packLayout(L);
    writeFileSync(join(OUT, `${icao}.json`), JSON.stringify(packed));
    const back = unpackLayout(packed);
    console.log(icao, `${Date.now() - t0} ms`, JSON.stringify(report(back), null, 1));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
