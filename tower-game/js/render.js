// Canvas drawing of the airport map and traffic, with pan, zoom and tap.

import { M_PER_NM, add, dist, fromHeading, mul, perp, sub, norm } from './geo.js';
import { endGeometry } from './layout.js';

const C = {
  bg: '#0d1712', grass: '#102018', runway: '#30343b', runwayEdge: '#5b616b', centre: '#e9edf2',
  twy: '#272c33', twyLine: '#c9a227', apron: '#1f252c', terminal: '#3c4756', hold: '#e5484d',
  arr: '#4fc3f7', dep: '#ffb454', sel: '#ffffff', req: '#ffe066', text: '#e6e9ed', muted: '#8d99a6',
  final: 'rgba(79,195,247,0.35)', route: 'rgba(255,255,255,0.55)', conflict: '#ff4d4f',
};

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
  }

  // fit the whole airport (and a bit of the final approach) on screen
  fit(layout) {
    const pts = layout.runways.flatMap((r) => [r.a, r.b]).concat(layout.terminal || []);
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

  draw(world, { selectedId = null, now = 0 } = {}) {
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

    if (L.apron) this.poly(L.apron, C.apron);
    if (L.terminal) this.poly(L.terminal, C.terminal);

    // taxiways under runways
    const g = L.graph;
    for (const e of g.edges) {
      if (e.kind === 'runway') continue;
      const a = g.nodes[e.a].p;
      const b = g.nodes[e.b].p;
      const w = e.kind === 'stand' ? 10 : 23;
      this.line(a, b, Math.max(2, w * s), C.twy);
    }
    for (const e of g.edges) {
      if (e.kind === 'runway') continue;
      this.line(g.nodes[e.a].p, g.nodes[e.b].p, 1, C.twyLine);
    }

    for (const r of L.runways) {
      const n = mul(perp(r.dir), r.width / 2);
      this.poly([add(r.a, n), add(r.b, n), sub(r.b, n), sub(r.a, n)], C.runway, C.runwayEdge);
      this.line(add(r.a, mul(r.dir, 80)), sub(r.b, mul(r.dir, 80)), Math.max(1, 1.2 * s), C.centre, [Math.max(4, 30 * s), Math.max(4, 20 * s)]);
      this.text(r.identA, add(r.a, mul(r.dir, -90)), { bold: true, size: 13 });
      this.text(r.identB, add(r.b, mul(r.dir, 90)), { bold: true, size: 13 });
    }

    // holding points (red bars) and taxiway names
    if (s > 0.05) {
      for (const nd of g.nodes) {
        if (nd.kind !== 'hold') continue;
        const r = L.runways.find((x) => x.id === nd.runway);
        const d = mul(r.dir, 18);
        this.line(add(nd.p, d), sub(nd.p, d), Math.max(2, 4 * s), C.hold);
        if (s > 0.12) this.text(nd.name, nd.p, { color: C.req, size: 10, dy: -10 });
      }
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

    // selected aircraft route
    const sel = world.ac.find((a) => a.id === selectedId);
    if (sel?.path && ['taxi_out', 'taxi_in', 'pushback', 'lineup', 'rollout'].includes(sel.state)) {
      const pts = [sel.p, ...sel.path.pts.filter((q, i) => sel.path.cum[i] > sel.ps)];
      for (let i = 1; i < pts.length; i += 1) this.line(pts[i - 1], pts[i], 2, C.route, [6, 5]);
      for (const cr of sel.crossings.filter((x) => !x.cleared && x.at > sel.ps)) {
        this.text('HOLD SHORT', sel.path.at(cr.at).p, { color: C.hold, size: 11, bold: true });
      }
    }

    for (const ac of world.ac) this.drawAircraft(ac, ac.id === selectedId, now);
  }

  drawAircraft(ac, selected, now) {
    const c = this.ctx;
    const s = this.view.s;
    const color = ac.kind === 'arr' ? C.arr : C.dep;
    const size = Math.max(9, 40 * s); // a 40 m airliner, at least 9 px
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
    if (ac.state === 'final') info += ` ${(ac.dist / M_PER_NM).toFixed(1)}NM${ac.cleared.land ? ' CLR' : ''}`;
    else if (kt > 2) info += ` ${kt}kt`;
    if (ac.hold) info += ' HOLD';
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
