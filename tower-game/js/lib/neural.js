// Built-in voices: Piper neural speech (open source) running in the browser,
// so the pilots sound the same on every device and don't depend on the
// voices installed there.
//
// Nothing is part of the site: each browser downloads the speech runtime
// (jsDelivr) and the voice models it needs (Hugging Face, or its mirror
// hf-mirror.com where Hugging Face is blocked) once, and keeps them in its
// own cache for offline play.
//
// Voice models are multi-speaker, which gives over a thousand different
// pilots from five downloads; see MODELS.

const RUNTIME = {
  ortJs: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.wasm.min.js',
  ortWasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort-wasm-simd.wasm',
  phonJs: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js',
  phonWasm: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm',
  phonData: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',
};
export const RUNTIME_MB = 30;
const HOSTS = ['https://huggingface.co/rhasspy/piper-voices/resolve/main/', 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/'];
const CACHE = 'tower-voices-1';

export const MODELS = {
  us: { file: 'en/en_US/libritts_r/medium/en_US-libritts_r-medium', mb: 79, label: 'American English', voices: 904 },
  uk: { file: 'en/en_GB/vctk/medium/en_GB-vctk-medium', mb: 77, label: 'English from around the British Isles', voices: 109 },
  intl: { file: 'en/en_US/l2arctic/medium/en_US-l2arctic-medium', mb: 77, label: 'English with Chinese, Korean, Vietnamese, Indian, Arabic and Spanish accents', voices: 24 },
  mix: { file: 'en/en_US/arctic/medium/en_US-arctic-medium', mb: 77, label: 'English: American, Scottish, Canadian and Indian voices', voices: 18 },
  zh: { file: 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium', mb: 63, label: 'Chinese (Daxing)', voices: 1 },
};

// speakers of the accented-English model by first language (L2-ARCTIC corpus)
const L2 = {
  mandarin: ['BWC', 'LXC', 'NCC', 'TXHC'], korean: ['HJK', 'HKK', 'YDCK', 'YKWK'], vietnamese: ['HQTV', 'PNV', 'THV', 'TLV'],
  hindi: ['ASI', 'RRBI', 'SVBI', 'TNI'], arabic: ['ABA', 'SKA', 'YBAA', 'ZHAA'], spanish: ['EBVS', 'ERMS', 'MBMPS', 'NJS'],
};
const ARCTIC = { indian: ['ksp', 'aup', 'axb', 'gka', 'slp'], scottish: ['awb'], canadian: ['jmk'], american: ['rms', 'slt', 'clb', 'bdl', 'eey', 'ljm', 'lnh'] };

// where an airline's pilots are likely from: [model, speaker group] choices
const US = [['us']];
const UK = [['uk']];
const AIRLINE_VOICES = {
  UAL: US, SKW: US, ASA: US, DAL: US, AAL: US, SWA: US, JBU: US, FFT: US,
  ACA: [['mix', ARCTIC.canadian], ['us']], BAW: [['uk'], ['mix', ARCTIC.scottish]], VIR: UK, EZY: UK, QFA: UK, ANZ: UK, JST: UK,
  DLH: UK, AFR: UK, KLM: UK, AFL: UK,
  AIC: [['intl', L2.hindi], ['mix', ARCTIC.indian]], IGO: [['intl', L2.hindi], ['mix', ARCTIC.indian]],
  SIA: [['intl', L2.mandarin], ['intl', L2.hindi], ['mix', ARCTIC.indian], ['uk']], TGW: [['intl', L2.mandarin], ['intl', L2.hindi], ['uk']],
  MAS: [['intl', L2.mandarin], ['intl', L2.hindi], ['uk']], AXM: [['intl', L2.mandarin], ['intl', L2.hindi], ['uk']],
  CPA: [['intl', L2.mandarin], ['uk']], CCA: [['intl', L2.mandarin]], CES: [['intl', L2.mandarin]], CSN: [['intl', L2.mandarin]],
  CXA: [['intl', L2.mandarin]], EVA: [['intl', L2.mandarin]], CAL: [['intl', L2.mandarin]],
  KAL: [['intl', L2.korean]], JAL: [['intl', L2.korean], ['intl', L2.mandarin]], ANA: [['intl', L2.korean], ['intl', L2.mandarin]],
  VJC: [['intl', L2.vietnamese]], GIA: [['intl', L2.vietnamese], ['intl', L2.spanish]], THA: [['intl', L2.vietnamese], ['intl', L2.mandarin]],
  CEB: [['intl', L2.spanish], ['intl', L2.vietnamese]], UAE: [['intl', L2.arabic], ['uk'], ['intl', L2.hindi]],
  QTR: [['intl', L2.arabic], ['intl', L2.hindi]], ETD: [['intl', L2.arabic], ['uk']],
};
const ANY = [['us'], ['uk'], ['intl'], ['mix']];

function hash(key) {
  let h = 2166136261;
  for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}
const frac = (key) => (hash(key) % 10000) / 10000;

// the models an airport's traffic needs. airlines: [{code, lang}]. The
// 'mix' model only adds variety, so it is left out unless asked for.
export function modelsFor(airlines = [], { extras = false } = {}) {
  const need = new Set();
  for (const { code, lang } of airlines) {
    if (lang === 'zh') { need.add('zh'); continue; }
    for (const [m] of AIRLINE_VOICES[code] || ANY) if (extras || m !== 'mix') need.add(m);
  }
  return Object.keys(MODELS).filter((k) => need.has(k));
}

// which model and speaker a pilot uses, plus a pitch and pace of their own.
// have: set of downloaded model keys. Null if none fits.
export function pilotVoice(key, airline, lang, have, configs = {}) {
  let choices;
  if (lang === 'zh') choices = have.has('zh') ? [['zh']] : [];
  else {
    choices = (AIRLINE_VOICES[airline] || ANY).filter(([m]) => have.has(m));
    if (!choices.length) choices = ANY.filter(([m]) => have.has(m));
  }
  if (!choices.length) return null; // the device's own voice then
  const [model, group] = choices[hash(`m${key}`) % choices.length];
  const cfg = configs[model];
  let speaker = 0;
  if (cfg?.speaker_id_map && Object.keys(cfg.speaker_id_map).length) {
    const map = cfg.speaker_id_map;
    const names = group ? group.filter((n) => n in map) : Object.keys(map);
    const list = names.length ? names : Object.keys(map);
    speaker = map[list[hash(`s${key}`) % list.length]];
  }
  // one Chinese voice: pitch spread wider so pilots don't all sound alike
  const spread = model === 'zh' ? 0.34 : 0.16;
  return { model, speaker, pitch: 1 - spread / 2 + frac(`p${key}`) * spread, rate: 0.94 + frac(`r${key}`) * 0.16 };
}

// ---------------------------------------------------------------- downloads
async function cacheOpen() {
  try { return await caches.open(CACHE); } catch { return null; }
}

// a file from the cache, or downloaded (with progress) and cached
async function getFile(urls, onBytes) {
  const list = Array.isArray(urls) ? urls : [urls];
  const cache = await cacheOpen();
  const hit = cache && await cache.match(list[0]);
  if (hit) return hit.arrayBuffer();
  let lastErr;
  for (const url of list) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const chunks = [];
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          onBytes?.(value.length);
        }
      } else chunks.push(new Uint8Array(await res.arrayBuffer()));
      const blob = new Blob(chunks);
      if (cache) await cache.put(list[0], new Response(blob)).catch(() => {});
      return blob.arrayBuffer();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export async function cachedModels() {
  const cache = await cacheOpen();
  const out = [];
  if (!cache) return out;
  for (const [k, m] of Object.entries(MODELS)) if (await cache.match(`${HOSTS[0]}${m.file}.onnx`)) out.push(k);
  return out;
}

export async function deleteVoices() {
  try { await caches.delete(CACHE); } catch { /* nothing to delete */ }
}

// ---------------------------------------------------------------- the engine
export class NeuralVoices {
  constructor(workerUrl = new URL('./neural-worker.js', import.meta.url)) {
    this.workerUrl = workerUrl;
    this.worker = null;
    this.ready = new Set(); // models loaded in the worker
    this.configs = {};
    this.queue = Promise.resolve();
    this.pending = new Map();
    this.seq = 0;
    this.loading = null;
  }

  call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async start(onBytes) {
    if (this.worker) return;
    const files = {};
    for (const [k, url] of Object.entries(RUNTIME)) files[k] = await getFile(url, onBytes);
    this.worker = new Worker(this.workerUrl);
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    await this.call({ type: 'init', ...files }, Object.values(files));
  }

  // download (or take from the cache) and load the models; onProgress(doneMB, totalMB, label)
  async load(keys, onProgress) {
    const want = keys.filter((k) => MODELS[k] && !this.ready.has(k));
    if (!want.length && this.worker) return;
    const cached = new Set(await cachedModels());
    let total = (this.worker || (await cacheOpen() && await (await cacheOpen()).match(RUNTIME.phonData)) ? 0 : RUNTIME_MB)
      + want.filter((k) => !cached.has(k)).reduce((s, k) => s + MODELS[k].mb, 0);
    let done = 0;
    const tick = (n) => { done += n / 1e6; onProgress?.(Math.min(done, total), total); };
    if (total === 0) total = 1;
    await this.start(tick);
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
    // each model on its own: one that fails doesn't stop the others
    const failed = [];
    for (const k of want) {
      const m = MODELS[k];
      onProgress?.(Math.min(done, total), total, m.label);
      try {
        const config = JSON.parse(new TextDecoder().decode(await getFile(HOSTS.map((h) => `${h}${m.file}.onnx.json`))));
        const onnx = await getFile(HOSTS.map((h) => `${h}${m.file}.onnx`), tick);
        await this.call({ type: 'load', model: k, onnx, config }, [onnx]);
        this.configs[k] = config;
        this.ready.add(k);
      } catch (e) {
        failed.push(`${m.label}: ${e.message}`);
      }
    }
    if (failed.length) throw new Error(failed.join('; '));
  }

  voiceFor(key, airline, lang) {
    return pilotVoice(key, airline, lang, this.ready, this.configs);
  }

  // speech for one transmission: {pcm, sampleRate}; one at a time in the worker
  synth(text, voice) {
    const run = () => this.call({ type: 'synth', model: voice.model, text, speaker: voice.speaker, lengthScale: voice.pitch / voice.rate });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    p.then((r) => { this.workMs = (this.workMs || 0) + (r.ms || 0); }, () => {});
    return p;
  }
}
