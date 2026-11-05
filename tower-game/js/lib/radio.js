// Radio sound around the pilots' speech: a squelch burst when they key the
// mic, a faint band-limited hiss while they talk, and the squelch tail when
// they let go. The browser's speech itself can't be filtered (speechSynthesis
// doesn't go through Web Audio), so this is what makes it sound like a radio.

function hash(key) {
  let h = 2166136261;
  for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// one aircraft's radio: its squelch click and tail, the colour of its hiss,
// and (one in eight) a faint whistle
export function radioCharacter(key) {
  const f = (name, lo, hi) => lo + ((hash(`${name}|${key}|${name}`) % 1000) / 1000) * (hi - lo);
  return {
    click: f('click', 0.04, 0.11), tail: f('tail', 0.09, 0.24), squelch: f('squelch', 1700, 3200), band: f('band', 1100, 2400),
    q: f('q', 0, 0.6), whistle: f('whistle?', 0, 1) < 0.125 ? f('whistle', 700, 1600) : 0,
  };
}

export class RadioFx {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.bed = null;
  }

  // must run inside a tap on iOS
  unlock() {
    // iOS: play even with the ring/silent switch on, like speech does
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older Safari */ }
    const ctx = this.context();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    this.sleepSoon();
  }

  // An audio engine that is running keeps the phone's audio hardware and a CPU thread busy even when
  // nothing plays, so it is switched off a few seconds after the last transmission and back on
  // (a few milliseconds) before the next one.
  wake() {
    const ctx = this.context();
    if (!ctx) return Promise.resolve(false);
    clearTimeout(this.sleepTimer);
    this.sleepSoon(); // (if nothing then plays, it goes back to sleep)
    return ctx.state === 'running' ? Promise.resolve(true) : ctx.resume().then(() => ctx.state === 'running', () => false);
  }

  sleepSoon() {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => {
      if (this.ctx && !this.bed && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    }, 4000);
  }

  context() {
    if (this.ctx) return this.ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    this.ctx = new AC();
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  // noise through a radio-like band-pass, with an envelope
  source(freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(bp).connect(gain).connect(ctx.destination);
    return { src, gain };
  }

  burst(seconds, level, freq = 2200) {
    const ctx = this.context();
    if (!ctx || !this.enabled) return;
    if (ctx.state !== 'running') { this.wake().then((ok) => { if (ok) this.burst(seconds, level, freq); }); return; }
    const { src, gain } = this.source(freq, 0.8);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.008);
    gain.gain.setValueAtTime(level, t + seconds * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + seconds);
    src.start(t, Math.random());
    src.stop(t + seconds + 0.05);
  }

  // the pilot presses the transmit button. Each aircraft's radio sounds a bit
  // different (key), and a far one (range, metres) is weaker and noisier.
  keyUp({ key = '', range = 3000 } = {}) {
    this.keyDown(true);
    const ctx = this.context();
    if (!ctx || !this.enabled) return;
    if (ctx.state !== 'running') { this.wake().then((ok) => { if (ok) this.keyUp({ key, range }); }); return; }
    const ch = radioCharacter(key);
    const far = Math.min(1, range / 20000);
    this.tail = ch.tail;
    this.burst(ch.click, 0.16 + 0.08 * far, ch.squelch);
    const { src, gain } = this.source(ch.band, 0.5 + ch.q);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.014 + 0.05 * far, t + 0.05);
    src.start(t, Math.random());
    const bed = { src, gain, extra: [] };
    // an old radio's whistle, now and then
    if (ch.whistle) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = ch.whistle;
      g.gain.value = 0.004 + 0.006 * far;
      o.connect(g).connect(ctx.destination);
      o.start(t);
      bed.extra.push(o);
    }
    this.bed = bed;
    // crackle on a weak signal
    clearInterval(this.crackle);
    if (far > 0.3) this.crackle = setInterval(() => { if (Math.random() < far * 0.6) this.burst(0.02 + Math.random() * 0.03, 0.05 + 0.1 * far, 1800 + Math.random() * 1500); }, 260);
    clearTimeout(this.bedTimer);
    this.bedTimer = setTimeout(() => this.keyDown(true), 20000); // never hiss forever
  }

  // ...and lets go: the squelch tail
  keyDown(quiet = false) {
    clearTimeout(this.bedTimer);
    clearInterval(this.crackle);
    const b = this.bed;
    this.bed = null;
    if (!b || !this.ctx) return;
    const t = this.ctx.currentTime;
    b.gain.gain.cancelScheduledValues(t);
    b.gain.gain.setValueAtTime(b.gain.gain.value, t);
    b.gain.gain.linearRampToValueAtTime(0, t + 0.04);
    b.src.stop(t + 0.06);
    for (const o of b.extra) o.stop(t + 0.05);
    if (!quiet) this.burst(this.tail || 0.14, 0.22, 2600);
    this.sleepSoon();
  }

  // play generated speech (built-in voices) through the radio: band-limited
  // to what an airband radio passes, a little overdriven and compressed, with
  // the squelch and static around it. Resolves when it has finished; false
  // if the sound can't play (audio not unlocked yet).
  play(pcm, sampleRate, { pitch = 1, volume = 1, key = '', range = 3000 } = {}) {
    const ctx = this.context();
    if (!ctx) return Promise.resolve(false);
    if (ctx.state !== 'running') return this.wake().then((ok) => (ok ? this.play(pcm, sampleRate, { pitch, volume, key, range }) : false));
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;
    const out = ctx.createGain();
    out.gain.value = volume;
    if (this.enabled) {
      const ch = radioCharacter(key);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 280 + ch.q * 150;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2700 + ch.q * 900;
      const peak = ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = ch.band; peak.gain.value = 5; peak.Q.value = 1;
      const drive = ctx.createWaveShaper();
      const k = 2 + 4 * Math.min(1, range / 20000); // weaker signal, rougher sound
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i += 1) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
      drive.curve = curve;
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -24; comp.ratio.value = 6;
      src.connect(hp).connect(lp).connect(peak).connect(drive).connect(comp).connect(out);
      out.gain.value = volume * 0.8;
    } else src.connect(out);
    out.connect(ctx.destination);
    return new Promise((resolve) => {
      src.onended = () => { this.keyDown(); resolve(true); };
      this.keyUp({ key, range });
      src.start(ctx.currentTime + 0.06);
    });
  }

  // the controller's own transmit click
  click() { this.burst(0.035, 0.12, 3000); this.sleepSoon(); }
}
