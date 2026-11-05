import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unpackLayout } from '../js/osm.js';
import { route } from '../js/layout.js';
import { edgeGroups } from '../js/render.js';
import { simplify } from '../js/scene3d.js';

const L = unpackLayout(JSON.parse(readFileSync(new URL('../data/hq/ZBAD.json', import.meta.url))));
const g = L.graph;

// a plain Dijkstra (no heuristic) to check the faster search against
function shortest(from, to) {
  const dist = new Map([[from, 0]]);
  const todo = [[0, from]];
  while (todo.length) {
    todo.sort((a, b) => a[0] - b[0]);
    const [d, u] = todo.shift();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === to) return d;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei];
      if (e.kind === 'runway') continue;
      if ((e.dir === 1 && e.a !== u) || (e.dir === -1 && e.b !== u)) continue;
      const v = e.a === u ? e.b : e.a;
      const k = g.nodes[v].kind;
      if (v !== to && (k === 'rwy' || k === 'gate')) continue;
      if (d + e.len < (dist.get(v) ?? Infinity)) { dist.set(v, d + e.len); todo.push([d + e.len, v]); }
    }
  }
  return null;
}
const length = (nodes) => nodes.slice(1).reduce((s, n, i) => {
  const u = nodes[i];
  const e = g.adj[u].map((k) => g.edges[k]).filter((x) => (x.a === u && x.b === n) || (x.b === u && x.a === n)).sort((a, b) => a.len - b.len)[0];
  return s + e.len;
}, 0);

test('the faster route search finds the shortest route (same length as a plain Dijkstra)', () => {
  const holds = Object.values(L.holdPoints).map((h) => h.h);
  const exits = Object.values(L.exits).filter((x) => x.length).map((x) => x[0].t);
  const pairs = [];
  for (const stand of L.gates.filter((_, i) => i % 17 === 0)) {
    pairs.push([stand.lane, holds[pairs.length % holds.length]]);
    pairs.push([exits[pairs.length % exits.length], stand.node]);
  }
  assert.ok(pairs.length >= 10);
  for (const [from, to] of pairs) {
    const r = route(L, from, to);
    const want = shortest(from, to);
    assert.ok(r, `no route ${from} -> ${to}`);
    assert.ok(Math.abs(length(r) - want) < 0.5, `${from} -> ${to}: ${length(r).toFixed(1)} m, the shortest is ${want.toFixed(1)} m`);
  }
});

test('the map draws merged polylines: every segment is in exactly one, in order', () => {
  const groups = edgeGroups(L);
  for (const k of ['twy', 'lane', 'stand', 'line', 'standLine']) {
    const segments = groups[`${k}Chains`].reduce((s, c) => s + c.pts.length - 1, 0);
    assert.equal(segments, groups[k].length, `${k}: every segment appears once`);
    assert.ok(groups[`${k}Chains`].length < groups[k].length / 2 || groups[k].length < 50, `${k}: segments are merged into longer paths`);
  }
  // consecutive points of a chain are joined by a real segment
  const byPair = new Set(g.edges.map((e) => `${e.a}>${e.b}`).concat(g.edges.map((e) => `${e.b}>${e.a}`)));
  const at = new Map(g.nodes.map((n) => [n.p, n.id]));
  for (const ch of edgeGroups(L).twyChains.slice(0, 200)) {
    for (let i = 1; i < ch.pts.length; i += 1) assert.ok(byPair.has(`${at.get(ch.pts[i - 1])}>${at.get(ch.pts[i])}`));
  }
});

test('simplify keeps the ends and stays within the tolerance', () => {
  const arc = Array.from({ length: 60 }, (_, i) => [Math.cos(i / 20) * 300, Math.sin(i / 20) * 300]);
  const out = simplify(arc, 3);
  assert.deepEqual(out[0], arc[0]);
  assert.deepEqual(out.at(-1), arc.at(-1));
  assert.ok(out.length < arc.length / 2 && out.length > 5, `${out.length} points`);
  // every original point is within 3 m of the simplified line
  const near = (p) => Math.min(...out.slice(1).map((b, i) => {
    const a = out[i]; const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }));
  for (const p of arc) assert.ok(near(p) <= 3.01, `${near(p)} m off`);
  assert.deepEqual(simplify([[0, 0], [1, 1]], 3), [[0, 0], [1, 1]]);
});
