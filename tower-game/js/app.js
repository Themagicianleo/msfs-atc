// Tower Controller: the game page. Wires the simulation, the map, the radio
// log, speech output, push-to-talk voice input, typing and buttons.
// A static site: everything it needs is in this folder.

import { unpackLayout } from './osm.js';
import { chooseConfig, runwayChoices } from './ops.js';
import { taxiwayNames } from './layout.js';
import { Speaker } from './lib/speech.js';
import { Listener, voiceSupport } from './lib/voice.js';
import { understand } from './commands.js';
import { buildLayout, endGeometry } from './layout.js';
import { Renderer, STATE_LABELS } from './render.js';
import { World } from './world.js';
import { M_PER_NM } from './geo.js';
import { generatedWind, liveWind, windText } from './weather.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// localStorage can be missing or throw (private browsing); the game still works
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`tower.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`tower.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

const settings = { tts: true, radioFx: true, rate: 1.15, lang: 'en-US', airport: '', traffic: 'normal', liveWeather: true, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);
// voices vary per aircraft; the Speaker reads these keys
const speakerSettings = { tts: settings.tts, radioFx: settings.radioFx, rate: settings.rate, pitch: 1, varyVoices: true, voiceURI: '' };
const speaker = new Speaker(speakerSettings);

const game = { world: null, phr: null, airlines: {}, speed: 1, selected: null, wind: null, last: 0, index: null };
const renderer = new Renderer($('#map'));

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- airport search
const DEMO = ['DEMO', 'Demo Field (fictional)', 'Demo City', '', 10000];

async function loadIndex() {
  try {
    game.index = await loadJson('data/airports/index.json');
  } catch {
    game.index = [];
    $('#start-note').textContent = 'Airport data is not built here yet (run python tools/build_airports.py). You can play the DEMO airport.';
  }
  game.index.push(DEMO);
}

function searchAirports(q) {
  const t = q.trim().toUpperCase();
  if (!t || !game.index) return [];
  const exact = game.index.filter((a) => a[0] === t);
  const prefix = game.index.filter((a) => a[0] !== t && a[0].startsWith(t));
  const text = t.length >= 3 ? game.index.filter((a) => !a[0].startsWith(t)
    && (a[1].toUpperCase().includes(t) || a[2].toUpperCase().includes(t))) : [];
  return [...exact, ...prefix, ...text].slice(0, 8);
}

function renderSuggestions() {
  const box = $('#suggest');
  box.innerHTML = '';
  for (const a of searchAirports($('#start-icao').value)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.code = a[0];
    b.textContent = `${a[0]}  ${a[1]}${a[2] ? `, ${a[2]}` : ''}${a[3] ? ` (${a[3]})` : ''}`;
    box.append(b);
  }
}
$('#start-icao').addEventListener('input', renderSuggestions);
$('#suggest').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-code]');
  if (!b) return;
  $('#start-icao').value = b.dataset.code;
  $('#suggest').innerHTML = '';
});

document.querySelector('.featured').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-code]');
  if (!b) return;
  $('#start-icao').value = b.dataset.code;
  $('#suggest').innerHTML = '';
  $$('.featured button').forEach((x) => x.classList.toggle('on', x === b));
});

async function loadAirport(code) {
  if (code === 'DEMO') return loadJson('data/demo.json');
  if (!/^[A-Z0-9]{3,4}$/.test(code)) throw new Error('Enter a 3- or 4-letter airport code.');
  try {
    return await loadJson(`data/airports/${code}.json`);
  } catch (err) {
    if (err.message === 'not found') {
      throw new Error(`${code} is not in the game's data (only airports with a runway of at least 1200 m are included).`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- starting a shift
function showWind() {
  const w = game.wind;
  $('#wind').textContent = `${windText(w, game.metric)}${w?.source === 'generated' ? ' (gen.)' : ''}`;
  $('#wind').title = w?.raw ? `METAR: ${w.raw}` : `Wind source: ${w?.source || 'none'}`;
}

// the detailed airports: real layout from OpenStreetMap, real airlines
export const FEATURED = ['WSSS', 'ZBAD', 'KSFO'];

async function loadFeatured(code) {
  const [packed, profile, types] = await Promise.all([loadJson(`data/hq/${code}.json`),
    loadJson(`data/traffic/${code}.json`), loadJson('data/aircraft.json')]);
  return { layout: unpackLayout(packed), profile, types, airport: { ...packed.airport, icao: code } };
}

function fillRunwayMenus(layout, profile, cfg) {
  const choices = runwayChoices(layout, profile);
  for (const [sel, val] of [[$('#arr-rwy'), cfg.arr.join('+')], [$('#dep-rwy'), cfg.dep.join('+')]]) {
    sel.innerHTML = '';
    for (const c of choices) sel.append(new Option(c, c));
    if (![...sel.options].some((o) => o.value === val)) sel.append(new Option(val, val));
    sel.value = val;
  }
}

async function startShift(code, traffic) {
  speaker.unlock(); // inside the tap: Safari needs this for speech
  const featured = FEATURED.includes(code);
  const [phr, phrZh, airlines, hq] = await Promise.all([loadJson('data/phraseology.json'), loadJson('data/phraseology-zh.json'), loadJson('data/airlines.json'),
    featured ? loadFeatured(code).catch(() => null) : null]);
  const airport = hq ? hq.airport : await loadAirport(code);
  let wind = settings.liveWeather && code !== 'DEMO' ? await liveWind(airport.icao) : null;
  if (!wind) wind = generatedWind(airport.icao);
  const layout = hq ? hq.layout : buildLayout(airport);
  const profile = hq?.profile || null;
  // a tower position from the airport's published chart, when we have one
  const tp = profile?.meta?.tower_pos;
  if (tp && layout.proj) layout.towerPos = layout.proj.toXY(tp.lat, tp.lon);
  const cfg = chooseConfig(layout, wind, profile);
  game.phr = phr;
  game.airlines = airlines;
  game.wind = wind;
  game.profile = profile;
  game.known = taxiwayNames(layout);
  // Chinese radio only for airlines marked lang "zh" in the airport's traffic profile
  const chinese = !!profile?.airlines?.some((a) => a.lang === 'zh');
  game.phrZh = chinese ? phrZh : null;
  game.metric = profile?.meta?.units === 'metric';
  setMicLang(chinese ? 'zh-CN' : settings.lang, chinese);
  game.world = new World({ layout, phr, phrZh: game.phrZh, airlines, arrEnd: cfg.arr, depEnd: cfg.dep, traffic, wind,
    profile, types: hq?.types || null,
    unit: profile?.meta?.tower || `${airport.municipality || airport.name || airport.icao} Tower` });
  game.selected = null;
  settings.airport = airport.icao;
  settings.traffic = traffic;
  saveSettings();
  $('#title').textContent = [game.phrZh && profile?.meta?.tower_zh, profile?.meta?.tower || `${airport.icao} Tower`].filter(Boolean).join(' · ');
  $('#traffic').value = traffic;
  fillRunwayMenus(layout, profile, cfg);
  showWind();
  $('#log').innerHTML = '';
  const how = hq ? `Real layout from OpenStreetMap (© OpenStreetMap contributors, ODbL): ${game.known.size} named taxiways, ${layout.gates.length} stands.`
    : 'Taxiways and stands are generated.';
  sys(`${airport.icao} ${airport.name}: runways ${layout.runways.map((r) => r.id).join(', ')}. ${windText(wind)} (${wind.source}). `
    + `${cfg.name}: landing ${cfg.arr.join(' and ')}, departing ${cfg.dep.join(' and ')} (${cfg.reason}). ${how}`);
  renderer.resize();
  renderer.fit(layout);
  $('#start').classList.add('hidden');
  game.last = performance.now();
}

$('#start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#start-error').textContent = '';
  try {
    await startShift($('#start-icao').value.trim().toUpperCase(), $('#start-traffic').value);
  } catch (err) {
    $('#start-error').textContent = err.message;
  }
});

// set the wind by hand (Settings)
$('#wind-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!game.world) return;
  const dir = Number($('#wind-dir').value);
  const kt = Number($('#wind-kt').value);
  if (!(dir >= 0 && dir <= 360 && kt >= 0 && kt <= 60)) return;
  game.wind = { available: true, source: 'set by you', wind_dir: Math.round(dir) % 360 || 360, wind_vrb: false, wind_kt: Math.round(kt), gust_kt: null };
  game.world.wind = game.wind;
  showWind();
  const cfg = chooseConfig(game.world.L, game.wind, game.profile);
  sys(`${windText(game.wind)}. Suggested: ${cfg.name}, landing ${cfg.arr.join(' and ')}, departing ${cfg.dep.join(' and ')} (change with Arr/Dep).`);
});

$('#new-shift').addEventListener('click', () => $('#start').classList.remove('hidden'));
$('#fit').addEventListener('click', () => {
  if (!game.world) return;
  if (game.view === 'map') renderer.fit(game.world.L); else game.scene3d?.reset();
});

// Map (2D), Tower (the cab view) or 3D (orbit camera). three.js loads on first use.
const HINTS = {
  map: 'Drag to pan · pinch or scroll to zoom · tap an aircraft to select it',
  tower: 'Drag to look around · pinch or scroll to zoom (binoculars) · tap an aircraft to select it',
  orbit: 'Drag to orbit · pinch or scroll to zoom · Follow keeps the selected aircraft in view',
};
game.view = 'map';
async function setView(view) {
  if (view !== 'map' && !game.scene3d) {
    try {
      const { Scene3D } = await import('./scene3d.js');
      game.scene3d = new Scene3D($('.map-wrap'));
      game.scene3d.onTap = (q) => {
        if (!game.world) return;
        const ac = game.scene3d.pick(game.world, q);
        game.selected = ac ? ac.id : null;
      };
      window.towerGame.scene3d = game.scene3d;
    } catch (err) {
      sys(`The 3D view could not start on this device (${err.message}). The map still works.`);
      view = 'map';
    }
  }
  game.view = view;
  const three = view !== 'map';
  $('#map').hidden = three;
  game.scene3d?.show(three);
  if (three) game.scene3d.setMode(view);
  $('#chart').hidden = three;
  $('#follow').hidden = view !== 'orbit';
  $('#map-hint').textContent = HINTS[view];
  $$('#view button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === view)));
  if (!three) renderer.resize();
}
$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});
$('#follow').addEventListener('click', () => {
  if (!game.scene3d) return;
  game.scene3d.follow = !game.scene3d.follow;
  if (game.scene3d.follow) game.scene3d.orbit.d = Math.min(game.scene3d.orbit.d, 400);
  $('#follow').classList.toggle('on', game.scene3d.follow);
});
$('#arr-rwy').addEventListener('change', (e) => { game.world?.setRunways(e.target.value.split('+'), game.world.depEnds); sys(`New arrivals will land runway ${e.target.value.replace('+', ' and ')}.`); });
$('#dep-rwy').addEventListener('change', (e) => { game.world?.setRunways(game.world.arrEnds, e.target.value.split('+')); sys(`New departures will use runway ${e.target.value.replace('+', ' and ')}.`); });
$('#chart').addEventListener('click', () => {
  renderer.chart = !renderer.chart;
  $('#chart').classList.toggle('on', renderer.chart);
  $('#chart').textContent = renderer.chart ? 'Radar' : 'Chart';
});
$('#traffic').addEventListener('change', (e) => { game.world?.setTraffic(e.target.value); settings.traffic = e.target.value; saveSettings(); });
$$('.speed button').forEach((b) => b.addEventListener('click', () => {
  game.speed = Number(b.dataset.speed);
  $$('.speed button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));

// Appearance: like the EFB, follow the device unless set to light or dark
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
function applyAppearance() {
  const pick = settings.appearance || 'auto';
  document.documentElement.dataset.theme = pick === 'auto' ? '' : pick;
  renderer.theme = pick === 'auto' ? (darkQuery?.matches ? 'dark' : 'light') : pick;
  $$('#appearance button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.theme === pick)));
}
$('#appearance').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme]');
  if (!b) return;
  settings.appearance = b.dataset.theme;
  saveSettings();
  applyAppearance();
});
darkQuery?.addEventListener?.('change', applyAppearance);
applyAppearance();

// ---------------------------------------------------------------- radio log
function addMsg(cls, who, text, onClick) {
  const box = $('#log');
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  if (who) div.append(Object.assign(document.createElement('span'), { className: 'who', textContent: who }));
  div.append(document.createTextNode(text));
  if (onClick) div.addEventListener('click', onClick);
  box.append(div);
  while (box.children.length > 150) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
const sys = (text, cls = 'sys') => addMsg(cls, '', text);

function handleEvents(events) {
  for (const ev of events) {
    if (ev.kind === 'pilot') {
      addMsg('', ev.callsign, ev.text, () => speaker.speak(ev.speech, `ac${ev.voice}`, ev.lang));
      speaker.speak(ev.speech, `ac${ev.voice}`, ev.lang, { reply: !!(ev.readback || ev.unable) });
    } else if (ev.kind === 'score') {
      sys(`${ev.delta > 0 ? '+' : ''}${ev.delta}  ${ev.reason}`, ev.delta > 0 ? 'good' : 'bad');
    } else if (ev.kind === 'alert') {
      const a = $('#alert');
      a.textContent = ev.text;
      a.classList.remove('hidden');
      clearTimeout(handleEvents.alertTimer);
      handleEvents.alertTimer = setTimeout(() => a.classList.add('hidden'), 6000);
    }
  }
}

// ---------------------------------------------------------------- giving instructions
function issueText(text) {
  const w = game.world;
  if (!w || !text.trim()) return;
  addMsg('you', 'You', text.trim());
  speaker.fx.click();
  const u = understand(text, w.ac, game.phr.commands, game.selected, game.known, game.phrZh?.commands || null);
  if (u.error) {
    if (u.ac) w.readback(u.ac, 'say_again');
    sys(u.error, 'bad');
    handleEvents(w.drain());
    return;
  }
  game.selected = u.ac.id;
  w.command(u.ac.id, u.cmd);
  handleEvents(w.drain());
}

function issueButton(type) {
  const w = game.world;
  const ac = w?.find(game.selected);
  if (!ac) return;
  addMsg('you', 'You', w.controllerText(ac, type));
  speaker.fx.click();
  w.command(ac.id, { type });
  handleEvents(w.drain());
}

$('#cmd-form').addEventListener('submit', (e) => {
  e.preventDefault();
  issueText($('#cmd-input').value);
  $('#cmd-input').value = '';
});

renderer.onTap = (pos, q) => {
  if (!game.world) return;
  if (game.plan) { planTap(q); return; }
  const ac = renderer.pick(game.world, q);
  game.selected = ac ? ac.id : null;
};

// ---------------------------------------------------------------- choosing the taxi route
// Tap taxiways on the map in the order the aircraft should use them; tap a
// holding point (departures) or a stand (arrivals) to change where it goes.
function startPlan() {
  const ac = game.world?.find(game.selected);
  if (!ac) return;
  if (game.view !== 'map') setView('map');
  game.plan = { id: ac.id, waypoints: [], runway: ac.kind === 'dep' ? ac.end : null, gate: ac.kind === 'arr' ? ac.gate : null };
  $('#plan').hidden = false;
  updatePlan();
}

function endPlan() {
  game.plan = null;
  $('#plan').hidden = true;
}

function updatePlan() {
  const p = game.plan;
  const w = game.world;
  const ac = w?.find(p?.id);
  if (!p || !ac) { endPlan(); return; }
  p.at = performance.now();
  const r = w.planTaxi(ac, p);
  if (!r) {
    if (!w.planTaxi(ac, {})) { endPlan(); return; } // it can't taxi any more
    p.waypoints.pop(); // that point can't be reached: forget it
    p.result = w.planTaxi(ac, p);
  } else p.result = r;
  const res = p.result;
  const dest = ac.kind === 'dep' ? `holding point runway ${res.runway}` : `stand ${res.gate}`;
  const cross = res.cross.length ? ` · crosses runway ${res.cross.join(', ')}` : '';
  $('#plan-text').innerHTML = '';
  $('#plan-text').append(
    Object.assign(document.createElement('b'), { textContent: `${ac.callsign}: ` }),
    `${res.via.length ? `via ${res.via.join(', ')} ` : ''}to ${dest}${cross}`,
    Object.assign(document.createElement('span'), { className: 'muted small',
      textContent: p.waypoints.length ? '' : ` — tap taxiways to route through, ${ac.kind === 'dep' ? 'a holding point' : 'a stand'} to change the destination` }),
  );
  $('#plan-cross').parentElement.hidden = !res.cross.length;
}

function planTap(q) {
  const p = game.plan;
  const w = game.world;
  const ac = w.find(p.id);
  if (!ac) { endPlan(); return; }
  const L = w.L;
  const g = L.graph;
  const px = (id) => { const s = renderer.toScreen(g.nodes[id].p); return Math.hypot(s[0] - q[0], s[1] - q[1]); };
  if (ac.kind === 'dep') {
    const hp = Object.entries(L.holdPoints).map(([end, h]) => ({ end, d: px(h.h) })).sort((a, b) => a.d - b.d)[0];
    if (hp && hp.d < 22) { p.runway = hp.end; updatePlan(); return; }
  } else {
    const st = L.gates.map((x) => ({ id: x.id, d: px(x.node) })).sort((a, b) => a.d - b.d)[0];
    if (st && st.d < 16) { p.gate = st.id; updatePlan(); return; }
  }
  let best = null;
  g.nodes.forEach((n, i) => {
    if (n.kind === 'rwy' || n.kind === 'gate') return;
    const d = px(i);
    if (d < 30 && (!best || d < best.d)) best = { i, d };
  });
  if (!best) return;
  p.waypoints.push(best.i);
  updatePlan();
}

$('#plan-undo').addEventListener('click', () => { game.plan?.waypoints.pop(); updatePlan(); });
$('#plan-clear').addEventListener('click', () => { if (game.plan) game.plan.waypoints = []; updatePlan(); });
$('#plan-cancel').addEventListener('click', endPlan);
$('#plan-send').addEventListener('click', () => {
  const p = game.plan;
  const w = game.world;
  const ac = w?.find(p?.id);
  if (!ac || !p.result) { endPlan(); return; }
  const res = p.result;
  const cross = $('#plan-cross').checked ? res.cross : [];
  addMsg('you', 'You', w.taxiText(ac, res, cross.length > 0));
  speaker.fx.click();
  w.command(ac.id, { type: 'taxi', waypoints: p.waypoints, via: res.via, runway: res.runway, gate: res.gate, cross });
  handleEvents(w.drain());
  endPlan();
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && game.plan) endPlan(); });

// ---------------------------------------------------------------- side panel
const REQ_TEXT = { land: 'wants landing clearance', push: 'requests pushback', taxi: 'ready to taxi',
  takeoff: 'ready for departure', taxi_in: 'requests taxi to stand', cross: 'holding short, wants to cross',
  contact: 'wants frequency change' };

const isAnswer = (req, type) => req && ({ land: 'land', push: 'push', taxi: 'taxi_out', takeoff: 'takeoff',
  taxi_in: 'taxi_in', cross: 'cross', contact: 'contact' })[req.type] === type;

function stripState(a) {
  const d = game.metric ? `${(a.dist / 1000).toFixed(1)}km` : `${(a.dist / M_PER_NM).toFixed(1)}NM`;
  return a.state === 'final' ? `FINAL ${d}${a.cleared.land ? ' CLR' : ''}` : (STATE_LABELS[a.state] || a.state);
}

// The panel is rebuilt only when something structural changes, so a tap is
// never lost on an element that was just replaced; distances update in place.
let lastSel = '';
let lastStrips = '';
function renderPanel() {
  const w = game.world;
  if (!w) return;
  const ac = w.find(game.selected);
  if (!ac && game.selected != null) game.selected = null;
  const selKey = JSON.stringify([game.selected, ac?.state, ac?.req?.type, ac?.hold, ac?.crossings?.map((c) => c.cleared), ac?.cleared]);
  if (selKey !== lastSel) {
    lastSel = selKey;
    $('#sel-cs').textContent = ac ? `${ac.cs.t}  (${ac.callsign} ${ac.type.code})` : 'No aircraft selected';
    $('#sel-state').textContent = ac ? (STATE_LABELS[ac.state] || ac.state) + (ac.end ? ` · RWY ${ac.end}` : '') + (ac.gate ? ` · ${ac.gate}` : '') : '';
    $('#sel-req').textContent = ac?.req ? `Request: ${REQ_TEXT[ac.req.type] || ac.req.type}` : '';
    const box = $('#sel-buttons');
    box.innerHTML = '';
    if (ac) {
      if (w.planTaxi(ac, {})) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.type = 'plan';
        b.textContent = 'Choose route on map';
        b.title = 'Tap the taxiways the aircraft should use';
        box.append(b);
      }
      for (const type of w.available(ac)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.type = type;
        b.textContent = w.phrOf(ac).buttons[type] || game.phr.buttons[type] || type;
        b.title = w.controllerText(ac, type);
        if (isAnswer(ac.req, type)) b.className = 'primary';
        box.append(b);
      }
    }
  }
  const stripKey = JSON.stringify([game.selected, w.ac.map((a) => [a.id, a.state, a.req?.type, a.cleared.land, a.end])]);
  const strips = $('#strips');
  if (stripKey !== lastStrips) {
    lastStrips = stripKey;
    strips.innerHTML = '';
    const order = [...w.ac].sort((a, b) => (b.req ? 1 : 0) - (a.req ? 1 : 0) || a.id - b.id);
    for (const a of order) {
      const d = document.createElement('div');
      d.className = `strip ${a.kind}${a.id === game.selected ? ' sel' : ''}${a.req ? ' req' : ''}`;
      d.dataset.id = a.id;
      d.append(Object.assign(document.createElement('span'), { className: 'cs', textContent: a.callsign }),
        Object.assign(document.createElement('span'), { className: 'st', textContent: '' }),
        Object.assign(document.createElement('span'), { className: 'rq', textContent: a.req ? '● call' : '' }));
      strips.append(d);
    }
  }
  for (const d of strips.children) {
    const a = w.find(Number(d.dataset.id));
    if (!a) continue;
    const route = a.other ? (a.kind === 'arr' ? ` from ${a.other}` : ` to ${a.other}`) : '';
    const txt = `${a.type.code} · ${stripState(a)} · ${a.kind === 'arr' ? 'ARR' : 'DEP'} ${a.end || ''}${route}`;
    const st = d.querySelector('.st');
    if (st.textContent !== txt) st.textContent = txt;
  }
}

// one listener per container (elements inside are replaced over time)
$('#sel-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-type]');
  if (b?.dataset.type === 'plan') startPlan();
  else if (b) issueButton(b.dataset.type);
});
$('#strips').addEventListener('click', (e) => {
  const d = e.target.closest('.strip');
  if (d) game.selected = Number(d.dataset.id);
});

// ---------------------------------------------------------------- voice
const listener = new Listener({
  lang: settings.lang,
  onInterim: (t) => { $('#ptt-interim').textContent = t; },
  onFinal: (t) => { $('#ptt-interim').textContent = ''; issueText(t); },
  onState: (state, detail) => {
    $('#ptt').classList.toggle('live', state === 'listening');
    setTalkLabel(state === 'listening');
    if (state === 'listening') $('#voice-status').textContent = 'Listening...';
    else if (state === 'error') $('#voice-status').textContent = `${detail} Try again, or type / use the buttons.`;
    else if (state === 'disabled') renderVoice();
    else $('#voice-status').textContent = '';
  },
});

// microphone language: Chinese for Chinese airlines at ZBAD, English otherwise
function setMicLang(lang, show) {
  listener.lang = lang;
  const box = $('#mic-lang');
  box.hidden = !show;
  box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === lang)));
}
$('#mic-lang').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-lang]');
  if (b) setMicLang(b.dataset.lang, true);
});

function renderVoice() {
  const s = voiceSupport();
  $('#voice-diag').textContent = s.ok ? `Speech recognition available${s.standalone ? ' (Home Screen app: if it fails, use a Safari tab)' : ''}.` : s.reason;
  $('#ptt').classList.toggle('disabled', listener.disabled);
  if (listener.disabled) $('#ptt-label').textContent = 'Voice unavailable: type or use buttons';
  else setTalkLabel(listener.active);
  if (listener.disabled) $('#voice-status').textContent = listener.reason;
}

// One tap starts listening, the next tap stops and sends (no holding, so the
// phone doesn't start selecting text). Recognition also ends by itself after
// a pause, and what was heard is sent then.
function setTalkLabel(live) {
  if (listener.disabled) return;
  $('#ptt-label').textContent = live ? 'Stop and send' : 'Start talking';
  $('#ptt').setAttribute('aria-pressed', String(!!live));
}
const ptt = $('#ptt');
const startTalk = () => { if (!listener.disabled && !listener.active) { speaker.stop(); listener.start(); setTalkLabel(true); } };
const stopTalk = () => { if (listener.active) listener.stop(); setTalkLabel(false); };
ptt.addEventListener('click', () => (listener.active ? stopTalk() : startTalk()));
ptt.addEventListener('contextmenu', (e) => e.preventDefault());
// PC: hold the space bar to talk (not while typing in a field)
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') stopTalk(); });

$('#set-tts').checked = settings.tts;
$('#set-radio').checked = settings.radioFx;
$('#set-radio').addEventListener('change', (e) => { settings.radioFx = speakerSettings.radioFx = e.target.checked; saveSettings(); });
$('#set-tts').addEventListener('change', (e) => { settings.tts = speakerSettings.tts = e.target.checked; saveSettings(); if (!e.target.checked) speaker.stop(); });
$('#set-rate').value = settings.rate;
$('#set-rate').addEventListener('change', (e) => { settings.rate = speakerSettings.rate = Number(e.target.value); saveSettings(); });
$('#set-lang').value = settings.lang;
$('#set-lang').addEventListener('change', (e) => { settings.lang = listener.lang = e.target.value; saveSettings(); });

// ---------------------------------------------------------------- main loop
function frame(now) {
  const w = game.world;
  if (w) {
    let dt = Math.min(0.25, (now - game.last) / 1000) * game.speed;
    while (dt > 0) {
      const step = Math.min(dt, 0.2);
      w.step(step);
      dt -= step;
    }
    handleEvents(w.drain());
    if (game.plan && now - (game.plan.at || 0) > 1000) updatePlan();
    if (game.view === 'map') renderer.draw(w, { selectedId: game.selected, now, plan: game.plan?.result });
    else game.scene3d.draw(w, { selectedId: game.selected, now, theme: renderer.theme });
    renderPanel();
    $('#score').textContent = w.score;
    const t = Math.floor(w.t);
    $('#clock').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    $('#score').title = `Arrived ${w.stats.arrived}, departed ${w.stats.departed}, go-arounds ${w.stats.goArounds}, conflicts ${w.stats.conflicts}`;
  }
  game.last = now;
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => { renderer.resize(); game.scene3d?.resize(); });
renderer.resize();
renderVoice();
$('#start-icao').value = settings.airport || '';
$('#start-traffic').value = settings.traffic || 'normal';
$('#set-live').checked = settings.liveWeather;
$('#set-live').addEventListener('change', (e) => { settings.liveWeather = e.target.checked; saveSettings(); });
loadIndex();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
requestAnimationFrame(frame);

// for the end-to-end test
window.towerGame = { game, endGeometry, renderer };
