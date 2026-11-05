// Canvas drawing of the airport map and traffic, with pan, zoom and tap.

import { M_PER_NM, add, dist, fromHeading, mul, perp, sub, norm } from './geo.js';
import { endGeometry } from './layout.js';
import { destinationPoint, taxiDestination } from './world.js';

// radar-style (dark) and airport-diagram style ("chart") colours
const DARK = {
  bg: '#0b0b0d', runway: '#30343b', runwayEdge: '#5b616b', centre: '#e9edf2', building: '#252b33',
  twy: '#272c33', lane: '#222730', twyLine: '#c9a227', apron: '#1a2026', terminal: '#3c4756', hold: '#e5484d',
  arr: '#0a84ff', dep: '#ff9f0a', sel: '#ffffff', req: '#ffd60a', text: '#ffffff', muted: 'rgba(235,235,245,.6)',
  final: 'rgba(10,132,255,0.45)', route: 'rgba(255,255,255,0.55)', conflict: '#ff4d4f',
  labelBg: 'rgba(13,23,18,0.75)', labelText: '#e9c46a', labelEdge: 'rgba(233,196,106,0.5)',
};
const CHART = {
  bg: '#f4f1e8', runway: '#1d1d1f', runwayEdge: '#000000', centre: '#ffffff', building: '#a9a39a',
  twy: '#c9c4b8', lane: '#d8d3c7', twyLine: '#8a7a3a', apron: '#e2ddd0', terminal: '#8f8a80', hold: '#d00000',
  arr: '#0067c0', dep: '#c25b00', sel: '#000000', req: '#b8860b', text: '#1d1d1f', muted: '#5a5a5a',
  final: 'rgba(0,103,192,0.45)', route: 'rgba(0,0,0,0.6)', conflict: '#d00000',
  labelBg: '#ffd400', labelText: '#000000', labelEdge: '#000000',
};
// EFB light appearance (Apple system colours)
const LIGHT = {
  bg: '#e5e5ea', runway: '#3a3a3c', runwayEdge: '#1c1c1e', centre: '#ffffff', building: '#c7c7cc',
  twy: '#c7c7cc', lane: '#d1d1d6', twyLine: '#b25000', apron: '#d8d8de', terminal: '#aeaeb2', hold: '#d70015',
  arr: '#007aff', dep: '#c77c02', sel: '#000000', req: '#ff9500', text: '#1c1c1e', muted: 'rgba(60,60,67,.6)',
  final: 'rgba(0,122,255,0.45)', route: 'rgba(0,0,0,0.55)', conflict: '#d70015',
  labelBg: 'rgba(255,255,255,0.85)', labelText: '#b25000', labelEdge: 'rgba(178,80,0,0.45)',
};
let C = DARK;

// the layout's segments sorted by how they are drawn (done once per layout)
function edgeGroups(L) {
  if (!L._edgeGroups) {
    const groups = { twy: [], lane: [], stand: [], line: [], standLine: [] };
    for (const e of L.graph.edges) {
      if (e.kind === 'runway') continue;
      if (e.kind === 'stand') { groups.stand.push(e); groups.standLine.push(e); continue; }
      (e.kind === 'lane' ? groups.lane : groups.twy).push(e);
      groups.line.push(e);
    }
    L._edgeGroups = groups;
  }
  return L._edgeGroups;
}

const SHORT = {
  final: 'FINAL', rollout: 'LAND', vacated: 'VACATED', taxi_in: 'TAXI IN', parked: 'PARKED',
  gate: 'STAND', pushback: 'PUSH', pushed: 'READY TAXI', taxi_out: 'TAXI', holding: 'HOLDING',
  lineup: 'LINE UP', lined_up: 'LINED UP', takeoff: 'T/O ROLL', climb: 'CLIMB', go_around: 'GO AROUND',
};

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cx: 0, cy: 0, s: 0.2 };
    this.pointers = new Map();
    this.onTap = null;
    this.bindInput();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.cv.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cache = null;
  }

  // fit the whole airport (and a bit of the final approach) on screen
  fit(layout) {
    const pts = layout.runways.flatMap((r) => [r.a, r.b]).concat(layout.terminal || [], ...(layout.aprons || []));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    this.view.cx = (minX + maxX) / 2;
    this.view.cy = (minY + maxY) / 2;
    this.view.s = Math.min(this.w / ((maxX - minX) * 1.25 || 1), this.h / ((maxY - minY) * 1.25 || 1));
  }

  toScreen(p) {
    return [this.w / 2 + (p[0] - this.view.cx) * this.view.s, this.h / 2 - (p[1] - this.view.cy) * this.view.s];
  }

  toWorld(q) {
    return [this.view.cx + (q[0] - this.w / 2) / this.view.s, this.view.cy - (q[1] - this.h / 2) / this.view.s];
  }

  zoomAt(q, factor) {
    const before = this.toWorld(q);
    this.view.s = Math.max(0.005, Math.min(4, this.view.s * factor));
    const after = this.toWorld(q);
    this.view.cx += before[0] - after[0];
    this.view.cy += before[1] - after[1];
  }

  bindInput() {
    const cv = this.cv;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt([e.offsetX, e.offsetY], Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY, t: performance.now() });
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) {
        this.view.cx -= (e.offsetX - p.x) / this.view.s;
        this.view.cy += (e.offsetY - p.y) / this.view.s;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.offsetX; p.y = e.offsetY;
        const after = Math.hypot(a.x - b.x, a.y - b.y);
        if (before > 10) this.zoomAt([(a.x + b.x) / 2, (a.y + b.y) / 2], after / before);
        return;
      }
      p.x = e.offsetX; p.y = e.offsetY;
    });
    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (p && Math.hypot(e.offsetX - p.x0, e.offsetY - p.y0) < 8 && performance.now() - p.t < 500) {
        this.onTap?.(this.toWorld([e.offsetX, e.offsetY]), [e.offsetX, e.offsetY]);
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
  }

  // aircraft nearest to a screen point (within 36 px)
  pick(world, q) {
    let best = null;
    for (const ac of world.ac) {
      const s = this.toScreen(ac.p);
      const d = Math.hypot(s[0] - q[0], s[1] - q[1]);
      if (d < 36 && (!best || d < best.d)) best = { ac, d };
    }
    return best?.ac || null;
  }

  // ---------------------------------------------------------------- drawing
  line(a, b, width, color, dash = null) {
    const c = this.ctx;
    const p = this.toScreen(a);
    const q = this.toScreen(b);
    c.beginPath();
    c.moveTo(p[0], p[1]);
    c.lineTo(q[0], q[1]);
    c.lineWidth = width;
    c.strokeStyle = color;
    c.setLineDash(dash || []);
    c.stroke();
    c.setLineDash([]);
  }

  poly(pts, fill, stroke) {
    const c = this.ctx;
    c.beginPath();
    pts.forEach((p, i) => { const s = this.toScreen(p); if (i) c.lineTo(s[0], s[1]); else c.moveTo(s[0], s[1]); });
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1; c.stroke(); }
  }

  text(str, p, { color = C.text, size = 12, align = 'center', bold = false, dx = 0, dy = 0 } = {}) {
    const c = this.ctx;
    const s = this.toScreen(p);
    c.font = `${bold ? '600 ' : ''}${size}px -apple-system, system-ui, sans-serif`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.fillStyle = color;
    c.fillText(str, s[0] + dx, s[1] + dy);
  }

  // everything that does not move: the background, runways, taxiways, labels and stands
  drawBase(world) {
    const c = this.ctx;
    const L = world.L;
    const s = this.view.s;
    c.fillStyle = C.bg;
    c.fillRect(0, 0, this.w, this.h);

    // final approach course of the arrival runway, with mile marks
    const fin = endGeometry(L, world.arrEnd);
    if (fin) {
      const far = sub(fin.thr, mul(fin.dir, 11 * M_PER_NM));
      this.line(fin.thr, far, 1, C.final, [8, 6]);
      for (let nm = 2; nm <= 10; nm += 2) {
        const p = sub(fin.thr, mul(fin.dir, nm * M_PER_NM));
        const n = mul(perp(fin.dir), 220);
        this.line(add(p, n), sub(p, n), 1, C.final);
        if (s > 0.02) this.text(`${nm}`, add(p, mul(perp(fin.dir), 450)), { color: C.muted, size: 11 });
      }
    }

    for (const ring of L.aprons || [L.apron].filter(Boolean)) this.poly(ring, C.apron);
    for (const ring of L.buildings || []) this.poly(ring, C.building);
    for (const ring of L.real ? L.terminals : [L.terminal].filter(Boolean)) this.poly(ring, C.terminal);

    // taxiways under runways: one stroke per kind (the layout has thousands of segments)
    const g = L.graph;
    const groups = edgeGroups(L);
    this.strokeEdges(g, groups.twy, Math.max(2, 23 * s), C.twy);
    this.strokeEdges(g, groups.lane, Math.max(2, 15 * s), C.lane);
    this.strokeEdges(g, groups.stand, Math.max(2, 8 * s), C.twy);
    this.strokeEdges(g, groups.line, 1, C.twyLine);
    if (s >= 0.3) this.strokeEdges(g, groups.standLine, 1, C.twyLine);

    for (const r of L.runways) {
      const n = mul(perp(r.dir), r.width / 2);
      this.poly([add(r.a, n), add(r.b, n), sub(r.b, n), sub(r.a, n)], C.runway, C.runwayEdge);
      this.line(add(r.a, mul(r.dir, 80)), sub(r.b, mul(r.dir, 80)), Math.max(1, 1.2 * s), C.centre, [Math.max(4, 30 * s), Math.max(4, 20 * s)]);
      // threshold bars
      for (const [p, d] of [[r.a, r.dir], [r.b, mul(r.dir, -1)]]) this.line(add(p, n), sub(p, n), Math.max(2, 4 * s), C.centre);
      this.text(r.identA, add(r.a, mul(r.dir, -90)), { bold: true, size: 13, color: C.text });
      this.text(r.identB, add(r.b, mul(r.dir, 90)), { bold: true, size: 13, color: C.text });
    }

    // holding points (red bars) and taxiway names
    if (s > 0.05) {
      for (const nd of g.nodes) {
        if (nd.kind !== 'hold') continue;
        const r = L.runways.find((x) => x.id === nd.runway);
        if (!r) continue;
        const d = mul(r.dir, 18);
        this.line(add(nd.p, d), sub(nd.p, d), Math.max(2, 4 * s), C.hold);
        if (s > 0.2 && nd.name) this.text(nd.name, nd.p, { color: C.hold, size: 10, dy: -10 });
      }
    }
    if (L.taxiLabels) {
      this.drawTaxiLabels(L.taxiLabels, s);
      if (s > 0.28) {
        // stands without a number in OpenStreetMap: drawn, never used for traffic
        const c = this.ctx;
        c.strokeStyle = C.muted;
        c.lineWidth = 1;
        for (const p of L.otherStands || []) {
          const q = this.toScreen(p);
          c.beginPath();
          c.arc(q[0], q[1], 3, 0, Math.PI * 2);
          c.stroke();
        }
        for (const gate of L.gates) this.text(gate.id, g.nodes[gate.node].p, { color: C.muted, size: 10, dy: 12 });
      }
    } else if (s > 0.05) {
      const named = new Set();
      for (const e of g.edges) {
        if (e.kind !== 'twy' && e.kind !== 'link') continue;
        if (named.has(e.name) && s < 0.25) continue;
        named.add(e.name);
        const mid = mul(add(g.nodes[e.a].p, g.nodes[e.b].p), 0.5);
        this.text(e.name, mid, { color: C.twyLine, size: 11, bold: true });
      }
      if (s > 0.3) for (const gate of L.gates) this.text(gate.id, g.nodes[gate.node].p, { color: C.muted, size: 10, dy: 14 });
    }
  }

  // The map under the aircraft is drawn once into a hidden canvas and copied
  // every frame; it is drawn again only when the view, theme or runways change
  // (while panning or zooming the old picture is moved and scaled, then
  // sharpened when the gesture settles).
  paintBase(world) {
    const v = this.view;
    const c = this.ctx;
    const key = `${this.chart ? 'chart' : this.theme}|${this.w}x${this.h}|${world.arrEnd}`;
    const vk = `${v.cx}|${v.cy}|${v.s}`;
    const now = performance.now();
    if (vk !== this.lastViewKey) { this.lastViewKey = vk; this.viewChangedAt = now; }
    let cache = this.cache;
    const sameWorld = cache && cache.L === world.L && cache.key === key;
    const k = sameWorld ? v.s / cache.s : 0;
    const exact = sameWorld && cache.vk === vk;
    if (!exact && (!sameWorld || now - this.viewChangedAt > 120 || k < 0.6 || k > 1.7)) {
      if (!this.off) this.off = document.createElement('canvas');
      this.off.width = this.cv.width;
      this.off.height = this.cv.height;
      const octx = this.off.getContext('2d');
      const dpr = this.cv.width / this.w;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx = octx;
      this.drawBase(world);
      this.ctx = c;
      cache = this.cache = { L: world.L, key, vk, cx: v.cx, cy: v.cy, s: v.s };
    } else if (!exact) {
      // stale picture, moved to where it belongs
      c.fillStyle = C.bg;
      c.fillRect(0, 0, this.w, this.h);
      const x0 = this.w / 2 - (this.w / 2) * k + (cache.cx - v.cx) * v.s;
      const y0 = this.h / 2 - (this.h / 2) * k - (cache.cy - v.cy) * v.s;
      c.drawImage(this.off, 0, 0, this.off.width, this.off.height, x0, y0, this.w * k, this.h * k);
      return;
    }
    c.drawImage(this.off, 0, 0, this.off.width, this.off.height, 0, 0, this.w, this.h);
  }

  // one path for many segments, skipping those off screen
  strokeEdges(g, edges, width, color) {
    const c = this.ctx;
    const m = width + 4;
    c.beginPath();
    for (const e of edges) {
      const p = this.toScreen(g.nodes[e.a].p);
      const q = this.toScreen(g.nodes[e.b].p);
      if ((p[0] < -m && q[0] < -m) || (p[0] > this.w + m && q[0] > this.w + m) || (p[1] < -m && q[1] < -m) || (p[1] > this.h + m && q[1] > this.h + m)) continue;
      c.moveTo(p[0], p[1]);
      c.lineTo(q[0], q[1]);
    }
    c.lineWidth = width;
    c.strokeStyle = color;
    c.lineJoin = 'round';
    c.stroke();
  }

  draw(world, { selectedId = null, now = 0, plan = null } = {}) {
    C = this.chart ? CHART : (this.theme === 'light' ? LIGHT : DARK);
    this.metric = !!world.metric;
    const c = this.ctx;
    const L = world.L;
    const s = this.view.s;
    const g = L.graph;
    this.paintBase(world);

    // selected aircraft route
    const sel = world.ac.find((a) => a.id === selectedId);
    if (sel?.path && ['taxi_out', 'taxi_in', 'pushback', 'lineup', 'rollout'].includes(sel.state)) {
      const pts = [sel.p, ...sel.path.pts.filter((q, i) => sel.path.cum[i] > sel.ps)];
      for (let i = 1; i < pts.length; i += 1) this.line(pts[i - 1], pts[i], 2, C.route, [6, 5]);
      for (const cr of sel.crossings.filter((x) => !x.cleared && x.at > sel.ps)) {
        this.text('HOLD SHORT', sel.path.at(cr.at).p, { color: C.hold, size: 11, bold: true });
      }
    }

    if (plan) this.drawPlan(plan, world);
    // where the selected aircraft is going
    if (sel) {
      const dest = taxiDestination(sel);
      const p = destinationPoint(world.L, dest);
      if (p) {
        const q = this.toScreen(p);
        const c = this.ctx;
        c.save();
        c.strokeStyle = C.req; c.lineWidth = 2; c.setLineDash([4, 3]);
        c.beginPath(); c.arc(q[0], q[1], 11, 0, Math.PI * 2); c.stroke();
        c.restore();
        this.text(dest.short, p, { color: C.req, size: 12, bold: true, dy: -16 });
      }
    }
    for (const ac of world.ac) this.drawAircraft(ac, ac.id === selectedId, now);
  }

  // the route being chosen on the map: thick line, the end, runway crossings
  drawPlan(plan, world) {
    const c = this.ctx;
    const pts = plan.points.map((p) => this.toScreen(p));
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = 'rgba(255,214,10,0.35)'; c.lineWidth = 10;
    c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.stroke();
    c.strokeStyle = C.req; c.lineWidth = 3;
    c.stroke();
    const end = pts[pts.length - 1];
    c.fillStyle = C.req;
    c.beginPath(); c.arc(end[0], end[1], 7, 0, Math.PI * 2); c.fill();
    c.restore();
    const g = world.L.graph;
    for (const id of plan.nodes) {
      const nd = g.nodes[id];
      if (nd.kind === 'rwyx') this.text('X', nd.p, { color: C.hold, size: 12, bold: true });
    }
  }

  // chart-style taxiway name boxes, skipping any that would overlap
  drawTaxiLabels(labels, s) {
    const c = this.ctx;
    const boxes = [];
    const minLane = this.chart ? 0.35 : 0.5;
    c.font = '700 11px -apple-system, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const l of labels) {
      // only real designators (A, B2, WA, M12); OSM descriptive names stay off the chart
      if (!/^[A-Z]{1,3}\d{0,3}[A-Z]?$/.test(l.name)) continue;
      if (l.lane && s < minLane) continue;
      if (!l.lane && s < 0.04) continue;
      const q = this.toScreen(l.p);
      if (q[0] < -20 || q[1] < -20 || q[0] > this.w + 20 || q[1] > this.h + 20) continue;
      const w = c.measureText(l.name).width + 8;
      const box = [q[0] - w / 2, q[1] - 8, w, 16];
      if (boxes.some((b) => b[0] < box[0] + box[2] + 2 && box[0] < b[0] + b[2] + 2 && b[1] < box[1] + box[3] + 2 && box[1] < b[1] + b[3] + 2)) continue;
      boxes.push(box);
      c.fillStyle = C.labelBg;
      c.fillRect(...box);
      c.strokeStyle = C.labelEdge;
      c.lineWidth = 1;
      c.strokeRect(...box);
      c.fillStyle = C.labelText;
      c.fillText(l.name, q[0], q[1] + 0.5);
    }
  }

  drawAircraft(ac, selected, now) {
    const c = this.ctx;
    const s = this.view.s;
    const color = ac.kind === 'arr' ? C.arr : C.dep;
    const size = Math.max(9, (ac.type.span || 36) * 1.1 * s); // to scale, at least 9 px
    const p = this.toScreen(ac.p);
    const f = fromHeading(ac.hdg);
    const dir = [f[0], -f[1]]; // screen y points down
    const side = [-dir[1], dir[0]];
    const pt = (along, across) => [p[0] + dir[0] * along * size + side[0] * across * size,
      p[1] + dir[1] * along * size + side[1] * across * size];
    const shape = [pt(0.5, 0), pt(0.05, 0.08), pt(0, 0.5), pt(-0.1, 0.5), pt(-0.12, 0.08), pt(-0.38, 0.06),
      pt(-0.45, 0.2), pt(-0.5, 0.2), pt(-0.48, 0), pt(-0.5, -0.2), pt(-0.45, -0.2), pt(-0.38, -0.06),
      pt(-0.12, -0.08), pt(-0.1, -0.5), pt(0, -0.5), pt(0.05, -0.08)];
    c.beginPath();
    shape.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])));
    c.closePath();
    c.fillStyle = color;
    c.globalAlpha = ac.state === 'parked' ? 0.5 : 1;
    c.fill();
    c.globalAlpha = 1;
    if (selected) { c.strokeStyle = C.sel; c.lineWidth = 2; c.stroke(); }
    if (ac.req && Math.floor(now / 500) % 2 === 0) {
      c.beginPath();
      c.arc(p[0], p[1], size * 0.75 + 4, 0, Math.PI * 2);
      c.strokeStyle = C.req;
      c.lineWidth = 2;
      c.stroke();
    }
    // data tag
    const kt = Math.round(ac.v / 0.514444);
    let info = SHORT[ac.state] || ac.state;
    const m = this.metric;
    if (ac.state === 'final') info += m ? ` ${(ac.dist / 1000).toFixed(1)}km` : ` ${(ac.dist / M_PER_NM).toFixed(1)}NM`;
    if (ac.state === 'final' && ac.cleared.land) info += ' CLR';
    else if (ac.state !== 'final' && kt > 2) info += m ? ` ${Math.round(ac.v * 3.6)}km/h` : ` ${kt}kt`;
    if (ac.alt > 50) info += m ? ` ${Math.round(ac.alt * 0.3048 / 10) * 10}m` : ` ${Math.round(ac.alt / 100) * 100}ft`;
    if (ac.hold) info += ' HOLD';
    const dest = taxiDestination(ac);
    if (dest) info += ` → ${dest.short}`;
    if (ac.blockedBy) info += ' WAIT';
    const lx = p[0] + size * 0.6 + 6;
    const ly = p[1] - size * 0.6 - 6;
    c.strokeStyle = 'rgba(230,233,237,0.35)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(lx - 2, ly + 4); c.stroke();
    c.font = '600 13px -apple-system, system-ui, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = selected ? C.sel : color;
    c.fillText(ac.callsign, lx, ly);
    c.font = '11px -apple-system, system-ui, sans-serif';
    c.fillStyle = C.text;
    c.fillText(`${ac.type.code} ${info}`, lx, ly + 14);
  }
}

export { SHORT as STATE_LABELS, dist, norm };
