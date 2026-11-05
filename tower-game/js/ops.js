// Which runways land and which depart, from the wind.
// An airport's traffic profile can list real configurations (e.g. SFO's West
// Plan: land 28L/28R, depart 1L/1R); those are the plans, plus mixed versions
// where the runways are parallel. Otherwise the plans are made from the
// runways: land on the end most into the wind, with its parallel runways
// either split (some land, some depart) or mixed (all runways do both).
// Any other combination can still be chosen runway by runway.
// runwayPlans() lists the plans with the best one for the wind first; that is
// what the game recommends when a shift starts.

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

const calmWind = (wind) => !wind || !wind.wind_kt || wind.wind_kt < 4 || wind.wind_dir == null;

// every runway end with its wind: headwind and crosswind in knots (negative headwind = tailwind)
export function endWinds(layout, wind) {
  return runwayEnds(layout).map((e) => {
    const c = wind && wind.wind_dir != null ? windComponents(e.heading, wind.wind_dir, wind.wind_kt || 0) : null;
    return { ...e, length_m: Math.round(e.length_ft * 0.3048), headwind: c ? Math.round(c.headwind) : null, crosswind: c ? Math.round(Math.abs(c.crosswind)) : null };
  });
}

// "mean headwind of the landing runways" for a plan, or null without a wind
function planHeadwind(plan, winds) {
  const hw = plan.arr.map((id) => winds.find((e) => e.ident === id)?.headwind).filter((v) => v != null);
  return hw.length ? Math.round(hw.reduce((a, b) => a + b, 0) / hw.length) : null;
}

// plans made from the runways alone: the best runway for the wind and its parallels
function generatedPlans(ends, wind) {
  const plans = [];
  const best = selectRunway(ends, wind) || { ident: ends[0].ident, reason: 'first runway' };
  const bestEnd = ends.find((e) => e.ident === best.ident);
  // runways pointing the same way as the best one (parallels)
  const group = ends.filter((e) => e.runway !== bestEnd.runway && angleDiff(e.heading, bestEnd.heading) < 15)
    .sort((a, b) => b.length_ft - a.length_ft);
  if (group.length) {
    const all = [bestEnd, ...group].map((e) => e.ident);
    plans.push({ name: `${best.ident} arrivals, ${group[0].ident} departures`, arr: [best.ident], dep: [group[0].ident], reason: best.reason });
    plans.push({ name: `${all.join(' + ')}, mixed`, arr: all, dep: all, reason: 'every runway lands and departs: harder' });
    if (group.length > 1) plans.push({ name: `${best.ident} arrivals, ${group.map((g) => g.ident).join(' + ')} departures`, arr: [best.ident], dep: group.map((g) => g.ident), reason: best.reason });
  } else {
    plans.push({ name: `Runway ${best.ident}`, arr: [best.ident], dep: [best.ident], reason: best.reason });
  }
  // and the best runway of the other direction, for when the wind changes
  const other = selectRunway(ends.filter((e) => angleDiff(e.heading, bestEnd.heading) > 90), wind);
  if (other) plans.push({ name: `Runway ${other.ident}`, arr: [other.ident], dep: [other.ident], reason: 'other direction' });
  return plans;
}

export function runwayPlans(layout, wind, profile = null) {
  const ends = runwayEnds(layout);
  const winds = endWinds(layout, wind);
  const has = (id) => ends.some((e) => e.ident === id);
  const calm = calmWind(wind);
  let plans = [];
  const configs = (profile?.configs || []).filter((c) => [...c.arr, ...c.dep].every(has));
  if (configs.length) {
    // the airport's real plans: the one for this wind first
    const fit = calm ? configs[0] : (configs.find((c) => inRange(wind.wind_dir, c.wind)) || configs[0]);
    for (const c of [fit, ...configs.filter((x) => x !== fit)]) {
      plans.push({ name: c.name, arr: c.arr, dep: c.dep, reason: c === fit ? (calm ? 'calm or no wind: default plan' : 'for the wind') : 'other plan' });
    }
    // the same runways with every runway doing both
    for (const c of [fit, ...configs.filter((x) => x !== fit)]) {
      const all = [...new Set([...c.arr, ...c.dep])].filter((id) => has(id));
      const par = all.length > 1 && !(c.arr.length === all.length && c.dep.length === all.length) && all.every((id) => {
        const h = ends.find((e) => e.ident === id).heading;
        return all.every((o) => angleDiff(h, ends.find((e) => e.ident === o).heading) < 20);
      });
      if (par) plans.push({ name: `${c.name}, mixed`, arr: all, dep: all, reason: 'every runway lands and departs: harder' });
    }
  } else {
    plans = generatedPlans(ends, wind);
  }
  plans = plans.map((p) => ({ ...p, headwind: planHeadwind(p, winds) }));
  // When the wind suits none of the published plans (a tailwind of 3 kt or more
  // on the landing runways), plans straight into the wind are recommended
  // instead, and the published ones stay on the list with their tailwind.
  const first = plans[0];
  if (configs.length && !calm && first.headwind != null && first.headwind <= -3) {
    const into = generatedPlans(ends, wind)
      .map((g) => ({ ...g, headwind: planHeadwind(g, winds), reason: `into the wind, not a published plan; the published plans have a ${-first.headwind} kt tailwind` }))
      .filter((g) => g.headwind != null && g.headwind >= first.headwind + 5 && !plans.some((x) => x.arr.join() === g.arr.join() && x.dep.join() === g.dep.join()))
      .map((g, i) => ({ g, i })).sort((a, b) => b.g.headwind - a.g.headwind || a.i - b.i).map((x) => x.g);
    if (into.length) plans = [...into, ...plans];
  }
  return plans;
}

// the recommended plan for the wind: {name, arr, dep, reason}
export function chooseConfig(layout, wind, profile = null) {
  const p = runwayPlans(layout, wind, profile)[0];
  return { name: p.name, arr: p.arr, dep: p.dep, reason: p.reason };
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
