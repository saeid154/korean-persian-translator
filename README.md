# Korean ⇄ Persian Offline Translator

A fully self-contained web app (works in iPhone Safari) that listens to
speech and translates between Korean and Persian — **with no server, no
account, no API key, and no ongoing cost.** Everything runs inside the
browser on your phone: speech recognition, translation, and even the
spoken output.

This is a deliberate rebuild after an earlier version of this project used
a cloud AI service (Azure) behind a small backend server. That worked well
and was cheap, but it wasn't "independent" — it needed a hosted server and
an external company's account/keys. This version needs none of that, at
the cost of lower accuracy and a chunkier (not word-by-word) live update.

## How it works — and why it needs no server

| Piece | Runs where | Technology |
|---|---|---|
| Speech-to-text | **In the browser**, on your phone's CPU | [Whisper](https://github.com/openai/whisper) (multilingual), via [Transformers.js](https://huggingface.co/docs/transformers.js) |
| Translation | **In the browser**, on your phone's CPU | [NLLB-200](https://ai.meta.com/research/no-language-left-behind/) (Meta's 200-language translation model), via Transformers.js |
| Spoken output | **In the browser** | The phone's own built-in `speechSynthesis` API |

Transformers.js runs real ONNX model files directly in JavaScript using
WebAssembly. The **only** network activity this app ever does is
downloading those model weight files once, from Hugging Face's public CDN
— the same way any other asset (like a font or an image) would load. After
that first download, the browser caches the files (Cache Storage API) and
the app works with **no internet connection at all**, forever, until you
clear Safari's site data.

There is no piece of this that talks to Azure, OpenAI, Google, or anyone
else's server at runtime. The code in this repo is the entire app.

## The real trade-offs of going fully offline

Be aware of what you're giving up compared to a cloud-based version:

1. **Not truly word-by-word live.** Whisper isn't a streaming model — it
   transcribes a chunk of audio at a time. This app fakes "live" by
   re-transcribing the audio captured so far roughly every 1.5 seconds
   while you're talking (using simple volume-based silence detection to
   know when a sentence has ended), so text updates in short bursts rather
   than continuously. When it detects ~0.7s of silence, it treats that as
   the end of a sentence, does one final transcription + translation pass,
   and that's what gets spoken aloud and logged.
2. **Lower accuracy, especially for Persian.** Whisper's training data
   skews toward higher-resource languages; Persian recognition will be
   noticeably rougher than Korean. NLLB-200 handles the ko↔fa pair
   reasonably but won't match a large cloud translation service.
3. **A real first-run cost.** The two models together are roughly
   150–700MB depending on the sizes you pick (defaults below aim for a
   reasonable middle ground). This downloads once — do it on Wi-Fi.
4. **CPU-only.** iOS Safari's WebAssembly runtime for these models
   currently has no working GPU acceleration path (`onnxruntime-web`'s
   WebGPU backend isn't supported on iOS regardless of browser, and there
   are open bug reports of it hanging/crashing pages when attempted). This
   app deliberately never tries WebGPU and forces CPU (WASM) execution —
   slower, but far more likely to actually work.
5. **This is genuinely experimental on iOS Safari.** In-browser ML on
   iPhone is a fast-moving, occasionally buggy area — there are open,
   unresolved GitHub issues about Whisper-in-the-browser misbehaving on
   iOS Safari specifically (crashes, stuck loading, cache errors). I've
   built around the known causes I could find (no WebGPU, inference in a
   Web Worker off the main thread, quantized/smaller models to reduce
   memory pressure, and clear on-screen errors instead of silent hangs),
   but **I have not been able to test this on a real iPhone myself** — I
   only validated it in a desktop headless browser. If something breaks
   the first time you try it, that's expected territory for this kind of
   app right now, not necessarily something wrong with the setup — see
   Troubleshooting below, and tell me what you see so we can fix it.

If, after trying this, the accuracy or reliability doesn't work for you,
the earlier Azure-based version (real streaming, much better accuracy, a
few dollars a month at most) is a reasonable fallback — just say so.

## Running it

There's no build step and nothing to install. It's plain HTML/CSS/JS.

**Locally, on a computer**, for a quick sanity check of the UI (mic access
works on `http://localhost` without HTTPS):

```bash
python3 -m http.server 8000
# open http://localhost:8000 in a browser
```

**On your iPhone**, you need HTTPS, so you need to actually host it
somewhere — see below.

## Hosting so you can open it on your iPhone — GitHub Pages (free, no account setup beyond GitHub)

Since this is now a 100%-static site, GitHub Pages is the simplest host —
it's free, gives you HTTPS automatically (required for microphone access),
and needs no server code, build step, or environment variables.

1. Push this repository to GitHub (if you're reading this from the repo,
   it's likely already there).
2. On GitHub, go to your repo → **Settings** → **Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a
   branch," pick the branch this code is on, and folder `/ (root)`.
4. Save. GitHub gives you a URL like
   `https://<your-username>.github.io/<repo-name>/`. It can take a minute
   or two to go live after the first save.

### Opening it on your iPhone 14 Pro

1. Open Safari and go to your GitHub Pages URL.
2. Tap the mic — Safari will ask for microphone permission; allow it.
3. Wait for the one-time model download (you'll see a progress bar). Do
   this on Wi-Fi the first time.
4. Once it says "Ready," tap the mic and talk. Tap ⇄ to flip direction
   between Korean→Persian and Persian→Korean.
5. Tap the Share icon → **Add to Home Screen** for an app-like icon that
   opens full-screen without Safari's address bar.

## Tuning it (in `model-worker.js`)

Two constants at the top control model size/quality/speed:

```js
const ASR_MODEL = 'Xenova/whisper-base';            // speech-to-text
const TRANSLATION_MODEL = 'Xenova/nllb-200-distilled-600M'; // translation
```

- For faster, smaller, less accurate: try `Xenova/whisper-tiny`.
- For slower, larger, more accurate: try `Xenova/whisper-small`.
- NLLB-200-distilled-600M is Meta's smallest official distilled NLLB
  model; there isn't a well-established smaller drop-in for this exact
  language pair without giving up either Korean or Persian coverage.

Voice-activity tuning is in `app.js` near the top:
`SILENCE_RMS` (how quiet counts as silence — raise this if it cuts you off
mid-sentence in a noisy room, lower it if it never detects silence),
`SILENCE_DURATION_MS` (how long a pause means "sentence over"), and
`INTERIM_INTERVAL_MS` (how often it tries a live update while you talk —
the app already skips a scheduled update if the previous one hasn't
finished, so on a slower phone updates will naturally come less often
rather than piling up).

## Troubleshooting

- **Stuck on "Loading on-device models…" forever:** check the browser
  console (on iPhone: Settings → Safari → Advanced → Web Inspector, then
  inspect from a Mac; or just watch the on-screen status text, which now
  shows the real error) — this app is built to show a real error message
  here (e.g. a network problem) rather than hang silently, so whatever it
  says is the actual cause.
- **Page reloads itself repeatedly / goes blank:** this matches a known
  class of iOS-Safari-specific crashes reported against Whisper-in-browser
  setups. Try `Xenova/whisper-tiny` (smaller, less memory pressure) in
  `model-worker.js`, and make sure Safari has been recently updated.
- **It mishears everything:** make sure the ⇄ toggle matches who's
  speaking — Korean recognition and Persian recognition are separate modes
  and each expects the language it's set to.
- **Translation quality is poor for uncommon phrases:** this is the
  expected quality ceiling of a compact on-device model; there is no
  further "correction pass" here like a cloud LLM could provide, since
  that would require a network call to some external service, which is
  exactly what this version avoids.
