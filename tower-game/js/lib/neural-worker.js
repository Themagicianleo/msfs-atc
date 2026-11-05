/* Piper neural speech in a worker, so the game keeps running while a call is
   generated. Classic worker (importScripts). The main thread sends the files
   (already downloaded and cached there), the worker never fetches anything
   from the network itself.

   messages in:  {type:'init', ortJs, ortWasm, phonJs, phonWasm, phonData}
                 {type:'load', model, onnx, config}
                 {type:'synth', id, model, text, speaker, lengthScale}
   messages out: {id, ok:true, ...} or {id, error}                        */

let phon = null;
const sessions = {};
const configs = {};

const blobUrl = (buf, type) => URL.createObjectURL(new Blob([buf], { type }));

function phonemize(text, voice) {
  return new Promise((resolve, reject) => {
    const lines = [];
    self.createPiperPhonemize({
      print: (line) => lines.push(line),
      printErr: () => {},
      locateFile: (url) => (url.endsWith('.wasm') ? phon.wasm : url.endsWith('.data') ? phon.data : url),
    }).then((mod) => {
      try {
        mod.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
        const ids = [];
        for (const l of lines) {
          try { ids.push(...JSON.parse(l).phoneme_ids); } catch { /* not a result line */ }
        }
        if (!ids.length) throw new Error('no phonemes');
        resolve(ids);
      } catch (e) { reject(e); }
    }, reject);
  });
}

async function synth({ model, text, speaker = 0, lengthScale = 1 }) {
  const cfg = configs[model];
  const session = sessions[model];
  if (!cfg || !session) throw new Error(`voice ${model} not loaded`);
  const ids = await phonemize(text, cfg.espeak.voice);
  const inf = cfg.inference || {};
  const feeds = {
    input: new self.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new self.ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)])),
    scales: new self.ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) * lengthScale, inf.noise_w ?? 0.8])),
  };
  if (cfg.num_speakers > 1) feeds.sid = new self.ort.Tensor('int64', BigInt64Array.from([BigInt(speaker % cfg.num_speakers)]));
  const out = await session.run(feeds);
  const pcm = Float32Array.from(out.output.data);
  return { pcm, sampleRate: cfg.audio.sample_rate };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      importScripts(blobUrl(m.ortJs, 'text/javascript'));
      self.ort.env.wasm.numThreads = 1;
      self.ort.env.wasm.simd = true;
      self.ort.env.wasm.wasmPaths = { 'ort-wasm-simd.wasm': blobUrl(m.ortWasm, 'application/wasm') };
      importScripts(blobUrl(m.phonJs, 'text/javascript'));
      phon = { wasm: blobUrl(m.phonWasm, 'application/wasm'), data: blobUrl(m.phonData, 'application/octet-stream') };
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'load') {
      configs[m.model] = m.config;
      sessions[m.model] = await self.ort.InferenceSession.create(new Uint8Array(m.onnx), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'synth') {
      const t0 = Date.now();
      const r = await synth(m);
      self.postMessage({ id: m.id, ok: true, pcm: r.pcm, sampleRate: r.sampleRate, ms: Date.now() - t0 }, [r.pcm.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
