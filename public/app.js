const APP_KEY_STORAGE = 'kp-translator-app-key';

const LANGS = {
  ko: { code: 'ko', label: 'Korean', speechCode: 'ko-KR', rtl: false },
  fa: { code: 'fa', label: 'Persian', speechCode: 'fa-IR', rtl: true },
};

let direction = 'ko-fa'; // 'ko-fa' => source Korean, target Persian
let listening = false;

// --- Voice-activity detection tuning ---
const VAD_INTERVAL_MS = 100;
// Speech = louder than 3x the room's measured background noise, with a low
// absolute floor. A fixed threshold proved too high for quiet mics with
// iOS noise suppression on.
const MIN_SPEECH_RMS = 0.008;
const NOISE_FLOOR_START = 0.003;
const SILENCE_DURATION_MS = 700;
const SEGMENT_INTERVAL_MS = 2000; // how often to flush a growing utterance for a live update
const MIN_SPEECH_MS = 400; // ignore blips shorter than this

let audioCtx = null;
let analyser = null;
let vadTimer = null;
let mediaStream = null;
let recorder = null;

let speaking = false;
let silenceMs = 0;
let segmentMs = 0;
let speechMsTotal = 0;
let noiseFloor = NOISE_FLOOR_START;
let currentUtterance = null; // { segments: [] } - see startSegmentRecorder

const statusEl = document.getElementById('status');
const micBtn = document.getElementById('micBtn');
const swapBtn = document.getElementById('swapBtn');
const srcLangLabel = document.getElementById('srcLangLabel');
const tgtLangLabel = document.getElementById('tgtLangLabel');
const sourceLiveEl = document.getElementById('sourceLive');
const targetLiveEl = document.getElementById('targetLive');
const transcriptEl = document.getElementById('transcript');
const levelBar = document.getElementById('levelBar');

function getAppKey() {
  let key = localStorage.getItem(APP_KEY_STORAGE);
  if (!key) {
    key = window.prompt('Enter the app password:');
    if (key) localStorage.setItem(APP_KEY_STORAGE, key);
  }
  return key;
}

async function apiFetch(path, options = {}) {
  const appKey = getAppKey();
  const headers = { ...(options.headers || {}), 'x-app-key': appKey || '' };
  // Only force JSON content-type for plain JSON bodies - a FormData body
  // needs the browser to set its own multipart boundary.
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem(APP_KEY_STORAGE);
    throw new Error('Wrong app password. Reload the page to try again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

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

async function transcribe(blob, language) {
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('webm') ? 'webm' : 'audio';
  const form = new FormData();
  form.append('audio', blob, `segment.${ext}`);
  form.append('language', language);
  const { text } = await apiFetch('/api/transcribe', { method: 'POST', body: form });
  return text;
}

async function translate(text, from, to) {
  if (!text || !text.trim()) return '';
  const { translation } = await apiFetch('/api/translate', {
    method: 'POST',
    body: JSON.stringify({ text, from, to }),
  });
  return translation;
}

function speak(text, speechCode) {
  if (!('speechSynthesis' in window) || !text) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = speechCode;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
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

  translate(sourceText, sourceLang.code, targetLang.code)
    .then((translation) => {
      setText(dstP, translation, targetLang);
      speak(translation, targetLang.speechCode);
    })
    .catch((err) => {
      dstP.textContent = '(translation failed)';
      console.error(err);
    });
}

// --- Recording segment lifecycle ---
// A single MediaRecorder instance produces one clean, decodable audio blob
// per start/stop cycle. Rather than trying to grow one recording (which
// would need incremental container parsing to get an interim guess), we
// stop and immediately start a fresh recorder every couple of seconds while
// the user is still talking, transcribe each short clip independently, and
// stitch the resulting TEXT together - this sidesteps having to concatenate
// compressed audio containers, which isn't reliably possible.
function pickMimeType() {
  const candidates = ['audio/mp4', 'audio/webm'];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined; // let the browser choose its default
}
const RECORDER_MIME_TYPE = pickMimeType();

function startSegmentRecorder() {
  // Capture which utterance this recorder's eventual blob belongs to, so a
  // fast-starting next utterance can never corrupt this one's text - each
  // segment's transcript is appended to the specific utterance object it
  // was recorded for, not a shared mutable variable.
  const utterance = currentUtterance;
  const options = RECORDER_MIME_TYPE ? { mimeType: RECORDER_MIME_TYPE } : undefined;
  recorder = new MediaRecorder(mediaStream, options);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || RECORDER_MIME_TYPE || 'audio/webm' });
    handleSegmentBlob(blob, utterance);
  };
  recorder.start();
}

function rotateSegment(isFinal) {
  if (!recorder || recorder.state === 'inactive') return;
  recorder.stop();
  recorder = null;
  if (!isFinal) startSegmentRecorder();
}

async function handleSegmentBlob(blob, utterance) {
  if (blob.size < 500) return; // essentially empty
  try {
    const text = await transcribe(blob, getSourceLang().code);
    if (!text) return;
    utterance.segments.push(text);
    if (utterance !== currentUtterance) return; // a newer utterance has since started
    const sourceLang = getSourceLang();
    const combined = utterance.segments.join(' ');
    setText(sourceLiveEl, combined, sourceLang);
    translate(combined, sourceLang.code, getTargetLang().code)
      .then((t) => setText(targetLiveEl, t, getTargetLang()))
      .catch((err) => {
        console.error(err);
        statusEl.textContent = `Translation error: ${err.message}`;
      });
  } catch (err) {
    console.error('Transcription error:', err);
    statusEl.textContent = `Transcription error: ${err.message}`;
  }
}

function finalizeUtterance() {
  const hadEnoughSpeech = speechMsTotal >= MIN_SPEECH_MS;
  const finishedUtterance = currentUtterance;
  rotateSegment(true); // stops the current recorder without starting a replacement
  speaking = false;
  silenceMs = 0;
  segmentMs = 0;
  speechMsTotal = 0;

  // Start capturing the next utterance immediately so there's no gap if the
  // other person starts talking right away; the 400ms delay below is only
  // for waiting on this just-finished utterance's last transcript to land.
  currentUtterance = { segments: [] };
  if (listening) startSegmentRecorder();
  sourceLiveEl.textContent = '';
  targetLiveEl.textContent = '';

  setTimeout(() => {
    const fullText = finishedUtterance.segments.join(' ').trim();
    if (hadEnoughSpeech && fullText) appendFinalTurn(fullText);
  }, 400);
}

function handleVadSample(rms) {
  const isSpeech = rms > Math.max(MIN_SPEECH_RMS, noiseFloor * 3);
  if (!isSpeech && !speaking) noiseFloor = noiseFloor * 0.9 + rms * 0.1;
  if (isSpeech) {
    if (!speaking) statusEl.textContent = `Speaking detected (${getSourceLang().label})…`;
    speaking = true;
    silenceMs = 0;
    speechMsTotal += VAD_INTERVAL_MS;
  } else if (speaking) {
    silenceMs += VAD_INTERVAL_MS;
  }
  if (speaking) segmentMs += VAD_INTERVAL_MS;

  if (speaking && silenceMs >= SILENCE_DURATION_MS) {
    finalizeUtterance();
  } else if (speaking && segmentMs >= SEGMENT_INTERVAL_MS) {
    segmentMs = 0;
    rotateSegment(false);
  }
}

function startVadLoop() {
  const data = new Uint8Array(analyser.fftSize);
  vadTimer = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    levelBar.style.width = `${Math.min(100, (rms / 0.1) * 100)}%`;
    handleVadSample(rms);
  }, VAD_INTERVAL_MS);
}

async function startListening() {
  // iOS Safari only lets an AudioContext run if it's created and resumed
  // synchronously inside the tap; creating it after awaiting mic permission
  // leaves it suspended and the analyser reads pure silence forever.
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();

  statusEl.textContent = 'Requesting microphone…';
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await audioCtx.resume();
  if (audioCtx.state !== 'running') {
    throw new Error(`audio engine is ${audioCtx.state} - tap the mic again`);
  }

  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  // WebKit may skip processing nodes that don't lead to the destination, so
  // route the analyser into a muted gain node to keep it fed with samples.
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  analyser.connect(mute);
  mute.connect(audioCtx.destination);

  currentUtterance = { segments: [] };
  speaking = false;
  silenceMs = 0;
  segmentMs = 0;
  speechMsTotal = 0;
  noiseFloor = NOISE_FLOOR_START;

  startSegmentRecorder();
  startVadLoop();

  listening = true;
  micBtn.classList.add('listening');
  statusEl.textContent = `Listening (${getSourceLang().label})…`;
}

function stopListening() {
  listening = false;
  micBtn.classList.remove('listening');
  statusEl.textContent = 'Tap the microphone to start.';

  if (vadTimer) {
    clearInterval(vadTimer);
    vadTimer = null;
  }
  levelBar.style.width = '0%';
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null; // discard the trailing partial clip
    recorder.stop();
  }
  recorder = null;
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  currentUtterance = null;
}

function beginListening() {
  startListening().catch((err) => {
    console.error(err);
    stopListening();
    statusEl.textContent = `Microphone error: ${err.message}`;
  });
}

micBtn.addEventListener('click', () => {
  if (listening) {
    stopListening();
    return;
  }
  // Ask for the password before audio starts: a prompt dialog popping up
  // mid-recording can interrupt the audio session on iOS.
  if (!getAppKey()) return;
  beginListening();
});

swapBtn.addEventListener('click', () => {
  const wasListening = listening;
  if (wasListening) stopListening();
  direction = direction === 'ko-fa' ? 'fa-ko' : 'ko-fa';
  updateLangLabels();
  sourceLiveEl.textContent = '';
  targetLiveEl.textContent = '';
  if (wasListening) beginListening();
});

updateLangLabels();
