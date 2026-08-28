# FrameScript

**Watch at the best quality. Understand it like a screenplay.**

Four surfaces over one engine: a Chrome extension that keeps YouTube and Netflix
playback at the highest quality actually offered and reconstructs a
time-synchronized screenplay while you watch — plus a web/mobile app, a CLI, and
an MCP server that run the same reconstruction over files you already have.

| Surface        | Runs where                         | For                                                  |
| -------------- | ---------------------------------- | ---------------------------------------------------- |
| **Extension**  | Chrome, on YouTube/Netflix         | Maximum Quality, and reconstruction while watching   |
| **Studio**     | Any browser, installable as a PWA  | Your own media files; reading and converting exports |
| **CLI**        | Node 20+                           | Scripting and batch conversion                       |
| **MCP server** | Codex, Claude Desktop, Claude Code | Letting a model work with screenplays                |

Only the extension can see a streaming site's player. The other three work on
files — see [Integrations](docs/INTEGRATIONS.md).

---

## What it is

FrameScript watches alongside you. It reads the subtitle track, listens to the
audio, observes the picture ten times a second, tracks playback timing, and folds
all of it into one evidence timeline. From that timeline it builds a structured
scene model, and from the scene model it renders a screenplay — in English,
Korean, Japanese, or any language with dialogue evidence.

It is **not** a subtitle reformatter. A subtitle track tells you what was said.
FrameScript tries to also establish who said it, what happened, where it
happened, what was heard, and in what order — from evidence, with provenance
attached to every line.

It is also **not** a downloader, a DRM tool, or a recorder. See
[Platform limitations](docs/PLATFORM_LIMITATIONS.md).

## Product philosophy

Three commitments shape every design decision in this codebase.

**Say what you actually know.** Confidence is ordinal (`high`/`medium`/`low`/
`unknown`), never a fake percentage. If Netflix's stream resolution cannot be
read, the popup says `Unknown` rather than substituting the display ceiling. If a
text region was detected but not read, no screenplay line is written. If twenty
minutes were skipped, the coverage bar shows the gap.

**Never invent across sources.** Dialogue and action are separate evidence and
are never derived from one another. A subtitle saying "I'm leaving" does not
produce the action "she stands and leaves" — that only appears if the picture
shows it.

**Respect the boundary.** No DRM circumvention, no entitlement spoofing, no
manifest manipulation, no unlocking resolutions the account does not have. The
extension holds no `webRequest` permission, so it cannot even see the traffic
such techniques would require.

---

## Maximum Quality

The default is _use the highest quality the platform currently makes available_ —
which is not the same as _force 4K regardless of support_.

**YouTube.** FrameScript drives the real player UI: opens the settings menu,
reads the options offered, ranks them structurally (resolution → enhanced bitrate
→ HDR → frame rate), clicks the best one within your preference, then verifies
against the decoded frame size. Quality-row detection is locale-independent — it
keys off the resolution pattern in the row's value, not its translated label, so
it works on a Korean or Japanese UI.

If you change quality yourself, FrameScript stands down for that video and
resumes on the next one. It will not fight you.

**Netflix.** FrameScript **does not change Netflix's quality**, because there is
no legitimate way to. Instead it reports three distinct facts and never conflates
them: what this environment could display, what the media element says is being
decoded, and — when that is unreadable — `Unknown`. It also names what
legitimately caps quality (account playback settings, a small viewport, the
display) so you can act on it in Netflix's own UI.

## Multimodal screenplay reconstruction

```
subtitles + audio + picture + on-screen text + timing + metadata + your corrections
                              ▼
                      evidence timeline
                              ▼
                    structured scene model
                              ▼
              English / Korean / Japanese screenplay
```

Sources contribute independently and degrade independently. Netflix blocks the
picture? The screenplay continues from subtitles, audio, speakers, sound and
timing — and the source panel says `Video — Protected` rather than going quiet.

Every screenplay element carries provenance: which evidence justifies it, from
which sources, at what confidence, and whether it was inferred. The Evidence view
shows it, and exports can include it.

## 100 ms temporal analysis

Detailed mode observes the picture every 100 ms — ten times a second. For a
120-minute film that is 72,000 observations.

Those observations are **not** each sent to an AI model. That would be slow,
expensive, redundant and a privacy problem. Instead:

- each frame becomes a 32×18 luma signature and the pixels are dropped;
- local heuristics score difference, motion, scene cuts and region activity;
- visually identical observations are skipped entirely;
- a token bucket admits a small, adaptive subset for deep semantic analysis —
  roughly 1/second in ordinary material, briefly higher around cuts and speech.

Dense observation exists to catch structure that sparse sampling misses:

> a character looks toward a door → reaches for it → **hesitates** → opens it →
> sees someone → their expression changes → they step back

The `ActionSegmenter` groups those micro-observations into one screenplay action
rather than seven CCTV lines, while preserving the hesitation — because the
hesitation is the point.

### Analysis modes

| Mode         | Observation           | Deep analysis       | For                      |
| ------------ | --------------------- | ------------------- | ------------------------ |
| Efficient    | ~5/s                  | 0.5–2/s             | Weaker machines, battery |
| **Detailed** | **10/s (100 ms)**     | **1–10/s adaptive** | **Default**              |
| Forensic     | every presented frame | 2–15/s adaptive     | High-fidelity study      |

Forensic keeps denser evidence and allows denser analysis of important windows.
It does not upload the film frame by frame; nothing does.

Local observation fidelity and remote analysis depth are **separate settings**.
Choosing Forensic makes the browser look more closely; it does not send more to a
provider. In Studio the remote budget is its own control, capped per file, and
the panel states the maximum number of requests before you start.

---

## Installation

Requires Node 20+ and desktop Chrome 116+.

```bash
git clone <repo> && cd framescript
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` directory
4. Open a YouTube or Netflix video
5. Click the FrameScript icon → **Start script analysis**

Analysis never starts on its own: `tabCapture` requires a user gesture, which is
a deliberate structural guarantee, not just a policy.

## Development

```bash
npm run dev         # extension watch build
npm run dev:web     # Studio dev server
npm run typecheck   # tsc: src, tests/e2e, and build scripts
npm run lint        # eslint, zero warnings tolerated
npm test            # vitest unit and regression suite
npm run verify      # typecheck + lint + test + build
npm run build:all   # extension + Studio + CLI/MCP
npm run test:e2e    # Playwright production flows in real Chrome
npm run check:mcp   # MCP server over its real stdio transport
npm run benchmark   # engine throughput + structural invariants
npm run fixtures    # regenerate the synthetic media fixtures
```

### Building each surface

```bash
npm run build        # extension  -> dist/        (load unpacked)
npm run build:web    # Studio     -> dist-web/    (static, deploy anywhere)
npm run build:tools  # CLI + MCP  -> dist-tools/
```

None of those output directories are committed — a hash-named bundle in git
churns on every build and leaves orphans behind. The CLI and MCP server are
what `bin` points at, so `npm run build:tools` runs from `prepare`, which means
installing this package straight from git still gets you working executables.

Most of the interesting logic — quality ranking, temporal heuristics, DSP,
fusion, scene building, rendering, export — is pure and has no browser
dependency. That is deliberate: it is what makes the reconstruction pipeline
testable without a streaming session.

`tests/dom/` runs against a hand-built synthetic player fixture in jsdom. The
audio fixture is a WAV synthesised from first principles by
`scripts/make-fixture-media.mjs` — two distinct synthetic voices, a silence, and
an impact — regenerated in CI and diffed, so the generator cannot drift from
what the tests assume. No copyrighted markup or media appears anywhere in the
test suite.

`npm run test:coverage` reports ~64% of statements overall, but that single
number is misleading in both directions. The pure logic — DSP, temporal
heuristics, quality ranking, fusion, scene building, export — sits between 80%
and 100%. The modules reporting 0% are browser glue: the service worker,
the offscreen document, the content-script entry points, the platform adapters.
Those are exercised by the Playwright suite and by manual QA, not by vitest,
because mocking Chrome well enough to cover them would test the mock.

## AI and BYOK

FrameScript runs locally by default. The extension makes **no network requests at
all** in its shipped configuration, and Web Studio makes none for subtitle,
project or purely structural media work.

Two things genuinely cannot be computed on device: turning speech into words, and
turning a picture into a description. Everything else — speech detection, speaker
clustering, sound, silence, motion, scene boundaries, scene construction, the
screenplay itself — is local, and stays local.

The two surfaces reach a model differently, on purpose:

- **The extension** is opt-in with your own key, and requires two separate
  actions in Settings → AI: acknowledging a notice that enumerates exactly what
  would be sent, then enabling the feature.
- **Web Studio** never holds a key. It posts to its own origin — `/api/transcribe`
  and `/api/analyze-frame` — and the deployment holds the provider credential
  server-side. Studio asks `/api/capabilities` before analysis and shows
  "Ready" or "Not configured" for each one rather than assuming. See
  [Web Studio](docs/WEB_STUDIO.md) for the environment variables and the exact
  payloads.

| Capability          | Local default                        | Optional provider                       |
| ------------------- | ------------------------------------ | --------------------------------------- |
| Scene understanding | Motion/change analysis only          | Anthropic or an OpenAI-compatible model |
| Speech recognition  | _Unavailable_ — see below            | Any OpenAI-compatible endpoint          |
| On-screen text      | Region detection, no reading         | Via the vision provider                 |
| Sound events        | Onset detection, conservative labels | —                                       |
| Speaker clustering  | Local, always                        | —                                       |
| Translation         | Unavailable                          | Anthropic (your key)                    |

Whatever a model returns becomes **evidence**, never prose. It is validated
against a schema, clamped into the window it was shown, marked `inferred`, and
then goes through exactly the same timeline, fusion and scene construction as a
subtitle file. There is no path where a model writes a screenplay.

Extension keys live in `chrome.storage.local` — not `sync`, so the browser does
not replicate them to your other machines. Studio keys live in the deployment's
server environment and are never sent to the browser; a regression test asserts
the built client bundle contains no key, endpoint or provider auth header.

Without a provider you still get: dialogue from subtitles, speaker clustering and
turn detection, sound and silence events, scene boundaries, timing, coverage, all
export formats, and action described in terms of observable change.

## Privacy

Defaults: no analytics, no telemetry, no remote AI, no raw media persistence, no
viewing-history transmission.

Media is held in fixed-size in-memory buffers for seconds and discarded once
evidence is derived. There is no code path in FrameScript that writes media to
disk. Full detail: [Privacy](docs/PRIVACY.md).

## Permissions

`storage`, `sidePanel`, `tabCapture`, `offscreen`, `scripting`, `activeTab`,
`unlimitedStorage`, plus host permissions for exactly two origins.

Deliberately **not** requested: `<all_urls>`, `history`, `cookies`, `webRequest`,
`declarativeNetRequest`, `downloads`. Rationale for each:
[Permissions](docs/PERMISSIONS.md).

## Known limitations

Summarized here, detailed in [Platform limitations](docs/PLATFORM_LIMITATIONS.md).

- **Netflix picture is usually unavailable.** Protected playback yields black
  frames to canvas readback. Detected and reported, not worked around.
- **Netflix quality cannot be changed.** Only reported, honestly.
- **No local speech recognition.** Chrome's `SpeechRecognition` cannot consume a
  captured tab stream, and no shipped browser API transcribes audio locally.
  Dialogue comes from subtitles unless a provider is configured — in Studio that
  is a deployment setting, in the extension it is your own key. Without one,
  FrameScript reports the detected speech and says plainly that it cannot write
  the words.
- **Local vision measures change, not meaning.** Without a provider it can say
  "the shot changes", not who moved.
- **On-screen text is detected, not read**, without a provider.
- **Sound classification is deliberately conservative.** "A sharp impact", not
  "a gunshot" — those are not separable from a few spectral features.
- **Speaker identity is never inferred.** Anonymous clusters until you name them.
- **Selectors are unverified against the live sites** in this build (no network
  access to them here). See [QA](docs/QA.md).
- **Diarization thresholds need real-speech calibration.** Currently tuned on
  synthetic signals, biased toward recoverable over-splitting.

## Troubleshooting

**Quality is not being applied on YouTube.** Open Settings → Advanced →
Diagnostics and check `Menu readable`. If false, YouTube changed its player;
the fix belongs in `src/platforms/youtube/selectors.ts` and nowhere else.

**Audio went silent when I started analysis.** This is a release-blocking bug —
the AudioWorklet passes input to output specifically to prevent it. Stop analysis
to restore audio and please report the Chrome version.

**The screenplay is only dialogue.** Expected without a vision provider, or on
Netflix where the picture is protected. Check the source panel: `Video —
Protected` or `Video — Unavailable` explains it.

**Nothing appears at all.** Confirm analysis is running (the popup dot pulses),
subtitles are on in the player, and the tab is a watch page rather than a
browse page.

**"Analysis coverage 43%".** Correct and intentional — you skipped material.
FrameScript reconstructs only what it observed and never fills gaps.

## Documentation

|                                                      |                                                      |
| ---------------------------------------------------- | ---------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)                 | Contexts, pipelines, data flow                       |
| [Privacy](docs/PRIVACY.md)                           | What is held, for how long, what leaves              |
| [Permissions](docs/PERMISSIONS.md)                   | Each permission and its justification                |
| [Platform limitations](docs/PLATFORM_LIMITATIONS.md) | What cannot be done, and why                         |
| [Performance](docs/PERFORMANCE.md)                   | Backpressure, budgets, measured costs                |
| [QA](docs/QA.md)                                     | Manual test checklist                                |
| [Integrations](docs/INTEGRATIONS.md)                 | Studio, CLI, MCP server, Claude Code skill           |
| [Web Studio](docs/WEB_STUDIO.md)                     | Routes, local workflows, project format, PWA, Vercel |
| [Store listing](docs/STORE_LISTING.md)               | Chrome Web Store copy                                |

## Licence

MIT.

FrameScript is not affiliated with, endorsed by, or connected to YouTube, Google,
or Netflix. Reconstructed screenplays are derived from observed playback and are
not original, shooting, or production screenplays.
