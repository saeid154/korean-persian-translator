// Runs entirely inside a Web Worker so heavy model inference never blocks
// the UI thread. Everything here executes on-device: model weights are
// downloaded once from Hugging Face's public CDN and cached by the browser
// (Cache Storage API); after that first download this worker makes no more
// network calls. There is no server, no account, and no API key anywhere
// in this app.
//
// iOS Safari's onnxruntime-web currently has no WebGPU support, and there
// are open reports of WebGPU attempts hanging/crashing the page on iOS. We
// deliberately force the WASM (CPU) execution provider everywhere instead.
//
// This is loaded with a dynamic import (not a static top-level `import`)
// specifically so a network hiccup fetching this ~third-party CDN module
// surfaces as a catchable error instead of silently leaving this worker's
// onmessage handler never registered at all.
const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

// Swap these for bigger/more accurate (but slower, larger-download, more
// memory-hungry) models once you've confirmed the defaults are stable on
// your phone. Multilingual (no ".en" suffix) Whisper models are required
// since we need Korean and Persian.
//
// Kept deliberately small: whisper-base (~150-300MB) + nllb-200-distilled-
// 600M at 8-bit (~600MB+) held in memory at the same time was enough to
// crash mobile Safari's tab (out of memory) during initial testing. tiny +
// 4-bit translation weights cut that combined footprint dramatically, at
// the cost of accuracy - this is the safer starting point.
const ASR_MODEL = 'Xenova/whisper-tiny';
const TRANSLATION_MODEL = 'Xenova/nllb-200-distilled-600M';

// Language tags each model expects.
const WHISPER_LANGUAGE = { ko: 'korean', fa: 'persian' };
const NLLB_CODE = { ko: 'kor_Hang', fa: 'pes_Arab' };

let pipeline = null;
let asrPipeline = null;
let translationPipeline = null;
let loaded = false;

function reportProgress(info) {
  // transformers.js reports one event per file (config, tokenizer, weights...).
  self.postMessage({ type: 'progress', payload: info });
}

async function loadModels() {
  if (!pipeline) {
    let mod;
    try {
      mod = await import(TRANSFORMERS_CDN_URL);
    } catch (err) {
      throw new Error(`Could not load the ML library from the CDN (check your internet connection): ${err.message}`);
    }
    pipeline = mod.pipeline;
    mod.env.allowLocalModels = false;
  }
  // whisper-tiny is small enough that 8-bit is fine. The 600M translation
  // model is the big one, so it gets the more aggressive 4-bit quantization
  // to keep combined resident memory down.
  asrPipeline = await pipeline('automatic-speech-recognition', ASR_MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: reportProgress,
  });
  translationPipeline = await pipeline('translation', TRANSLATION_MODEL, {
    dtype: 'q4',
    device: 'wasm',
    progress_callback: reportProgress,
  });
  loaded = true;
}

async function transcribe(audio, sourceLang) {
  const result = await asrPipeline(audio, {
    language: WHISPER_LANGUAGE[sourceLang],
    task: 'transcribe',
  });
  return (result?.text || '').trim();
}

async function translate(text, sourceLang, targetLang) {
  if (!text) return '';
  const result = await translationPipeline(text, {
    src_lang: NLLB_CODE[sourceLang],
    tgt_lang: NLLB_CODE[targetLang],
  });
  return result?.[0]?.translation_text || '';
}

self.onmessage = async (event) => {
  const { type, payload } = event.data;
  const requestId = payload?.requestId;

  try {
    if (type === 'load') {
      if (!loaded) await loadModels();
      self.postMessage({ type: 'ready' });
      return;
    }

    if (type === 'transcribe') {
      const text = await transcribe(payload.audio, payload.sourceLang);
      self.postMessage({ type: 'transcript', payload: { requestId, kind: payload.kind, text } });
      return;
    }

    if (type === 'translate') {
      const text = await translate(payload.text, payload.sourceLang, payload.targetLang);
      self.postMessage({ type: 'translation', payload: { requestId, kind: payload.kind, text } });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      payload: { requestId, message: (err && err.message) || String(err) },
    });
  }
};
