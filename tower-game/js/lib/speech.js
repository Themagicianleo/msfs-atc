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

// efficient: prefer the compact voices. Premium, Enhanced and neural voices sound better but the phone
// computes them every time a pilot speaks, which is a lot of work on a busy frequency (and heat).
export function voiceScore(v, efficient = false) {
  const name = v.name || '';
  if (NOVELTY.test(name)) return -100;
  let s = 0;
  if (/premium|enhanced|natural|neural|siri/i.test(name)) s += efficient ? -45 : 40; // Apple's downloadable and Edge's neural voices
  if (/online/i.test(name)) s += 30; // Microsoft "... Online (Natural)"
  if (/google/i.test(name)) s += 25; // Chrome's network voices
  if (/^(samantha|daniel|karen|moira|tessa|rishi|serena|arthur|martha|catherine|gordon|aaron|nicky|evan|zoe|tom|ava|allison|susan|joelle|nathan|noelle|oliver|stephanie|ting-ting|tingting|lili|yu-shu|meijia|sinji)\b/i.test(name)) s += 15;
  if (v.localService === false) s += 3;
  return s;
}

// Device voices don't say whether they are a woman or a man; the names of the common ones do.
const FEMALE = /^(samantha|karen|moira|tessa|serena|martha|catherine|allison|susan|joelle|noelle|ava|zoe|nicky|stephanie|ting-ting|tingting|lili|yu-shu|meijia|sinji|aria|jenny|sonia|libby|hazel|zira|susan|heather|linda|catherine|amelie|anna|alice|paulina|monica|kyoko|sara|nora|ellen|fiona|veena|lekha|mei-jia|yaoyao|huihui|xiaoxiao|xiaoyi|hanhan|yating|female)\b|female/i;
const MALE = /^(daniel|alex|aaron|arthur|gordon|rishi|tom|evan|nathan|oliver|fred|ralph|guy|ryan|david|mark|george|james|richard|thomas|google uk english male|male|yunxi|yunyang|kangkang|zhiwei|jorge|diego|thomas|otoya|ichiro|hemant|rishi)\b|\bmale\b/i;
export function voiceGender(v) {
  const name = String(v.name || '').replace(/^(microsoft|google|apple)\s+/i, ''); // "Microsoft Aria Online (Natural)" -> "Aria ..."
  if (/\bfemale\b/i.test(name)) return 'f';
  if (/\bmale\b/i.test(name)) return 'm';
  if (FEMALE.test(name)) return 'f';
  if (MALE.test(name)) return 'm';
  return null;
}

// the better voices of a language, best first
export function rankVoices(voices, langPrefix, efficient = false) {
  const want = langPrefix.toLowerCase();
  return voices
    .filter((v) => (v.lang || '').toLowerCase().replace('_', '-').startsWith(want))
    .map((v) => ({ v, s: voiceScore(v, efficient) }))
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
  return { pitch: 0.8 + ((h % 1000) / 1000) * 0.4, rate: 0.85 + (((h >>> 10) % 1000) / 1000) * 0.45 }; // slow and measured to quick
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

// ---------------------------------------------------------------- natural pacing
// A text-to-speech voice reads a whole call in one breath at one pace, with every digit equally spaced: that is what sounds
// like a machine. A pilot reads a call in phrases, with small pauses, digits in groups ("two seven, left"), a little quicker
// here and slower there, and a falling tone at the end. This cuts a call into phrases and gives each its own pause, pace and
// pitch, the same ones every time for a given pilot (so a pilot has a manner, not a random wobble).
const NUMBER_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|niner|fife|tree)';
const DIGIT_RUN = new RegExp(`\\b${NUMBER_WORD}(?: ${NUMBER_WORD}){3,}\\b`, 'gi');

// "one two three four five six" -> "one two three, four five six": groups of two or three, as callsigns and QNH are read
export function groupDigits(text) {
  return String(text).replace(DIGIT_RUN, (run) => {
    const w = run.split(' ');
    const sizes = w.length === 4 ? [2, 2] : w.length === 5 ? [3, 2] : w.length === 6 ? [3, 3] : w.length === 7 ? [3, 2, 2] : [3, 3, ...Array(w.length - 6).fill(2)];
    let at = 0;
    return sizes.map((n) => { const part = w.slice(at, at + n).join(' '); at += n; return part; }).filter(Boolean).join(', ');
  });
}

// [{text, gap, pitch, rate}]: the phrases of a call. gap: pause before the phrase (ms); pitch and rate: multipliers.
export function phrasesOf(text, key = 'x', { max = 5 } = {}) {
  const pieces = String(text).match(/[^,;.!?，。；、：:]+[,;.!?，。；、：:]*\s*/g) || [String(text)];
  const bare = (t) => t.replace(/[,;.!?，。；、：:\s]/g, '').length;
  // very short pieces ("Roger,") stay with the next one
  const merged = [];
  for (const t of pieces.map((x) => x.trim()).filter(Boolean)) {
    if (merged.length && bare(merged[merged.length - 1]) < 4) merged[merged.length - 1] += ` ${t}`;
    else merged.push(t);
  }
  // too many pieces: join the two neighbours that are shortest together, so a call is not chopped up
  while (merged.length > max) {
    let k = 0;
    for (let i = 1; i < merged.length - 1; i += 1) if (merged[i].length + merged[i + 1].length < merged[k].length + merged[k + 1].length) k = i;
    merged.splice(k, 2, `${merged[k]} ${merged[k + 1]}`);
  }
  const h = (n) => ((hash(`${key}${n}`) % 1000) / 1000);
  return merged.map((t, i) => {
    const last = i === merged.length - 1;
    const afterStop = i > 0 && /[.!?。]\s*$/.test(merged[i - 1]);
    return {
      // the pause replaces the comma; digits inside a phrase are grouped with a comma the voice takes as a breath
      text: groupDigits(t.replace(/[,;，；、]+\s*$/, '').trim()),
      gap: i === 0 ? undefined : Math.round((afterStop ? 220 : 70) + h(`g${i}`) * (afterStop ? 180 : 110)),
      rate: (0.95 + h(`r${i}`) * 0.12) * (last ? 0.95 : 1), // a little slower to finish
      pitch: (0.97 + h(`p${i}`) * 0.06) * (last ? 0.95 : 1), // and the tone falls
    };
  }).filter((p) => p.text);
}

// A Chinese call with English words in it ("经 alpha、bravo 幺滑到跑道两拐外等待点") is said by two voices: the Chinese
// voice for the Chinese, an English one for the code words (a Chinese voice cannot read "alpha"). [{text, lang}]
export function splitLanguages(text, lang = 'zh') {
  if (lang !== 'zh') return [{ text, lang }];
  const runs = [];
  const joined = String(text).replace(/([A-Za-z])\s*[、，,]\s*(?=[A-Za-z])/g, '$1, '); // "alpha、bravo": one English phrase
  for (const m of joined.matchAll(/[A-Za-z][A-Za-z'-]*(?:[ ,]+[A-Za-z][A-Za-z'-]*)*|[^A-Za-z]+/g)) {
    const t = m[0];
    if (/^[A-Za-z]/.test(t)) runs.push({ text: t.replace(/[ ,]+$/, ''), lang: 'en' });
    else if (/[^\s，。、,.]/.test(t)) runs.push({ text: t, lang: 'zh' });
    else if (runs.length && runs[runs.length - 1].lang === 'zh') runs[runs.length - 1].text += t; // punctuation stays with the Chinese before it
  }
  return runs.length ? runs : [{ text, lang }];
}

export class Speaker {
  constructor(settings) {
    this.settings = settings;
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.unlocked = false;
    this.voices = [];
    this.fx = new RadioFx();
    this.chain = Promise.resolve();
    this.gen = 0; // bumped by stop(): calls queued before it are not spoken
    this.muted = false; // the controller is transmitting: nothing is heard
    this.held = []; // calls that came in meanwhile, played when the key is released
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

  englishVoices() { return rankVoices(this.voices, 'en', !!this.settings.efficient); }

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
    const eff = !!this.settings.efficient;
    let top = pool.filter((v) => voiceScore(v, eff) >= voiceScore(pool[0], eff) - 30).slice(0, 12);
    // each pilot has a gender of their own (about half women): a voice of that gender where the pool has one
    const want = (hash(`g${key}`) % 100) < 50 ? 'f' : 'm';
    const same = top.filter((v) => voiceGender(v) === want);
    if (same.length) top = same;
    else {
      const wider = pool.filter((v) => voiceGender(v) === want).slice(0, 12);
      if (wider.length) top = wider;
    }
    return top[hash(key) % top.length];
  }

  voiceFor(unitKey, airline) {
    const chosen = this.voices.find((v) => v.voiceURI === this.settings.voiceURI);
    if (chosen && !this.settings.varyVoices) return chosen;
    if (this.settings.accents !== false) {
      for (const lang of accentFor(airline)) {
        const pool = rankVoices(this.voices, lang, !!this.settings.efficient);
        if (pool.length) return this.pick(pool, unitKey || 'x');
      }
    }
    return this.pick(this.englishVoices(), unitKey || 'x') || chosen || null;
  }

  // a voice for another language (e.g. 'zh' -> a zh-CN system voice), stable per key
  voiceForLang(lang, unitKey) {
    let pool = rankVoices(this.voices, lang, !!this.settings.efficient);
    if (lang.toLowerCase() === 'zh') {
      const cn = pool.filter((v) => /cn|hans/i.test(v.lang));
      if (cn.length) pool = cn;
    }
    return this.pick(pool, unitKey || 'x');
  }

  // opts.reply: a readback, said after a short pause as a person would
  // radio: { airline, range } of the aircraft talking
  speak(text, unitKey, lang = 'en', opts = {}) {
    if (!this.settings.tts || !text) return;
    // natural pacing: a call in phrases, each with its own pause, pace and pitch (Settings: Natural pacing)
    if (!opts.phrase && this.settings.pacing !== false) {
      const phrases = phrasesOf(text, unitKey || 'x');
      if (phrases.length > 1) {
        phrases.forEach((p, i) => this.speak(p.text, unitKey, lang, { ...opts, phrase: true, gap: i ? p.gap : opts.gap, reply: i ? false : opts.reply, pros: { rate: p.rate, pitch: p.pitch } }));
        return;
      }
    }
    if (lang === 'zh' && !opts.part && /[A-Za-z]{2}/.test(text)) {
      splitLanguages(text, lang).forEach((r, i) => this.speak(r.text, unitKey, r.lang, { ...opts, part: true, gap: i ? 60 : undefined, reply: i ? false : opts.reply }));
      return;
    }
    // like a real radio: while the controller holds the key nobody else is heard. Calls from pilots
    // who wait their turn are played afterwards (see release()).
    if (this.muted) { this.held.push({ args: [text, unitKey, lang, opts], at: Date.now() }); return; }
    const { reply = false, airline = '', range = 3000 } = opts;
    this.fx.enabled = this.settings.radioFx !== false;
    if (this.fx.enabled || this.settings.builtinVoices) this.fx.wake(); // ready by the time the pilot talks
    const pause = opts.gap ?? (reply ? 600 + Math.random() * 900 : 150 + Math.random() * 500);
    // on a busy frequency calls queue up; one that has waited too long is
    // not read out late (it is still in the radio log)
    const queued = Date.now();
    const gen = this.gen;
    const stale = () => gen !== this.gen || Date.now() - queued > 25000; // stop() or mute() makes everything queued before it stale
    const wait = () => (stale() ? Promise.reject(new Error('stale')) : new Promise((resolve, reject) => setTimeout(() => (stale() ? reject(new Error('stale')) : resolve()), pause)));
    // built-in voices: start generating now, while earlier calls are still playing
    const nv = this.settings.builtinVoices && this.neural?.voiceFor(unitKey || 'x', airline, lang);
    if (nv) {
      const rate = Number(this.settings.rate) || 1;
      const pros = opts.pros || { rate: 1, pitch: 1 };
      const voice = { ...nv, rate: nv.rate * rate * pros.rate, pitch: nv.pitch * pros.pitch };
      const audio = this.neural.synth(text, voice);
      audio.catch(() => {});
      this.chain = this.chain.then(wait).then(() => audio)
        .then((s) => {
          if (stale()) return true;
          const t0 = performance.now();
          return Promise.resolve(this.fx.play(s.pcm, s.sampleRate, { pitch: voice.pitch, key: unitKey, range, volume: 1 - Math.min(0.25, (range || 0) / 80000) }))
            .then((played) => { this.talkMs = (this.talkMs || 0) + performance.now() - t0; return played; });
        })
        .then((played) => (played ? null : this.say(text, unitKey, lang, airline, range, opts.pros)))
        .catch((e) => (e?.message === 'stale' ? null : this.say(text, unitKey, lang, airline, range, opts.pros)));
      return;
    }
    if (!this.supported) return;
    this.chain = this.chain.then(wait).then(() => this.say(text, unitKey, lang, airline, range, opts.pros)).catch(() => {});
  }

  say(text, unitKey, lang, airline, range, pros = null) {
    if (!this.supported) return null;
    const u = new SpeechSynthesisUtterance(text);
    const voice = lang && lang !== 'en' ? this.voiceForLang(lang, unitKey) : this.voiceFor(unitKey, airline);
    u.volume = 1 - Math.min(0.25, (range || 0) / 80000); // a far aircraft is a little quieter
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = lang === 'zh' ? 'zh-CN' : 'en-US'; }
    const shape = this.settings.varyVoices ? pilotVoiceShape(unitKey || 'x') : { pitch: 1, rate: 1 };
    u.rate = (Number(this.settings.rate) || 1) * shape.rate * (pros?.rate || 1);
    u.pitch = (Number(this.settings.pitch) || 1) * shape.pitch * (pros?.pitch || 1);
    this.fx.enabled = this.settings.radioFx !== false;
    let began = 0;
    u.onstart = () => { began = performance.now(); this.fx.keyUp({ key: unitKey, range }); };
    // Safari can stay "paused" after the app was in the background
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    // finished when the sentence ends, so the next call waits for it
    return new Promise((resolve) => {
      const done = (quiet) => { clearTimeout(guard); if (began) this.talkMs = (this.talkMs || 0) + performance.now() - began; this.fx.keyDown(quiet); resolve(); };
      const guard = setTimeout(() => done(true), 4000 + text.length * 150);
      u.onend = () => done(false);
      u.onerror = () => done(true);
      window.speechSynthesis.speak(u);
    });
  }

  stop() {
    this.gen += 1;
    this.chain = Promise.resolve();
    this.fx.cut();
    this.fx.keyDown(true);
    if (this.supported) window.speechSynthesis.cancel();
  }

  // The controller presses the transmit key: whoever is talking is cut off (the call stays in the radio
  // log, tap it to hear it again) and nothing else is heard until the key is released.
  mute() {
    if (this.muted) return;
    this.muted = true;
    this.stop();
  }

  // Key released. Calls that came in meanwhile are played now (those that waited too long are dropped).
  // Call this after issuing the instruction, so the pilot's readback is queued before them.
  release() {
    if (!this.muted) return;
    this.muted = false;
    const held = this.held;
    this.held = [];
    for (const h of held) if (Date.now() - h.at < 20000) this.speak(...h.args);
  }
}
