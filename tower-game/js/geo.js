// 2D geometry in a local flat frame: x = metres east, y = metres north of the
// airport reference point. Headings are degrees true, 0 = north, clockwise.

export const M_PER_NM = 1852;
export const M_PER_FT = 0.3048;
export const KT = 0.514444; // m/s per knot

export function makeProjection(lat0, lon0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: ([x, y]) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
// left-hand normal (90 degrees counter-clockwise)
export const perp = (a) => [-a[1], a[0]];
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function headingOf(v) {
  return ((Math.atan2(v[0], v[1]) * 180) / Math.PI + 360) % 360;
}

export function fromHeading(deg) {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

export function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// proper intersection of segments ab and cd (not at the end points)
export function segmentIntersection(a, b, c, d, eps = 1e-6) {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null; // parallel
  const qp = sub(c, a);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return { t, u, p: add(a, mul(r, t)) };
}

export function pointSegmentDistance(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return { d: dist(p, add(a, mul(ab, t))), t };
}

// A polyline with cumulative distances, for things moving along a route.
export class Path {
  constructor(points) {
    this.pts = points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > 0.01);
    if (this.pts.length === 1) this.pts.push([...this.pts[0]]);
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i += 1) this.cum.push(this.cum[i - 1] + dist(this.pts[i - 1], this.pts[i]));
    this.length = this.cum[this.cum.length - 1];
  }

  // the sharp turns of the path: [{s, angle}] (degrees, measured over 15 m either side of the corner so that a
  // curve made of many small segments counts as one turn). Used to slow taxiing aircraft for corners.
  turns() {
    if (!this._turns) {
      const out = [];
      for (let i = 1; i < this.pts.length - 1; i += 1) {
        const a = this.at(this.cum[i] - 15).dir;
        const b = this.at(this.cum[i] + 15).dir;
        const angle = (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
        if (angle < 25) continue;
        const last = out[out.length - 1];
        if (last && this.cum[i] - last.s < 25) { if (angle > last.angle) { last.angle = angle; last.s = this.cum[i]; } } else out.push({ s: this.cum[i], angle });
      }
      this._turns = out;
    }
    return this._turns;
  }

  // position and direction (unit vector) at distance s along the path
  at(s) {
    const c = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < c) i += 1;
    const segLen = this.cum[i] - this.cum[i - 1] || 1;
    const t = (c - this.cum[i - 1]) / segLen;
    const a = this.pts[i - 1];
    const b = this.pts[i];
    return { p: lerp(a, b, t), dir: norm(sub(b, a)) };
  }
}
