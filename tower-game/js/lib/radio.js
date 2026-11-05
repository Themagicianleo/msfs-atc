// Radio sound around the pilots' speech: a squelch burst when they key the
// mic, a faint band-limited hiss while they talk, and the squelch tail when
// they let go. The browser's speech itself can't be filtered (speechSynthesis
// doesn't go through Web Audio), so this is what makes it sound like a radio.

export class RadioFx {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.bed = null;
  }

  // must run inside a tap on iOS
  unlock() {
    const ctx = this.context();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
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
    if (!ctx || !this.enabled || ctx.state !== 'running') return;
    const { src, gain } = this.source(freq, 0.8);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.008);
    gain.gain.setValueAtTime(level, t + seconds * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + seconds);
    src.start(t, Math.random());
    src.stop(t + seconds + 0.05);
  }

  // the pilot presses the transmit button
  keyUp(level = 1) {
    this.keyDown(true);
    const ctx = this.context();
    if (!ctx || !this.enabled || ctx.state !== 'running') return;
    this.burst(0.07, 0.18 * level);
    const { src, gain } = this.source(1600, 0.6);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.03 * level, t + 0.05);
    src.start(t, Math.random());
    this.bed = { src, gain };
    clearTimeout(this.bedTimer);
    this.bedTimer = setTimeout(() => this.keyDown(true), 20000); // never hiss forever
  }

  // ...and lets go: the squelch tail
  keyDown(quiet = false) {
    clearTimeout(this.bedTimer);
    const b = this.bed;
    this.bed = null;
    if (!b || !this.ctx) return;
    const t = this.ctx.currentTime;
    b.gain.gain.cancelScheduledValues(t);
    b.gain.gain.setValueAtTime(b.gain.gain.value, t);
    b.gain.gain.linearRampToValueAtTime(0, t + 0.04);
    b.src.stop(t + 0.06);
    if (!quiet) this.burst(0.14, 0.22, 2600);
  }

  // the controller's own transmit click
  click() { this.burst(0.035, 0.12, 3000); }
}
