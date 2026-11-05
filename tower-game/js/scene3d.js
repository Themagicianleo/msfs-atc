// 3D views of the airport with three.js (vendored, MIT licence): a tower cab
// view from the control tower and a free orbit camera. Loaded only when a 3D
// view is opened. World coordinates are metres east (x) and north (y); in
// three.js that is x → x, north → −z, altitude → y.

import * as THREE from './vendor/three.module.min.js';
import { STATE_LABELS } from './render.js';
import { M_PER_NM } from './geo.js';

const FT = 0.3048;
const DEG = Math.PI / 180;
const W3 = (p, y = 0) => new THREE.Vector3(p[0], y, -p[1]);

const THEMES = {
  light: { sky: 0xbcd3ea, fog: 0xc9d9ea, grass: 0x86a36c, apron: 0xb9b9bd, twy: 0x8e8e93, lane: 0xa3a3a8, runway: 0x48484c,
    mark: 0xffffff, yellow: 0xe0b100, hold: 0xd70015, terminal: 0xdfe4ea, building: 0xc2bdb4, hemi: [0xffffff, 0x6f7a5c, 1.6], sun: 1.6 },
  dark: { sky: 0x101826, fog: 0x141c2a, grass: 0x1d2a1f, apron: 0x2c2f35, twy: 0x23262c, lane: 0x292c33, runway: 0x18191c,
    mark: 0xd9dde3, yellow: 0xc9a227, hold: 0xe5484d, terminal: 0x4a5566, building: 0x343a44, hemi: [0x9fb4d8, 0x1a2018, 0.9], sun: 0.6 },
};

// a soft, stable colour per airline for the tail (not a livery)
export function tailColour(code = '') {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.62, 0.42);
}

// ------------------------------------------------------------------ geometry helpers
// flat ground triangles in one buffer per material
class Flat {
  constructor() { this.v = []; }
  tri(a, b, c, y) { this.v.push(a[0], y, -a[1], b[0], y, -b[1], c[0], y, -c[1]); }
  // a strip of width w from a to b
  quad(a, b, w, y) {
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * (w / 2); const ny = (dx / l) * (w / 2);
    const p1 = [a[0] + nx, a[1] + ny]; const p2 = [b[0] + nx, b[1] + ny];
    const p3 = [b[0] - nx, b[1] - ny]; const p4 = [a[0] - nx, a[1] - ny];
    this.tri(p1, p4, p3, y); this.tri(p1, p3, p2, y);
  }
  disc(p, r, y, n = 10) {
    for (let i = 0; i < n; i += 1) {
      const a0 = (i / n) * Math.PI * 2; const a1 = ((i + 1) / n) * Math.PI * 2;
      this.tri(p, [p[0] + Math.cos(a1) * r, p[1] + Math.sin(a1) * r], [p[0] + Math.cos(a0) * r, p[1] + Math.sin(a0) * r], y);
    }
  }
  ring(pts, y) {
    const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    if (contour.length > 2 && contour[0].equals(contour[contour.length - 1])) contour.pop();
    if (contour.length < 3) return;
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [i, j, k] of tris) this.tri(pts[i], pts[j], pts[k], y);
  }
  mesh(color, order) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.v, 3));
    g.computeVertexNormals();
    // ground layers never fight: drawn in order, no depth writes
    const m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = order;
    return mesh;
  }
}

function textPlane(text, height, color = '#ffffff') {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = color;
  c.font = 'bold 110px -apple-system, system-ui, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 128, 70);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(height * 2, height), m);
  mesh.renderOrder = 6;
  return mesh;
}

// extruded footprint, height h
function block(ring, h, material) {
  const pts = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  if (pts.length > 2 && pts[0].equals(pts[pts.length - 1])) pts.pop();
  if (pts.length < 3) return null;
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return new THREE.Mesh(g, material);
}

// ------------------------------------------------------------------ low-poly aircraft
// built from the type's real length and span, nose along +x, wheels at y = 0
const FOUR_ENGINES = new Set(['A388', 'B748', 'B744', 'A343', 'A346']);
const BODY = new THREE.MeshLambertMaterial({ color: 0xf2f4f7 });
const GREY = new THREE.MeshLambertMaterial({ color: 0x9aa0a8 });
const GLASS = new THREE.MeshLambertMaterial({ color: 0x1c2733 });
const geoCache = new Map();

function wingShape(rootX, root, tip, half, sweep) {
  // in x (along the body) / y (spanwise) plane
  const s = new THREE.Shape();
  const tipX = rootX - Math.tan(sweep) * half;
  s.moveTo(rootX, 0);
  s.lineTo(tipX, half);
  s.lineTo(tipX - tip, half);
  s.lineTo(rootX - root, 0);
  s.lineTo(tipX - tip, -half);
  s.lineTo(tipX, -half);
  s.closePath();
  return s;
}

export function aircraftGeometry(type) {
  const key = type.code || 'X';
  if (geoCache.has(key)) return geoCache.get(key);
  const L = type.length || 38;
  const S = type.span || 36;
  let r = L * 0.05;
  if (key === 'A388') r *= 1.25;
  const gear = r * 0.75;
  const cy = gear + r;
  const parts = [];
  const add = (g, mat) => parts.push({ g, mat });

  const body = new THREE.CylinderGeometry(r, r, L * 0.72, 14, 1);
  body.rotateZ(Math.PI / 2);
  body.translate(L * 0.04, cy, 0);
  add(body, 'body');
  const nose = new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  nose.scale(1, 1.6, 1);
  nose.rotateZ(-Math.PI / 2);
  nose.translate(L * 0.4, cy, 0);
  add(nose, 'body');
  const tail = new THREE.ConeGeometry(r, L * 0.2, 14, 1);
  tail.rotateZ(Math.PI / 2);
  tail.translate(-L * 0.42, cy + r * 0.25, 0);
  add(tail, 'body');
  const wind = new THREE.CylinderGeometry(r * 0.35, r * 0.35, r * 2.02, 8, 1);
  wind.rotateX(Math.PI / 2);
  wind.translate(L * 0.42, cy + r * 0.35, 0);
  add(wind, 'glass');

  const wing = new THREE.ExtrudeGeometry(wingShape(L * 0.08, L * 0.2, L * 0.05, S / 2, 27 * DEG), { depth: r * 0.15, bevelEnabled: false });
  wing.rotateX(Math.PI / 2);
  wing.translate(0, cy - r * 0.45, 0);
  add(wing, 'body');
  const stab = new THREE.ExtrudeGeometry(wingShape(-L * 0.36, L * 0.1, L * 0.04, S * 0.17, 32 * DEG), { depth: r * 0.1, bevelEnabled: false });
  stab.rotateX(Math.PI / 2);
  stab.translate(0, cy + r * 0.2, 0);
  add(stab, 'body');
  const finS = new THREE.Shape();
  finS.moveTo(-L * 0.3, 0);
  finS.lineTo(-L * 0.46, L * 0.17);
  finS.lineTo(-L * 0.52, L * 0.17);
  finS.lineTo(-L * 0.5, 0);
  finS.closePath();
  const fin = new THREE.ExtrudeGeometry(finS, { depth: r * 0.12, bevelEnabled: false });
  fin.translate(0, cy + r * 0.6, -r * 0.06);
  add(fin, 'tail');

  const engines = FOUR_ENGINES.has(key) ? [0.2, 0.36] : [0.18];
  for (const f of engines) {
    for (const side of [1, -1]) {
      const z = side * S * f;
      const sweepBack = Math.tan(27 * DEG) * S * f;
      const er = r * (engines.length > 1 ? 0.42 : 0.5);
      const e = new THREE.CylinderGeometry(er, er * 0.85, L * 0.11, 10, 1, false);
      e.rotateZ(Math.PI / 2);
      e.translate(L * 0.08 - sweepBack + L * 0.03, cy - r * 0.45 - er * 0.9, z);
      add(e, 'grey');
    }
  }
  // gear legs, so it sits on the ground
  for (const [x, z] of [[L * 0.33, 0], [-L * 0.02, r * 0.8], [-L * 0.02, -r * 0.8]]) {
    const g = new THREE.CylinderGeometry(r * 0.12, r * 0.12, gear + r * 0.3, 5);
    g.translate(x, (gear + r * 0.3) / 2, z);
    add(g, 'grey');
  }
  geoCache.set(key, parts);
  return parts;
}

const tailMats = new Map();
function makeAircraft(ac) {
  const grp = new THREE.Group();
  if (!tailMats.has(ac.code)) tailMats.set(ac.code, new THREE.MeshLambertMaterial({ color: tailColour(ac.code) }));
  const mats = { body: BODY, grey: GREY, glass: GLASS, tail: tailMats.get(ac.code) };
  for (const { g, mat } of aircraftGeometry(ac.type || {})) grp.add(new THREE.Mesh(g, mats[mat]));
  grp.rotation.order = 'YZX';
  return grp;
}

// ------------------------------------------------------------------ tower position
function inside(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// OpenStreetMap has no usable tower position for these airports, so the tower
// is put just outside the terminals, in the nearest open space from their middle
export function towerSpot(L) {
  const rings = (L.terminals?.length ? L.terminals : [L.terminal].filter(Boolean));
  const pts = rings.flat();
  if (!pts.length) return [0, 0];
  const c = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const solid = rings.concat(L.buildings || []);
  const blocked = (p) => solid.some((r) => inside(p, r));
  let best = null;
  for (let k = 0; k < 24; k += 1) {
    const a = (k / 24) * Math.PI * 2;
    for (let d = 0; d < 3000; d += 20) {
      const p = [c[0] + Math.sin(a) * d, c[1] + Math.cos(a) * d];
      if (!blocked(p)) { if (!best || d < best.d) best = { d, a }; break; }
    }
  }
  if (!best) return c;
  const d = best.d + 60;
  return [c[0] + Math.sin(best.a) * d, c[1] + Math.cos(best.a) * d];
}

// ------------------------------------------------------------------ the scene
export class Scene3D {
  constructor(wrap) {
    this.wrap = wrap;
    this.cv = document.createElement('canvas');
    this.cv.className = 'map3d';
    this.cv.setAttribute('aria-label', '3D airport view');
    wrap.prepend(this.cv);
    this.labels = document.createElement('div');
    this.labels.className = 'labels3d';
    wrap.append(this.labels);
    this.gl = new THREE.WebGLRenderer({ canvas: this.cv, antialias: true, logarithmicDepthBuffer: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 60000);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 1.4);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-3000, 6000, 2000);
    this.scene.add(this.hemi, this.sun);
    this.models = new Map();
    this.tags = new Map();
    this.mode = 'tower';
    this.follow = false;
    this.themeName = null;
    this.look = { yaw: 0, pitch: -6 * DEG, fov: 50 };
    this.orbit = { az: 210 * DEG, el: 32 * DEG, d: 3500, target: new THREE.Vector3() };
    this.pointers = new Map();
    this.onTap = null;
    this.visible = false;
    this.bindInput();
    // selection and calling rings
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.05, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false }));
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.renderOrder = 7;
    this.reqRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.05, 48), new THREE.MeshBasicMaterial({ color: 0xffd60a, side: THREE.DoubleSide, depthWrite: false }));
    this.reqRing.rotation.x = -Math.PI / 2;
    this.reqRing.renderOrder = 7;
  }

  show(on) {
    this.visible = on;
    this.cv.hidden = !on;
    this.labels.hidden = !on;
    if (on) this.resize();
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.gl.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }

  setTheme(name) {
    const t = THEMES[name === 'light' ? 'light' : 'dark'];
    if (this.themeName === name) return;
    this.themeName = name;
    this.T = t;
    this.scene.background = new THREE.Color(t.sky);
    this.scene.fog = new THREE.Fog(t.fog, 6000, 32000);
    this.hemi.color.set(t.hemi[0]); this.hemi.groundColor.set(t.hemi[1]); this.hemi.intensity = t.hemi[2];
    this.sun.intensity = t.sun;
    if (this.L) this.build(this.L, true);
  }

  // where the tower is: the generated layout says, otherwise in the middle of the terminals
  towerSpot(L) {
    if (L.towerPos) return L.towerPos;
    return towerSpot(L);
  }

  build(L, force = false) {
    if (this.L === L && !force) return;
    this.L = L;
    if (!this.T) this.setTheme('dark');
    if (this.static) {
      this.scene.remove(this.static);
      this.static.traverse((o) => { o.geometry?.dispose(); if (o.material && !o.material.shared) o.material.dispose?.(); });
    }
    for (const m of this.models.values()) this.scene.remove(m);
    this.models.clear();
    const T = this.T;
    const grp = new THREE.Group();
    const runways = L.runways.concat(L.closedRunways || []);
    const all = runways.flatMap((r) => [r.a, r.b]);
    const cx = all.reduce((s, p) => s + p[0], 0) / all.length;
    const cy = all.reduce((s, p) => s + p[1], 0) / all.length;
    this.centre = [cx, cy];

    const grass = new Flat();
    grass.quad([cx - 30000, cy], [cx + 30000, cy], 60000, 0);
    grp.add(grass.mesh(T.grass, 0));
    const apron = new Flat();
    for (const ring of L.aprons || [L.apron].filter(Boolean)) apron.ring(ring, 0);
    grp.add(apron.mesh(T.apron, 1));

    const g = L.graph;
    const twy = new Flat(); const lane = new Flat(); const yel = new Flat(); const red = new Flat();
    const widthOf = new Map();
    for (const e of g.edges) {
      if (e.kind === 'runway') continue;
      const a = g.nodes[e.a].p; const b = g.nodes[e.b].p;
      if (e.kind !== 'stand') {
        const w = e.kind === 'lane' ? 15 : 23;
        (e.kind === 'lane' ? lane : twy).quad(a, b, w, 0);
        for (const n of [e.a, e.b]) widthOf.set(n, Math.max(widthOf.get(n) || 0, w));
      }
      yel.quad(a, b, 0.6, 0);
    }
    for (const [n, w] of widthOf) twy.disc(g.nodes[n].p, w / 2, 0);
    grp.add(lane.mesh(T.lane, 2), twy.mesh(T.twy, 2));

    const rw = new Flat(); const mark = new Flat();
    for (const r of runways) {
      rw.quad(r.a, r.b, r.width, 0);
      const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
      const d = r.dir || [(r.b[0] - r.a[0]) / len, (r.b[1] - r.a[1]) / len];
      const at = (s, o = 0) => [r.a[0] + d[0] * s - d[1] * o, r.a[1] + d[1] * s + d[0] * o];
      for (let s = 120; s < len - 120; s += 60) mark.quad(at(s), at(s + 30), 0.9, 0);
      for (const [s0, dirSign] of [[6, 1], [len - 6, -1]]) {
        // threshold piano keys
        for (let k = -r.width / 2 + 3; k < r.width / 2 - 2; k += 3.6) {
          if (Math.abs(k) < 2) continue;
          mark.quad(at(s0, k), at(s0 + dirSign * 30, k), 1.8, 0);
        }
        // aiming point blocks
        for (const k of [-r.width / 4, r.width / 4]) mark.quad(at(s0 + dirSign * 400, k), at(s0 + dirSign * 460, k), 6, 0);
      }
      for (const [ident, s0, sgn] of [[r.identA, 70, 1], [r.identB, len - 70, -1]]) {
        if (!ident) continue;
        const t = textPlane(ident, Math.min(18, r.width * 0.4), '#ffffff');
        const p = at(s0);
        t.position.set(p[0], 0, -p[1]);
        t.rotation.order = 'YXZ';
        t.rotation.x = -Math.PI / 2;
        t.rotation.y = Math.atan2(-d[0] * sgn, d[1] * sgn);
        grp.add(t);
      }
    }
    grp.add(rw.mesh(T.runway, 3), mark.mesh(T.mark, 4), yel.mesh(T.yellow, 5));
    for (const nd of g.nodes) {
      if (nd.kind !== 'hold') continue;
      const r = L.runways.find((x) => x.id === nd.runway);
      if (!r) continue;
      const d = r.dir; red.quad([nd.p[0] + d[0] * 18, nd.p[1] + d[1] * 18], [nd.p[0] - d[0] * 18, nd.p[1] - d[1] * 18], 2, 0);
    }
    grp.add(red.mesh(T.hold, 6));

    // runway edge lights, which matter in the dark appearance
    const lights = [];
    for (const r of runways) {
      const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
      const d = r.dir;
      for (let s = 0; s <= len; s += 60) {
        for (const o of [r.width / 2 + 1, -r.width / 2 - 1]) {
          lights.push(r.a[0] + d[0] * s - d[1] * o, 0.5, -(r.a[1] + d[1] * s + d[0] * o));
        }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
    const dark = this.themeName !== 'light';
    grp.add(new THREE.Points(lg, new THREE.PointsMaterial({ color: 0xfff3c4, size: dark ? 3 : 1.5, sizeAttenuation: false, transparent: true, opacity: dark ? 1 : 0.5 })));

    const termMat = new THREE.MeshLambertMaterial({ color: T.terminal });
    const bldMat = new THREE.MeshLambertMaterial({ color: T.building });
    for (const ring of (L.terminals?.length ? L.terminals : [L.terminal].filter(Boolean))) { const m = block(ring, L.real ? 22 : 15, termMat); if (m) grp.add(m); }
    for (const ring of L.buildings || []) { const m = block(ring, 16, bldMat); if (m) grp.add(m); }

    // the control tower: shaft, cab and its glass
    const tp = this.towerSpot(L);
    this.towerHeight = 75;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(5, 7, this.towerHeight - 8, 12), termMat);
    shaft.position.set(tp[0], (this.towerHeight - 8) / 2, -tp[1]);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(11, 9, 8, 12), new THREE.MeshLambertMaterial({ color: 0x24384d }));
    cab.position.set(tp[0], this.towerHeight - 4, -tp[1]);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 1.2, 12), termMat);
    roof.position.set(tp[0], this.towerHeight + 0.6, -tp[1]);
    this.towerParts = [shaft, cab, roof];
    grp.add(shaft, cab, roof);
    this.setMode(this.mode);
    this.tower = tp;

    this.static = grp;
    this.scene.add(grp);
    this.scene.add(this.selRing, this.reqRing);
    this.reset();
  }

  // looking from the tower at the middle of the runways; the orbit around the airport
  reset() {
    if (!this.L) return;
    const [cx, cy] = this.centre;
    // toward the middle of the runways, or straight out if the tower is right there
    const far = Math.hypot(cx - this.tower[0], cy - this.tower[1]) > 900;
    const rings = this.L.terminals?.length ? this.L.terminals : [this.L.terminal].filter(Boolean);
    const tc = rings.flat().reduce((m, p, i, all) => [m[0] + p[0] / all.length, m[1] + p[1] / all.length], [0, 0]);
    this.look.yaw = far || !rings.length ? Math.atan2(cx - this.tower[0], cy - this.tower[1]) : Math.atan2(this.tower[0] - tc[0], this.tower[1] - tc[1]);
    // aim at the middle of the runways
    this.look.pitch = -Math.atan2(this.towerHeight, Math.max(1200, Math.hypot(cx - this.tower[0], cy - this.tower[1])));
    this.look.fov = 45;
    const ext = Math.max(...this.L.runways.flatMap((r) => [Math.abs(r.a[0] - cx), Math.abs(r.a[1] - cy), Math.abs(r.b[0] - cx), Math.abs(r.b[1] - cy)]));
    this.orbit = { az: 200 * DEG, el: 35 * DEG, d: Math.max(1500, ext * 2.2), target: W3([cx, cy]) };
  }

  setMode(mode) {
    this.mode = mode;
    for (const p of this.towerParts || []) p.visible = mode !== 'tower';
  }

  bindInput() {
    const cv = this.cv;
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(Math.exp(e.deltaY * 0.0015)); }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY, t: performance.now() });
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.offsetX; p.y = e.offsetY;
        const after = Math.hypot(a.x - b.x, a.y - b.y);
        if (before > 10 && after > 10) this.zoom(before / after);
        return;
      }
      const dx = e.offsetX - p.x; const dy = e.offsetY - p.y;
      p.x = e.offsetX; p.y = e.offsetY;
      if (this.mode === 'tower') {
        const k = (this.look.fov * DEG) / Math.max(1, this.h); // grab the view
        this.look.yaw -= dx * k;
        this.look.pitch = Math.max(-70 * DEG, Math.min(25 * DEG, this.look.pitch + dy * k));
      } else {
        this.orbit.az -= dx * 0.006;
        this.orbit.el = Math.max(4 * DEG, Math.min(88 * DEG, this.orbit.el + dy * 0.006));
      }
    });
    cv.addEventListener('pointerup', (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (p && Math.hypot(e.offsetX - p.x0, e.offsetY - p.y0) < 8 && performance.now() - p.t < 500) this.onTap?.([e.offsetX, e.offsetY]);
    });
    cv.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
  }

  // >1 zooms out
  zoom(f) {
    if (this.mode === 'tower') this.look.fov = Math.max(4, Math.min(75, this.look.fov * f));
    else this.orbit.d = Math.max(40, Math.min(30000, this.orbit.d * f));
  }

  placeCamera(world, selectedId) {
    const cam = this.camera;
    if (this.mode === 'tower') {
      cam.fov = this.look.fov;
      cam.position.set(this.tower[0], this.towerHeight - 3, -this.tower[1]);
      const { yaw, pitch } = this.look;
      const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      cam.lookAt(cam.position.clone().add(dir));
    } else {
      cam.fov = 50;
      const sel = this.follow && world.ac.find((a) => a.id === selectedId);
      if (sel) this.orbit.target.lerp(W3(sel.p, sel.alt * FT + 4), 0.2);
      const { az, el, d, target } = this.orbit;
      cam.position.set(target.x + Math.sin(az) * Math.cos(el) * d, Math.max(3, target.y + Math.sin(el) * d), target.z - Math.cos(az) * Math.cos(el) * d);
      cam.lookAt(target);
    }
    cam.near = this.mode === 'tower' ? 2 : Math.max(1, this.orbit.d / 400);
    cam.updateProjectionMatrix();
  }

  // screen position of a world point, or null when behind the camera
  project(v) {
    const p = v.clone().project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return [(p.x + 1) / 2 * this.w, (1 - p.y) / 2 * this.h];
  }

  pick(world, q) {
    let best = null;
    for (const ac of world.ac) {
      const s = this.project(W3(ac.p, (ac.alt || 0) * FT));
      if (!s) continue;
      const d = Math.hypot(s[0] - q[0], s[1] - q[1]);
      if (d < 40 && (!best || d < best.d)) best = { ac, d };
    }
    return best?.ac || null;
  }

  draw(world, { selectedId = null, now = 0, theme = 'dark' } = {}) {
    if (!this.visible) return;
    this.setTheme(theme);
    this.build(world.L);
    const seen = new Set();
    for (const ac of world.ac) {
      seen.add(ac.id);
      let m = this.models.get(ac.id);
      if (!m) { m = makeAircraft(ac); this.models.set(ac.id, m); this.scene.add(m); }
      const y = (ac.alt || 0) * FT;
      m.position.set(ac.p[0], y, -ac.p[1]);
      m.rotation.y = (90 - ac.hdg) * DEG;
      let pitch = 0;
      if (ac.state === 'final') pitch = 2;
      else if (ac.state === 'climb' || ac.state === 'go_around' || (ac.state === 'takeoff' && y > 1)) pitch = 12;
      m.rotation.z = pitch * DEG;
    }
    for (const [id, m] of this.models) if (!seen.has(id)) { this.scene.remove(m); this.models.delete(id); }

    const sel = world.ac.find((a) => a.id === selectedId);
    this.selRing.visible = !!sel;
    if (sel) {
      const r = (sel.type?.span || 36) * 0.65;
      this.selRing.scale.setScalar(r);
      this.selRing.position.set(sel.p[0], (sel.alt || 0) * FT + 0.3, -sel.p[1]);
    }
    const caller = world.ac.find((a) => a.req && a.id !== selectedId);
    this.reqRing.visible = !!caller && Math.floor(now / 500) % 2 === 0;
    if (caller) {
      this.reqRing.scale.setScalar((caller.type?.span || 36) * 0.75);
      this.reqRing.position.set(caller.p[0], (caller.alt || 0) * FT + 0.3, -caller.p[1]);
    }

    this.placeCamera(world, selectedId);
    this.gl.render(this.scene, this.camera);
    this.drawTags(world, selectedId, now);
  }

  // HTML callsign tags over each aircraft
  drawTags(world, selectedId, now) {
    const seen = new Set();
    const metric = !!world.metric;
    for (const ac of world.ac) {
      const s = this.project(W3(ac.p, (ac.alt || 0) * FT + (ac.type?.length || 38) * 0.25));
      let tag = this.tags.get(ac.id);
      if (!s || s[0] < -50 || s[1] < -30 || s[0] > this.w + 50 || s[1] > this.h + 30) { if (tag) tag.hidden = true; continue; }
      seen.add(ac.id);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = `tag3d ${ac.kind}`;
        tag.innerHTML = '<b></b><span></span>';
        this.labels.append(tag);
        this.tags.set(ac.id, tag);
      }
      tag.hidden = false;
      let info = STATE_LABELS[ac.state] || ac.state;
      if (ac.state === 'final') info += metric ? ` ${(ac.dist / 1000).toFixed(1)}km` : ` ${(ac.dist / M_PER_NM).toFixed(1)}NM`;
      if (ac.hold) info += ' HOLD';
      const line = `${ac.type?.code || ''} ${info}`;
      if (tag.firstChild.textContent !== ac.callsign) tag.firstChild.textContent = ac.callsign;
      if (tag.lastChild.textContent !== line) tag.lastChild.textContent = line;
      tag.classList.toggle('sel', ac.id === selectedId);
      tag.classList.toggle('req', !!ac.req && Math.floor(now / 500) % 2 === 0);
      tag.style.transform = `translate(${Math.round(s[0])}px, ${Math.round(s[1])}px)`;
    }
    for (const [id, tag] of this.tags) {
      if (!world.ac.some((a) => a.id === id)) { tag.remove(); this.tags.delete(id); } else if (!seen.has(id)) tag.hidden = true;
    }
  }
}
