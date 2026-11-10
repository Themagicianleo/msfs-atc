// Push-to-talk with the browser's speech recognition (webkitSpeechRecognition
// on iPad Safari). It is often unavailable or unreliable (needs HTTPS, Siri
// and Dictation enabled, a network connection on many iPads, and reportedly
// does not work in Home Screen web apps on some iPadOS versions), so this
// class reports its state and gives up after repeated failures. The app
// then hides the button and the phrase buttons and text box carry on.

import { applyHints } from './hints.js';
import { recognitionPrompt } from './asr-correct.js';

// After this long without the words changing, a transcript that already is a whole instruction is sent
// without waiting for the recogniser's own (slower) end-of-speech decision. (isComplete may return its own
// delay: a taxi route is given more time, since controllers pause between taxiways.)
const SETTLE_MS = 450;

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);
const MAX_FAILURES = 3;

export function voiceSupport() {
  // The Mac app (Electron) has the browser's recogniser object but it cannot work there (it needs Google's service): voice is
  // then the AI model's job (Settings -> AI voice recognition, on by default in the app).
  if (typeof window !== 'undefined' && window.towerDesktop) return { ok: true, SR: null, desktop: true, standalone: false };
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return { ok: false, reason: 'This browser has no speech recognition.' };
  if (!window.isSecureContext) return { ok: false, reason: 'Voice input needs the secure (https://) address.' };
  const standalone = window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  return { ok: true, SR, standalone };
}

export class Listener {
  constructor({ lang = 'en-US', onFinal, onInterim, onState, isComplete = null, getHints = null, correct = null, ai = null }) {
    const s = voiceSupport();
    this.support = s;
    this.lang = lang;
    this.onFinal = onFinal;
    this.onInterim = onInterim;
    this.onState = onState;
    this.isComplete = isComplete; // (text) => true when the words so far are a whole instruction
    this.getHints = getHints; // () => [{text, boost}] for the recogniser
    this.correct = correct; // (text) => text fitted to the radio (AI recognition: callsigns, taxiways, commands)
    this.ai = ai; // AiRecognizer (Whisper): used instead of the browser's recogniser while it is loaded
    this.failures = 0;
    this.disabled = !s.ok;
    this.reason = s.ok ? '' : s.reason;
    this.rec = null;
    this.active = false;
  }

  setState(state, detail = '') { this.onState?.(state, detail); }

  start(useAi = true) {
    if (this.disabled || this.active) return;
    this.aiMode = false;
    if (useAi && !this.aiSkip && this.ai?.usable()) { this.startAi(); return; }
    if (!this.support.SR) { // the desktop app without its AI model (still downloading, or off)
      this.fail('Voice input in the Mac app uses the AI model: turn it on under Settings, AI voice recognition (one download), then try again. You can type or use the buttons meanwhile.');
      return;
    }
    const rec = new this.support.SR();
    rec.lang = this.lang;
    rec.interimResults = true;
    rec.continuous = false; // continuous mode has hung on iPad in the past
    rec.maxAlternatives = 5; // the game tries each guess and takes the first it understands
    try { applyHints(rec, this.getHints?.()); } catch { /* hints are optional */ }
    this.final = '';
    this.interim = '';
    this.segments = []; // each final result's list of guesses
    this.started = false;
    this.errored = false;
    this.active = true;
    rec.onstart = () => { this.started = true; this.setState('listening'); };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) {
          this.final += r[0].transcript;
          this.segments.push(Array.from({ length: r.length }, (_, k) => r[k].transcript));
        } else interim += r[0].transcript;
      }
      this.interim = interim;
      this.onInterim?.(this.final + interim);
      this.settle();
    };
    rec.onerror = (e) => {
      this.errored = true;
      if (FATAL.has(e.error)) {
        this.disable(e.error === 'not-allowed'
          ? 'Microphone or speech recognition permission was denied.'
          : `Speech recognition is not available here (${e.error}).`);
      } else if (e.error !== 'aborted') {
        this.fail(e.error === 'no-speech' ? 'Nothing heard.' : `Recognition error: ${e.error}.`);
      }
    };
    rec.onend = () => {
      this.active = false;
      clearTimeout(this.watchdog);
      clearTimeout(this.settleTimer);
      const text = (this.final || this.interim).trim();
      if (text) {
        this.failures = 0;
        this.setState('idle');
        this.onFinal?.(text, this.alternatives());
      } else if (!this.errored && !this.disabled) {
        this.fail('Nothing recognised.');
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.active = false;
      this.fail(`Could not start recognition (${err.message}).`);
      return;
    }
    // some iPad builds never fire onstart; treat that as a failure
    this.watchdog = setTimeout(() => {
      if (!this.started && this.active) {
        try { rec.abort(); } catch { /* ignore */ }
        this.active = false;
        this.fail('Speech recognition did not start.');
      }
    }, 4000);
  }

  // ---- AI recognition (Whisper): record, then recognise the whole transmission
  async startAi() {
    this.aiMode = true;
    this.active = true;
    this.errored = false;
    this.aiBusy = false;
    this.final = '';
    this.interim = '';
    this.segments = [];
    const token = (this.aiToken = (this.aiToken || 0) + 1);
    let rec;
    try {
      rec = await this.ai.record((ev) => {
        if (token !== this.aiToken) return;
        if (ev === 'end') this.stop();
        else if (ev === 'nothing') this.finishAi(null, 'Nothing heard.');
      });
    } catch (err) {
      this.active = false;
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') { this.disable('Microphone permission was denied.'); return; }
      // The model's microphone would not open: this press uses the browser's own recogniser instead, and after two such
      // failures so does everything else until the page is reloaded. Voice input does not stop.
      this.aiMicFails = (this.aiMicFails || 0) + 1;
      if (this.aiMicFails >= 2) this.aiSkip = true;
      this.aiMicError = String(err?.message || err);
      if (this.support.ok) { this.start(false); return; }
      this.fail(`Could not open the microphone (${this.aiMicError}).`);
      return;
    }
    this.aiMicFails = 0;
    if (token !== this.aiToken || !this.active) { rec.abort(); return; }
    this.recording = rec;
    this.setState('listening');
  }

  async finishAi(rec, failReason = '') {
    const r = rec || this.recording;
    this.recording = null;
    this.aiToken += 1;
    if (!r) { this.active = false; this.fail(failReason || 'Nothing heard.'); return; }
    if (failReason) { r.abort(); this.active = false; this.fail(failReason); return; }
    this.onInterim?.('...');
    this.aiBusy = true;
    let audio = null;
    try {
      const spoke = r.heard();
      audio = await r.stop();
      if (!spoke || audio.length < 4000) { this.aiBusy = false; this.active = false; this.fail('Nothing heard.'); return; }
      const zh = this.lang.toLowerCase().startsWith('zh');
      const hints = this.getHints?.() || [];
      const raw = await this.ai.transcribe(audio, { language: zh ? 'chinese' : 'english', prompt: recognitionPrompt(hints, { zh }) });
      this.aiBusy = false;
      this.active = false;
      this.onInterim?.('');
      const fixed = (this.correct ? this.correct(raw) : raw).trim();
      if (!fixed) { this.fail('Nothing recognised.'); return; }
      this.failures = 0;
      this.setState('idle');
      this.onFinal?.(fixed, fixed === raw.trim() ? [fixed] : [fixed, raw.trim()]);
    } catch (err) {
      this.aiBusy = false;
      this.active = false;
      this.onInterim?.('');
      this.ai.fault = String(err?.message || err);
      this.ai.status = 'error'; // the browser's own recogniser takes over until the page is reloaded
      this.fail(`AI recognition failed (${this.ai.fault}); using the browser's recogniser instead.`);
    }
  }

  // Faster than waiting for the recogniser to notice the silence: once the words have stopped changing and
  // they already make a whole instruction, stop listening.
  settle() {
    clearTimeout(this.settleTimer);
    if (!this.isComplete || !this.active) return;
    const heard = this.final + this.interim;
    const ready = this.isComplete(heard);
    if (!ready) return;
    this.settleTimer = setTimeout(() => {
      if (this.active && heard === this.final + this.interim) this.stop();
    }, typeof ready === 'number' ? ready : SETTLE_MS);
  }

  stop() {
    clearTimeout(this.settleTimer);
    if (this.aiMode && this.active) {
      if (this.recording && !this.aiBusy) this.finishAi(this.recording);
      else if (!this.recording && !this.aiBusy) { this.aiToken += 1; this.active = false; this.setState('idle'); } // released before the microphone opened
      return;
    }
    if (!this.rec || !this.active) return;
    try { this.rec.stop(); } catch { /* ignore */ }
    // if Safari never sends onend, finish ourselves
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      if (this.active) {
        this.active = false;
        try { this.rec.abort(); } catch { /* ignore */ }
        const text = (this.final || this.interim).trim();
        if (text) this.onFinal?.(text, this.alternatives()); else this.fail('Recognition did not finish.');
      }
    }, 3000);
  }

  // whole-utterance guesses, best first: the k-th guess of every part joined
  alternatives() {
    const text = (this.final || this.interim).trim();
    const out = [text];
    const parts = this.segments.length ? this.segments : [];
    const most = Math.max(0, ...parts.map((p) => p.length));
    for (let k = 1; k < most; k += 1) {
      const alt = parts.map((p) => p[k] ?? p[0]).join('').trim();
      if (alt && !out.includes(alt)) out.push(alt);
    }
    return out;
  }

  fail(reason) {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.disable(`Voice input switched off after ${MAX_FAILURES} failed tries (${reason}) Use the buttons or type.`);
    } else {
      this.setState('error', reason);
    }
  }

  disable(reason) {
    this.disabled = true;
    this.reason = reason;
    this.active = false;
    this.setState('disabled', reason);
  }

  reset() {
    const s = voiceSupport();
    this.failures = 0;
    this.disabled = !s.ok;
    this.reason = s.ok ? '' : s.reason;
  }
}
