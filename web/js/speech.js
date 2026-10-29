// Spoken ATC replies with the browser's built-in speech synthesis.
// Safari only plays speech after the first speak() call that happens inside a
// user gesture, so unlock() must be called from a tap handler.

export class Speaker {
  constructor(settings) {
    this.settings = settings;
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.unlocked = false;
    this.voices = [];
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

  englishVoices() { return this.voices.filter((v) => /^en/i.test(v.lang)); }

  unlock() {
    if (!this.supported || this.unlocked) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    this.unlocked = true;
  }

  voiceFor(unitKey) {
    const chosen = this.voices.find((v) => v.voiceURI === this.settings.voiceURI);
    const english = this.englishVoices();
    if (!this.settings.varyVoices || !unitKey || english.length < 2) return chosen || english[0] || null;
    // stable pick per controller so each unit keeps its own voice
    let h = 0;
    for (const c of unitKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const pool = chosen ? [chosen, ...english.filter((v) => v !== chosen)] : english;
    return pool[h % Math.min(pool.length, 6)];
  }

  speak(text, unitKey) {
    if (!this.supported || !this.settings.tts || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.voiceFor(unitKey);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
    u.rate = Number(this.settings.rate) || 1;
    u.pitch = Number(this.settings.pitch) || 1;
    // Safari can stay "paused" after the app was in the background
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
  }

  stop() {
    if (this.supported) window.speechSynthesis.cancel();
  }
}
