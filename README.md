# Korean ⇄ Persian Live Translator

A web app (works in iPhone Safari, no Mac/Xcode needed) that listens to
speech, shows a live rough translation while you're still talking, and
replaces it with a corrected translation once the sentence is finalized.
Speaks the translation aloud using the phone's built-in voices.

> **Note:** this repo briefly went through a fully offline, on-device
> version (no server/account at all) using Whisper + NLLB running in the
> browser. Real iPhone testing showed it repeatedly crashing Safari from
> memory pressure, even after cutting the models down — in-browser ML on
> iOS Safari is genuinely not reliable enough yet for this. This is back to
> the cloud (Azure) version below, which is far more likely to just work.

## How it works

```
iPhone Safari  ── mic audio (direct, wss) ──►  Azure Speech (speech-to-text)
      │                                              │
      │◄── interim + final transcript ───────────────┘
      │
      │── text to translate ──►  your Node server ──►  Azure Translator
      │◄── translated text ───────────┘
```

- The browser talks to Azure Speech **directly** over a secure WebSocket
  using a short-lived token (10 minutes) — this keeps latency low and is
  Microsoft's recommended pattern for browser apps.
- The browser talks to **your own server** for translation. Your server
  holds the real Azure Translator key and forwards the request — the key
  never reaches the phone.
- While you're mid-sentence, Azure sends "recognizing" (interim) events;
  each one is translated and shown immediately (throttled to ~3/sec so it
  doesn't spam the API). When Azure emits the final "recognized" event for
  the complete sentence, that clean text is re-translated and replaces the
  live guess — that's the "live, then corrected" behavior you asked for.
- Tap the ⇄ button to flip direction (Korean→Persian or Persian→Korean).
  A fixed direction (rather than auto-detecting the spoken language) keeps
  recognition accuracy high — telling Azure "expect Korean" vs. "expect
  Persian" matters a lot for accuracy.

## Why Azure for both pieces

| Need | Service | Why |
|---|---|---|
| Streaming speech-to-text, ko-KR + fa-IR, interim results | **Azure Speech** | Free tier: 5 audio-hours/month forever, then ~$1/hour. Confirmed streaming support for both languages. |
| Text translation, ko ↔ fa | **Azure Translator** | Free tier: 2,000,000 characters/month forever, then ~$10/million chars. |

For light personal use (a few hours a week of talking) this will likely
stay **$0/month**, permanently — both free tiers renew every month, they're
not a one-time trial. Heavier daily use (say an hour a day) is still only
roughly $5–10/month combined. I picked Azure over Google Cloud because
Google's generous-looking free tier is a 90-day trial credit, not
recurring, and Azure's Translator free tier alone is larger than most
personal usage will ever need.

If you ever outgrow the Speech free tier, a cheaper (but non-streaming)
fallback for speech-to-text is OpenAI's transcription API (~$0.003–0.006
per minute); it would need short recorded chunks instead of continuous
interim results, so it's a rougher live experience — worth it only if cost
becomes the binding constraint.

## Keeping your API keys safe

1. **Keys never go in client-side code.** Anything shipped to Safari
   (HTML/CSS/JS) is visible to anyone via "View Source" — so the Azure
   Speech key and Translator key live only in server environment
   variables (`server/.env` locally, host secrets in production), never in
   `public/`.
2. **The browser gets a scoped, short-lived token, not the real key**, for
   speech (`/api/speech-token` mints a 10-minute Azure token). If someone
   intercepted it, it expires quickly and only grants speech access.
3. **`server/.env` is git-ignored** (see `.gitignore`) so it can't be
   committed by accident. `server/.env.example` is the template — copy it,
   don't rename it.
4. **A shared app password** (`APP_PASSWORD`) gates every `/api/*` route.
   The web app asks for it once (stored in `localStorage`) and sends it as
   an `x-app-key` header. Without this, anyone who discovered your app's
   URL could make translation/speech requests on your Azure bill.
5. **Rate limiting** (60 requests/min per IP) on all `/api/*` routes caps
   the damage even if the password leaks.
6. If a key ever leaks, rotate it immediately in the Azure Portal (Keys
   and Endpoint blade) — this instantly invalidates the old one.

## Running it locally

```bash
cd server
cp .env.example .env      # then fill in your real Azure keys + a password
npm install
npm start
```

Open `http://localhost:3000` in a desktop browser to sanity-check the UI.
(Full mic testing is easiest once it's deployed with HTTPS — see below;
Safari also allows mic access on `http://localhost` if you want to try
Safari's iOS Simulator or a Mac browser first.)

### Getting Azure keys

1. Create a free account at https://portal.azure.com.
2. Create a **Speech** resource (search "Speech" in "Create a resource").
   Pick the **F0 (free)** pricing tier if offered. Note its **Key** and
   **Region** from the resource's "Keys and Endpoint" page.
3. Create a **Translator** resource the same way (search "Translator").
   Again pick the **F0 (free)** tier. Note its **Key** and **Region**.
4. Put those four values plus a password you invent into `server/.env`
   (or your host's environment variable settings).

## Deploying so you can open it on your iPhone

Mic access requires HTTPS (or localhost), so you need to actually deploy
this rather than just opening the HTML file. **Render.com** has a free web
service tier with automatic HTTPS and is the simplest option:

1. Push this repository to GitHub (already set up if you're reading this
   from the repo).
2. Go to https://render.com, sign up/log in, click **New +** → **Web
   Service**, and connect this GitHub repo.
3. Configure it:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment**, add the 5 variables from `server/.env.example`
   (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_TRANSLATOR_KEY`,
   `AZURE_TRANSLATOR_REGION`, `APP_PASSWORD`) with your real values.
5. Click **Create Web Service**. Render builds and gives you a URL like
   `https://your-app-name.onrender.com`.

Note: Render's free tier spins the service down after 15 minutes of
inactivity, so the first request after a while takes ~30–50 seconds to
wake up. That's a fine trade-off for a personal app; if it bothers you,
Render's paid $7/month instance (or a small Fly.io VM) stays always-on.

This needs a **different host than GitHub Pages** — GitHub Pages only
serves static files and can't run the Node server that keeps your Azure
keys safe. Render (or Fly.io/Railway) is required here.

### Opening it on your iPhone 14 Pro

1. Open Safari and go to your Render URL.
2. Allow microphone access when prompted.
3. Enter the app password you set as `APP_PASSWORD` (asked once, then
   remembered).
4. Tap the Share icon → **Add to Home Screen** to get an app-like icon
   that opens full-screen without Safari's address bar.

## Known limitations / good next upgrades

- **Direction is manual, not auto-detected.** Tap ⇄ before the other
  person starts speaking. Auto-detecting Korean vs. Persian mid-stream is
  possible with Azure's `AutoDetectSourceLanguageConfig`, but it doesn't
  reliably know the language until a phrase finishes, which would make the
  *interim* (live) results unreliable — not worth the trade-off for a v1.
- **Spoken output uses the phone's free built-in voice**, not a cloud
  neural voice. If Persian TTS quality/availability on-device isn't good
  enough, Azure also offers cloud text-to-speech (`fa-IR` neural voices)
  for a small additional cost — same auth pattern (short-lived token) would
  apply.
- **No offline mode** — this always needs a network connection since both
  STT and MT are cloud calls.
- For noticeably better translation quality/nuance on the *final* (not
  live) pass, swapping the last translation call per sentence for an LLM
  (e.g. Claude or GPT-4o-mini) is a straightforward upgrade — call it only
  on the final event, not every interim update, to keep cost low.
