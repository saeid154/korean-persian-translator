require('dotenv').config();

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { OPENAI_API_KEY, APP_PASSWORD, PORT = 3000 } = process.env;

// Fail fast on startup instead of silently running as an unprotected proxy
// or with a broken OpenAI integration.
const REQUIRED_ENV = { OPENAI_API_KEY, APP_PASSWORD };
for (const [key, value] of Object.entries(REQUIRED_ENV)) {
  if (!value) {
    console.error(
      `Missing required environment variable: ${key}. Copy server/.env.example to server/.env and fill it in (or set it in your host's dashboard).`
    );
    process.exit(1);
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // one utterance clip, generous ceiling
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Everything under /api requires the shared app password and is rate
// limited, since every request costs real OpenAI money.
function requireAppKey(req, res, next) {
  const key = req.get('x-app-key');
  if (!key || key !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);
app.use('/api', requireAppKey);

const ALLOWED_LANGS = new Set(['ko', 'fa']);
const LANG_NAMES = { ko: 'Korean', fa: 'Persian' };

const EXT_FOR_MIME = {
  'audio/mp4': 'mp4',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};

// Proxies one short audio clip to OpenAI's transcription API. The browser
// never holds the OpenAI key - only this server does.
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file || !req.file.buffer.length) {
    return res.status(400).json({ error: 'audio file is required' });
  }
  const { language } = req.body || {};
  if (!ALLOWED_LANGS.has(language)) {
    return res.status(400).json({ error: 'invalid language' });
  }

  try {
    const ext = EXT_FOR_MIME[req.file.mimetype] || 'webm';
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), `audio.${ext}`);
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', language);
    form.append('response_format', 'json');

    const openaiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!openaiRes.ok) {
      const detail = await openaiRes.text().catch(() => '');
      throw new Error(`OpenAI transcription failed: ${openaiRes.status} ${detail.slice(0, 200)}`);
    }
    const data = await openaiRes.json();
    res.json({ text: (data.text || '').trim() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Transcription failed' });
  }
});

// Proxies text translation through OpenAI's chat completions API.
app.post('/api/translate', async (req, res) => {
  const { text, from, to } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'text too long' });
  }
  if (!ALLOWED_LANGS.has(from) || !ALLOWED_LANGS.has(to) || from === to) {
    return res.status(400).json({ error: 'invalid from/to language' });
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `Translate the user's message from ${LANG_NAMES[from]} to ${LANG_NAMES[to]}. Reply with ONLY the translation, no notes, no quotation marks, no explanation.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!openaiRes.ok) {
      const detail = await openaiRes.text().catch(() => '');
      throw new Error(`OpenAI translation failed: ${openaiRes.status} ${detail.slice(0, 200)}`);
    }
    const data = await openaiRes.json();
    const translation = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ translation });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Translation failed' });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
