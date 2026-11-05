// AI speech recognition: Whisper running in the browser (see whisper-worker.js), used instead of the browser's own
// recogniser when it is switched on in Settings and has been downloaded. The browser's own recogniser stays the
// fallback, so voice input never stops working while the model is still loading.
//
// This file: the microphone (records, detects the end of speech, resamples to 16 kHz) and the connection to
// the worker. The words it hears are fitted to the radio by asr-correct.js.

export const MODEL = { id: 'Xenova/whisper-base', mb: 80, label: 'Whisper base (multilingual)' };
const RUNTIME = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/+esm';
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];
const CACHE_NAMES = ['transformers-cache'];

const TARGET_RATE = 16000;
const MAX_SECONDS = 25;
const SILENCE_MS = 1000; // quiet this long after speech: the transmission is over
const NO_SPEECH_MS = 7000; // nobody spoke at all

export function aiSupport() {
  const ok = typeof window !== 'undefined' && typeof Worker !== 'undefined' && !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || window.webkitAudioContext) && window.isSecureContext;
  return ok ? { ok: true } : { ok: false, reason: 'AI recognition needs the secure (https://) address, a microphone and a modern browser.' };
}

// 48 kHz (or 44.1) -> 16 kHz, averaging the samples that fall into each new one
export function resample(samples, fromRate, toRate = TARGET_RATE) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j += 1) sum += samples[j];
    out[i] = sum / (b - a);
  }
  return out;
}

export const rms = (buf) => {
  let s = 0;
  for (let i = 0; i < buf.length; i += 1) s += buf[i] * buf[i];
  return Math.sqrt(s / (buf.length || 1));
};

// Decides from chunk loudness when a transmission has ended: speech is louder than the room (measured at the
// start, so a fan or an engine-noise recording doesn't count), and silence after speech ends it.
export class EndOfSpeech {
  constructor() { this.floor = null; this.spoke = false; this.quietMs = 0; this.totalMs = 0; }

  // returns 'speech' | 'quiet' | 'end' | 'nothing'
  push(level, ms) {
    this.totalMs += ms;
    if (this.floor === null || this.totalMs < 400) this.floor = this.floor === null ? level : Math.min(this.floor, level);
    const loud = level > Math.max(0.012, (this.floor || 0) * 3);
    if (loud) { this.spoke = true; this.quietMs = 0; return 'speech'; }
    this.quietMs += ms;
    if (this.spoke && this.quietMs >= SILENCE_MS) return 'end';
    if (!this.spoke && this.totalMs >= NO_SPEECH_MS) return 'nothing';
    return 'quiet';
  }
}

export class AiRecognizer {
  constructor(workerUrl = typeof window !== 'undefined' ? new URL('./whisper-worker.js', import.meta.url) : null) {
    this.workerUrl = workerUrl;
    this.worker = null;
    this.status = 'off'; // off | loading | ready | error
    this.error = '';
    this.pending = new Map();
    this.seq = 0;
    this.loadPromise = null;
    this.onProgress = null;
  }

  usable() { return this.status === 'ready'; }

  call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  // downloads (first time) and loads the model; onProgress(doneMB, totalMB)
  load(onProgress) {
    if (this.status === 'ready') return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.status = 'loading';
    this.error = '';
    this.onProgress = onProgress;
    const files = new Map();
    this.loadPromise = (async () => {
      this.worker = new Worker(this.workerUrl, { type: 'module' });
      this.worker.onmessage = (e) => {
        if (e.data.progress) {
          const p = e.data.progress;
          files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let l = 0; let t = 0;
          for (const f of files.values()) { l += f.loaded; t += f.total; }
          this.onProgress?.(l / 1e6, Math.max(t / 1e6, MODEL.mb * 0.9));
          return;
        }
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
      };
      this.worker.onerror = (e) => {
        const err = new Error(e.message || 'The recognition worker failed.');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
      try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
      await this.call({ type: 'load', model: MODEL.id, runtime: RUNTIME, hosts: HOSTS });
    })().then(() => { this.status = 'ready'; }, (e) => {
      this.status = 'error';
      this.error = e.message;
      this.loadPromise = null;
      try { this.worker?.terminate(); } catch { /* ignore */ }
      this.worker = null;
      throw e;
    });
    return this.loadPromise;
  }

  unload() {
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
    this.loadPromise = null;
    this.status = 'off';
    this.pending.clear();
  }

  // audio: Float32Array at 16 kHz. language: 'english' | 'chinese'. Returns the text.
  async transcribe(audio, { language = 'english', prompt = '' } = {}) {
    if (!this.usable()) throw new Error('The AI model is not loaded.');
    const r = await this.call({ type: 'transcribe', audio, language, prompt }, [audio.buffer]);
    this.workMs = (this.workMs || 0) + (r.ms || 0);
    return r.text;
  }

  // Opens the microphone. Returns a recording: {stop() -> Promise<Float32Array 16 kHz>, abort()}; onEvent('speech'|'end'|'nothing')
  // tells the caller what the microphone hears.
  async record(onEvent) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new Ctx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let samples = 0;
    const vad = new EndOfSpeech();
    let closed = false;
    node.onaudioprocess = (e) => {
      if (closed) return;
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      chunks.push(data);
      samples += data.length;
      const ms = (data.length / ctx.sampleRate) * 1000;
      const ev = vad.push(rms(data), ms);
      if (ev !== 'quiet') onEvent?.(ev);
      if (samples / ctx.sampleRate > MAX_SECONDS) onEvent?.('end');
    };
    src.connect(node);
    node.connect(ctx.destination); // a script node only runs when connected; it outputs silence
    const close = () => {
      if (closed) return;
      closed = true;
      try { node.disconnect(); src.disconnect(); } catch { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    };
    return {
      rate: ctx.sampleRate,
      heard: () => vad.spoke,
      stop: async () => {
        close();
        const all = new Float32Array(samples);
        let at = 0;
        for (const c of chunks) { all.set(c, at); at += c.length; }
        return resample(all, ctx.sampleRate);
      },
      abort: close,
    };
  }
}

export async function aiModelCached() {
  try {
    for (const name of CACHE_NAMES) {
      if (!(await caches.has(name))) continue;
      const c = await caches.open(name);
      for (const req of await c.keys()) if (req.url.includes('whisper-base')) return true;
    }
  } catch { /* no cache */ }
  return false;
}

export async function deleteAiModel() {
  try { for (const name of CACHE_NAMES) await caches.delete(name); } catch { /* nothing to delete */ }
}
