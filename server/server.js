require('dotenv').config();

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  AZURE_TRANSLATOR_KEY,
  AZURE_TRANSLATOR_REGION,
  APP_PASSWORD,
  PORT = 3000,
} = process.env;

// Fail fast on startup instead of silently running as an unprotected proxy
// or with a broken Azure integration.
const REQUIRED_ENV = {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  AZURE_TRANSLATOR_KEY,
  AZURE_TRANSLATOR_REGION,
  APP_PASSWORD,
};
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Everything under /api requires the shared app password and is rate
// limited, since every request costs real Azure money.
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

// Issues a short-lived (10 minute) Azure Speech token so the browser can
// talk to Azure's streaming recognizer directly without ever seeing the
// real subscription key.
app.get('/api/speech-token', async (req, res) => {
  try {
    const tokenRes = await fetch(
      `https://${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY },
      }
    );
    if (!tokenRes.ok) {
      throw new Error(`Azure token request failed: ${tokenRes.status}`);
    }
    const token = await tokenRes.text();
    res.json({ token, region: AZURE_SPEECH_REGION });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to issue speech token' });
  }
});

const ALLOWED_LANGS = new Set(['ko', 'fa']);

// Proxies text translation so the Translator key stays server-side.
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
    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${from}&to=${to}`;
    const translateRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_TRANSLATOR_KEY,
        'Ocp-Apim-Subscription-Region': AZURE_TRANSLATOR_REGION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ Text: text }]),
    });
    if (!translateRes.ok) {
      throw new Error(`Azure Translator request failed: ${translateRes.status}`);
    }
    const data = await translateRes.json();
    const translation = data?.[0]?.translations?.[0]?.text ?? '';
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
