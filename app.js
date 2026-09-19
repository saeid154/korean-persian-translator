const LANGS = {
  ko: { code: 'ko', label: 'Korean', rtl: false },
  fa: { code: 'fa', label: 'Persian', rtl: true },
};

let direction = 'ko-fa'; // 'ko-fa' => source Korean, target Persian
let listening = false;
let modelsReady = false;

// --- Audio capture / voice-activity detection state ---
const SAMPLE_RATE = 16000;
const SILENCE_RMS = 0.012;
const SILENCE_DURATION_MS = 700;
const INTERIM_INTERVAL_MS = 1500;
const MAX_UTTERANCE_MS = 20000;

let audioCtx = null;
let workletNode = null;
let mediaStream = null;
let utteranceChunks = [];
let utteranceMs = 0;
let silenceMs = 0;
let speaking = false;
let lastInterimAt = 0;
let transcribeBusy = false;
let nextRequestId = 1;
const pendingTranslations = new Map(); // requestId -> { kind: 'live' | 'final', el }

const statusEl = document.getElementById('status');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const micBtn = document.getElementById('micBtn');
const swapBtn = document.getElementById('swapBtn');
const srcLangLabel = document.getElementById('srcLangLabel');
const tgtLangLabel = document.getElementById('tgtLangLabel');
const sourceLiveEl = document.getElementById('sourceLive');
const targetLiveEl = document.getElementById('targetLive');
const transcriptEl = document.getElementById('transcript');

function getSourceLang() {
  return direction === 'ko-fa' ? LANGS.ko : LANGS.fa;
}
function getTargetLang() {
  return direction === 'ko-fa' ? LANGS.fa : LANGS.ko;
}

function setText(el, text, lang) {
  el.textContent = text;
  el.dir = lang.rtl ? 'rtl' : 'ltr';
}

function updateLangLabels() {
  srcLangLabel.textContent = getSourceLang().label;
  tgtLangLabel.textContent = getTargetLang().label;
}

// --- Worker setup ---
const worker = new Worker('model-worker.js', { type: 'module' });

worker.onmessage = (event) => {
  const { type, payload } = event.data;

  if (type === 'progress') {
    handleProgress(payload);
  } else if (type === 'ready') {
    modelsReady = true;
    progressWrap.hidden = true;
    statusEl.textContent = 'Ready. Tap the microphone to start.';
    micBtn.disabled = false;
  } else if (type === 'transcript') {
    handleTranscript(payload);
  } else if (type === 'translation') {
    handleTranslation(payload);
  } else if (type === 'error') {
    console.error('Worker error:', payload.message);
    statusEl.textContent = `Error: ${payload.message}`;
    transcribeBusy = false;
  }
};

const seenFiles = new Set();
let totalFiles = 0;
let doneFiles = 0;

function handleProgress(info) {
  // transformers.js progress events: { status, file, progress, ... }
  if (!info || !info.file) return;
  if (!seenFiles.has(info.file)) {
    seenFiles.add(info.file);
    totalFiles += 1;
  }
  if (info.status === 'done') {
    doneFiles += 1;
  }
  progressWrap.hidden = false;
  const pct = Math.min(100, Math.round((doneFiles / Math.max(totalFiles, 1)) * 100));
  progressBar.style.width = `${pct}%`;
  statusEl.textContent = `Downloading on-device models… ${pct}% (${info.file})`;
}

function handleTranscript({ requestId, kind, text }) {
  if (kind === 'interim') {
    transcribeBusy = false;
    const sourceLang = getSourceLang();
    setText(sourceLiveEl, text, sourceLang);
    if (text) {
      const id = nextRequestId++;
      pendingTranslations.set(id, { kind: 'live' });
      worker.postMessage({
        type: 'translate',
        payload: {
          requestId: id,
          kind: 'live',
          text,
          sourceLang: sourceLang.code,
          targetLang: getTargetLang().code,
        },
      });
    }
  } else if (kind === 'final') {
    transcribeBusy = false;
    setText(sourceLiveEl, '', getSourceLang());
    targetLiveEl.textContent = '';
    if (text) appendFinalTurn(text);
  }
}

function appendFinalTurn(sourceText) {
  const sourceLang = getSourceLang();
  const targetLang = getTargetLang();

  const row = document.createElement('div');
  row.className = 'turn';
  const srcP = document.createElement('p');
  srcP.className = 'src';
  setText(srcP, sourceText, sourceLang);
  const dstP = document.createElement('p');
  dstP.className = 'dst';
  setText(dstP, '…', targetLang);
  row.append(srcP, dstP);
  transcriptEl.prepend(row);

  const id = nextRequestId++;
  pendingTranslations.set(id, { kind: 'final', el: dstP, targetLang });
  worker.postMessage({
    type: 'translate',
    payload: {
      requestId: id,
      kind: 'final',
      text: sourceText,
      sourceLang: sourceLang.code,
      targetLang: targetLang.code,
    },
  });
}

function handleTranslation({ requestId, kind, text }) {
  const pending = pendingTranslations.get(requestId);
  pendingTranslations.delete(requestId);
  if (kind === 'live') {
    setText(targetLiveEl, text, getTargetLang());
  } else if (kind === 'final' && pending) {
    setText(pending.el, text, pending.targetLang);
    speak(text, pending.targetLang.code);
  }
}

function speak(text, langCode) {
  if (!('speechSynthesis' in window) || !text) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = langCode === 'fa' ? 'fa-IR' : 'ko-KR';
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

// --- Audio capture + simple energy-based voice activity detection ---
function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function requestInterimTranscript() {
  if (transcribeBusy || utteranceChunks.length === 0) return;
  transcribeBusy = true;
  const audio = concatChunks(utteranceChunks);
  worker.postMessage({
    type: 'transcribe',
    payload: { requestId: nextRequestId++, kind: 'interim', audio, sourceLang: getSourceLang().code },
  }, [audio.buffer]);
}

function finalizeUtterance() {
  if (utteranceChunks.length === 0) return;
  const audio = concatChunks(utteranceChunks);
  utteranceChunks = [];
  utteranceMs = 0;
  silenceMs = 0;
  speaking = false;
  transcribeBusy = true;
  worker.postMessage({
    type: 'transcribe',
    payload: { requestId: nextRequestId++, kind: 'final', audio, sourceLang: getSourceLang().code },
  }, [audio.buffer]);
}

function handleAudioChunk(chunk) {
  const level = rms(chunk);
  const chunkMs = (chunk.length / SAMPLE_RATE) * 1000;
  const now = performance.now();

  if (level > SILENCE_RMS) {
    speaking = true;
    silenceMs = 0;
    utteranceChunks.push(chunk);
    utteranceMs += chunkMs;
    if (now - lastInterimAt > INTERIM_INTERVAL_MS) {
      lastInterimAt = now;
      requestInterimTranscript();
    }
    if (utteranceMs > MAX_UTTERANCE_MS) {
      finalizeUtterance();
    }
  } else if (speaking) {
    utteranceChunks.push(chunk);
    utteranceMs += chunkMs;
    silenceMs += chunkMs;
    if (silenceMs > SILENCE_DURATION_MS) {
      finalizeUtterance();
    }
  }
}

async function startListening() {
  statusEl.textContent = 'Requesting microphone…';
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  await audioCtx.audioWorklet.addModule('audio-processor.js');
  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-batcher');
  workletNode.port.onmessage = (event) => handleAudioChunk(event.data);
  source.connect(workletNode);

  listening = true;
  micBtn.classList.add('listening');
  statusEl.textContent = `Listening (${getSourceLang().label})…`;
}

function stopListening() {
  listening = false;
  micBtn.classList.remove('listening');
  statusEl.textContent = 'Tap the microphone to start.';

  if (utteranceChunks.length > 0) finalizeUtterance();

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

micBtn.addEventListener('click', () => {
  if (!modelsReady) return;
  if (listening) {
    stopListening();
  } else {
    startListening().catch((err) => {
      statusEl.textContent = `Microphone error: ${err.message}`;
      console.error(err);
    });
  }
});

swapBtn.addEventListener('click', () => {
  const wasListening = listening;
  if (wasListening) stopListening();
  direction = direction === 'ko-fa' ? 'fa-ko' : 'ko-fa';
  updateLangLabels();
  sourceLiveEl.textContent = '';
  targetLiveEl.textContent = '';
  if (wasListening) {
    startListening().catch((err) => {
      statusEl.textContent = `Microphone error: ${err.message}`;
    });
  }
});

updateLangLabels();
worker.postMessage({ type: 'load' });
