// Flight plans handed over from another app (e.g. the MSFS Buddy EFB), as a
// link (#fp=…) or a pasted code (OPENATC1:…). The payload is base64url JSON
// of the same fields as the Flight plan form. It only ever fills the form:
// nothing starts until you press Start flight. Everything in it is treated
// as untrusted text: unknown keys are dropped, values are trimmed, limited
// in length and checked against the form's formats.

export const PREFIX = 'OPENATC1:';

const TEXT = { callsign: 12, callsignSpoken: 60, dep: 4, arr: 4, cruise: 10, initialClimb: 10, sid: 12, star: 12,
  approach: 8, region: 8, route: 2000, depRunway: 4, arrRunway: 4, depStand: 8, arrStand: 8, taxiOut: 40,
  taxiIn: 40, depTransitionFt: 6, arrTransitionFt: 6, centerName: 40 };
const KEEP_CASE = new Set(['callsignSpoken', 'route', 'centerName']);
const APPROACHES = ['ILS', 'RNAV', 'RNP', 'VOR', 'VISUAL'];

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The code another app produces (also used by the tests). */
export function encodePlan(fp) {
  return PREFIX + toBase64Url(JSON.stringify({ v: 1, ...fp }));
}

/**
 * Read a plan from a link, a hash ("#fp=…"), a code ("OPENATC1:…") or the
 * bare payload. Returns form values, or throws an Error saying what's wrong.
 */
export function decodePlan(input) {
  let s = String(input ?? '').trim();
  const hash = s.match(/[#&]fp=([A-Za-z0-9_-]+)/);
  if (hash) s = hash[1];
  else if (s.toUpperCase().startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]{8,20000}$/.test(s)) throw new Error('That is not an OpenATC flight plan code.');
  let raw;
  try {
    raw = JSON.parse(fromBase64Url(s));
  } catch {
    throw new Error('The flight plan code is damaged (it may have been cut off when copying).');
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) throw new Error('Unsupported flight plan code version.');

  const fp = {};
  for (const [key, max] of Object.entries(TEXT)) {
    if (typeof raw[key] !== 'string' && typeof raw[key] !== 'number') continue;
    let v = String(raw[key]).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    if (!v) continue;
    if (!KEEP_CASE.has(key)) v = v.toUpperCase();
    fp[key] = v;
  }
  if (fp.region) fp.region = fp.region.toLowerCase() === 'china' ? 'china' : 'icao';
  if (fp.approach && !APPROACHES.includes(fp.approach)) delete fp.approach;
  for (const k of ['dep', 'arr']) if (fp[k] && !/^[A-Z0-9]{4}$/.test(fp[k])) delete fp[k];
  for (const k of ['depTransitionFt', 'arrTransitionFt']) if (fp[k] && !/^\d{3,5}$/.test(fp[k])) delete fp[k];
  if (!fp.dep || !fp.arr) throw new Error('The flight plan has no departure or arrival airport.');
  return fp;
}
