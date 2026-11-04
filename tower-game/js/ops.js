// Which runways land and which depart, from the wind.
// An airport's traffic profile can list real configurations (e.g. SFO's West
// Plan: land 28L/28R, depart 1L/1R). Otherwise: land on the runway end most
// into the wind and, if there is a parallel runway, depart from that one.

import { selectRunway, windComponents } from './lib/runway.js';
import { angleDiff } from './geo.js';

export function runwayEnds(layout) {
  return layout.runways.flatMap((r) => [
    { ident: r.identA, heading: r.headingA, length_ft: r.len / 0.3048, runway: r.id },
    { ident: r.identB, heading: r.headingB, length_ft: r.len / 0.3048, runway: r.id }]);
}

function inRange(dir, [from, to]) {
  return from <= to ? dir >= from && dir < to : dir >= from || dir < to;
}

export function chooseConfig(layout, wind, profile = null) {
  const ends = runwayEnds(layout);
  const has = (id) => ends.some((e) => e.ident === id);
  const usable = (profile?.configs || []).filter((c) => [...c.arr, ...c.dep].every(has));
  if (usable.length) {
    const dir = wind?.wind_dir;
    const calm = !wind || !wind.wind_kt || wind.wind_kt < 4 || dir == null;
    const pick = calm ? usable[0] : (usable.find((c) => inRange(dir, c.wind)) || usable[0]);
    return { name: pick.name, arr: pick.arr, dep: pick.dep, reason: calm ? 'calm or no wind: default plan' : 'for the wind' };
  }
  const best = selectRunway(ends, wind) || { ident: ends[0].ident, reason: 'first runway' };
  const bestEnd = ends.find((e) => e.ident === best.ident);
  // a parallel runway pointing the same way, for departures
  const parallel = ends.filter((e) => e.runway !== bestEnd.runway && angleDiff(e.heading, bestEnd.heading) < 15)
    .sort((a, b) => b.length_ft - a.length_ft)[0];
  return { name: parallel ? `${best.ident} arrivals, ${parallel.ident} departures` : `Runway ${best.ident}`,
    arr: [best.ident], dep: [parallel ? parallel.ident : best.ident], reason: best.reason };
}

// choices for the Arr/Dep menus: each end, plus the profile's runway pairs
export function runwayChoices(layout, profile = null) {
  const singles = runwayEnds(layout).map((e) => e.ident);
  const sets = (profile?.configs || []).flatMap((c) => [c.arr, c.dep]).filter((x) => x.length > 1).map((x) => x.join('+'));
  return [...new Set([...sets, ...singles])];
}

export function headwind(end, wind) {
  if (!wind || wind.wind_dir == null) return null;
  return Math.round(windComponents(end.heading, wind.wind_dir, wind.wind_kt).headwind);
}
