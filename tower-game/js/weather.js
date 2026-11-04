// Wind for the game: a live METAR from the NOAA Aviation Weather Center if the
// browser is allowed to fetch it, otherwise a generated wind (stable for an
// airport for the current hour). The player can also set the wind by hand.

const AWC = 'https://aviationweather.gov/api/data/metar';
const WIND_RE = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)\b/;

export function parseMetarWind(raw) {
  const m = String(raw || '').match(WIND_RE);
  if (!m) return null;
  const k = { KT: 1, MPS: 1.943844, KMH: 0.539957 }[m[4]];
  return {
    wind_dir: m[1] === 'VRB' ? null : Number(m[1]),
    wind_vrb: m[1] === 'VRB',
    wind_kt: Math.round(Number(m[2]) * k),
    gust_kt: m[3] ? Math.round(Number(m[3]) * k) : null,
  };
}

export async function liveWind(icao, { timeoutMs = 6000, fetchFn = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${AWC}?ids=${encodeURIComponent(icao)}&format=json`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.[0]?.rawOb;
    const w = parseMetarWind(raw);
    return w ? { available: true, source: 'live METAR', raw, ...w } : null;
  } catch {
    return null; // offline, blocked by the browser (CORS) or no report
  } finally {
    clearTimeout(timer);
  }
}

// deterministic "weather" from the airport code and the hour
export function generatedWind(icao, date = new Date()) {
  let h = 2166136261;
  for (const c of `${icao}${date.toISOString().slice(0, 13)}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const dir = (h % 36) * 10 || 360;
  const kt = 3 + ((h >>> 8) % 16);
  const gust = (h >>> 16) % 5 === 0 ? kt + 8 : null;
  return { available: true, source: 'generated', wind_dir: dir, wind_vrb: false, wind_kt: kt, gust_kt: gust };
}

export function windText(w) {
  if (!w) return 'Wind --';
  if (!w.wind_kt) return 'Wind calm';
  const dir = w.wind_dir == null ? 'VRB' : String(w.wind_dir).padStart(3, '0');
  return `Wind ${dir}/${String(w.wind_kt).padStart(2, '0')}${w.gust_kt ? `G${w.gust_kt}` : ''}`;
}
