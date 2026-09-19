const APP_KEY_STORAGE = 'kp-translator-app-key';

const LANGS = {
  ko: { speechCode: 'ko-KR', translatorCode: 'ko', label: 'Korean', rtl: false },
  fa: { speechCode: 'fa-IR', translatorCode: 'fa', label: 'Persian', rtl: true },
};

let direction = 'ko-fa'; // 'ko-fa' means source=Korean, target=Persian
let recognizer = null;
let recognizing = false;
let interimTimer = null;
let lastInterimText = '';

const statusEl = document.getElementById('status');
const micBtn = document.getElementById('micBtn');
const swapBtn = document.getElementById('swapBtn');
const srcLangLabel = document.getElementById('srcLangLabel');
const tgtLangLabel = document.getElementById('tgtLangLabel');
const sourceLiveEl = document.getElementById('sourceLive');
const targetLiveEl = document.getElementById('targetLive');
const transcriptEl = document.getElementById('transcript');

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
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'x-app-key': appKey || '',
      'Content-Type': 'application/json',
    },
  });
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

function appendFinalTurn(sourceText, sourceLang, targetLang) {
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

  translate(sourceText, sourceLang.translatorCode, targetLang.translatorCode)
    .then((translation) => {
      setText(dstP, translation, targetLang);
      speak(translation, targetLang.speechCode);
    })
    .catch((err) => {
      dstP.textContent = '(translation failed)';
      console.error(err);
    });
}

function scheduleLiveTranslate(text) {
  if (!text || text === lastInterimText) return;
  lastInterimText = text;
  clearTimeout(interimTimer);
  interimTimer = setTimeout(() => {
    const sourceLang = getSourceLang();
    const targetLang = getTargetLang();
    translate(text, sourceLang.translatorCode, targetLang.translatorCode)
      .then((translation) => setText(targetLiveEl, translation, targetLang))
      .catch((err) => console.error(err));
  }, 350);
}

async function startRecognition() {
  statusEl.textContent = 'Connecting…';
  const { token, region } = await apiFetch('/api/speech-token', { method: 'GET' });

  const sourceLang = getSourceLang();
  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.speechRecognitionLanguage = sourceLang.speechCode;

  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognizing = (s, e) => {
    const text = e.result.text;
    setText(sourceLiveEl, text, sourceLang);
    scheduleLiveTranslate(text);
  };

  recognizer.recognized = (s, e) => {
    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech && e.result.text) {
      setText(sourceLiveEl, '', sourceLang);
      targetLiveEl.textContent = '';
      lastInterimText = '';
      appendFinalTurn(e.result.text, sourceLang, getTargetLang());
    }
  };

  recognizer.canceled = (s, e) => {
    console.error('Recognition canceled:', e.errorDetails);
    statusEl.textContent = `Error: ${e.errorDetails || 'recognition canceled'}`;
    stopRecognition();
  };

  recognizer.sessionStopped = () => stopRecognition();

  recognizer.startContinuousRecognitionAsync(
    () => {
      recognizing = true;
      statusEl.textContent = `Listening (${sourceLang.label})…`;
      micBtn.classList.add('listening');
    },
    (err) => {
      statusEl.textContent = `Error: ${err}`;
      stopRecognition();
    }
  );
}

function stopRecognition() {
  const r = recognizer;
  recognizer = null;
  recognizing = false;
  micBtn.classList.remove('listening');
  statusEl.textContent = 'Tap the microphone to start.';
  if (r) {
    r.stopContinuousRecognitionAsync(
      () => r.close(),
      () => r.close()
    );
  }
}

micBtn.addEventListener('click', () => {
  if (recognizing) {
    stopRecognition();
  } else {
    startRecognition().catch((err) => {
      statusEl.textContent = `Error: ${err.message}`;
      console.error(err);
    });
  }
});

swapBtn.addEventListener('click', () => {
  const wasRecognizing = recognizing;
  if (wasRecognizing) stopRecognition();
  direction = direction === 'ko-fa' ? 'fa-ko' : 'ko-fa';
  updateLangLabels();
  sourceLiveEl.textContent = '';
  targetLiveEl.textContent = '';
  if (wasRecognizing) {
    startRecognition().catch((err) => {
      statusEl.textContent = `Error: ${err.message}`;
    });
  }
});

updateLangLabels();
