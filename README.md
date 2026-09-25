# Korean ⇄ Persian Live Translator

A web app (works in iPhone Safari, no Mac/Xcode needed) that listens to
speech, and once you pause, shows the transcript and its translation —
speaking the translation aloud using the phone's built-in voice.

> **History:** this repo has gone through two earlier versions. First, an
> Azure-based one (dropped because signing up required a Microsoft
> account). Then a fully offline, on-device one using Whisper + NLLB
> running entirely in the browser (dropped because it repeatedly crashed
> Safari on real iPhone testing from memory pressure — in-browser ML isn't
> reliable enough on iOS Safari yet). This version uses OpenAI instead:
> simpler signup (email or an existing Google account, no Microsoft
> account), and one provider/key instead of several.

## How it works

```
iPhone Safari                         your Node server                OpenAI
     │                                       │                            │
     │── mic audio, ~2s clips ──────────────►│                            │
     │   (only while you're speaking,        │── audio clip ─────────────►│  transcription
     │    detected by volume)                │◄── transcript text ────────│  (gpt-4o-mini-transcribe)
     │◄── live transcript + translation ─────│                            │
     │                                       │── text to translate ──────►│  translation
     │◄── corrected translation, spoken ─────│◄── translated text ────────│  (gpt-4o-mini)
```

- The browser never talks to OpenAI directly and never holds the API key —
  every request goes through your own small server, which attaches the key
  server-side.
- **Why not true word-by-word streaming:** OpenAI's transcription API
  isn't a continuous streaming service the way this project first tried
  with Azure. Instead, the browser detects when you're speaking (by
  microphone volume) and records in short ~2 second clips while you talk,
  transcribing each clip independently and stitching the resulting *text*
  together — that's what gives the "live, updating" feel. When you pause
  (~0.7s of silence), that's treated as the end of a sentence: the full
  stitched text gets one final translation pass, gets spoken aloud, and is
  logged.
- Tap the ⇄ button to flip direction (Korean→Persian or Persian→Korean). A
  fixed direction (rather than auto-detecting the spoken language) keeps
  transcription accuracy high.

## Why OpenAI

One provider covers both pieces this app needs:

| Need | Model | Notes |
|---|---|---|
| Speech-to-text, Korean + Persian | `gpt-4o-mini-transcribe` | Good multilingual coverage; called on short clips, not full streaming. |
| Text translation, ko ↔ fa | `gpt-4o-mini` | Cheap, fast, handles this language pair well via a simple translation prompt. |

**Signup is simple:** go to platform.openai.com, sign up with your email
or "Continue with Google" (no Microsoft account, no resource groups, no
regions to pick) and create an API key.

**Cost is pay-as-you-go, not a permanent free tier** — unlike Azure, there
isn't a monthly free allowance that renews forever. You add a small
prepaid balance (as little as $5) and usage is deducted from it. For
personal conversational use, translation is negligible (a few cents per
1,000 sentences); transcription is priced per minute of audio and is the
main cost driver — check OpenAI's current pricing page for the exact rate
before relying on this for heavy daily use, since API pricing changes over
time and isn't worth hardcoding a number here that could go stale.

## Keeping your API key safe

1. **The key never goes in client-side code.** Anything shipped to Safari
   (HTML/CSS/JS) is visible to anyone via "View Source" — so the OpenAI key
   lives only in a server environment variable (`server/.env` locally,
   host secrets in production), never in `public/`.
2. **`server/.env` is git-ignored** (see `.gitignore`) so it can't be
   committed by accident. `server/.env.example` is the template — copy it,
   don't rename it.
3. **A shared app password** (`APP_PASSWORD`) gates every `/api/*` route.
   The web app asks for it once (stored in `localStorage`) and sends it as
   an `x-app-key` header. Without this, anyone who discovered your app's
   URL could burn through your OpenAI balance.
4. **Rate limiting** (60 requests/min per IP) on all `/api/*` routes caps
   the damage even if the password leaks.
5. If the key ever leaks, revoke it immediately at
   platform.openai.com/api-keys and issue a new one.

## Running it locally

```bash
cd server
cp .env.example .env      # then fill in your real OpenAI key + a password
npm install
npm start
```

Open `http://localhost:3000` in a desktop browser to sanity-check the UI.
(Full mic testing is easiest once it's deployed with HTTPS — see below;
Safari also allows mic access on `http://localhost`.)

### Getting an OpenAI API key

1. Go to https://platform.openai.com and sign up (email or Google login).
2. Add a small prepaid balance under **Settings → Billing**.
3. Go to **API keys**, create a new key, and copy it immediately (OpenAI
   only shows it once).
4. Put it plus a password you invent into `server/.env`.

## Deploying so you can open it on your iPhone

Mic access requires HTTPS, so you need to actually deploy this rather than
just opening the HTML file. **Render.com** has a free web service tier
with automatic HTTPS:

1. Push this repository to GitHub (already set up if you're reading this
   from the repo).
2. Go to https://render.com, sign up/log in, click **New +** → **Web
   Service**, and connect this GitHub repo.
3. Configure it:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment**, add `OPENAI_API_KEY` and `APP_PASSWORD` with your
   real values.
5. Click **Create Web Service**. Render builds and gives you a URL like
   `https://your-app-name.onrender.com`.

This needs a **different host than GitHub Pages** — GitHub Pages only
serves static files and can't run the Node server that keeps your API key
safe. Render (or Fly.io/Railway) is required here.

Note: Render's free tier spins the service down after 15 minutes of
inactivity, so the first request after a while takes ~30–50 seconds to
wake up. That's a fine trade-off for a personal app; if it bothers you,
Render's paid $7/month instance (or a small Fly.io VM) stays always-on.

### Opening it on your iPhone 14 Pro

1. Open Safari and go to your Render URL.
2. Allow microphone access when prompted.
3. Enter the app password you set as `APP_PASSWORD` (asked once, then
   remembered).
4. Tap the mic and talk — after you pause, the transcript, translation,
   and spoken output should appear.
5. Tap the Share icon → **Add to Home Screen** for an app-like icon that
   opens full-screen without Safari's address bar.

## Known limitations / good next upgrades

- **Not continuous word-by-word streaming** — see "How it works" above.
  The live text updates roughly every 2 seconds while you talk, not
  instantly per word.
- **Direction is manual, not auto-detected.** Tap ⇄ before the other
  person starts speaking.
- **Spoken output uses the phone's free built-in voice**, not a cloud
  neural voice. OpenAI also has a text-to-speech API if you want a more
  natural voice later, at a small additional cost.
- **~2-second clip boundaries can occasionally split a word awkwardly**,
  causing a minor transcription glitch right at that boundary — the final
  corrected pass usually smooths this out since it's working from the full
  stitched utterance.
- If you outgrow casual use, check OpenAI's current per-minute
  transcription pricing against your actual usage before relying on this
  daily — it's the main cost driver in this design.
