// How heavy is the simulation? node tools/bench-sim.mjs [ICAO] [traffic] [simulated minutes]
// Runs a busy shift with the controller answering everything, and prints the cost of one step (the game steps twice a
// second of game time, more when fast-forwarded), so a slow device's headroom can be judged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { unpackLayout } from '../js/osm.js';
import { World } from '../js/world.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (p) => JSON.parse(readFileSync(join(ROOT, p)));
const code = process.argv[2] || 'ZBAD';
const traffic = process.argv[3] || 'busy';
const minutes = Number(process.argv[4] || 40);
const L = unpackLayout(json(`data/hq/${code}.json`));
const profile = json(`data/traffic/${code}.json`);
const cfg = profile.configs?.[0] || { arr: [L.runways[0].identA], dep: [L.runways[0].identA] };
let s = 21;
const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
const w = new World({ layout: L, phr: json('data/phraseology.json'), phrZh: json('data/phraseology-zh.json'), airlines: json('data/airlines.json'), rng,
  arrEnd: cfg.arr, depEnd: cfg.dep, traffic, wind: { available: true, wind_dir: 170, wind_kt: 8 }, profile, types: json('data/aircraft.json'), events: true });
const steps = [];
let peak = 0;
const t0 = performance.now();
for (let t = 0; t < minutes * 60; t += 0.5) {
  const a = performance.now();
  w.step(0.5);
  steps.push(performance.now() - a);
  w.drain();
  for (const ac of w.ac) {
    if (!ac.req) continue;
    const type = { land: 'land', push: 'push', taxi: 'taxi', takeoff: 'takeoff', taxi_in: 'taxi', cross: 'cross', contact: 'contact' }[ac.req.type];
    if (type && ac.req.t + 8 < w.t) w.command(ac.id, { type });
  }
  for (const ac of w.ac) if (ac.state === 'climb' && !ac.cleared.contact) w.command(ac.id, { type: 'contact' });
  peak = Math.max(peak, w.ac.length);
}
const total = performance.now() - t0;
steps.sort((x, y) => x - y);
const q = (p) => steps[Math.floor(p * (steps.length - 1))].toFixed(3);
console.log(JSON.stringify({ airport: code, traffic, simMinutes: minutes, aircraftPeak: peak, steps: steps.length, totalMs: Math.round(total),
  meanMs: +(steps.reduce((x, y) => x + y, 0) / steps.length).toFixed(3), p50: +q(0.5), p95: +q(0.95), p99: +q(0.99), maxMs: +steps[steps.length - 1].toFixed(2), stats: w.stats }));
