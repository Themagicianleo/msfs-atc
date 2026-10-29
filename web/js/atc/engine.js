// Rule-based ATC for one IFR flight: a state machine driven by pilot calls
// and by the live aircraft state. No AI and no network access here, so the
// whole engine can be tested in Node (see web/tests).
//
// Every public method returns a list of events:
//   {kind: 'atc', unit, unitName, freq, text, speech, heard, t}
//   {kind: 'pilot', text, freq, t}
//   {kind: 'system', text, t}
//   {kind: 'effect', mock: {...}}   (commands for the mock aircraft)

import { Formatter, PHONETIC, callsignOf, parseLevel, render } from './format.js';
import { detectIntent, missingItems } from './parser.js';
import { distanceNm, selectRunway } from './runway.js';

export const PHASES = {
  clearance: { unit: 'dep_DEL', label: 'Clearance' },
  startup: { unit: 'dep_GND', label: 'Push & start' },
  taxi_request: { unit: 'dep_GND', label: 'Taxi' },
  taxiing: { unit: 'dep_GND', label: 'Taxi to holding point', also: { dep_TWR: ['ready_departure', 'check_in'] } },
  lineup: { unit: 'dep_TWR', label: 'Holding point' },
  takeoff: { unit: 'dep_TWR', label: 'Take-off' },
  departure: { unit: 'dep_DEP', label: 'Departure' },
  departure_climb: { unit: 'dep_DEP', label: 'Climb' },
  enroute_checkin: { unit: 'CTR', label: 'En route' },
  cruise: { unit: 'CTR', label: 'Cruise' },
  descent: { unit: 'CTR', label: 'Descent' },
  approach_checkin: { unit: 'arr_APP', label: 'Approach' },
  approach: { unit: 'arr_APP', label: 'Approach' },
  final: { unit: 'arr_APP', label: 'Final', also: { arr_TWR: ['check_in', 'report_established'] } },
  tower_checkin: { unit: 'arr_TWR', label: 'Landing' },
  landing: { unit: 'arr_TWR', label: 'Landing' },
  taxi_in_request: { unit: 'arr_GND', label: 'Taxi to stand' },
  taxi_in: { unit: 'arr_GND', label: 'Taxi to stand' },
  done: { unit: null, label: 'Flight complete' },
};

const FREQ_FALLBACK = {
  DEL: ['DEL', 'GND', 'TWR'], GND: ['GND', 'TWR'], TWR: ['TWR'],
  DEP: ['DEP', 'APP'], APP: ['APP', 'DEP'],
};
const GO_AROUND_PHASES = ['approach', 'final', 'tower_checkin', 'landing'];
const HANDOFF_TOLERANCE_MHZ = 0.003;

export class AtcEngine {
  constructor({ phraseology, airlines = {}, rng = Math.random, options = {} }) {
    this.phr = phraseology;
    this.airlines = airlines;
    this.rng = rng;
    this.opts = { freqCheck: true, strictReadback: true, radio: 'com1', ...options };
    this.f = new Formatter(phraseology);
    this.sim = null;
    this.fp = null;
    this.s = null;
  }

  // ------------------------------------------------------------ setup
  setFlightPlan(fp, depInfo, arrInfo, now = Date.now()) {
    this.fp = { ...fp };
    this.dep = depInfo;
    this.arr = arrInfo;
    this.metar = { dep: null, arr: null };
    this.s = {
      phase: 'clearance', pending: null, squawk: this.newSquawk(), cleared: null,
      depRunway: null, arrRunway: null, lockDep: false, lockArr: false,
      last: {}, missed: null, flags: {}, stoppedSince: null, startedAt: now,
    };
    this.buildUnits();
    this.chooseRunways();
    const events = [this.system(`Flight plan loaded: ${this.fp.callsign} ${this.dep.icao} to ${this.arr.icao}. `
      + `Tune ${this.unitLabel(this.expectedUnit())} and request your clearance.`, now)];
    for (const u of Object.values(this.units)) {
      if (u.source === 'default') {
        events.push(this.system(`No ${u.role} frequency known for ${u.airport || 'this flight'}; using ${u.freq}. `
          + 'Add it in the flight plan or airports_manual.json.', now));
      }
    }
    return events;
  }

  setOptions(options) { Object.assign(this.opts, options); }

  setWeather(which, metar) {
    if (!this.s) return;
    this.metar[which] = metar;
    this.chooseRunways();
  }

  get active() { return !!this.s; }

  serialize() {
    if (!this.s) return null;
    return JSON.stringify({ fp: this.fp, dep: this.dep, arr: this.arr, metar: this.metar, s: this.s });
  }

  restore(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    Object.assign(this, { fp: d.fp, dep: d.dep, arr: d.arr, metar: d.metar, s: d.s });
    this.buildUnits();
  }

  newSquawk() {
    const d = this.phr.defaults || {};
    const lo = Number(d.squawkMin || 2001);
    const hi = Number(d.squawkMax || 6777);
    for (let i = 0; i < 100; i += 1) {
      const code = Array.from({ length: 4 }, () => Math.floor(this.rng() * 8)).join('');
      const n = Number(code);
      if (n >= lo && n <= hi && !code.endsWith('00')) return code;
    }
    return '4721';
  }

  // altitude defaults may be given in feet (xxxFt) or meters (xxxM)
  defaultFt(name) {
    const d = this.phr.defaults || {};
    if (d[`${name}M`] !== undefined) return d[`${name}M`] * 3.28084;
    return d[`${name}Ft`];
  }

  cruiseFt() {
    return parseLevel(this.fp.cruise, this.f) || 30000;
  }

  // ------------------------------------------------------------ units
  buildUnits() {
    const u = {};
    const make = (key, airport, role, which) => {
      const override = this.fp.frequencies?.[key];
      let freq = override || null;
      let source = override ? 'flight plan' : null;
      if (!freq) {
        for (const r of FREQ_FALLBACK[role]) {
          const list = airport?.frequencies?.[r];
          if (list && list.length) {
            freq = list[0].mhz;
            source = r === role ? 'airport' : `airport ${r}`;
            break;
          }
        }
      }
      if (!freq && role !== 'DEP' && role !== 'APP') {
        freq = this.phr.defaults?.towerFrequency || '118.100';
        source = 'default';
      }
      u[key] = { key, role, which, airport: airport?.icao, name: this.unitName(airport, role), freq, source };
    };
    make('dep_DEL', this.dep, 'DEL', 'dep');
    make('dep_GND', this.dep, 'GND', 'dep');
    make('dep_TWR', this.dep, 'TWR', 'dep');
    make('dep_DEP', this.dep, 'DEP', 'dep');
    make('arr_APP', this.arr, 'APP', 'arr');
    make('arr_TWR', this.arr, 'TWR', 'arr');
    make('arr_GND', this.arr, 'GND', 'arr');
    const ctrFreq = this.fp.frequencies?.CTR || this.arr?.frequencies?.CTR?.[0]?.mhz
      || this.dep?.frequencies?.CTR?.[0]?.mhz || this.phr.defaults?.centerFrequency || '127.500';
    const ctrName = this.fp.centerName || this.arr?.names?.CTR || this.dep?.names?.CTR
      || `${this.place(this.dep)} ${this.phr.unitNames.CTR}`;
    let ctrSource = 'default';
    if (this.fp.frequencies?.CTR) ctrSource = 'flight plan';
    else if (this.arr?.frequencies?.CTR?.length || this.dep?.frequencies?.CTR?.length) ctrSource = 'airport';
    u.CTR = { key: 'CTR', role: 'CTR', which: 'enroute', name: ctrName, freq: ctrFreq, source: ctrSource };
    // no departure/approach frequency: the centre (or tower) works it
    if (!u.dep_DEP.freq) Object.assign(u.dep_DEP, { freq: ctrFreq, name: ctrName, source: 'centre' });
    if (!u.arr_APP.freq) Object.assign(u.arr_APP, { freq: ctrFreq, name: ctrName, source: 'centre' });
    this.units = u;
  }

  place(airport) {
    if (!airport) return '';
    return airport.municipality || (airport.name || airport.icao || '').split(/\s+/)[0];
  }

  unitName(airport, role) {
    return airport?.names?.[role] || `${this.place(airport)} ${this.phr.unitNames[role]}`;
  }

  unitLabel(key) {
    const u = this.units?.[key];
    return u ? `${u.name} ${this.f.freq(u.freq).t}` : '';
  }

  tunedFreq() {
    const v = this.sim?.[`${this.opts.radio}_active`];
    return this.sim?.connected && this.sim?.in_flight && typeof v === 'number' ? v : null;
  }

  freqChecking() { return this.opts.freqCheck && this.tunedFreq() !== null; }

  unitsOn(freq) {
    return Object.values(this.units).filter((u) => u.freq
      && Math.abs(Number(u.freq) - freq) < HANDOFF_TOLERANCE_MHZ).map((u) => u.key);
  }

  isTunedTo(unitKey) {
    if (!this.freqChecking()) return true;
    return this.unitsOn(this.tunedFreq()).includes(unitKey);
  }

  expectedUnit() {
    if (!this.s) return null;
    return this.s.pending?.unit || PHASES[this.s.phase].unit;
  }

  // ------------------------------------------------------------ runways & weather
  chooseRunways() {
    if (!this.s.lockDep) {
      const sel = selectRunway(this.dep?.runways, this.metar.dep, { preferred: this.fp.depRunway });
      this.s.depRunway = sel;
    }
    if (!this.s.lockArr) {
      const sel = selectRunway(this.arr?.runways, this.metar.arr, { preferred: this.fp.arrRunway });
      this.s.arrRunway = sel;
    }
  }

  runwayEnd(which) {
    const id = which === 'dep' ? this.s.depRunway?.ident : this.s.arrRunway?.ident;
    const ap = which === 'dep' ? this.dep : this.arr;
    return (ap?.runways || []).find((r) => r.ident === id) || null;
  }

  atisLetter(which) {
    const m = this.metar[which];
    if (!m || !m.available || !m.time) return null;
    const hour = new Date(m.time).getUTCHours();
    if (Number.isNaN(hour)) return null;
    const letter = String.fromCharCode(65 + (hour % 26));
    return { t: letter, s: PHONETIC[letter] };
  }

  // ------------------------------------------------------------ values for templates
  values(unitKey, extra = {}) {
    const f = this.f;
    const which = ['takeoff', 'clearance', 'startup', 'taxi_request', 'taxiing', 'lineup'].includes(this.s.phase)
      || (this.units[unitKey]?.which === 'dep') ? 'dep' : 'arr';
    const ap = which === 'dep' ? this.dep : this.arr;
    const rwy = which === 'dep' ? this.s.depRunway : this.s.arrRunway;
    const ta = this.fp[which === 'dep' ? 'depTransitionFt' : 'arrTransitionFt'];
    const lvl = (ft) => f.level(ft, ta ? { transitionAltitudeFt: Number(ta) } : {});
    const sim = this.sim;
    const v = {
      callsign: callsignOf(this.fp, this.airlines, f),
      unit: this.units[unitKey]?.name,
      arrival: { t: this.arr.icao, s: this.place(this.arr) || f.spell(this.arr.icao) },
      sid: this.fp.sid ? speakProcedure(this.fp.sid, f) : null,
      star: this.fp.star ? speakProcedure(this.fp.star, f) : null,
      runway: rwy ? f.runway(rwy.ident) : null,
      initial_alt: lvl(Number(this.fp.initialClimbFt) || parseLevel(this.fp.initialClimb, f) || this.defaultFt('initialClimb')),
      squawk: f.digits(this.s.squawk),
      qnh: f.qnh(this.metar[which]?.available ? this.metar[which].qnh_hpa : null),
      wind: f.wind(this.metar[which]),
      atis: this.atisLetter(which),
      approach: { t: this.fp.approach || 'ILS', s: speakApproach(this.fp.approach || 'ILS', f) },
      stand: this.fp[which === 'dep' ? 'depStand' : 'arrStand'] || null,
      taxi_route: this.fp[which === 'dep' ? 'taxiOut' : 'taxiIn'] || null,
      facing: this.fp.pushFacing || null,
      good_day: this.phr.defaults?.goodDay || 'good day',
      cleared: this.s.cleared ? lvl(this.s.cleared) : null,
      altitude: sim?.in_flight && typeof sim.ind_alt_ft === 'number' && !sim.on_ground ? lvl(sim.ind_alt_ft) : null,
      freq: this.units[unitKey] ? f.freq(this.units[unitKey].freq) : null,
      airport: ap?.icao,
    };
    for (const [k, val] of Object.entries(extra)) {
      v[k] = typeof val === 'number' && k === 'level' ? lvl(val) : val;
    }
    return v;
  }

  // ------------------------------------------------------------ message helpers
  system(text, now) { return { kind: 'system', text, t: now }; }

  atc(unitKey, tplKey, extra, now) {
    const tpl = this.phr.atc[tplKey];
    const { text, speech } = render(tpl, this.values(unitKey, extra));
    const unit = this.units[unitKey];
    const heard = this.isTunedTo(unitKey);
    const msg = { kind: 'atc', unit: unitKey, unitName: unit.name, freq: unit.freq, text, speech, heard, t: now, tpl: tplKey };
    this.s.last[unitKey] = { tplKey, extra, text, speech };
    this.s.missed = heard ? null : { unit: unitKey, tplKey, extra, t: now };
    return msg;
  }

  nextExtra(toKey) {
    const u = this.units[toKey];
    return { next_unit: u.name, next_freq: this.f.freq(u.freq) };
  }

  // remember what must be read back; onOk is a method name run on success
  expect(unitKey, kind, items, onOk, extra = {}) {
    this.s.pending = { unit: unitKey, kind, items, onOk, extra };
  }

  item(key, value, label) {
    if (!value) return null;
    const v = typeof value === 'object' ? value : { t: String(value), s: String(value) };
    const tokenFor = {
      runway: () => v.t.toLowerCase(),
      freq: () => v.t.replace(/\D/g, ''),
      squawk: () => v.t,
      qnh: () => v.t,
      level: () => v.token,
    };
    return { key, t: `${label ? label + ' ' : ''}${v.t}`, s: `${label ? label + ' ' : ''}${v.s}`,
      token: (tokenFor[key] || (() => v.t.toLowerCase()))() };
  }

  levelItem(ft, label = '') {
    const v = this.values(this.expectedUnit(), { level: ft }).level;
    let token;
    if (v.meters !== undefined) token = String(v.meters);
    else token = v.t.startsWith('FL') ? String(Number(v.t.slice(2))) : String(v.ft);
    return this.item('level', { ...v, token }, label);
  }

  handoff(fromKey, toKey, tplKey, nextPhase, now) {
    const extra = this.nextExtra(toKey);
    const msg = this.atc(fromKey, tplKey, extra, now);
    this.expect(fromKey, 'contact', [this.item('freq', extra.next_freq)], 'advance', { ...extra, nextPhase });
    return [msg];
  }

  // generic readback success: move on to the phase stored with the instruction
  advance(now, p) {
    if (p?.extra?.nextPhase) this.setPhase(p.extra.nextPhase, now);
    return [];
  }

  setPhase(phase, now) {
    this.s.phase = phase;
    this.s.phaseAt = now;
    this.s.flags.triggered = false;
  }

  // ------------------------------------------------------------ pilot input
  pilotSays(text, { intent: forced = null, now = Date.now() } = {}) {
    if (!this.s) return [this.system('Load a flight plan first.', now)];
    const events = [];
    const tuned = this.tunedFreq();
    events.push({ kind: 'pilot', text, freq: tuned, t: now });
    const expected = this.expectedUnit();
    let unitKey = expected;
    if (this.freqChecking()) {
      const on = this.unitsOn(tuned);
      if (!on.length) {
        events.push(this.system(`No reply: no controller on ${this.f.freq(tuned).t}. `
          + (expected ? `Tune ${this.unitLabel(expected)}.` : ''), now));
        return events;
      }
      unitKey = on.includes(expected) ? expected : on[0];
    }
    if (!unitKey) {
      events.push(this.system('The flight is complete. Load a new flight plan for another flight.', now));
      return events;
    }
    const intent = forced || detectIntent(text, this.phr.intents);

    if (intent === 'say_again') {
      const last = this.s.last[unitKey];
      if (last) events.push(this.atc(unitKey, last.tplKey, last.extra, now));
      else events.push(this.atc(unitKey, 'say_again', {}, now));
      return events;
    }
    if (intent === 'radio_check') {
      events.push(this.atc(unitKey, 'radio_check', {}, now));
      return events;
    }

    const p = this.s.pending;
    if (p && unitKey !== p.unit && p.kind === 'contact' && this.units[p.unit]
        && unitKey === PHASES[p.extra.nextPhase]?.unit) {
      // pilot skipped the frequency readback and just called the next unit: fine
      this.s.pending = null;
      this.setPhase(p.extra.nextPhase, now);
    } else if (p) {
      if (unitKey !== p.unit) {
        events.push(this.atc(unitKey, 'wrong_unit', this.nextExtra(p.unit), now));
        return events;
      }
      return events.concat(this.checkReadback(text, intent, now));
    }

    const phase = this.s.phase;
    const info = PHASES[phase];
    if (unitKey !== info.unit) {
      const also = info.also?.[unitKey];
      if (!(also && (!intent || also.includes(intent)))) {
        events.push(this.atc(unitKey, 'wrong_unit', this.nextExtra(info.unit), now));
        return events;
      }
    }
    if (intent === 'go_around' && GO_AROUND_PHASES.includes(phase)) {
      return events.concat(this.goAround(unitKey, now));
    }
    const handler = HANDLERS[phase]?.[intent];
    if (!handler) {
      if (!intent) {
        events.push(this.atc(unitKey, 'say_again', {}, now));
        events.push(this.system(`Not understood. Try: "${this.getHint().say || 'a phrase button'}"`, now));
      } else {
        events.push(this.atc(unitKey, 'standby', {}, now));
        events.push(this.system(`That call is not expected now. ${this.getHint().note || ''}`.trim(), now));
      }
      return events;
    }
    return events.concat(handler.call(this, unitKey, now));
  }

  checkReadback(text, intent, now) {
    const p = this.s.pending;
    const items = p.items.filter(Boolean);
    const missing = this.opts.strictReadback ? missingItems(text, items) : [];
    if (!missing.length) {
      this.s.pending = null;
      return this[p.onOk](now, p) || [];
    }
    const joined = {
      t: missing.map((m) => m.t).join(', '),
      s: missing.map((m) => m.s).join(', '),
    };
    const looksLikeRequest = intent && intent !== 'check_in' && missing.length === items.length;
    return [this.atc(p.unit, looksLikeRequest ? 'readback_required' : 'readback_wrong', { items: joined }, now)];
  }

  // ------------------------------------------------------------ phase handlers
  giveClearance(unitKey, now) {
    const msg = this.atc(unitKey, 'clearance', {}, now);
    const v = this.values(unitKey);
    this.s.lockDep = true;
    this.s.cleared = Number(this.fp.initialClimbFt) || parseLevel(this.fp.initialClimb, this.f) || this.defaultFt('initialClimb');
    this.expect(unitKey, 'clearance', [
      this.item('runway', v.runway, 'runway'),
      this.levelItem(this.s.cleared, 'climb'),
      this.item('squawk', v.squawk, 'squawk'),
    ], 'clearanceOk');
    return [msg];
  }

  clearanceOk(now) {
    this.setPhase('startup', now);
    return [this.atc('dep_DEL', 'readback_correct_next', this.nextExtra('dep_GND'), now),
      { kind: 'effect', mock: { cmd: 'squawk', code: this.s.squawk } }];
  }

  givePushback(unitKey, now) {
    const msg = this.atc(unitKey, 'pushback', {}, now);
    this.expect(unitKey, 'pushback', [{ key: 'push', t: 'push and start approved', s: 'push and start approved', token: ['push', 'start'] }], 'pushbackOk');
    return [msg];
  }

  pushbackOk(now) {
    this.setPhase('taxi_request', now);
    return [{ kind: 'effect', mock: { cmd: 'phase', phase: 'pushback' } }];
  }

  giveTaxi(unitKey, now) {
    const xpdr = this.sim?.in_flight ? this.sim.xpdr : null;
    const squawkCheck = xpdr && xpdr !== this.s.squawk ? this.f.digits(this.s.squawk) : null;
    const msg = this.atc(unitKey, 'taxi', { squawk_check: squawkCheck }, now);
    const v = this.values(unitKey);
    this.expect(unitKey, 'taxi', [this.item('runway', v.runway, 'holding point runway')], 'taxiOk');
    return [msg];
  }

  taxiOk(now) {
    this.setPhase('taxiing', now);
    return [{ kind: 'effect', mock: { cmd: 'phase', phase: 'taxi' } }];
  }

  readyDeparture(unitKey, now) {
    if (unitKey === 'dep_GND') return this.handoff('dep_GND', 'dep_TWR', 'taxi_handoff', 'lineup', now);
    return this.giveTakeoff(unitKey, now);
  }

  giveTakeoff(unitKey, now) {
    const msg = this.atc(unitKey, 'takeoff', {}, now);
    const v = this.values(unitKey);
    this.expect(unitKey, 'takeoff', [this.item('runway', v.runway, 'runway'),
      { key: 'takeoff', t: 'cleared for take-off', s: 'cleared for take-off', token: ['takeoff', 'take off'] }], 'takeoffOk');
    return [msg];
  }

  takeoffOk(now) {
    this.setPhase('takeoff', now);
    return [{ kind: 'effect', mock: { cmd: 'phase', phase: 'takeoff' } }];
  }

  airborneHandoff(unitKey, now) {
    return this.handoff('dep_TWR', 'dep_DEP', 'departure_handoff', 'departure', now);
  }

  radarContact(unitKey, now) {
    const climb = Math.min(this.cruiseFt(), this.defaultFt('departureClimb') || 15000);
    this.s.cleared = climb;
    const msg = this.atc(unitKey, 'radar_contact', { level: climb }, now);
    this.expect(unitKey, 'climb', [this.levelItem(climb)], 'advance', { level: climb, nextPhase: 'departure_climb' });
    return [msg];
  }

  centerCheckin(unitKey, now) {
    const cruise = this.cruiseFt();
    const climbing = (this.s.cleared || 0) < cruise;
    this.s.cleared = cruise;
    const msg = this.atc(unitKey, climbing ? 'center_climb' : 'center_maintain', { level: cruise }, now);
    this.expect(unitKey, climbing ? 'climb' : 'maintain', [this.levelItem(cruise)], 'advance', { level: cruise, nextPhase: 'cruise' });
    return [msg];
  }

  giveDescent(unitKey, now) {
    this.s.lockArr = true;
    const target = Math.min(this.defaultFt('descent') || 10000, this.s.cleared || 99999);
    this.s.cleared = target;
    const msg = this.atc(unitKey, 'descent', { level: target }, now);
    this.expect(unitKey, 'descent', [this.levelItem(target)], 'advance', { level: target, nextPhase: 'descent' });
    return [msg];
  }

  approachCheckin(unitKey, now) {
    this.s.lockArr = true;
    const elev = this.arr?.elevation_ft || 0;
    const alt = Math.max(this.defaultFt('approachAlt') || 3000, Math.ceil((elev + 2000) / 1000) * 1000);
    this.s.cleared = alt;
    const msg = this.atc(unitKey, 'approach_checkin', { level: alt }, now);
    const v = this.values(unitKey);
    this.expect(unitKey, 'approach_descent', [this.levelItem(alt), this.item('qnh', v.qnh, 'QNH'),
      this.item('runway', v.runway, 'runway')], 'advance', { level: alt, nextPhase: 'approach' });
    return [msg];
  }

  approachClearance(unitKey, now) {
    const msg = this.atc(unitKey, 'approach_clearance', {}, now);
    const v = this.values(unitKey);
    this.expect(unitKey, 'approach_clearance', [this.item('runway', v.runway, 'runway')], 'advance', { nextPhase: 'final' });
    return [msg];
  }

  established(unitKey, now) {
    if (unitKey === 'arr_TWR') return this.giveLanding(unitKey, now);
    return this.handoff('arr_APP', 'arr_TWR', 'final_handoff', 'tower_checkin', now);
  }

  giveLanding(unitKey, now) {
    const msg = this.atc(unitKey, 'landing', {}, now);
    const v = this.values(unitKey);
    this.s.flags.landingCleared = true;
    this.expect(unitKey, 'landing', [this.item('runway', v.runway, 'runway'),
      { key: 'land', t: 'cleared to land', s: 'cleared to land', token: 'land' }], 'advance', { nextPhase: 'landing' });
    return [msg];
  }

  vacated(unitKey, now) {
    return this.handoff('arr_TWR', 'arr_GND', 'vacate', 'taxi_in_request', now);
  }

  giveTaxiIn(unitKey, now) {
    const msg = this.atc(unitKey, 'taxi_in', {}, now);
    const v = this.values(unitKey);
    const items = v.stand ? [this.item('stand', { t: v.stand, s: v.stand }, 'stand')]
      : [{ key: 'taxi', t: 'taxi', s: 'taxi', token: ['taxi', 'apron'] }];
    this.expect(unitKey, 'taxi_in', items, 'advance', { nextPhase: 'taxi_in' });
    return [msg];
  }

  goAround(unitKey, now) {
    const alt = Math.max(this.defaultFt('approachAlt') || 3000, Math.ceil(((this.arr?.elevation_ft || 0) + 2000) / 1000) * 1000);
    this.s.cleared = alt;
    this.s.flags.landingCleared = false;
    if (unitKey === 'arr_APP') {
      const msg = this.atc(unitKey, 'go_around_app', { level: alt }, now);
      this.expect(unitKey, 'go_around_app', [this.levelItem(alt)], 'advance', { level: alt, nextPhase: 'approach' });
      return [msg];
    }
    const extra = { level: alt, ...this.nextExtra('arr_APP') };
    const msg = this.atc(unitKey, 'go_around', extra, now);
    this.expect(unitKey, 'go_around', [this.levelItem(alt), this.item('freq', extra.next_freq)], 'advance',
      { ...extra, nextPhase: 'approach_checkin' });
    return [msg];
  }

  // ------------------------------------------------------------ sim-driven events
  updateSim(state, now = Date.now()) {
    this.sim = state;
    if (!this.s) return [];
    const events = [];
    // a call we made while the pilot was on another frequency
    const missed = this.s.missed;
    if (missed && this.isTunedTo(missed.unit)) {
      events.push(this.atc(missed.unit, missed.tplKey, missed.extra, now));
    } else if (missed && now - missed.t > 30000) {
      events.push(this.atc(missed.unit, missed.tplKey, missed.extra, now));
    }
    if (this.s.flags.pendingContactNow) {
      this.s.flags.pendingContactNow = false;
      events.push(this.atc('arr_APP', 'contact_now', this.nextExtra('arr_TWR'), now));
    }
    if (this.s.pending || !state?.in_flight) return events;
    const trig = TRIGGERS[this.s.phase];
    if (trig && !this.s.flags.triggered && trig.when.call(this, state, now)) {
      this.s.flags.triggered = true;
      events.push(...trig.fire.call(this, now));
    }
    return events;
  }

  // the sim did not report the event (no sim, odd aircraft): do it by hand
  canSkip() { return !!(this.s && !this.s.pending && TRIGGERS[this.s.phase]); }

  skip(now = Date.now()) {
    if (!this.canSkip()) return [];
    this.s.flags.triggered = true;
    return TRIGGERS[this.s.phase].fire.call(this, now);
  }

  distToArr() {
    const sim = this.sim;
    if (!sim || sim.lat === null || sim.lat === undefined) return null;
    const end = this.runwayEnd('arr');
    const lat = end?.lat ?? this.arr?.lat;
    const lon = end?.lon ?? this.arr?.lon;
    return distanceNm(sim.lat, sim.lon, lat, lon);
  }

  // ------------------------------------------------------------ UI helpers
  pilotValues() {
    const unitKey = this.expectedUnit();
    return this.values(unitKey);
  }

  pilotText(key) {
    return render(this.phr.pilot[key], this.pilotValues()).text;
  }

  getActions() {
    if (!this.s) return [];
    const btn = this.phr.buttons;
    const acts = [];
    const add = (id, intent, textKey = id) => acts.push({ id, intent, label: btn[id] || id, text: this.pilotText(textKey) });
    const p = this.s.pending;
    if (p) {
      const tpl = this.phr.readback[p.kind] || '{callsign}';
      acts.push({ id: 'readback', intent: 'readback', label: btn.readback, primary: true,
        text: render(tpl, this.values(p.unit, p.extra)).text });
    } else {
      const ph = this.s.phase;
      const sim = this.sim?.in_flight ? this.sim : null;
      const map = {
        clearance: [['request_clearance', 'request_clearance']],
        startup: [['request_pushback', 'request_pushback'], ['request_taxi', 'request_taxi']],
        taxi_request: [['request_taxi', 'request_taxi']],
        taxiing: [['ready_ground', 'ready_departure']],
        lineup: [['ready_departure', 'ready_departure']],
        departure: [['checkin', 'check_in', 'checkin_climbing']],
        enroute_checkin: [['checkin', 'check_in', sim && this.s.cleared && Math.abs(sim.ind_alt_ft - this.cruiseFt()) < 300 ? 'checkin_level' : 'checkin_climbing']],
        cruise: [['request_descent', 'request_descent']],
        approach_checkin: [['checkin', 'check_in', 'checkin_descending']],
        approach: [['report_established', 'report_established']],
        final: [['report_established', 'report_established']],
        tower_checkin: [['checkin_tower', 'check_in']],
        landing: [['runway_vacated', 'runway_vacated']],
        taxi_in_request: [['runway_vacated', 'runway_vacated']],
      }[ph] || [];
      map.forEach(([id, intent, textKey], i) => {
        add(id, intent, textKey || id);
        if (i === 0) acts[acts.length - 1].primary = true;
      });
      if (GO_AROUND_PHASES.includes(ph)) add('go_around', 'go_around');
    }
    if (this.s.phase !== 'done') {
      add('say_again', 'say_again');
      add('radio_check', 'radio_check');
    }
    return acts;
  }

  getHint() {
    if (!this.s) return { say: null, tune: null, note: 'Fill in the flight plan to start.' };
    const unitKey = this.expectedUnit();
    const u = this.units[unitKey];
    const hint = { say: null, tune: null, note: null, missed: null, squawk: null, phase: PHASES[this.s.phase].label };
    if (u && this.freqChecking() && !this.isTunedTo(unitKey)) {
      hint.tune = { freq: u.freq, name: u.name, text: `Tune ${this.opts.radio.toUpperCase()} to ${this.f.freq(u.freq).t} (${u.name})` };
    }
    if (this.s.missed) {
      const m = this.units[this.s.missed.unit];
      hint.missed = `${m.name} is calling you on ${this.f.freq(m.freq).t}.`;
    }
    const primary = this.getActions().find((a) => a.primary);
    if (primary) hint.say = primary.text;
    const xpdr = this.sim?.in_flight ? this.sim.xpdr : null;
    if (xpdr && this.s.phase !== 'clearance' && xpdr !== this.s.squawk) hint.squawk = `Set transponder to ${this.s.squawk}`;
    const notes = {
      taxiing: 'Taxi to the holding point. Ground hands you to tower when you stop there.',
      takeoff: 'Take off. Tower hands you to departure once airborne.',
      departure_climb: `Climb to ${this.values(unitKey).cleared?.t || 'the cleared level'}. Departure hands you on.`,
      cruise: 'Cruise. Control starts your descent near the top of descent, or request it.',
      descent: 'Descend as cleared. Control hands you to approach.',
      approach: 'Fly the approach. Approach clears you when you are closer.',
      landing: 'Land, then vacate the runway. Tower hands you to ground.',
      taxi_in: 'Taxi to the stand and set the parking brake.',
      done: 'Flight complete. Load a new flight plan for the next flight.',
    };
    if (this.s.pending) hint.note = 'Read back the instruction.';
    else hint.note = notes[this.s.phase] || null;
    return hint;
  }
}

const HANDLERS = {
  clearance: { request_clearance: AtcEngine.prototype.giveClearance },
  startup: { request_pushback: AtcEngine.prototype.givePushback, request_taxi: AtcEngine.prototype.giveTaxi },
  taxi_request: { request_taxi: AtcEngine.prototype.giveTaxi, request_pushback: AtcEngine.prototype.givePushback },
  taxiing: { ready_departure: AtcEngine.prototype.readyDeparture, check_in: AtcEngine.prototype.readyDeparture },
  lineup: { ready_departure: AtcEngine.prototype.giveTakeoff, check_in: AtcEngine.prototype.giveTakeoff },
  takeoff: { check_in: AtcEngine.prototype.airborneHandoff },
  departure: { check_in: AtcEngine.prototype.radarContact },
  enroute_checkin: { check_in: AtcEngine.prototype.centerCheckin },
  cruise: { request_descent: AtcEngine.prototype.giveDescent },
  approach_checkin: { check_in: AtcEngine.prototype.approachCheckin },
  approach: { report_established: AtcEngine.prototype.approachClearance, check_in: AtcEngine.prototype.approachClearance },
  final: { report_established: AtcEngine.prototype.established, check_in: AtcEngine.prototype.established },
  tower_checkin: { check_in: AtcEngine.prototype.giveLanding, report_established: AtcEngine.prototype.giveLanding },
  landing: { runway_vacated: AtcEngine.prototype.vacated },
  taxi_in_request: {
    runway_vacated: AtcEngine.prototype.giveTaxiIn, request_taxi: AtcEngine.prototype.giveTaxiIn,
    check_in: AtcEngine.prototype.giveTaxiIn,
  },
};

const TRIGGERS = {
  taxiing: {
    when(s, now) {
      const end = this.runwayEnd('dep');
      if (!end || end.lat === null || end.lat === undefined) return false;
      const d = distanceNm(s.lat, s.lon, end.lat, end.lon);
      if (d !== null && d < 0.7 && (s.gs_kt ?? 99) < 2) {
        this.s.stoppedSince = this.s.stoppedSince ?? now;
        return now - this.s.stoppedSince > 4000;
      }
      this.s.stoppedSince = null;
      return false;
    },
    fire(now) { return this.handoff('dep_GND', 'dep_TWR', 'taxi_handoff', 'lineup', now); },
  },
  takeoff: {
    when(s) { return s.on_ground === false && (s.alt_agl_ft ?? 0) > 700; },
    fire(now) { return this.airborneHandoff('dep_TWR', now); },
  },
  departure_climb: {
    when(s) {
      const target = this.s.cleared || 15000;
      return !s.on_ground && (s.ind_alt_ft ?? 0) >= target - 2000;
    },
    fire(now) { return this.handoff('dep_DEP', 'CTR', 'climb_handoff', 'enroute_checkin', now); },
  },
  cruise: {
    when(s) {
      const d = this.distToArr();
      if (d === null) return false;
      const tod = ((s.ind_alt_ft ?? 0) - (this.arr?.elevation_ft || 0)) / 1000 * 3 + 10;
      return d < tod;
    },
    fire(now) { return this.giveDescent('CTR', now); },
  },
  descent: {
    when(s) {
      const d = this.distToArr();
      return (s.ind_alt_ft ?? 99999) <= (this.s.cleared || 10000) + 2000 || (d !== null && d < 40);
    },
    fire(now) { return this.handoff('CTR', 'arr_APP', 'approach_handoff', 'approach_checkin', now); },
  },
  approach: {
    when() { const d = this.distToArr(); return d !== null && d < 18; },
    fire(now) { return this.approachClearance('arr_APP', now); },
  },
  final: {
    when() { const d = this.distToArr(); return d !== null && d < 9; },
    fire(now) { return this.handoff('arr_APP', 'arr_TWR', 'final_handoff', 'tower_checkin', now); },
  },
  tower_checkin: {
    when() {
      const d = this.distToArr();
      if (d === null || d > 4) return false;
      if (this.isTunedTo('arr_TWR')) return true;
      if (!this.s.flags.contactNow) {
        this.s.flags.contactNow = true;
        this.s.flags.pendingContactNow = true;
      }
      return false;
    },
    fire(now) { return this.giveLanding('arr_TWR', now); },
  },
  landing: {
    when(s) { return s.on_ground === true && (s.gs_kt ?? 99) < 50; },
    fire(now) { return this.vacated('arr_TWR', now); },
  },
  taxi_in: {
    when(s) { return s.parking_brake === true && (s.gs_kt ?? 99) < 1; },
    fire(now) {
      this.setPhase('done', now);
      this.s.flags.triggered = true;
      return [this.system('Parked. Flight complete, well done.', now)];
    },
  },
};

// "LAM3A" -> "lam three alpha" (TTS reads the waypoint name as a word)
function speakProcedure(name, f) {
  const m = String(name).toUpperCase().match(/^([A-Z]+)(\d+)([A-Z]?)$/);
  if (!m) return { t: name, s: name };
  return { t: name, s: `${m[1].toLowerCase()} ${f.spell(m[2])}${m[3] ? ' ' + PHONETIC[m[3]] : ''}` };
}

function speakApproach(type, f) {
  const t = String(type).toUpperCase();
  if (['ILS', 'VOR', 'NDB', 'RNP', 'GLS'].includes(t)) return t.split('').join(' ');
  if (t === 'RNAV') return 'R-NAV';
  if (t === 'VISUAL') return 'visual';
  return f.spell(t);
}
