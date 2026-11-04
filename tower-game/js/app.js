// Tower Controller: the game page. Wires the simulation, the map, the radio
// log, speech output, push-to-talk voice input, typing and buttons.
// A static site: everything it needs is in this folder.

import { selectRunway } from './lib/runway.js';
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

const settings = { tts: true, rate: 1.15, lang: 'en-US', airport: '', traffic: 'normal', liveWeather: true, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);
// voices vary per aircraft; the Speaker reads these keys
const speakerSettings = { tts: settings.tts, rate: settings.rate, pitch: 1, varyVoices: true, voiceURI: '' };
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
  $('#wind').textContent = `${windText(w)}${w?.source === 'generated' ? ' (gen.)' : ''}`;
  $('#wind').title = w?.raw ? `METAR: ${w.raw}` : `Wind source: ${w?.source || 'none'}`;
}

async function startShift(code, traffic) {
  speaker.unlock(); // inside the tap: Safari needs this for speech
  const [airport, phr, airlines] = await Promise.all([loadAirport(code), loadJson('data/phraseology.json'), loadJson('data/airlines.json')]);
  let wind = settings.liveWeather && code !== 'DEMO' ? await liveWind(airport.icao) : null;
  if (!wind) wind = generatedWind(airport.icao);
  const layout = buildLayout(airport);
  const ends = layout.runways.flatMap((r) => [
    { ident: r.identA, heading: r.headingA, length_ft: r.len / 0.3048 },
    { ident: r.identB, heading: r.headingB, length_ft: r.len / 0.3048 }]);
  const pick = selectRunway(ends, wind) || { ident: ends[0].ident, reason: 'first runway' };
  game.phr = phr;
  game.airlines = airlines;
  game.wind = wind;
  game.world = new World({ layout, phr, airlines, arrEnd: pick.ident, depEnd: pick.ident, traffic, wind,
    unit: `${airport.municipality || airport.name || airport.icao} Tower` });
  game.selected = null;
  settings.airport = airport.icao;
  settings.traffic = traffic;
  saveSettings();
  $('#title').textContent = `${airport.icao} Tower`;
  $('#traffic').value = traffic;
  for (const sel of [$('#arr-rwy'), $('#dep-rwy')]) {
    sel.innerHTML = '';
    for (const e of ends) sel.append(new Option(e.ident, e.ident));
    sel.value = pick.ident;
  }
  showWind();
  $('#log').innerHTML = '';
  sys(`${airport.icao} ${airport.name}: runways ${layout.runways.map((r) => r.id).join(', ')}. ${windText(wind)} (${wind.source}). `
    + `Landing and departing ${pick.ident} (${pick.reason}). Taxiways and stands are generated.`);
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
  const ends = game.world.L.runways.flatMap((r) => [{ ident: r.identA, heading: r.headingA, length_ft: r.len / 0.3048 },
    { ident: r.identB, heading: r.headingB, length_ft: r.len / 0.3048 }]);
  const pick = selectRunway(ends, game.wind);
  sys(`${windText(game.wind)}. Best runway now: ${pick.ident} (change it with Arr/Dep).`);
});

$('#new-shift').addEventListener('click', () => $('#start').classList.remove('hidden'));
$('#fit').addEventListener('click', () => game.world && renderer.fit(game.world.L));
$('#arr-rwy').addEventListener('change', (e) => { game.world?.setRunways(e.target.value, game.world.depEnd); sys(`New arrivals will land runway ${e.target.value}.`); });
$('#dep-rwy').addEventListener('change', (e) => { game.world?.setRunways(game.world.arrEnd, e.target.value); sys(`New departures will use runway ${e.target.value}.`); });
$('#traffic').addEventListener('change', (e) => { game.world?.setTraffic(e.target.value); settings.traffic = e.target.value; saveSettings(); });
$$('.speed button').forEach((b) => b.addEventListener('click', () => {
  game.speed = Number(b.dataset.speed);
  $$('.speed button').forEach((x) => x.classList.toggle('on', x === b));
}));

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
      addMsg('', ev.callsign, ev.text, () => speaker.speak(ev.speech, `ac${ev.voice}`));
      speaker.speak(ev.speech, `ac${ev.voice}`);
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
  const u = understand(text, w.ac, game.phr.commands, game.selected);
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
  const ac = renderer.pick(game.world, q);
  game.selected = ac ? ac.id : null;
};

// ---------------------------------------------------------------- side panel
const REQ_TEXT = { land: 'wants landing clearance', push: 'requests pushback', taxi: 'ready to taxi',
  takeoff: 'ready for departure', taxi_in: 'requests taxi to stand', cross: 'holding short, wants to cross',
  contact: 'wants frequency change' };

const isAnswer = (req, type) => req && ({ land: 'land', push: 'push', taxi: 'taxi_out', takeoff: 'takeoff',
  taxi_in: 'taxi_in', cross: 'cross', contact: 'contact' })[req.type] === type;

function stripState(a) {
  return a.state === 'final' ? `FINAL ${(a.dist / M_PER_NM).toFixed(1)}NM${a.cleared.land ? ' CLR' : ''}` : (STATE_LABELS[a.state] || a.state);
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
      for (const type of w.available(ac)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.type = type;
        b.textContent = game.phr.buttons[type] || type;
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
    const txt = `${stripState(a)} · ${a.kind === 'arr' ? 'ARR' : 'DEP'} ${a.end || ''}`;
    const st = d.querySelector('.st');
    if (st.textContent !== txt) st.textContent = txt;
  }
}

// one listener per container (elements inside are replaced over time)
$('#sel-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-type]');
  if (b) issueButton(b.dataset.type);
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
    if (state === 'listening') $('#voice-status').textContent = 'Listening...';
    else if (state === 'error') $('#voice-status').textContent = `${detail} Try again, or type / use the buttons.`;
    else if (state === 'disabled') renderVoice();
    else $('#voice-status').textContent = '';
  },
});

function renderVoice() {
  const s = voiceSupport();
  $('#voice-diag').textContent = s.ok ? `Speech recognition available${s.standalone ? ' (Home Screen app: if it fails, use a Safari tab)' : ''}.` : s.reason;
  $('#ptt').classList.toggle('disabled', listener.disabled);
  $('#ptt-label').textContent = listener.disabled ? 'Voice unavailable: type or use buttons' : 'Hold to talk (or hold Space)';
  if (listener.disabled) $('#voice-status').textContent = listener.reason;
}

const ptt = $('#ptt');
const startTalk = () => { if (!listener.disabled && !listener.active) { speaker.stop(); listener.start(); } };
const stopTalk = () => { if (listener.active) listener.stop(); };
ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture?.(e.pointerId); startTalk(); });
ptt.addEventListener('pointerup', stopTalk);
ptt.addEventListener('pointercancel', stopTalk);
ptt.addEventListener('contextmenu', (e) => e.preventDefault());
// PC: hold the space bar to talk (not while typing in a field)
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') stopTalk(); });

$('#set-tts').checked = settings.tts;
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
    renderer.draw(w, { selectedId: game.selected, now });
    renderPanel();
    $('#score').textContent = w.score;
    const t = Math.floor(w.t);
    $('#clock').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    $('#score').title = `Arrived ${w.stats.arrived}, departed ${w.stats.departed}, go-arounds ${w.stats.goArounds}, conflicts ${w.stats.conflicts}`;
  }
  game.last = now;
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());
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
window.towerGame = { game, endGeometry };
