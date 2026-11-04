// OpenATC Tower: the game page. Wires the simulation, the map, the radio
// log, speech output, push-to-talk voice input, typing and buttons.

import { selectRunway } from '../atc/runway.js';
import { Speaker } from '../speech.js';
import { Listener, voiceSupport } from '../voice.js';
import { understand } from './commands.js';
import { buildLayout, endGeometry } from './layout.js';
import { Renderer, STATE_LABELS } from './render.js';
import { World } from './world.js';
import { M_PER_NM } from './geo.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`openatc.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`openatc.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(`openatc.${k}`); } catch { /* ignore */ } },
};

const settings = { tts: true, rate: 1.15, lang: 'en-US', airport: '', traffic: 'normal', ...store.get('tower', {}) };
const saveSettings = () => store.set('tower', settings);
// voices vary per aircraft; the shared Speaker reads these keys
const speakerSettings = { tts: settings.tts, rate: settings.rate, pitch: 1, varyVoices: true, voiceURI: '' };
const speaker = new Speaker(speakerSettings);

const game = { world: null, phr: null, airlines: {}, speed: 1, selected: null, metar: null, last: 0, token: store.get('token') };
const renderer = new Renderer($('#map'));

// ---------------------------------------------------------------- helper API
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json',
    ...(game.token ? { Authorization: `Bearer ${game.token}` } : {}) } });
  if (res.status === 401) { showPairing(); throw new Error('This device is not paired yet.'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function showPairing() {
  game.token = null;
  store.del('token');
  $('#pair').classList.remove('hidden');
}

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('#pair-code').value.trim(), device: 'Tower game' }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'pairing failed');
    game.token = body.token;
    store.set('token', game.token);
    $('#pair').classList.add('hidden');
  } catch (err) { $('#pair-error').textContent = err.message; }
});

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- starting a shift
async function startShift(icao, traffic) {
  speaker.unlock(); // inside the tap: Safari needs this for speech
  const [airport, phr, airlines] = await Promise.all([
    api(`/api/airport/${encodeURIComponent(icao)}`), loadJson('/phraseology/tower.json'), loadJson('/data/airlines.json')]);
  let metar = null;
  try { metar = await api(`/api/metar/${encodeURIComponent(icao)}`); } catch { metar = null; }
  const layout = buildLayout(airport);
  const ends = layout.runways.flatMap((r) => [
    { ident: r.identA, heading: r.headingA, length_ft: r.len / 0.3048 },
    { ident: r.identB, heading: r.headingB, length_ft: r.len / 0.3048 }]);
  const pick = selectRunway(ends, metar) || { ident: ends[0].ident };
  game.phr = phr;
  game.airlines = airlines;
  game.metar = metar;
  game.world = new World({ layout, phr, airlines, arrEnd: pick.ident, depEnd: pick.ident, traffic, wind: metar });
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
  $('#wind').textContent = metar?.available
    ? `Wind ${metar.wind_dir == null ? 'VRB' : String(metar.wind_dir).padStart(3, '0')}/${metar.wind_kt}kt`
    : 'Wind: no live METAR';
  $('#log').innerHTML = '';
  sys(`${airport.icao} ${airport.name}: runways ${layout.runways.map((r) => r.id).join(', ')}. Landing and departing ${pick.ident} (${pick.reason}). Taxiways and stands are generated.`);
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
if (!game.token) showPairing();
requestAnimationFrame(frame);

// for the end-to-end test
window.openatcTower = { game, endGeometry };
