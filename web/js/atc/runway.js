// Runway choice from live wind, plus small geometry helpers.

const EARTH_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;

export function distanceNm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined)) return null;
  const dp = rad(lat2 - lat1);
  const dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function windComponents(runwayHeading, windDir, windKt) {
  const diff = rad(windDir - runwayHeading);
  return { headwind: windKt * Math.cos(diff), crosswind: windKt * Math.sin(diff) };
}

// runways: [{ident, heading, length_ft, closed}]; metar: {available, wind_dir, wind_kt}
// Returns {ident, reason, headwind, crosswind} or null if there are no runways.
export function selectRunway(runways, metar, { preferred, minLengthFt = 0, calmKt = 3 } = {}) {
  const usable = (runways || []).filter((r) => !r.closed && (r.length_ft ?? Infinity) >= minLengthFt);
  if (!usable.length) return null;
  const wind = metar && metar.available && metar.wind_dir !== null && metar.wind_dir !== undefined
    ? { dir: metar.wind_dir, kt: metar.wind_kt || 0 } : null;
  const describe = (r, reason) => {
    const out = { ident: r.ident, reason, headwind: null, crosswind: null };
    if (wind && r.heading !== null && r.heading !== undefined) {
      const c = windComponents(r.heading, wind.dir, wind.kt);
      out.headwind = Math.round(c.headwind);
      out.crosswind = Math.round(Math.abs(c.crosswind));
    }
    return out;
  };
  if (preferred) {
    const p = usable.find((r) => r.ident === String(preferred).toUpperCase());
    if (p) return describe(p, 'chosen by you');
  }
  const longest = [...usable].sort((a, b) => (b.length_ft || 0) - (a.length_ft || 0));
  if (!wind || wind.kt < calmKt) {
    const reason = !metar || !metar.available ? 'no live weather, longest runway'
      : (metar.wind_vrb ? 'variable wind, longest runway' : 'calm wind, longest runway');
    return describe(longest[0], reason);
  }
  const scored = usable.filter((r) => r.heading !== null && r.heading !== undefined).map((r) => ({
    r, head: windComponents(r.heading, wind.dir, wind.kt).headwind,
  }));
  if (!scored.length) return describe(longest[0], 'runway headings unknown, longest runway');
  // best headwind; within 2 kt prefer the longer runway (parallel runways)
  scored.sort((a, b) => (Math.abs(b.head - a.head) <= 2
    ? (b.r.length_ft || 0) - (a.r.length_ft || 0) : b.head - a.head));
  return describe(scored[0].r, 'into the wind');
}
