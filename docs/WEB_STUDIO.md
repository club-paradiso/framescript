# FrameScript Web Studio

Web Studio is the public, file-based surface of FrameScript. It imports the
shared engine from `src/core`; it does not maintain a browser-specific copy of
reconstruction logic.

## Routes

| Route     | Purpose                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `/`       | Public product landing page                                               |
| `/studio` | Local file intake, reconstruction, review, search, inspection, and export |
| `/view`   | Project-focused import and review entry point                             |
| `/docs`   | In-product documentation                                                  |

Vite builds all routes into one static bundle. `vercel.json` rewrites direct
application-route requests to `index.html`, so refreshing `/studio`, `/view`, or
`/docs` works without server functions. The rewrite pattern excludes `/api/`,
`/assets/`, `/icons/`, `manifest.webmanifest` and `sw.js`: an API route rewritten
to the SPA shell would return HTML to a `fetch` expecting JSON, which is the
failure this exclusion exists to prevent.

## Analysis endpoints

| Route                | Method | Purpose                                                     |
| -------------------- | ------ | ----------------------------------------------------------- |
| `/api/capabilities`  | GET    | Which evidence sources this deployment can produce          |
| `/api/transcribe`    | POST   | One WAV window of detected speech to a transcript           |
| `/api/analyze-frame` | POST   | One window of selected keyframes to structured observations |

These exist because two things cannot be computed in the browser: turning speech
into words and turning a picture into a description. Everything else Studio does
is local and reaches no server.

The routes are the only place a provider credential lives. Studio holds no key,
no endpoint and no vendor identity; it posts to its own origin, which is why the
production CSP keeps `connect-src 'self'`.

### Configuration

Set on the deployment (Vercel project environment variables), never in the
client:

| Variable                      | Default                                          |
| ----------------------------- | ------------------------------------------------ |
| `FRAMESCRIPT_ASR_PROVIDER`    | `openai-compatible`                              |
| `FRAMESCRIPT_ASR_API_KEY`     | required to enable transcription                 |
| `FRAMESCRIPT_ASR_ENDPOINT`    | `https://api.openai.com/v1/audio/transcriptions` |
| `FRAMESCRIPT_ASR_MODEL`       | required to enable transcription                 |
| `FRAMESCRIPT_VISION_PROVIDER` | `anthropic`, or `openai-compatible`              |
| `FRAMESCRIPT_VISION_API_KEY`  | required to enable scene understanding           |
| `FRAMESCRIPT_VISION_ENDPOINT` | `https://api.anthropic.com/v1/messages`          |
| `FRAMESCRIPT_VISION_MODEL`    | required to enable scene understanding           |

Missing configuration is a state, not an error. `/api/capabilities` reports it,
the analyzer labels that source "Not configured", and local analysis proceeds.
`VITE_*` is never used for any of these: those are inlined into the client
bundle.

### What is transmitted

| Sent                                                          | Never sent                     |
| ------------------------------------------------------------- | ------------------------------ |
| Speech windows the VAD detected, 16 kHz mono, 30 s at most    | The media file                 |
| Up to 3 downscaled JPEG keyframes per selected window         | A frame stream, or every frame |
| Dialogue text and sound labels for the window being described | Audio, to the vision provider  |

Both stages are bounded per file: transcription plans windows against a total
speech budget, and scene understanding is capped by an explicit control (off, up
to 6 windows, or up to 12) that is separate from local observation fidelity.
Concurrency is capped at 2 for each. Repeated provider failures stop the stage
rather than retrying into a wall, and only 429 and 5xx are retried at all.

Nothing is stored server-side. Responses carry `no-store`, and the service worker
skips `/api/` entirely.

## Supported local workflows

- SRT and WebVTT subtitle-only reconstruction
- aligned multilingual subtitle tracks identified by filename, such as
  `episode.en.srt` and `episode.ko.srt`
- one browser-decodable video or audio file, optionally combined with subtitles
- versioned FrameScript JSON project import/export
- scene navigation, cross-language search, dual-language reading, provenance,
  coverage and conflict inspection
- Fountain, Markdown, text, SRT and native JSON export

Audio analysis detects speech regions, speaker clusters, sound events and
silence. Picture analysis observes motion and scene changes during local
playback. Where the deployment configures a provider, detected speech is
transcribed and selected scene windows are described; both produce **evidence**,
which the same deterministic engine assembles. A model never writes a screenplay,
and speaker clusters alone never become dialogue.

Analysis runs in named phases — reading media, decoding audio, detecting speech,
identifying speakers, transcribing speech, scanning picture, analyzing selected
scenes, building screenplay — and reports measured counts rather than one opaque
progress bar. Every stage may fail on its own: a transcription outage keeps the
speaker clusters, a readback failure keeps the audio, and each failure surfaces
as a typed, user-readable notice.

Coverage is reported per source and deliberately not merged. "Timeline observed"
and "detected speech transcribed" are different numbers, because 100% of a
timeline observed is not 100% of a screenplay.

## Browser security boundary

A normal website cannot inspect or control a YouTube or Netflix tab. Live player
observation, subtitle collection and Maximum Quality remain Chrome Extension
responsibilities. The supported handoff is a versioned FrameScript project:
export from the extension, then open the JSON file in `/view` or `/studio`.

No media or screenplay data is placed in URLs. No production origin is hardcoded,
and there is no externally connectable extension message bridge.

## Privacy and caching

Studio reads user-selected files with browser File APIs and runs analysis in the
page. It has no account, database, analytics SDK or client-side secret, and the
media file is never uploaded. The only server boundary is the analysis endpoints
documented above, which carry derived speech windows and selected keyframes, are
bounded per file, and store nothing.

The service worker caches only the application shell and static assets. It never
caches blob URLs, local media, imported projects, reconstructed screenplays,
exports, or anything under `/api/`. Each release uses a new cache name and
removes obsolete shell caches on activation.

"Copy diagnostics" produces a report built from an allowlist: version, browser,
media dimensions, phase counts, request tallies and error codes. It contains no
transcript, no evidence payload, no media bytes, no file path and no
credential.

## Native project format

Native exports use `format: "framescript-screenplay"` and an explicit
`formatVersion`. Version 2 preserves the scene model, language variants,
characters, beat provenance, coverage, conflicts, metadata and source summaries.

All imports pass through `src/storage/projectFormat.ts`. The parser bounds file
size and model cardinality, validates nested structures, rejects unknown future
versions, and migrates supported legacy extension records. Imported strings are
rendered as React text, never raw HTML.

## Development and deployment

```bash
npm ci
npm run dev:web
npm run typecheck
npm run lint
npm test
npm run build:web
npx playwright test e2e-web/studio.spec.ts
npx playwright test e2e-web/media.spec.ts
```

`media.spec.ts` is the regression for the video path. It records an encoded MP4
in the browser under test, serves the production build with the real API routes,
and substitutes only the providers — so the container, `decodeAudioData`,
playback, canvas readback, VAD, diarization, WAV framing, the API round trip, the
evidence mapping and the reconstruction are all the shipped implementations. A
green subtitle or WAV test covers none of that.

`npm run build:web` produces `dist-web/`, and Vercel builds `api/` into functions
from the same repository. Transcription and scene understanding are enabled by
setting the environment variables above on the deployment; with none set, the
site runs exactly as it did before — local-only, and honest about it. On another
static host the application routes need an SPA fallback to `/index.html`,
`/api/*` must not be rewritten into it, and without a function runtime the
analysis endpoints are simply absent, which Studio reports as "not configured"
rather than failing.

After deployment, smoke-test `/`, direct navigation to `/studio`, manifest and
service-worker delivery, subtitle intake, native project import/export, a mobile
viewport, and `GET /api/capabilities` returning JSON rather than the SPA shell.
