// Push-to-talk with the browser's speech recognition (webkitSpeechRecognition
// on iPad Safari). It is often unavailable or unreliable (needs HTTPS, Siri
// and Dictation enabled, a network connection on many iPads, and reportedly
// does not work in Home Screen web apps on some iPadOS versions), so this
// class reports its state and gives up after repeated failures. The app
// then hides the button and the phrase buttons and text box carry on.

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);
const MAX_FAILURES = 3;

export function voiceSupport() {
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return { ok: false, reason: 'This browser has no speech recognition.' };
  if (!window.isSecureContext) return { ok: false, reason: 'Voice input needs the secure (https://) address.' };
  const standalone = window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  return { ok: true, SR, standalone };
}

export class Listener {
  constructor({ lang = 'en-US', onFinal, onInterim, onState }) {
    const s = voiceSupport();
    this.support = s;
    this.lang = lang;
    this.onFinal = onFinal;
    this.onInterim = onInterim;
    this.onState = onState;
    this.failures = 0;
    this.disabled = !s.ok;
    this.reason = s.ok ? '' : s.reason;
    this.rec = null;
    this.active = false;
  }

  setState(state, detail = '') { this.onState?.(state, detail); }

  start() {
    if (this.disabled || this.active) return;
    const rec = new this.support.SR();
    rec.lang = this.lang;
    rec.interimResults = true;
    rec.continuous = false; // continuous mode has hung on iPad in the past
    rec.maxAlternatives = 1;
    this.final = '';
    this.interim = '';
    this.started = false;
    this.errored = false;
    this.active = true;
    rec.onstart = () => { this.started = true; this.setState('listening'); };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) this.final += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.interim = interim;
      this.onInterim?.(this.final + interim);
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
      const text = (this.final || this.interim).trim();
      if (text) {
        this.failures = 0;
        this.setState('idle');
        this.onFinal?.(text);
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

  stop() {
    if (!this.rec || !this.active) return;
    try { this.rec.stop(); } catch { /* ignore */ }
    // if Safari never sends onend, finish ourselves
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      if (this.active) {
        this.active = false;
        try { this.rec.abort(); } catch { /* ignore */ }
        const text = (this.final || this.interim).trim();
        if (text) this.onFinal?.(text); else this.fail('Recognition did not finish.');
      }
    }, 3000);
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
