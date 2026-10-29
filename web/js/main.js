// OpenATC web app: wiring between the helper connection, the ATC engine,
// the screen, speech output and voice input.

import { AtcEngine, PHASES } from './atc/engine.js';
import { Formatter } from './atc/format.js';
import { loadPhraseology, validatePhraseology } from './atc/phraseology.js';
import { Speaker } from './speech.js';
import { Listener, voiceSupport } from './voice.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------------------------------------------------------------- storage
// localStorage can be missing or throw (private mode); everything still works
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(`openatc.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`openatc.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
  del(key) { try { localStorage.removeItem(`openatc.${key}`); } catch { /* ignore */ } },
};

const settings = {
  tts: true, voiceURI: '', varyVoices: true, rate: 1.05, pitch: 1,
  voiceIn: true, pttMode: 'hold', review: false, lang: 'en-US',
  radio: 'com1', freqCheck: true, strictReadback: true, night: false, wakeLock: true,
  mockFollow: true,
  ...store.get('settings', {}),
};
const saveSettings = () => store.set('settings', settings);

const app = {
  token: store.get('token'),
  ws: null,
  wsOk: false,
  sim: null,
  source: 'none',
  engine: null,
  region: null,
  phr: null,
  airlines: {},
  log: store.get('log', []),
  lastSimAt: 0,
};

const speaker = new Speaker(settings);
let listener = null;

// ---------------------------------------------------------------- helper API
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(app.token ? { Authorization: `Bearer ${app.token}` } : {}) },
  });
  if (res.status === 401) { needPairing(); throw new Error('not paired'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function needPairing() {
  app.token = null;
  store.del('token');
  $('#pair').classList.remove('hidden');
  $('#pair-code').focus();
}

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#pair-error').textContent = '';
  try {
    const res = await fetch('api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('#pair-code').value.trim(), device: navigator.platform || 'iPad' }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'pairing failed');
    app.token = body.token;
    store.set('token', app.token);
    $('#pair').classList.add('hidden');
    connect();
  } catch (err) {
    $('#pair-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- WebSocket
let retry = 1000;
let staleTimer = null;
function connect() {
  if (!app.token) { needPairing(); return; }
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  app.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ token: app.token }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'auth_failed') { needPairing(); ws.close(); return; }
    if (msg.type === 'hello') {
      app.wsOk = true; retry = 1000; app.source = msg.source;
      $('#mock-panel').classList.toggle('hidden', msg.source !== 'mock');
      $('#about').textContent = `Helper ${msg.version}, sim source: ${msg.source}, ${msg.secure ? 'HTTPS' : 'plain HTTP (voice input disabled)'}.`;
      renderStatus();
    }
    if (msg.type === 'sim') onSim(msg.data);
  };
  ws.onclose = () => {
    app.wsOk = false;
    renderStatus();
    if (!app.token) return;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  };
  ws.onerror = () => ws.close();
}

function send(obj) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(obj));
}

function onSim(state) {
  app.sim = state;
  app.lastSimAt = Date.now();
  clearTimeout(staleTimer);
  staleTimer = setTimeout(renderStatus, 5000);
  if (app.engine?.active) handleEvents(app.engine.updateSim(state, Date.now()));
  renderStatus();
  renderData();
  renderRadio();
}

// ---------------------------------------------------------------- phraseology & engine
async function loadRegion(region) {
  if (app.region === region && app.phr) return app.phr;
  const phr = await loadPhraseology(region, async (id) => {
    const res = await fetch(`phraseology/${id}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`phraseology/${id}.json not found`);
    try { return await res.json(); } catch (err) { throw new Error(`phraseology/${id}.json: ${err.message}`); }
  });
  const problems = validatePhraseology(phr);
  if (problems.length) throw new Error(`Phraseology file problems: ${problems.join('; ')}`);
  app.phr = phr;
  app.region = region;
  return phr;
}

async function loadAirlines() {
  try {
    const res = await fetch('data/airlines.json', { cache: 'no-cache' });
    app.airlines = await res.json();
  } catch { app.airlines = {}; }
}

function makeEngine(phr) {
  return new AtcEngine({
    phraseology: phr, airlines: app.airlines,
    options: { freqCheck: settings.freqCheck, strictReadback: settings.strictReadback, radio: settings.radio },
  });
}

function saveEngine() {
  if (app.engine?.active) store.set('engine', { region: app.region, state: app.engine.serialize() });
}

async function startFlight(fp) {
  $('#fp-error').textContent = '';
  const [dep, arr] = await Promise.all([api(`api/airport/${encodeURIComponent(fp.dep)}`),
    api(`api/airport/${encodeURIComponent(fp.arr)}`)]);
  const phr = await loadRegion(fp.region || 'icao');
  app.engine = makeEngine(phr);
  if (app.sim) app.engine.updateSim(app.sim, Date.now());
  app.log = [];
  handleEvents(app.engine.setFlightPlan(fp, dep, arr, Date.now()));
  store.set('fp', fp);
  fetchWeather();
  if (app.source === 'mock') {
    send({ type: 'mock', cmd: 'setup', dep: { lat: dep.lat, lon: dep.lon, elevation_ft: dep.elevation_ft },
      arr: { lat: arr.lat, lon: arr.lon, elevation_ft: arr.elevation_ft }, cruise_ft: app.engine.cruiseFt() });
  }
  saveEngine();
  renderFlightSummary();
  showView('radio');
  renderRadio();
}

let weatherTimer = null;
async function fetchWeather() {
  clearTimeout(weatherTimer);
  const e = app.engine;
  if (!e?.active) return;
  for (const which of ['dep', 'arr']) {
    const icao = which === 'dep' ? e.dep.icao : e.arr.icao;
    try {
      const m = await api(`api/metar/${encodeURIComponent(icao)}`);
      e.setWeather(which, m);
    } catch (err) {
      e.setWeather(which, { available: false, error: err.message });
    }
  }
  renderFlightSummary();
  renderRadio();
  saveEngine();
  weatherTimer = setTimeout(fetchWeather, 15 * 60 * 1000);
}

// ---------------------------------------------------------------- events from the engine
let atcQueue = Promise.resolve();
function handleEvents(events) {
  for (const ev of events) {
    if (ev.kind === 'effect') {
      if (app.source === 'mock' && settings.mockFollow) send({ type: 'mock', ...ev.mock });
      continue;
    }
    if (ev.kind === 'atc') {
      // a short pause before the controller answers, like a real frequency
      atcQueue = atcQueue.then(() => new Promise((resolve) => {
        setTimeout(() => {
          addLog(ev);
          if (ev.heard) speaker.speak(ev.speech, ev.unit);
          resolve();
        }, 900 + Math.random() * 900);
      }));
    } else {
      addLog(ev);
    }
  }
  saveEngine();
  renderRadio();
}

function addLog(ev) {
  app.log.push({ kind: ev.kind, text: ev.text, speech: ev.speech, unit: ev.unit, unitName: ev.unitName,
    freq: ev.freq, heard: ev.heard, t: ev.t || Date.now() });
  if (app.log.length > 300) app.log.splice(0, app.log.length - 300);
  store.set('log', app.log);
  renderLog();
}

// ---------------------------------------------------------------- pilot input
function transmit(text, intent = null) {
  if (!text || !text.trim()) return;
  if (!app.engine?.active) {
    addLog({ kind: 'system', text: 'Start a flight first (Flight plan tab).' });
    showView('flight');
    return;
  }
  speaker.stop();
  handleEvents(app.engine.pilotSays(text.trim(), { intent, now: Date.now() }));
}

$('#type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#type-input');
  transmit(input.value);
  input.value = '';
  input.blur();
});

$('#actions').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-text]');
  if (!b) return;
  transmit(b.dataset.text, b.dataset.intent === 'readback' ? null : b.dataset.intent);
});

$('#skip').addEventListener('click', () => {
  if (app.engine?.canSkip()) handleEvents(app.engine.skip(Date.now()));
});

// ---------------------------------------------------------------- voice input
function setupVoice() {
  listener = new Listener({
    lang: settings.lang,
    onInterim: (t) => { $('#ptt-interim').textContent = t; },
    onFinal: (t) => {
      $('#ptt-interim').textContent = '';
      if (settings.review) { $('#type-input').value = t; $('#type-input').focus(); } else transmit(t);
    },
    onState: (state, detail) => {
      $('#ptt').classList.toggle('live', state === 'listening');
      if (state === 'error') $('#voice-status').textContent = `${detail} Try again or use the buttons.`;
      if (state === 'listening') $('#voice-status').textContent = 'Listening...';
      if (state === 'idle') $('#voice-status').textContent = '';
      if (state === 'disabled') renderVoice();
    },
  });
  renderVoice();
}

function renderVoice() {
  const ptt = $('#ptt');
  const s = voiceSupport();
  let diag = s.ok ? 'Speech recognition API found.' : s.reason;
  if (s.ok && s.standalone) diag += ' Running as a Home Screen app: on some iPadOS versions recognition only works in a normal Safari tab.';
  $('#voice-diag').textContent = diag;
  const off = !settings.voiceIn || !listener || listener.disabled;
  ptt.parentElement.classList.toggle('hidden', !settings.voiceIn);
  ptt.classList.toggle('disabled', off);
  $('#ptt-label').textContent = off ? 'Voice input unavailable' : (settings.pttMode === 'hold' ? 'Hold to talk' : 'Tap to talk');
  $('#voice-status').textContent = settings.voiceIn && listener?.disabled ? listener.reason : '';
}

const ptt = $('#ptt');
ptt.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!listener || listener.disabled) return;
  speaker.stop();
  if (settings.pttMode === 'toggle' && listener.active) { listener.stop(); return; }
  ptt.setPointerCapture?.(e.pointerId);
  listener.start();
});
for (const evName of ['pointerup', 'pointercancel']) {
  ptt.addEventListener(evName, () => {
    if (settings.pttMode === 'hold' && listener?.active) listener.stop();
  });
}
ptt.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- rendering
function fmtFreq(v) { return typeof v === 'number' ? v.toFixed(3) : '---.---'; }

function renderStatus() {
  const helper = $('#st-helper');
  helper.className = `pill ${app.wsOk ? 'good' : 'bad'}`;
  helper.textContent = app.wsOk ? 'Helper' : 'Helper offline';
  const sim = $('#st-sim');
  const s = app.sim;
  const stale = Date.now() - app.lastSimAt > 5000;
  let cls = 'bad'; let label = 'Sim offline';
  if (app.wsOk && s && !stale) {
    if (s.connected && s.in_flight) { cls = 'good'; label = s.source === 'mock' ? 'Mock sim' : 'Sim'; } else if (s.connected) { cls = 'warn'; label = 'Sim: no flight'; }
  } else if (app.wsOk && stale) { cls = 'warn'; label = 'Sim data stale'; }
  sim.className = `pill ${cls}`;
  sim.textContent = label;
  sim.title = s?.message || '';
  const radio = settings.radio;
  $('#st-com').textContent = `${radio.toUpperCase()} ${fmtFreq(s?.[`${radio}_active`])}`;
  $('#st-xpdr').textContent = `XPDR ${s?.xpdr || '----'}`;
  $('#st-phase').textContent = app.engine?.active ? PHASES[app.engine.s.phase].label : 'No flight';
}

function renderRadio() {
  const e = app.engine;
  const hint = e?.active ? e.getHint() : { say: 'Fill in the flight plan to start.', note: '' };
  $('#hint-say').textContent = hint.say ? `“${hint.say}”` : 'Wait for ATC.';
  $('#hint-note').textContent = hint.note || '';
  const tune = $('#hint-tune');
  if (hint.tune) {
    tune.classList.remove('hidden');
    tune.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = hint.tune.text;
    tune.append(span);
    if (app.source === 'mock') {
      const b = document.createElement('button');
      b.textContent = 'Tune (mock)';
      b.addEventListener('click', () => send({ type: 'mock', cmd: 'tune', freq: hint.tune.freq, radio: settings.radio }));
      tune.append(b);
    }
  } else tune.classList.add('hidden');
  $('#hint-missed').classList.toggle('hidden', !hint.missed);
  $('#hint-missed').textContent = hint.missed || '';
  $('#hint-squawk').classList.toggle('hidden', !hint.squawk);
  $('#hint-squawk').textContent = hint.squawk || '';

  const box = $('#actions');
  box.innerHTML = '';
  for (const a of e?.active ? e.getActions() : []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.title = a.text;
    b.dataset.text = a.text;
    b.dataset.intent = a.intent;
    if (a.primary) b.className = 'primary';
    box.append(b);
  }
  $('#skip').classList.toggle('hidden', !(e?.active && e.canSkip()));
  renderStatus();
}

function renderLog() {
  const box = $('#log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = '';
  for (const m of app.log) {
    const div = document.createElement('div');
    div.className = `msg ${m.kind}${m.kind === 'atc' && !m.heard ? ' unheard' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = m.kind === 'atc' ? `${m.unitName} ${Number(m.freq).toFixed(3)}${m.heard ? '' : ' (not heard: you were on another frequency)'}`
      : m.kind === 'pilot' ? `You${typeof m.freq === 'number' ? ' on ' + m.freq.toFixed(3) : ''}` : 'OpenATC';
    const when = new Date(m.t).toISOString().slice(11, 19) + 'Z';
    meta.append(Object.assign(document.createElement('span'), { textContent: who }),
      Object.assign(document.createElement('span'), { textContent: when }));
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.text;
    div.append(meta, body);
    if (m.kind === 'atc') div.addEventListener('click', () => speaker.speak(m.speech, m.unit));
    box.append(div);
  }
  if (atBottom || app.log.length < 3) box.scrollTop = box.scrollHeight;
}

const DATA_ROWS = [
  ['Position', (s) => (typeof s.lat === 'number' ? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}` : '-')],
  ['Altitude (indicated)', (s) => (s.ind_alt_ft != null ? `${Math.round(s.ind_alt_ft)} ft` : '-')],
  ['Altitude above ground', (s) => (s.alt_agl_ft != null ? `${Math.round(s.alt_agl_ft)} ft` : '-')],
  ['Heading (magnetic)', (s) => (s.hdg_mag != null ? `${Math.round(s.hdg_mag)}°` : '-')],
  ['Ground speed', (s) => (s.gs_kt != null ? `${Math.round(s.gs_kt)} kt` : '-')],
  ['Indicated airspeed', (s) => (s.ias_kt != null ? `${Math.round(s.ias_kt)} kt` : '-')],
  ['Vertical speed', (s) => (s.vs_fpm != null ? `${Math.round(s.vs_fpm)} ft/min` : '-')],
  ['On ground', (s) => (s.on_ground == null ? '-' : (s.on_ground ? 'yes' : 'no'))],
  ['COM1 active / standby', (s) => `${fmtFreq(s.com1_active)} / ${fmtFreq(s.com1_standby)}`],
  ['COM2 active / standby', (s) => `${fmtFreq(s.com2_active)} / ${fmtFreq(s.com2_standby)}`],
  ['Transponder', (s) => s.xpdr || '-'],
  ['Parking brake', (s) => (s.parking_brake == null ? '-' : (s.parking_brake ? 'set' : 'released'))],
  ['Flaps handle', (s) => (s.flaps_index == null ? '-' : String(s.flaps_index))],
  ['Gear handle', (s) => (s.gear_down == null ? '-' : (s.gear_down ? 'down' : 'up'))],
];

function renderData() {
  if (!$('#view-data').classList.contains('active')) return;
  const s = app.sim || {};
  const table = $('#data-table');
  table.innerHTML = '';
  for (const [label, fn] of DATA_ROWS) {
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('td'), { textContent: label }),
      Object.assign(document.createElement('td'), { textContent: fn(s) }));
    table.append(tr);
  }
  $('#data-msg').textContent = s.message ? `Helper: ${s.message}` : '';
}

function renderFlightSummary() {
  const e = app.engine;
  const box = $('#fp-summary');
  if (!e?.active) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const f = new Formatter(e.phr);
  const wx = (w) => (w?.available ? w.raw : `no live weather (${w?.error || 'not fetched yet'})`);
  const rw = (r) => (r ? `${r.ident} (${r.reason}${r.headwind != null ? `, headwind ${r.headwind} kt, crosswind ${r.crosswind} kt` : ''})` : 'no runway data: enter one manually');
  const lines = [
    `${e.fp.callsign}: ${e.dep.icao} ${e.dep.name} to ${e.arr.icao} ${e.arr.name}`,
    `Cruise ${f.level(e.cruiseFt()).t}. Squawk ${e.s.squawk}.`,
    `Departure runway: ${rw(e.s.depRunway)}`,
    `Arrival runway: ${rw(e.s.arrRunway)}`,
    `${e.dep.icao} METAR: ${wx(e.metar.dep)}`,
    `${e.arr.icao} METAR: ${wx(e.metar.arr)}`,
    'Frequencies:',
    ...Object.values(e.units).map((u) => `  ${u.name}: ${u.freq} (${u.source})`),
  ];
  box.innerHTML = '<h2>Current flight</h2>';
  const pre = document.createElement('div');
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = lines.join('\n');
  box.append(pre);
}

// ---------------------------------------------------------------- views & forms
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'data') renderData();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

const FP_FIELDS = ['callsign', 'callsignSpoken', 'dep', 'arr', 'cruise', 'initialClimb', 'sid', 'star', 'approach',
  'region', 'route', 'depRunway', 'arrRunway', 'depStand', 'arrStand', 'taxiOut', 'taxiIn', 'depTransitionFt',
  'arrTransitionFt', 'centerName'];
const FREQ_FIELDS = ['CTR', 'dep_DEL', 'dep_GND', 'dep_TWR', 'dep_DEP', 'arr_APP', 'arr_TWR', 'arr_GND'];

function readForm() {
  const form = $('#fp-form');
  const fp = {};
  for (const k of FP_FIELDS) {
    const v = form.elements[k].value.trim();
    if (v) fp[k] = ['callsignSpoken', 'route', 'centerName'].includes(k) ? v : v.toUpperCase();
  }
  if (fp.region) fp.region = fp.region.toLowerCase();
  fp.frequencies = {};
  for (const k of FREQ_FIELDS) {
    const v = form.elements[`f_${k}`].value.trim();
    if (v && !Number.isNaN(Number(v))) fp.frequencies[k] = Number(v).toFixed(3);
  }
  return fp;
}

function fillForm(fp) {
  const form = $('#fp-form');
  for (const k of FP_FIELDS) if (fp[k] !== undefined) form.elements[k].value = fp[k];
  for (const k of FREQ_FIELDS) form.elements[`f_${k}`].value = fp.frequencies?.[k] || '';
}

$('#fp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await startFlight(readForm());
  } catch (err) {
    $('#fp-error').textContent = err.message;
  }
});

$('#fp-demo').addEventListener('click', () => fillForm({
  callsign: 'CCA1234', dep: 'XDEP', arr: 'XARR', cruise: 'FL240', sid: 'DEMO1A', star: 'HARB2B',
  approach: 'ILS', region: 'icao', arrStand: 'B7', route: 'DCT', frequencies: {},
}));

// mock controls
$('#mock-panel').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mock]');
  if (!b) return;
  const cmd = b.dataset.mock;
  if (cmd === 'tune-hint') {
    const h = app.engine?.getHint();
    if (h?.tune) send({ type: 'mock', cmd: 'tune', freq: h.tune.freq, radio: settings.radio });
  } else if (cmd === 'speed') send({ type: 'mock', cmd: 'speed', value: Number(b.dataset.value) });
  else send({ type: 'mock', cmd });
});

// settings
function bindSettings() {
  const bindCheck = (id, key, after) => {
    const el = $(id);
    el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); after?.(); });
  };
  const bindValue = (id, key, after) => {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('change', () => { settings[key] = el.type === 'range' ? Number(el.value) : el.value; saveSettings(); after?.(); });
    el.addEventListener('input', () => after?.());
  };
  const applyEngineOpts = () => {
    app.engine?.setOptions({ freqCheck: settings.freqCheck, strictReadback: settings.strictReadback, radio: settings.radio });
    renderRadio();
  };
  bindCheck('#set-tts', 'tts');
  bindCheck('#set-vary', 'varyVoices');
  bindCheck('#set-voicein', 'voiceIn', () => { listener?.reset(); renderVoice(); });
  bindCheck('#set-review', 'review');
  bindCheck('#set-freqcheck', 'freqCheck', applyEngineOpts);
  bindCheck('#set-strict', 'strictReadback', applyEngineOpts);
  bindCheck('#set-night', 'night', () => document.body.classList.toggle('night', settings.night));
  bindCheck('#set-wakelock', 'wakeLock', requestWakeLock);
  bindCheck('#mock-follow', 'mockFollow');
  bindValue('#set-radio', 'radio', applyEngineOpts);
  bindValue('#set-pttmode', 'pttMode', renderVoice);
  bindValue('#set-lang', 'lang', () => { if (listener) listener.lang = settings.lang; });
  const showRange = () => {
    $('#set-rate-v').textContent = `${Number($('#set-rate').value).toFixed(2)}x`;
    $('#set-pitch-v').textContent = Number($('#set-pitch').value).toFixed(2);
    settings.rate = Number($('#set-rate').value);
    settings.pitch = Number($('#set-pitch').value);
  };
  bindValue('#set-rate', 'rate', showRange);
  bindValue('#set-pitch', 'pitch', showRange);
  showRange();
  const voiceSel = $('#set-voice');
  const fillVoices = () => {
    voiceSel.innerHTML = '';
    voiceSel.append(new Option('Default English voice', ''));
    for (const v of speaker.voices) voiceSel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
    voiceSel.value = settings.voiceURI || '';
  };
  speaker.onVoices = fillVoices;
  fillVoices();
  voiceSel.addEventListener('change', () => { settings.voiceURI = voiceSel.value; saveSettings(); });
  $('#test-voice').addEventListener('click', () => {
    speaker.unlock();
    speaker.speak('Air China one two three four, runway two seven, cleared for take-off.', 'test');
  });
  $('#clear-log').addEventListener('click', () => { app.log = []; store.set('log', []); renderLog(); });
  $('#unpair').addEventListener('click', () => {
    if (!window.confirm('Forget the pairing on this iPad? You will need the code again.')) return;
    store.del('token');
    app.token = null;
    app.ws?.close();
    needPairing();
  });
  document.body.classList.toggle('night', settings.night);
}

// keep the screen on (Screen Wake Lock API, Safari 16.4+; may fail silently)
let wakeLock = null;
async function requestWakeLock() {
  try {
    if (!settings.wakeLock) { await wakeLock?.release(); wakeLock = null; return; }
    if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported or refused: user can set Auto-Lock to Never */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    if (!app.wsOk && app.token) connect();
  }
});

// ---------------------------------------------------------------- start-up
async function restore() {
  const saved = store.get('engine');
  const fp = store.get('fp');
  if (fp) fillForm(fp);
  if (!saved?.state) return;
  try {
    const phr = await loadRegion(saved.region || 'icao');
    app.engine = makeEngine(phr);
    app.engine.restore(saved.state);
    renderFlightSummary();
    fetchWeather();
  } catch (err) {
    addLog({ kind: 'system', text: `Could not restore the last flight: ${err.message}` });
  }
}

$('#start-btn').addEventListener('click', async () => {
  speaker.unlock(); // must happen inside this tap
  $('#start').classList.add('hidden');
  requestWakeLock();
  if (!app.token) needPairing(); else connect();
});

bindSettings();
setupVoice();
renderLog();
await loadAirlines();
await restore();
renderRadio();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
}
