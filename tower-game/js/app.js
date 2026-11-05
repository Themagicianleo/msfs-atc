// Tower Controller: the game page. Wires the simulation, the map, the radio
// log, speech output, push-to-talk voice input, typing and buttons.
// A static site: everything it needs is in this folder.

import { unpackLayout } from './osm.js';
import { chooseConfig, endWinds, runwayPlans } from './ops.js';
import { taxiwayNames } from './layout.js';
import { Speaker } from './lib/speech.js';
import { MODELS, NeuralVoices, cachedModels, deleteVoices, modelsFor } from './lib/neural.js';
import { Listener, voiceSupport } from './lib/voice.js';
import { understand, understandBest } from './commands.js';
import { recognitionHints } from './lib/hints.js';
import { buildLayout, endGeometry } from './layout.js';
import { Renderer, STATE_LABELS } from './render.js';
import { World, taxiDestination } from './world.js';
import { VERSION } from './version.js';
import { M_PER_NM } from './geo.js';
import { generatedWind, liveWind, windText } from './weather.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// localStorage can be missing or throw (private browsing); the game still works
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`tower.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`tower.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

const settings = { effects: 'auto', voiceQuality: 'best', tts: true, radioFx: true, accents: true, builtinVoices: false, autoRunways: false, rate: 1.15, lang: 'en-US', airport: '', traffic: 'normal', liveWeather: true, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);
// voices vary per aircraft; the Speaker reads these keys
const speakerSettings = { efficient: settings.voiceQuality === 'efficient', tts: settings.tts, radioFx: settings.radioFx, accents: settings.accents, builtinVoices: settings.builtinVoices, rate: settings.rate, pitch: 1, varyVoices: true, voiceURI: '' };
const speaker = new Speaker(speakerSettings);
speaker.neural = new NeuralVoices();

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

// Step 1 of starting a shift: load the airport, the layout and the weather
async function prepareShift(code, traffic) {
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
  return { code, traffic, phr, phrZh, airlines, hq, airport, wind, layout, profile, metric: profile?.meta?.units === 'metric' };
}

// Step 2: which runways land and depart. The plan for the wind is recommended;
// every runway end can be switched on or off for landing and for departures.
const rwy = { ctx: null, mode: 'start', arr: new Set(), dep: new Set(), plans: [] };

const speedUnit = (metric) => (metric ? 'm/s' : 'kt');
const speedOf = (kt, metric) => (metric ? Math.round(kt * 0.514444) : kt);

function showStartForm() {
  $('#rwy-step').hidden = true;
  $('#start-form').hidden = false;
  $('#start').classList.remove('hidden');
}

function openRunwayStep(mode, ctx = null) {
  const world = game.world;
  rwy.mode = mode;
  rwy.ctx = ctx;
  const layout = ctx ? ctx.layout : world.L;
  const wind = ctx ? ctx.wind : game.wind;
  const profile = ctx ? ctx.profile : game.profile;
  rwy.layout = layout;
  rwy.wind = wind;
  rwy.metric = ctx ? ctx.metric : game.metric;
  rwy.plans = runwayPlans(layout, wind, profile);
  const rec = rwy.plans[0];
  const now = mode === 'game' ? { arr: world.arrEnds, dep: world.depEnds } : rec;
  rwy.arr = new Set(now.arr);
  rwy.dep = new Set(now.dep);
  const where = ctx ? `${ctx.airport.icao} ${ctx.airport.name}` : $('#title').textContent;
  $('#rwy-title').textContent = mode === 'game' ? 'Runways in use' : `${where}: runways in use`;
  const src = wind?.source === 'generated' ? 'generated for this hour, no live METAR' : (wind?.source || 'no wind');
  $('#rwy-wind').textContent = `${windText(wind, rwy.metric)} (${src}). The recommended plan is for this wind.`;
  $('#rwy-begin').textContent = mode === 'game' ? 'Apply' : 'Begin shift';
  $('#rwy-back').textContent = mode === 'game' ? 'Cancel' : 'Back';
  $('#rwy-auto-row').hidden = mode === 'game';
  $('#rwy-auto').checked = !!settings.autoRunways;
  $('#rwy-error').textContent = '';
  renderRunwayStep();
  $('#start-form').hidden = true;
  $('#rwy-step').hidden = false;
  $('#start').classList.remove('hidden');
}

const sameSet = (set, list) => set.size === list.length && list.every((x) => set.has(x));

function renderRunwayStep() {
  // best headwind first, so the runways to use are at the front
  const winds = endWinds(rwy.layout, rwy.wind).map((e, i) => ({ ...e, i }))
    .sort((a, b) => (b.headwind ?? -99) - (a.headwind ?? -99) || a.i - b.i);
  const unit = speedUnit(rwy.metric);
  $('#rwy-rec-label').textContent = rwy.wind?.wind_kt ? `(for ${windText(rwy.wind, rwy.metric).replace(/^Wind /, '')})` : '';
  const plans = $('#rwy-plans');
  plans.innerHTML = '';
  rwy.plans.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plan';
    b.dataset.plan = String(i);
    b.setAttribute('aria-pressed', String(sameSet(rwy.arr, p.arr) && sameSet(rwy.dep, p.dep)));
    const hw = p.headwind == null ? '' : (p.headwind >= 0 ? `, headwind ${speedOf(p.headwind, rwy.metric)} ${unit}` : `, TAILWIND ${speedOf(-p.headwind, rwy.metric)} ${unit}`);
    b.innerHTML = `${i === 0 ? '<span class="rec">Recommended</span>' : ''}<b></b><small></small>`;
    b.querySelector('b').textContent = p.name;
    b.querySelector('small').textContent = `Landing ${p.arr.join(' + ')} · departing ${p.dep.join(' + ')} · ${p.reason}${hw}`;
    plans.append(b);
  });
  for (const [box, set, key] of [[$('#rwy-arr'), rwy.arr, 'arr'], [$('#rwy-dep'), rwy.dep, 'dep']]) {
    box.innerHTML = '';
    for (const e of winds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${e.headwind != null && e.headwind < -2 ? ' tail' : ''}`;
      b.dataset.role = key;
      b.dataset.end = e.ident;
      b.setAttribute('aria-pressed', String(set.has(e.ident)));
      const w = e.headwind == null ? `${(e.length_m / 1000).toFixed(1)} km`
        : `${e.headwind >= 0 ? 'head' : 'tail'} ${speedOf(Math.abs(e.headwind), rwy.metric)} · cross ${speedOf(e.crosswind, rwy.metric)}`;
      b.innerHTML = '<b></b><small></small>';
      b.querySelector('b').textContent = e.ident;
      b.querySelector('small').textContent = w;
      box.append(b);
    }
  }
  const tail = winds.filter((e) => (rwy.arr.has(e.ident) || rwy.dep.has(e.ident)) && e.headwind != null && e.headwind < -5);
  $('#rwy-note').textContent = tail.length
    ? `Tailwind of more than 5 ${unit} on ${tail.map((e) => e.ident).join(', ')}: real controllers would avoid it.`
    : 'Landing and departing on the same runway works but is busier. New arrivals and departures use the runways in turn; aircraft already on final or at their stand keep theirs until told otherwise.';
}

$('#rwy-plans').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-plan]');
  if (!b) return;
  const p = rwy.plans[Number(b.dataset.plan)];
  rwy.arr = new Set(p.arr);
  rwy.dep = new Set(p.dep);
  $('#rwy-error').textContent = '';
  renderRunwayStep();
});
$('#rwy-step').addEventListener('click', (e) => {
  const b = e.target.closest('button.chip');
  if (!b) return;
  const set = b.dataset.role === 'arr' ? rwy.arr : rwy.dep;
  if (set.has(b.dataset.end)) set.delete(b.dataset.end); else set.add(b.dataset.end);
  $('#rwy-error').textContent = '';
  renderRunwayStep();
});
$('#rwy-back').addEventListener('click', () => {
  if (rwy.mode === 'game') $('#start').classList.add('hidden'); else showStartForm();
  $('#rwy-step').hidden = true;
  if (rwy.mode !== 'game') $('#start-form').hidden = false;
});
$('#rwy-step').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!rwy.arr.size || !rwy.dep.size) { $('#rwy-error').textContent = 'Choose at least one runway for landing and one for departures.'; return; }
  const order = (set) => rwy.layout.runways.flatMap((r) => [r.identA, r.identB]).filter((id) => set.has(id));
  const arr = order(rwy.arr);
  const dep = order(rwy.dep);
  const plan = rwy.plans.find((p) => sameSet(rwy.arr, p.arr) && sameSet(rwy.dep, p.dep));
  const cfg = plan || { name: 'Your choice', arr, dep, reason: 'chosen by you' };
  if (rwy.mode === 'game') {
    game.world.setRunways(arr, dep);
    showRunways(arr, dep);
    sys(`Runways changed: landing ${arr.join(' and ')}, departing ${dep.join(' and ')}. New arrivals and departures use them; aircraft already on final or waiting at a stand keep theirs.`);
    $('#start').classList.add('hidden');
    $('#rwy-step').hidden = true;
    return;
  }
  settings.autoRunways = $('#rwy-auto').checked;
  $('#set-askrwy').checked = !settings.autoRunways;
  saveSettings();
  beginShift(rwy.ctx, { ...cfg, arr, dep });
});
$('#rwy-open').addEventListener('click', () => { if (game.world) openRunwayStep('game'); });

function showRunways(arr, dep) {
  $('#rwy-open').textContent = `Arr ${arr.join('+')} · Dep ${dep.join('+')}`;
}

// Step 3: start with the chosen runways
function beginShift(ctx, cfg) {
  const { traffic, phr, phrZh, airlines, hq, airport, wind, layout, profile } = ctx;
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
  showRunways(cfg.arr, cfg.dep);
  showWind();
  $('#log').innerHTML = '';
  const how = hq ? `Real layout from OpenStreetMap (© OpenStreetMap contributors, ODbL): ${game.known.size} named taxiways, ${layout.gates.length} stands.`
    : 'Taxiways and stands are generated.';
  sys(`${airport.icao} ${airport.name}: runways ${layout.runways.map((r) => r.id).join(', ')}. ${windText(wind, game.metric)} (${wind.source}). `
    + `${cfg.name}: landing ${cfg.arr.join(' and ')}, departing ${cfg.dep.join(' and ')} (${cfg.reason}). ${how}`);
  renderer.resize();
  renderer.fit(layout);
  $('#rwy-step').hidden = true;
  $('#start-form').hidden = false;
  $('#start').classList.add('hidden');
  game.last = performance.now();
  ensureVoices();
}

$('#start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#start-error').textContent = '';
  const go = e.submitter || $('#start-form button[type=submit]');
  const label = go.textContent;
  go.disabled = true;
  go.textContent = 'Loading airport and weather...';
  try {
    const ctx = await prepareShift($('#start-icao').value.trim().toUpperCase(), $('#start-traffic').value);
    if (settings.autoRunways) beginShift(ctx, chooseConfig(ctx.layout, ctx.wind, ctx.profile));
    else openRunwayStep('start', ctx);
  } catch (err) {
    $('#start-error').textContent = err.message;
  } finally {
    go.disabled = false;
    go.textContent = label;
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
  sys(`${windText(game.wind, game.metric)}. Recommended for this wind: ${cfg.name}, landing ${cfg.arr.join(' and ')}, departing ${cfg.dep.join(' and ')} (change with the Runways button).`);
});

$('#new-shift').addEventListener('click', showStartForm);
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
      const radio = { airline: ev.airline, range: ev.range };
      addMsg('', ev.callsign, ev.text, () => speaker.speak(ev.speech, `ac${ev.voice}`, ev.lang, radio));
      speaker.speak(ev.speech, `ac${ev.voice}`, ev.lang, { reply: !!(ev.readback || ev.unable), ...radio });
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
// alternatives: the recogniser's other guesses (voice only); the first that is a full instruction is used
function issueText(text, alternatives = []) {
  const w = game.world;
  if (!w || !text.trim()) return;
  const u = understandBest([text, ...alternatives.filter((a) => a !== text)], w.ac, game.phr.commands, game.selected, game.known, game.phrZh?.commands || null);
  addMsg('you', 'You', u.text.trim());
  speaker.fx.click();
  if (u.error) {
    if (u.ac) w.readback(u.ac, 'say_again');
    // for Chinese, show how the game read it, so a misheard digit or letter is easy to spot
    const read = u.heard && u.heard !== u.text.trim() ? ` 听成：「${u.heard}」` : '';
    sys(`${u.error}${read}`, 'bad');
    handleEvents(w.drain());
    return;
  }
  game.selected = u.ac.id;
  w.command(u.ac.id, u.cmd);
  handleEvents(w.drain());
}

function issueButton(type, runway = null) {
  const w = game.world;
  const ac = w?.find(game.selected);
  if (!ac) return;
  addMsg('you', 'You', w.controllerText(ac, type, runway ? { runway: w.rwy(ac, runway) } : {}));
  speaker.fx.click();
  w.command(ac.id, runway ? { type, runway } : { type });
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

// ---------------------------------------------------------------- built-in voices
// Downloads (once per device) the voice models this airport's airlines need.
let voiceJob = null;
function airportAirlines() {
  if (game.profile?.airlines) return game.profile.airlines.map((a) => ({ code: a.code, lang: game.phrZh ? (a.lang || 'en') : 'en' }));
  return Object.keys(game.airlines || {}).filter((k) => /^[A-Z]{3}$/.test(k)).map((code) => ({ code, lang: 'en' }));
}

async function renderBuiltin(progress = null) {
  const st = $('#builtin-status');
  const bar = $('#builtin-progress');
  bar.hidden = !progress;
  if (progress) {
    bar.max = progress.total; bar.value = progress.done;
    st.textContent = `Downloading built-in voices: ${Math.round(progress.done)} of ${Math.round(progress.total)} MB${progress.label ? ` (${progress.label})` : ''}. The device's voices are used until then.`;
    return;
  }
  const ready = [...(speaker.neural?.ready || [])];
  const cached = await cachedModels();
  $('#builtin-delete').hidden = !cached.length;
  if (!settings.builtinVoices) {
    st.textContent = cached.length ? `Downloaded on this device: ${cached.map((k) => MODELS[k].label).join('; ')}.` : 'Off: pilots use this device\'s own voices.';
    return;
  }
  st.textContent = ready.length
    ? `Ready: ${ready.map((k) => `${MODELS[k].label} (${MODELS[k].voices} voice${MODELS[k].voices > 1 ? 's' : ''})`).join('; ')}.`
    : 'Built-in voices load when a shift starts.';
}

function ensureVoices() {
  if (!settings.builtinVoices || !game.world || voiceJob) { renderBuiltin(); return; }
  const keys = modelsFor(airportAirlines());
  if (keys.every((k) => speaker.neural.ready.has(k))) { renderBuiltin(); return; }
  const fresh = keys.filter((k) => !speaker.neural.ready.has(k));
  voiceJob = speaker.neural.load(keys, (done, total, label) => renderBuiltin({ done, total, label }))
    .then(() => {
      voiceJob = null;
      renderBuiltin();
      if (fresh.length) sys(`Built-in voices ready: ${fresh.map((k) => MODELS[k].label).join('; ')}.`);
    }, async (err) => {
      voiceJob = null;
      await renderBuiltin();
      const some = speaker.neural.ready.size ? `${$('#builtin-status').textContent} Missing: ` : 'Couldn\'t load the built-in voices: ';
      $('#builtin-status').textContent = `${some}${err.message}. The device's voices fill in; the download is tried again at the next shift.`;
    });
}

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
  const selKey = JSON.stringify([game.selected, ac?.state, ac?.gate, ac?.end, w.depEnds.join('+'), ac?.req?.type, ac?.hold, ac?.crossings?.map((c) => c.cleared), ac?.cleared]);
  if (selKey !== lastSel) {
    lastSel = selKey;
    $('#sel-cs').textContent = ac ? `${ac.cs.t}  (${ac.callsign} ${ac.type.code})` : 'No aircraft selected';
    $('#sel-state').textContent = ac ? (STATE_LABELS[ac.state] || ac.state) + (ac.end ? ` · RWY ${ac.end}` : '') + (ac.gate ? ` · ${ac.gate}` : '') : '';
    const dest = ac && taxiDestination(ac);
    const req = ac?.req ? `Request: ${REQ_TEXT[ac.req.type] || ac.req.type}` : '';
    $('#sel-req').textContent = [req, dest ? `Going to ${dest.long}` : ''].filter(Boolean).join(' · ');
    const box = $('#sel-buttons');
    box.innerHTML = '';
    if (ac) {
      if (w.canPlanTaxi(ac)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.type = 'plan';
        b.textContent = 'Choose route on map';
        b.title = 'Tap the taxiways the aircraft should use';
        box.append(b);
      }
      for (const type of w.available(ac)) {
        // pushback: the runway to expect. With several departure runways, one button for each.
        const runways = type === 'push' ? w.pushRunways(ac) : [];
        for (const run of runways.length > 1 ? runways : [null]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.type = type;
          const label = w.phrOf(ac).buttons[type] || game.phr.buttons[type] || type;
          b.textContent = run ? `${label} · RWY ${run}` : label;
          b.title = w.controllerText(ac, type, run ? { runway: w.rwy(ac, run) } : {});
          if (run) b.dataset.runway = run;
          if (isAnswer(ac.req, type) && (!run || run === ac.end)) b.className = 'primary';
          box.append(b);
        }
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
    const dest = taxiDestination(a);
    const rwy = dest?.kind === 'runway' ? '' : ` ${a.end || ''}`; // the runway is already in the destination
    const txt = `${a.type.code} · ${stripState(a)}${dest ? ` → ${dest.short}` : ''} · ${a.kind === 'arr' ? 'ARR' : 'DEP'}${rwy}${route}`;
    const st = d.querySelector('.st');
    if (st.textContent !== txt) st.textContent = txt;
  }
}

// one listener per container (elements inside are replaced over time)
$('#sel-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-type]');
  if (b?.dataset.type === 'plan') startPlan();
  else if (b) issueButton(b.dataset.type, b.dataset.runway || null);
});
$('#strips').addEventListener('click', (e) => {
  const d = e.target.closest('.strip');
  if (d) game.selected = Number(d.dataset.id);
});

// ---------------------------------------------------------------- voice
const listener = new Listener({
  lang: settings.lang,
  onInterim: (t) => { $('#ptt-interim').textContent = t; },
  // the instruction goes in first, so the pilot's readback is queued before the calls that waited for the key
  onFinal: (t, alts) => { $('#ptt-interim').textContent = ''; issueText(t, alts); speaker.release(); },
  onState: (state, detail) => {
    $('#ptt').classList.toggle('live', state === 'listening');
    setTalkLabel(state === 'listening');
    if (state === 'listening') $('#voice-status').textContent = 'Listening... (other aircraft are muted while you talk)';
    else if (state === 'error') $('#voice-status').textContent = `${detail} Try again, or type / use the buttons.`;
    else if (state === 'disabled') renderVoice();
    else $('#voice-status').textContent = '';
    if (state === 'error' || state === 'disabled') speaker.release();
  },
  // sends as soon as the words so far are a whole instruction and have stopped changing
  isComplete: (t) => {
    const w = game.world;
    if (!w) return false;
    const u = understand(t, w.ac, game.phr.commands, game.selected, game.known, game.phrZh?.commands || null);
    if (u.error || /(\bvia|\band|\bthen|\btaxiway|\bcross|\bshort( of)?|经|然后|穿越|在)$/i.test(t.trim())) return false;
    return u.cmd.type === 'taxi' ? 1200 : 700;
  },
  // what the recogniser should listen for: callsigns on frequency, the ICAO alphabet, this airport's taxiways
  getHints: () => {
    const w = game.world;
    return recognitionHints({ aircraft: w?.ac || [], taxiways: game.known || [], zh: listener.lang.toLowerCase().startsWith('zh') });
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
// Pressing the key mutes the radio, like a real one: nobody else is heard while you transmit.
const startTalk = () => { if (!listener.disabled && !listener.active) { speaker.mute(); listener.start(); setTalkLabel(true); } };
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
$$('#voicequality button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.vq === settings.voiceQuality)));
$('#voicequality').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-vq]');
  if (!b) return;
  settings.voiceQuality = b.dataset.vq;
  speakerSettings.efficient = b.dataset.vq === 'efficient';
  saveSettings();
  $$('#voicequality button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  speaker.stop();
});
$('#set-askrwy').checked = !settings.autoRunways;
$('#set-askrwy').addEventListener('change', (e) => { settings.autoRunways = !e.target.checked; saveSettings(); });
$('#set-accents').checked = settings.accents;
$('#set-builtin').checked = settings.builtinVoices;
$('#set-builtin').addEventListener('change', (e) => {
  settings.builtinVoices = speakerSettings.builtinVoices = e.target.checked;
  saveSettings();
  if (e.target.checked) ensureVoices(); else renderBuiltin();
});
$('#builtin-delete').addEventListener('click', async () => {
  await deleteVoices();
  speaker.neural?.worker?.terminate();
  speaker.neural = new NeuralVoices();
  voiceJob = null;
  settings.builtinVoices = speakerSettings.builtinVoices = false;
  $('#set-builtin').checked = false;
  saveSettings();
  renderBuiltin();
});
renderBuiltin();
$('#set-accents').addEventListener('change', (e) => { settings.accents = speakerSettings.accents = e.target.checked; saveSettings(); });
$('#set-radio').addEventListener('change', (e) => { settings.radioFx = speakerSettings.radioFx = e.target.checked; saveSettings(); });
$('#set-tts').addEventListener('change', (e) => { settings.tts = speakerSettings.tts = e.target.checked; saveSettings(); if (!e.target.checked) speaker.stop(); });
$('#set-rate').value = settings.rate;
$('#set-rate').addEventListener('change', (e) => { settings.rate = speakerSettings.rate = Number(e.target.value); saveSettings(); });
$('#set-lang').value = settings.lang;
$('#set-lang').addEventListener('change', (e) => { settings.lang = listener.lang = e.target.value; saveSettings(); });

// ---------------------------------------------------------------- main loop
// ---------------------------------------------------------------- speed
// A phone that redraws 60 times a second gets hot, and aircraft move slowly. The
// simulation runs on real time; the picture is drawn 30 times a second on a
// touch device (as often as the screen on a laptop), only when something
// changes while paused, and every frame while you pan or zoom (that is cheap).
// If the device still can't keep up the game lowers its own detail, step by step.
const COARSE = !!window.matchMedia?.('(pointer: coarse)').matches;
// minInterval: the shortest time between pictures the game has been forced to by a struggling device
const perf = { minInterval: 0, level: 0 };
// How often a picture is drawn. Aircraft move slowly, so on a touch device a normal-speed game
// needs 20 a second, and only a fast-forwarded one 30 (a laptop draws every frame it can).
const drawInterval = () => Math.max(perf.minInterval, COARSE ? (game.view !== 'map' || game.speed < 2 ? 50 : 33) : 0);
const PANEL_MS = 150;
let lastDraw = 0;
let lastPanel = 0;
let lastSig = '';

// Visual effects: Fast (flat controls, no blur) or Full (glass). Automatic is Fast on touch devices.
function applyEffects() {
  const pick = settings.effects || 'auto';
  const fast = pick === 'fast' || (pick === 'auto' && (COARSE || perf.level >= 1));
  document.documentElement.classList.toggle('solid', fast);
  $$('#effects button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.fx === pick)));
  $('#fx-note').textContent = pick === 'auto' ? `Automatic: ${fast ? 'Fast' : 'Full'} on this device${perf.level ? ' (the game lowered its detail because the device was struggling)' : ''}.`
    : (pick === 'fast' ? 'Flat controls, no blur: coolest and fastest.' : 'Glass effects: look best, use more power.');
}
$('#effects').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fx]');
  if (!b) return;
  settings.effects = b.dataset.fx;
  perf.level = 0;
  saveSettings();
  applyEffects();
});
applyEffects();

// the screen's frame rate over the last second or two; if it is low while playing, do less
const deltas = [];
let slowWindows = 0;
function watchFrameRate(delta) {
  if (document.hidden || !game.world || game.speed === 0) { deltas.length = 0; slowWindows = 0; return; }
  if (delta < 250) deltas.push(delta); // a stall (e.g. a map redraw) is not the frame rate
  if (deltas.length < 90) return;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  deltas.length = 0;
  slowWindows = median > 40 ? slowWindows + 1 : 0; // (iOS Low Power Mode runs the screen at 30 fps: not struggling)
  if (slowWindows < 2) return;
  slowWindows = 0;
  perf.level += 1;
  if (perf.level === 1 && (settings.effects || 'auto') === 'auto' && !document.documentElement.classList.contains('solid')) {
    applyEffects(); // 1: flat controls
    sys('The device is struggling, so the game switched to Fast visual effects.');
  } else if (renderer.maxDpr !== 1.25 && (renderer.maxDpr || 2) > 1.25) {
    renderer.maxDpr = (renderer.maxDpr || 2) > 1.5 ? 1.5 : 1.25; // 2: fewer pixels
    renderer.resize();
    if (game.scene3d) game.scene3d.maxDpr = renderer.maxDpr;
    game.scene3d?.resize();
    applyEffects();
    sys('The device is still struggling, so the game lowered the picture resolution.');
  } else if (perf.minInterval < 1000 / 15) {
    perf.minInterval = perf.minInterval ? 1000 / 15 : 1000 / 20; // 3: fewer pictures
    sys(`The device is still struggling, so the game draws ${perf.minInterval > 55 ? 15 : 20} pictures a second.`);
  }
}

// what is on screen, so a paused game redraws only when it changed
const signature = (w) => `${game.selected}|${game.view}|${game.plan?.result?.nodes?.length ?? ''}|${w.ac.length}|${renderer.theme}|${renderer.chart}|${game.scene3d?.mode}`;

// what the game spends, for the Performance readout in Settings
const stats = { since: performance.now(), rafs: 0, draws: 0, jsMs: 0, talk0: 0, work0: 0 };
function frame(now) {
  const started = performance.now();
  stats.rafs += 1;
  const w = game.world;
  watchFrameRate(now - game.last);
  if (w) {
    let dt = Math.min(0.25, (now - game.last) / 1000) * game.speed;
    while (dt > 0) {
      const step = Math.min(dt, 0.2);
      w.step(step);
      dt -= step;
    }
    handleEvents(w.drain());
    const interacting = now - (renderer.viewChangedAt || 0) < 250 || (game.scene3d?.pointers?.size > 0);
    const sig = signature(w);
    const due = interacting || sig !== lastSig || now - lastDraw >= (game.speed === 0 ? 500 : drawInterval()) - 3;
    if (due) {
      stats.draws += 1;
      lastDraw = now;
      lastSig = sig;
      if (game.plan && now - (game.plan.at || 0) > 1000) updatePlan();
      if (game.view === 'map') renderer.draw(w, { selectedId: game.selected, now, plan: game.plan?.result });
      else game.scene3d.draw(w, { selectedId: game.selected, now, theme: renderer.theme });
    }
    if (now - lastPanel >= PANEL_MS) {
      lastPanel = now;
      renderPanel();
      $('#score').textContent = w.score;
      const t = Math.floor(w.t);
      $('#clock').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      $('#score').title = `Arrived ${w.stats.arrived}, departed ${w.stats.departed}, go-arounds ${w.stats.goArounds}, conflicts ${w.stats.conflicts}`;
    }
  }
  game.last = now;
  stats.jsMs += performance.now() - started;
  requestAnimationFrame(frame);
}

// the Performance readout: updated once a second while the Settings section is open
const settingsBox = document.querySelector('details.settings');
let perfTimer = null;
function perfReport() {
  const t = performance.now();
  const dt = (t - stats.since) / 1000 || 1;
  const talk = speaker.talkMs || 0;
  const work = speaker.neural?.workMs || 0;
  const lines = [
    `Screen ${(stats.rafs / dt).toFixed(0)} frames/s, pictures ${(stats.draws / dt).toFixed(0)}/s${game.speed === 0 ? ' (paused)' : ''}`,
    `Game code (main thread): ${(stats.jsMs / dt / 10).toFixed(1)}% of a second`,
    `Speaking: ${((talk - stats.talk0) / dt / 10).toFixed(0)}% of the time${settings.builtinVoices ? `, built-in voices computing ${((work - stats.work0) / dt / 10).toFixed(0)}%` : ' (device voices)'}`,
    `View ${game.view} · effects ${document.documentElement.classList.contains('solid') ? 'Fast' : 'Full'}${perf.level ? ` (lowered ${perf.level}x)` : ''} · resolution up to ${renderer.maxDpr || 2}x · radio sound ${settings.radioFx ? 'on' : 'off'} · audio engine ${speaker.fx.ctx?.state || 'off'}`,
    `Aircraft ${game.world ? game.world.ac.length : 0} · game speed ${game.speed}x · touch device ${COARSE ? 'yes' : 'no'}`,
    `Version ${VERSION}`,
  ];
  Object.assign(stats, { since: t, rafs: 0, draws: 0, jsMs: 0, talk0: talk, work0: work });
  $('#perf-report').textContent = lines.join('\n');
}
settingsBox?.addEventListener('toggle', () => {
  clearInterval(perfTimer);
  if (settingsBox.open) { Object.assign(stats, { since: performance.now(), rafs: 0, draws: 0, jsMs: 0, talk0: speaker.talkMs || 0, work0: speaker.neural?.workMs || 0 }); perfTimer = setInterval(perfReport, 1000); }
});
$('#perf-copy').addEventListener('click', () => navigator.clipboard?.writeText($('#perf-report').textContent).catch(() => {}));
$('#version').textContent = `Version ${VERSION}`;

// A page that stays open keeps running the version it loaded. Look for a newer one now and then.
let lastUpdateCheck = 0;
async function checkForUpdate() {
  if (VERSION === 'dev' || Date.now() - lastUpdateCheck < 120000) return;
  lastUpdateCheck = Date.now();
  try {
    const text = await (await fetch(`js/version.js?${Date.now()}`, { cache: 'no-store' })).text();
    const latest = text.match(/VERSION = '([^']+)'/)?.[1];
    if (latest && latest !== VERSION) $('#update-bar').hidden = false;
  } catch { /* offline: nothing to say */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
$('#update-reload').addEventListener('click', async () => {
  try { for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.update(); } catch { /* ignore */ }
  location.reload();
});
setTimeout(checkForUpdate, 3000);

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
window.towerGame = { game, endGeometry, renderer, speaker };
