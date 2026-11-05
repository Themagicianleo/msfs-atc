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

// a stable, slightly different pitch and pace per pilot
export function pilotVoiceShape(key) {
  const h = hash(key);
  return { pitch: 0.9 + ((h % 1000) / 1000) * 0.22, rate: 0.95 + (((h >>> 10) % 1000) / 1000) * 0.14 };
}

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
    const top = pool.filter((v) => voiceScore(v) >= voiceScore(pool[0]) - 25).slice(0, 8);
    return top[hash(key) % top.length];
  }

  voiceFor(unitKey) {
    const chosen = this.voices.find((v) => v.voiceURI === this.settings.voiceURI);
    if (chosen && !this.settings.varyVoices) return chosen;
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
  speak(text, unitKey, lang = 'en', { reply = false } = {}) {
    if (!this.supported || !this.settings.tts || !text) return;
    const pause = reply ? 600 + Math.random() * 900 : 150 + Math.random() * 500;
    this.chain = this.chain.then(() => new Promise((r) => setTimeout(r, pause))).then(() => this.say(text, unitKey, lang));
  }

  say(text, unitKey, lang) {
    const u = new SpeechSynthesisUtterance(text);
    const voice = lang && lang !== 'en' ? this.voiceForLang(lang, unitKey) : this.voiceFor(unitKey);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = lang === 'zh' ? 'zh-CN' : 'en-US'; }
    const shape = this.settings.varyVoices ? pilotVoiceShape(unitKey || 'x') : { pitch: 1, rate: 1 };
    u.rate = (Number(this.settings.rate) || 1) * shape.rate;
    u.pitch = (Number(this.settings.pitch) || 1) * shape.pitch;
    this.fx.enabled = this.settings.radioFx !== false;
    u.onstart = () => this.fx.keyUp();
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
