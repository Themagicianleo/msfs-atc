// Spoken pilot calls with the browser's built-in speech synthesis.
// Safari only plays speech after the first speak() call that happens inside a
// user gesture, so unlock() must be called from a tap handler.
//
// To sound less like one robot: each pilot gets one of the device's better
// voices (novelty and very old voices are left out), a slightly different
// pitch and pace, answers after a short human pause, and talks over the radio
// sounds in radio.js.

import { RadioFx } from './radio.js';

// macOS / iOS joke voices and the old "Eloquence" set: never for pilots
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|fred|princess|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

export function voiceScore(v) {
  const name = v.name || '';
  if (NOVELTY.test(name)) return -100;
  let s = 0;
  if (/premium|enhanced|natural|neural|siri/i.test(name)) s += 40; // Apple's downloadable and Edge's neural voices
  if (/online/i.test(name)) s += 30; // Microsoft "... Online (Natural)"
  if (/google/i.test(name)) s += 25; // Chrome's network voices
  if (/^(samantha|daniel|karen|moira|tessa|rishi|serena|arthur|martha|catherine|gordon|aaron|nicky|evan|zoe|tom|ava|allison|susan|joelle|nathan|noelle|oliver|stephanie|ting-ting|tingting|lili|yu-shu|meijia|sinji)\b/i.test(name)) s += 15;
  if (v.localService === false) s += 3;
  return s;
}

// the better voices of a language, best first
export function rankVoices(voices, langPrefix) {
  const want = langPrefix.toLowerCase();
  return voices
    .filter((v) => (v.lang || '').toLowerCase().replace('_', '-').startsWith(want))
    .map((v) => ({ v, s: voiceScore(v) }))
    .filter((x) => x.s > -50)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v);
}

function hash(key) {
  let h = 2166136261;
  for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// a stable, different pitch and pace per pilot
export function pilotVoiceShape(key) {
  const h = hash(key);
  return { pitch: 0.86 + ((h % 1000) / 1000) * 0.3, rate: 0.92 + (((h >>> 10) % 1000) / 1000) * 0.2 };
}

// Where an airline's pilots are from: the voice languages to try, best first.
// English ones give the local English accent; the others are the device's
// German, French, Japanese... voices reading the English call, which sounds
// like a pilot from there. Languages whose voices read English badly are left out.
const ACCENTS = {
  BAW: ['en-gb'], VIR: ['en-gb'], EZY: ['en-gb'], QFA: ['en-au'], JST: ['en-au'], ANZ: ['en-nz', 'en-au'],
  AIC: ['en-in'], IGO: ['en-in'], SIA: ['en-sg', 'en-in', 'en-gb'], TGW: ['en-sg', 'en-in', 'en-gb'],
  MAS: ['en-my', 'en-sg', 'en-in'], AXM: ['en-my', 'en-sg', 'en-in'], CPA: ['en-hk', 'en-gb'], UAE: ['en-gb', 'en-in', 'en-za'],
  CEB: ['en-ph', 'fil'], ACA: ['en-ca', 'en-us'], ASA: ['en-us'], AAL: ['en-us'], DAL: ['en-us'], UAL: ['en-us'], SKW: ['en-us'],
  SWA: ['en-us'], JBU: ['en-us'], FFT: ['en-us'],
  DLH: ['de'], AFR: ['fr'], KLM: ['nl'], JAL: ['ja'], ANA: ['ja'], KAL: ['ko'], AFL: ['ru'], GIA: ['id'],
  CCA: ['zh-cn'], CES: ['zh-cn'], CSN: ['zh-cn'], CXA: ['zh-cn'], EVA: ['zh-tw'], CAL: ['zh-tw'],
};
export function accentFor(airline) { return ACCENTS[airline] || []; }

export class Speaker {
  constructor(settings) {
    this.settings = settings;
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.unlocked = false;
    this.voices = [];
    this.fx = new RadioFx();
    this.chain = Promise.resolve();
    if (this.supported) {
      this.loadVoices();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.loadVoices());
    }
  }

  loadVoices() {
    const all = window.speechSynthesis.getVoices();
    // English voices first; iPad lists many languages
    this.voices = all.filter((v) => /^en/i.test(v.lang)).concat(all.filter((v) => !/^en/i.test(v.lang)));
    this.onVoices?.(this.voices);
  }

  englishVoices() { return rankVoices(this.voices, 'en'); }

  unlock() {
    this.fx.unlock();
    if (!this.supported || this.unlocked) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    this.unlocked = true;
  }

  // a good voice, stable per pilot; several pilots share the best few voices
  pick(pool, key) {
    if (!pool.length) return null;
    const top = pool.filter((v) => voiceScore(v) >= voiceScore(pool[0]) - 30).slice(0, 12);
    return top[hash(key) % top.length];
  }

  voiceFor(unitKey, airline) {
    const chosen = this.voices.find((v) => v.voiceURI === this.settings.voiceURI);
    if (chosen && !this.settings.varyVoices) return chosen;
    if (this.settings.accents !== false) {
      for (const lang of accentFor(airline)) {
        const pool = rankVoices(this.voices, lang);
        if (pool.length) return this.pick(pool, unitKey || 'x');
      }
    }
    return this.pick(this.englishVoices(), unitKey || 'x') || chosen || null;
  }

  // a voice for another language (e.g. 'zh' -> a zh-CN system voice), stable per key
  voiceForLang(lang, unitKey) {
    let pool = rankVoices(this.voices, lang);
    if (lang.toLowerCase() === 'zh') {
      const cn = pool.filter((v) => /cn|hans/i.test(v.lang));
      if (cn.length) pool = cn;
    }
    return this.pick(pool, unitKey || 'x');
  }

  // opts.reply: a readback, said after a short pause as a person would
  // radio: { airline, range } of the aircraft talking
  speak(text, unitKey, lang = 'en', { reply = false, airline = '', range = 3000 } = {}) {
    if (!this.supported || !this.settings.tts || !text) return;
    const pause = reply ? 600 + Math.random() * 900 : 150 + Math.random() * 500;
    this.chain = this.chain.then(() => new Promise((r) => setTimeout(r, pause))).then(() => this.say(text, unitKey, lang, airline, range));
  }

  say(text, unitKey, lang, airline, range) {
    const u = new SpeechSynthesisUtterance(text);
    const voice = lang && lang !== 'en' ? this.voiceForLang(lang, unitKey) : this.voiceFor(unitKey, airline);
    u.volume = 1 - Math.min(0.25, (range || 0) / 80000); // a far aircraft is a little quieter
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = lang === 'zh' ? 'zh-CN' : 'en-US'; }
    const shape = this.settings.varyVoices ? pilotVoiceShape(unitKey || 'x') : { pitch: 1, rate: 1 };
    u.rate = (Number(this.settings.rate) || 1) * shape.rate;
    u.pitch = (Number(this.settings.pitch) || 1) * shape.pitch;
    this.fx.enabled = this.settings.radioFx !== false;
    u.onstart = () => this.fx.keyUp({ key: unitKey, range });
    u.onend = () => this.fx.keyDown();
    u.onerror = () => this.fx.keyDown(true);
    // Safari can stay "paused" after the app was in the background
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
  }

  stop() {
    this.chain = Promise.resolve();
    this.fx.keyDown(true);
    if (this.supported) window.speechSynthesis.cancel();
  }
}
