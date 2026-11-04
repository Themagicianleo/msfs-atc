import { designator } from './frequency.js';

// Text and speech formatting for radio phraseology.
// Every formatter returns {t, s}: t = what is shown, s = what is spoken.

export const DEFAULT_NUMBER_WORDS = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
  5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'niner',
};

export const PHONETIC = {
  A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot', G: 'golf',
  H: 'hotel', I: 'india', J: 'juliet', K: 'kilo', L: 'lima', M: 'mike', N: 'november',
  O: 'oscar', P: 'papa', Q: 'quebec', R: 'romeo', S: 'sierra', T: 'tango', U: 'uniform',
  V: 'victor', W: 'whiskey', X: 'x-ray', Y: 'yankee', Z: 'zulu',
};

const FT_PER_M = 3.28084;

export class Formatter {
  constructor(region = {}) {
    this.region = region;
    this.words = { ...DEFAULT_NUMBER_WORDS, ...(region.numberWords || {}) };
    this.units = region.units || {};
  }

  digit(c) { return this.words[c] ?? c; }

  // "4721" -> "four seven two one"; letters spelled phonetically
  spell(str) {
    return String(str).toUpperCase().split('').filter((c) => c.trim() && c !== '-')
      .map((c) => (/\d/.test(c) ? this.digit(c) : (PHONETIC[c] || c))).join(' ');
  }

  digits(str) { return { t: String(str), s: this.spell(str) }; }

  // 11000 -> "one one thousand", 3500 -> "three thousand five hundred"
  thousands(n) {
    n = Math.round(n);
    const th = Math.floor(n / 1000);
    const hu = Math.floor((n % 1000) / 100);
    const rest = n % 100;
    const parts = [];
    if (th) parts.push(`${this.spell(String(th))} thousand`);
    if (hu) parts.push(`${this.digit(String(hu))} hundred`);
    if (rest || (!th && !hu)) parts.push(this.spell(String(rest)));
    return parts.join(' ');
  }

  // ICAO readout by default: all six digits unless the last two are zeros
  // (121.900 -> "121.9", 124.350 -> "124.350", 118.705 -> "118.705");
  // units.freqStyle "trim" drops all trailing zeros instead (FAA style)
  freq(mhz) {
    if (mhz === null || mhz === undefined || mhz === '') return null;
    const t = designator(mhz, this.units.freqStyle || 'icao');
    const [a, b] = t.split('.');
    const dec = this.units.decimalWord || 'decimal';
    return { t, s: `${this.spell(a)} ${dec} ${this.spell(b)}`, mhz: Number(mhz) };
  }

  runway(id) {
    if (!id) return null;
    const m = String(id).toUpperCase().match(/^(\d{1,2})([LRC]?)$/);
    if (!m) return { t: String(id), s: this.spell(id) };
    const side = { L: 'left', R: 'right', C: 'center' }[m[2]] || '';
    const num = m[1].padStart(2, '0');
    return { t: num + m[2], s: `${this.spell(num)}${side ? ' ' + side : ''}` };
  }

  heading(deg) {
    const h = String(Math.round(((deg % 360) + 360) % 360) || 360).padStart(3, '0');
    return { t: h, s: this.spell(h) };
  }

  qnh(hpa) {
    if (!hpa) return null;
    const v = String(Math.round(hpa));
    return { t: v, s: this.spell(v) };
  }

  wind(metar) {
    if (!metar || !metar.available || metar.wind_kt === undefined || metar.wind_kt === null) return null;
    const kt = Math.round(metar.wind_kt);
    if (kt === 0) return { t: 'calm', s: 'calm' };
    const speed = String(kt).padStart(2, '0');
    let t; let s;
    if (metar.wind_dir === null || metar.wind_dir === undefined) {
      t = `variable ${speed} kt`;
      s = `variable, ${this.spell(String(kt))} knots`;
    } else {
      const d = this.heading(metar.wind_dir);
      t = `${d.t}/${speed}`;
      s = `${d.s} degrees, ${this.spell(String(kt))} knots`;
    }
    if (metar.gust_kt) {
      t += `G${metar.gust_kt}`;
      s += `, gusting ${this.spell(String(metar.gust_kt))}`;
    }
    return { t, s };
  }

  // ------------------------------------------------------------- altitudes
  metricTable() { return this.region.metricLevels || []; }

  // nearest metric flight level (meters) for a flight level in feet
  metersForFeet(ft) {
    const table = this.metricTable();
    if (table.length) {
      let best = table[0];
      for (const row of table) if (Math.abs(row.fl * 100 - ft) < Math.abs(best.fl * 100 - ft)) best = row;
      if (Math.abs(best.fl * 100 - ft) <= 600) return best.m;
    }
    return Math.round(ft / FT_PER_M / 100) * 100;
  }

  // ft -> {t, s}, as a flight level or an altitude depending on the region
  level(ft, { transitionAltitudeFt } = {}) {
    if (ft === null || ft === undefined) return null;
    const ta = transitionAltitudeFt ?? this.units.transitionAltitudeFt ?? 5000;
    const metric = this.units.altitude === 'meters';
    if (metric) {
      const above = ft > ta;
      const m = above ? this.metersForFeet(ft) : Math.round(ft / FT_PER_M / 100) * 100;
      const word = this.units.metersWord || 'meters';
      return { t: `${m} m`, s: `${this.thousands(m)} ${word}`, meters: m, ft: Math.round(ft) };
    }
    if (ft > ta) {
      const fl = String(Math.round(ft / 100)).padStart(3, '0');
      return { t: `FL${fl}`, s: `flight level ${this.spell(fl)}`, ft: Math.round(ft) };
    }
    const r = Math.round(ft / 100) * 100;
    return { t: `${r} ft`, s: `${this.thousands(r)} feet`, ft: r };
  }

  // the string a pilot must say back for a level ("350", "5000", "8900")
  levelToken(ft, opts) {
    const l = this.level(ft, opts);
    if (!l) return null;
    if (l.meters !== undefined) return String(l.meters);
    return l.t.startsWith('FL') ? String(Number(l.t.slice(2))) : String(l.ft);
  }
}

// Cruise level input: "FL350", "350", "35000", "10100m", "S1010" (China)
export function parseLevel(input, formatter) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  let m = s.match(/^(?:FL)?(\d{2,3})$/);
  if (m) return Number(m[1]) * 100;
  m = s.match(/^S(\d{4})$/);
  if (m) return metersToFeet(Number(m[1]) * 10, formatter);
  m = s.match(/^(\d{3,5})M$/);
  if (m) return metersToFeet(Number(m[1]), formatter);
  m = s.match(/^(\d{4,5})(FT)?$/);
  if (m) return Number(m[1]);
  return null;
}

function metersToFeet(meters, formatter) {
  const row = formatter?.metricTable().find((r) => r.m === meters);
  return row ? row.fl * 100 : Math.round(meters * FT_PER_M);
}

// Callsign: "CCA1234" -> {t: "Air China 1234", s: "Air China one two three four"}
export function callsignOf(fp, airlines, f) {
  const raw = String(fp.callsign || '').toUpperCase().replace(/\s+/g, '');
  if (fp.callsignSpoken && fp.callsignSpoken.trim()) {
    const words = fp.callsignSpoken.trim();
    return { t: words, s: words.replace(/\d/g, (d) => ` ${f.digit(d)} `).replace(/\s+/g, ' ').trim() };
  }
  const m = raw.match(/^([A-Z]{3})(\d[A-Z0-9]*)$/);
  if (m && airlines && airlines[m[1]]) {
    const tel = airlines[m[1]];
    return { t: `${tel} ${m[2]}`, s: `${tel} ${f.spell(m[2])}` };
  }
  return { t: raw, s: f.spell(raw) };
}

// Render "{a}, cleared[ via {b}]" with values {a: {t, s} | string}.
// A [bracketed] part is dropped when any placeholder inside it is empty.
// [first|second] uses the first alternative whose placeholders all have values.
export function render(template, values) {
  const get = (key, which) => {
    const v = values[key];
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object') return v[which] ?? null;
    return String(v);
  };
  const pass = (which) => {
    const optional = template.replace(/\[([^[\]]*)\]/g, (_, inner) => {
      for (const alt of inner.split('|')) {
        const keys = [...alt.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
        if (keys.every((k) => get(k, which) !== null)) return alt;
      }
      return '';
    });
    return optional.replace(/\{(\w+)\}/g, (_, k) => get(k, which) ?? '')
      .replace(/\s+([,.])/g, '$1').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
  };
  return { text: pass('t'), speech: pass('s') };
}
