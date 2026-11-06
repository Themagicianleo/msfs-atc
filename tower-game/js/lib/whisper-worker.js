/* Speech recognition with OpenAI's Whisper (open source) in a worker, so the game keeps running while a
   transmission is recognised. Module worker. Nothing is part of the site: the browser downloads the runtime
   (jsDelivr, transformers.js running onnxruntime-web) and the model (Hugging Face, or its mirror hf-mirror.com)
   once, and keeps them in its cache for offline play.

   messages in:  {type:'load', id, model, runtime, hosts}
                 {type:'transcribe', id, audio: Float32Array (16 kHz mono), language, prompt}
   messages out: {id, ok:true, ...} | {id, error} | {progress:{file, loaded, total}}                       */

let asr = null;

async function load({ model, runtime, hosts }) {
  const tf = await import(/* @vite-ignore */ runtime);
  tf.env.allowLocalModels = false;
  tf.env.useBrowserCache = true;
  let lastErr;
  for (const host of hosts) {
    try {
      tf.env.remoteHost = host;
      asr = await tf.pipeline('automatic-speech-recognition', model, {
        dtype: 'q8', // 8-bit weights: a quarter of the download, nearly the same accuracy
        device: 'wasm',
        progress_callback: (p) => { if (p && p.status === 'progress') self.postMessage({ progress: { file: p.file, loaded: p.loaded, total: p.total } }); },
      });
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// The prompt (callsigns, taxiways, usual phrases) is given to the model as the text that came "before" the
// audio, which makes it spell those names the same way. Not every runtime version accepts it: then it is left out.
async function run(audio, language, prompt) {
  const opts = { language, task: 'transcribe', chunk_length_s: 30, return_timestamps: false };
  if (prompt) {
    try {
      const tok = asr.tokenizer;
      const prev = tok.model.convert_tokens_to_ids?.(['<|startofprev|>'])?.[0];
      const ids = tok.encode(` ${prompt}`);
      if (prev !== undefined && prev !== null && ids?.length) return await asr(audio, { ...opts, generate_kwargs: { prompt_ids: [prev, ...ids] } });
    } catch { /* fall through: without the prompt */ }
  }
  return asr(audio, opts);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load(m);
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'transcribe') {
      const t0 = Date.now();
      const out = await run(m.audio, m.language, m.prompt);
      self.postMessage({ id: m.id, ok: true, text: String(out?.text || '').trim(), ms: Date.now() - t0 });
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
