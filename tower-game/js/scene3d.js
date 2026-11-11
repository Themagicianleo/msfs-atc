// 3D views of the airport with three.js (vendored, MIT licence): a tower cab
// view from the control tower and a free orbit camera. Loaded only when a 3D
// view is opened. World coordinates are metres east (x) and north (y); in
// three.js that is x → x, north → −z, altitude → y.

import * as THREE from './vendor/three.module.min.js';
import { STATE_LABELS, edgeGroups } from './render.js';
import { taxiDestination } from './world.js';
import { M_PER_NM } from './geo.js';
import { pixelRatio } from './lib/perf.js';
import { MODEL_FILES, modelFor, placement } from './lib/models.js';

const FT = 0.3048;
const DEG = Math.PI / 180;
const W3 = (p, y = 0) => new THREE.Vector3(p[0], y, -p[1]);

const THEMES = {
  light: { sky: 0xbcd3ea, fog: 0xc9d9ea, grass: 0x86a36c, apron: 0xb9b9bd, twy: 0x8e8e93, lane: 0xa3a3a8, runway: 0x48484c,
    mark: 0xffffff, yellow: 0xe0b100, hold: 0xd70015, terminal: 0xdfe4ea, building: 0xc2bdb4, hemi: [0xffffff, 0x6f7a5c, 1.6], sun: 1.6, zenith: 0x5f98d6, glass: 0x4d7896, glassGlow: 0 },
  dark: { sky: 0x101826, fog: 0x141c2a, grass: 0x1d2a1f, apron: 0x2c2f35, twy: 0x23262c, lane: 0x292c33, runway: 0x18191c,
    mark: 0xd9dde3, yellow: 0xc9a227, hold: 0xe5484d, terminal: 0x4a5566, building: 0x343a44, hemi: [0x9fb4d8, 0x1a2018, 0.9], sun: 0.6, zenith: 0x04070d, glass: 0x2d4a63, glassGlow: 0.55 },
};

// Douglas-Peucker: a polyline with the points that matter (tol metres off a straight line)
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i]; const [bx, by] = pts[j];
    const dx = bx - ax; const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let max = 0; let at = -1;
    for (let k = i + 1; k < j; k += 1) {
      const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / len;
      if (d > max) { max = d; at = k; }
    }
    if (max > tol) { keep[at] = 1; stack.push([i, at], [at, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

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
function block(ring, h, material, y0 = 0, grow = 1) {
  let pts = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  if (pts.length > 2 && pts[0].equals(pts[pts.length - 1])) pts.pop();
  if (pts.length < 3) return null;
  if (grow !== 1) { // a little bigger all round, so a glass band shows outside the wall
    const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length; const cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    pts = pts.map((q) => new THREE.Vector2(cx + (q.x - cx) * grow, cy + (q.y - cy) * grow));
  }
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  if (y0) g.translate(0, y0, 0);
  return new THREE.Mesh(g, material);
}

// the point on a closed ring nearest to p, and its distance
function nearestOnRing(ring, p) {
  let best = null;
  for (let i = 1; i < ring.length; i += 1) {
    const [ax, ay] = ring[i - 1]; const [bx, by] = ring[i];
    const dx = bx - ax; const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const q = [ax + dx * t, ay + dy * t];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!best || d < best.d) best = { q, d };
  }
  return best;
}

// a mottled grass texture, so the ground is not one flat colour
function grassTexture(hex) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const c = cv.getContext('2d');
  const col = new THREE.Color(hex);
  c.fillStyle = `#${col.getHexString()}`;
  c.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2600; i += 1) {
    const k = rnd() < 0.5 ? 255 : 0;
    c.fillStyle = `rgba(${k},${k},${k},${0.01 + rnd() * 0.022})`;
    const r = 2 + rnd() * 10;
    c.beginPath(); c.arc(rnd() * 256, rnd() * 256, r, 0, 7); c.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.repeat.set(600, 600);
  return tex;
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

// Arrivals are blue, departures magenta: the same two colours as on the map and in the lists, and unlike the
// grey pavement, the yellow lines and the green grass, so aircraft are what the eye finds first.
const KIND_COLOUR = { arr: 0x2ea8ff, dep: 0xff3d9a };
const kindBody = new Map();
const kindDisc = new Map();
const MODEL_SCALE = 2; // the real models are recognisable, so they need less enlarging than the plain shapes
const AIRCRAFT_SCALE = 2.4; // bigger than life: a real 737 is a speck at the distance the airport is viewed from
const tailMats = new Map();
function makeAircraft(ac, pack = null) {
  const grp = new THREE.Group();
  const real = pack?.[modelFor(ac.type?.code)];
  if (real) {
    // a real airliner model, scaled to the type's length (the models carry their own paint)
    const pl = placement(real.box, ac.type?.length);
    const holder = new THREE.Group();
    const body = real.root.clone(true);
    body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    holder.add(body);
    holder.scale.setScalar(pl.scale);
    holder.position.set(...pl.offset);
    grp.add(holder);
    grp.userData.real = true;
    const kind = ac.kind === 'arr' ? 'arr' : 'dep';
    if (!kindDisc.has(kind)) kindDisc.set(kind, new THREE.MeshBasicMaterial({ color: KIND_COLOUR[kind], transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
    const disc = new THREE.Mesh(new THREE.CircleGeometry((ac.type?.span || 36) * 0.75, 28), kindDisc.get(kind));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.35;
    disc.renderOrder = 6;
    grp.add(disc);
    grp.scale.setScalar(MODEL_SCALE);
    grp.rotation.order = 'YZX';
    return grp;
  }
  if (!tailMats.has(ac.code)) tailMats.set(ac.code, new THREE.MeshLambertMaterial({ color: tailColour(ac.code) }));
  const kind = ac.kind === 'arr' ? 'arr' : 'dep';
  if (!kindBody.has(kind)) kindBody.set(kind, new THREE.MeshLambertMaterial({ color: KIND_COLOUR[kind], emissive: KIND_COLOUR[kind], emissiveIntensity: 0.25 }));
  const mats = { body: kindBody.get(kind), grey: GREY, glass: GLASS, tail: tailMats.get(ac.code) };
  for (const { g, mat } of aircraftGeometry(ac.type || {})) grp.add(new THREE.Mesh(g, mats[mat]));
  // a flat disc in the same colour on the ground under it
  if (!kindDisc.has(kind)) kindDisc.set(kind, new THREE.MeshBasicMaterial({ color: KIND_COLOUR[kind], transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
  const disc = new THREE.Mesh(new THREE.CircleGeometry((ac.type?.span || 36) * 0.75, 28), kindDisc.get(kind));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.35;
  disc.renderOrder = 6;
  grp.add(disc);
  grp.scale.setScalar(AIRCRAFT_SCALE);
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
  constructor(wrap, opts = {}) {
    this.wrap = wrap;
    this.cv = document.createElement('canvas');
    this.cv.className = 'map3d';
    this.cv.setAttribute('aria-label', '3D airport view');
    wrap.prepend(this.cv);
    this.labels = document.createElement('div');
    this.labels.className = 'labels3d';
    wrap.append(this.labels);
    // Light on the GPU: no logarithmic depth buffer (it switches off early depth rejection on
    // every fragment) and anti-aliasing only on a pointer-driven (laptop) screen, where it is cheap.
    // 'low-power' asks a phone for its efficient GPU path.
    const touch = !!window.matchMedia?.('(pointer: coarse)').matches;
    this.gl = new THREE.WebGLRenderer({ canvas: this.cv, antialias: !touch && opts.antialias !== false, powerPreference: 'low-power' });
    this.maxDpr = touch ? (Math.min(window.innerWidth, window.innerHeight) < 700 ? 1 : 1.25) : 1.5; // a phone 1, an iPad 1.25
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 60000);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 1.4);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-3000, 6000, 2000);
    this.scene.add(this.hemi, this.sun);
    this.models = new Map();
    this.tags = new Map();
    this.pack = null; // the real aircraft models, once loaded
    this.quality = 'standard';
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
    this.setQuality(opts.quality || 'standard');
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
    this.gl.setPixelRatio(pixelRatio({ devicePixelRatio: window.devicePixelRatio, maxDpr: this.maxDpr || 1.5, cssW: r.width, cssH: r.height, budget: this.pixelBudget })); // sharp enough, and a third less to draw than 2x
    this.gl.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }

  // 'high': real aircraft models, soft shadows, a sky, finer buildings and lights, film-like colour. 'standard': the light version.
  setQuality(q) {
    const high = q === 'high';
    if (this.quality === q && this.qualitySet) return;
    this.quality = q; this.qualitySet = true;
    this.high = high;
    this.gl.shadowMap.enabled = high;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = high ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.sun.castShadow = high;
    if (high) {
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.6;
      if (!this.sun.target.parent) this.scene.add(this.sun.target);
      this.loadModels();
    }
    if (this.sky) this.sky.visible = high;
    // everything is rebuilt in the new quality
    for (const m of this.models.values()) this.scene.remove(m);
    this.models.clear();
    this.themeName = null; // the next picture rebuilds the airport (and the sky) in the new quality
  }

  // the real aircraft models are fetched once, after the 3D view is first opened in high quality
  loadModels() {
    if (this.pack || this.packing) return this.packing;
    this.packing = (async () => {
      const { GLTFLoader } = await import('./vendor/GLTFLoader.js');
      const loader = new GLTFLoader();
      const pack = {};
      await Promise.all(MODEL_FILES.map(async (f) => {
        try {
          const g = await loader.loadAsync(new URL(`../assets/models/${f}.glb`, import.meta.url).href);
          g.scene.updateMatrixWorld(true);
          const b = new THREE.Box3().setFromObject(g.scene);
          g.scene.traverse((o) => { if (o.isMesh && o.material?.map) o.material.map.anisotropy = 8; });
          pack[f] = { root: g.scene, box: { min: b.min.toArray(), max: b.max.toArray() } };
        } catch { /* that model stays the plain shape */ }
      }));
      this.pack = pack;
      for (const m of this.models.values()) this.scene.remove(m); // aircraft are made again with the models
      this.models.clear();
      return pack;
    })();
    return this.packing;
  }

  // a dome of sky that follows the camera
  makeSky() {
    const g = new THREE.SphereGeometry(30000, 24, 12);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
    this.sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false }));
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  paintSky() {
    if (!this.high) return;
    if (!this.sky) this.makeSky();
    const T = this.T;
    const top = new THREE.Color(T.zenith); const hor = new THREE.Color(T.fog); const c = new THREE.Color();
    const pos = this.sky.geometry.attributes.position; const col = this.sky.geometry.attributes.color;
    for (let i = 0; i < pos.count; i += 1) {
      const h = Math.max(0, pos.getY(i) / 30000);
      c.copy(hor).lerp(top, Math.pow(h, 0.55));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    this.sky.visible = true;
  }

  setTheme(name) {
    const t = THEMES[name === 'light' ? 'light' : 'dark'];
    if (this.themeName === name) return;
    this.themeName = name;
    this.T = t;
    this.scene.background = new THREE.Color(t.sky);
    this.scene.fog = new THREE.Fog(t.fog, 6000, 32000);
    // film-like colour (high quality) darkens night scenes, so moonlight is lifted to keep the airport readable
    const lift = this.high && name !== 'light' ? 2.6 : 1;
    this.hemi.color.set(t.hemi[0]); this.hemi.groundColor.set(t.hemi[1]); this.hemi.intensity = t.hemi[2] * lift;
    this.sun.intensity = t.sun * (lift > 1 ? 2.4 : 1);
    this.paintSky();
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

    const high = this.high;
    if (high) {
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), new THREE.MeshLambertMaterial({ map: grassTexture(T.grass), depthWrite: false }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(cx, 0, -cy);
      ground.renderOrder = 0;
      grp.add(ground);
    } else {
      const grass = new Flat();
      grass.quad([cx - 30000, cy], [cx + 30000, cy], 60000, 0);
      grp.add(grass.mesh(T.grass, 0));
    }
    const apron = new Flat();
    for (const ring of L.aprons || [L.apron].filter(Boolean)) apron.ring(ring, 0);
    grp.add(apron.mesh(T.apron, 1));

    const g = L.graph;
    const twy = new Flat(); const lane = new Flat(); const yel = new Flat(); const red = new Flat();
    // Taxiways are drawn from merged, simplified polylines: a quad for each stretch, and a round
    // patch only at the ends and at real corners (a quad and a disc for each of Daxing's 15,000
    // segments was 209,000 triangles; a phone can't draw that smoothly)
    const groups = edgeGroups(L);
    const ribbon = (flat, chains, width, tol, joints) => {
      for (const ch of chains) {
        const pts = simplify(ch.pts, tol);
        for (let i = 1; i < pts.length; i += 1) flat.quad(pts[i - 1], pts[i], width, 0);
        if (!joints) continue;
        flat.disc(pts[0], width / 2, 0, 6);
        flat.disc(pts[pts.length - 1], width / 2, 0, 6);
        for (let i = 1; i < pts.length - 1; i += 1) {
          const ux = pts[i][0] - pts[i - 1][0]; const uy = pts[i][1] - pts[i - 1][1];
          const vx = pts[i + 1][0] - pts[i][0]; const vy = pts[i + 1][1] - pts[i][1];
          const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
          if (turn > 0.25) flat.disc(pts[i], width / 2, 0, 6); // more than about 14 degrees
        }
      }
    };
    ribbon(twy, groups.twyChains, 23, 3, true);
    ribbon(lane, groups.laneChains, 15, 2.5, true);
    ribbon(yel, groups.lineChains, 0.6, 1.5, false);
    ribbon(yel, groups.standLineChains, 0.6, 1.5, false);
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
    const termRings = L.terminals?.length ? L.terminals : [L.terminal].filter(Boolean);
    const glassMat = new THREE.MeshLambertMaterial({ color: T.glass, emissive: 0xffd9a0, emissiveIntensity: T.glassGlow });
    const roofMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(T.terminal).multiplyScalar(0.7) });
    for (const ring of termRings) {
      const h = L.real ? 22 : 15;
      const m = block(ring, h, termMat);
      if (m) grp.add(m);
      if (high && m) { // a band of glass round the walls, and a darker roof
        const gl = block(ring, h - 8, glassMat, 4, 1.004); if (gl) grp.add(gl);
        const rf = block(ring, 1.4, roofMat, h, 1.006); if (rf) grp.add(rf);
      }
    }
    let n = 0;
    for (const ring of L.buildings || []) {
      n += 1;
      const hgt = high ? 9 + ((n * 7919) % 17) : 16; // not all the same height
      const m = block(ring, hgt, bldMat);
      if (m) grp.add(m);
      if (high && m) { const rf = block(ring, 0.8, roofMat, hgt, 1.01); if (rf) grp.add(rf); }
    }
    if (high) this.addDetail(grp, L, T, groups, runways);

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

    if (high) grp.traverse((o) => { if (o.isMesh && !o.userData.noShadow) o.receiveShadow = true; });
    this.static = grp;
    this.scene.add(grp);
    this.scene.add(this.selRing, this.reqRing);
    this.reset();
  }

  // high quality only: jet bridges, taxiway edge lights, approach lights and apron floodlights
  addDetail(grp, L, T, groups, runways) {
    const nodes = L.graph.nodes;
    const rings = (L.terminals?.length ? L.terminals : [L.terminal].filter(Boolean));
    // jet bridges: from the terminal wall to the aircraft's door, one instanced box each
    const bridges = [];
    for (const g of L.gates || []) {
      const nd = nodes[g.node];
      if (!nd) continue;
      const p = nd.p;
      let best = null;
      for (const r of rings) { const q = nearestOnRing(r, p); if (q && (!best || q.d < best.d)) best = q; }
      if (!best || best.d > 90 || best.d < 14) continue;
      const hd = (g.heading ?? 0) * DEG; // compass heading the aircraft faces when parked
      const fwd = [Math.sin(hd), Math.cos(hd)];
      const side = Math.sign((best.q[0] - p[0]) * fwd[1] - (best.q[1] - p[1]) * fwd[0]) || 1; // which side the terminal is on
      const nx = fwd[1] * side * -1; const ny = fwd[0] * side; // unit vector toward the terminal
      const door = [p[0] + fwd[0] * 9 + nx * 2.8, p[1] + fwd[1] * 9 + ny * 2.8];
      bridges.push({ a: best.q, b: door });
    }
    if (bridges.length) {
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(T.terminal).multiplyScalar(0.85) });
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, bridges.length);
      const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const e = new THREE.Euler(); const sc = new THREE.Vector3(); const ps = new THREE.Vector3();
      bridges.forEach((b, i) => {
        const dx = b.b[0] - b.a[0]; const dy = b.b[1] - b.a[1];
        const len = Math.hypot(dx, dy);
        e.set(0, Math.atan2(dy, dx), 0); // x → east, north → −z: rotation about y by the bearing
        q.setFromEuler(e);
        sc.set(len, 3.4, 3.2);
        ps.set((b.a[0] + b.b[0]) / 2, 5.2, -(b.a[1] + b.b[1]) / 2);
        m4.compose(ps, q, sc);
        inst.setMatrixAt(i, m4);
      });
      inst.castShadow = true;
      grp.add(inst);
    }
    // taxiway edge lights (blue) and runway approach lights (white): points, so they cost almost nothing
    const dark = this.themeName !== 'light';
    const edge = [];
    for (const ch of groups.twyChains) {
      const pts = simplify(ch.pts, 3);
      let carry = 0;
      for (let i = 1; i < pts.length; i += 1) {
        const dx = pts[i][0] - pts[i - 1][0]; const dy = pts[i][1] - pts[i - 1][1];
        const len = Math.hypot(dx, dy) || 1;
        for (let s0 = carry; s0 < len; s0 += 30) {
          for (const o of [11.8, -11.8]) edge.push(pts[i - 1][0] + (dx / len) * s0 - (dy / len) * o, 0.4, -(pts[i - 1][1] + (dy / len) * s0 + (dx / len) * o));
          carry = s0 + 30 - len;
        }
      }
    }
    if (edge.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
      grp.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x4aa8ff, size: dark ? 2.6 : 1.4, sizeAttenuation: false, transparent: true, opacity: dark ? 1 : 0.5, toneMapped: false })));
    }
    const appr = [];
    for (const r of runways) {
      const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
      const d = r.dir || [(r.b[0] - r.a[0]) / len, (r.b[1] - r.a[1]) / len];
      for (const [p0, sgn] of [[r.a, -1], [r.b, 1]]) {
        for (let s0 = 30; s0 <= 720; s0 += 30) {
          const base = [p0[0] + d[0] * s0 * sgn, p0[1] + d[1] * s0 * sgn];
          appr.push(base[0], 1.2, -base[1]);
          if (s0 % 150 === 0) for (const o of [-9, -6, -3, 3, 6, 9]) appr.push(base[0] - d[1] * o, 1.2, -(base[1] + d[0] * o));
        }
      }
    }
    if (appr.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(appr, 3));
      grp.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff6dd, size: dark ? 3.2 : 1.8, sizeAttenuation: false, transparent: true, opacity: dark ? 1 : 0.6, toneMapped: false })));
    }
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
      if (!m) { m = makeAircraft(ac, this.high ? this.pack : null); this.models.set(ac.id, m); this.scene.add(m); }
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
    if (this.high) this.followLight();
    this.gl.render(this.scene, this.camera);
    this.drawTags(world, selectedId, now);
  }

  // the shadow map covers the part of the airport being looked at, so it stays sharp
  followLight() {
    const cam = this.camera;
    if (this.sky) this.sky.position.copy(cam.position);
    let target; let half;
    if (this.mode === 'tower') {
      const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
      const reach = Math.min(900, Math.max(250, this.look.fov * 22));
      target = cam.position.clone().addScaledVector(dir, reach); target.y = 0; half = Math.max(250, reach * 0.9);
    } else {
      target = this.orbit.target.clone(); target.y = 0; half = Math.max(120, Math.min(1800, this.orbit.d * 0.7));
    }
    const sc = this.sun.shadow.camera;
    if (Math.abs(sc.right - half) > 1) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 50; sc.far = 9000; sc.updateProjectionMatrix(); }
    // snap to the shadow texels so shadows do not shimmer as the camera moves
    const step = (half * 2) / this.sun.shadow.mapSize.x;
    target.x = Math.round(target.x / step) * step; target.z = Math.round(target.z / step) * step;
    this.sun.target.position.copy(target);
    this.sun.position.set(target.x - 3000, 5200, target.z + 2000);
    this.sun.target.updateMatrixWorld();
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
      const dest = taxiDestination(ac);
      if (dest) info += ` → ${dest.short}`;
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
