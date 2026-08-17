# Platform limitations

An honest account of what FrameScript can and cannot do, and why. Where a
limitation is structural, it is named as structural rather than described as a
feature that is coming later.

## DRM: the hard boundary

FrameScript does not, and contains no code that could:

- bypass or interact with Widevine, EME, or any CDM
- extract, derive, or manipulate DRM keys or licences
- intercept decrypted protected media
- circumvent HDCP
- modify or substitute media manifests
- spoof entitlement, subscription state, or device capability
- unlock a resolution the service is not offering the account
- download, persist, or reconstruct protected media

It also holds no `webRequest` or `declarativeNetRequest` permission, so it cannot
see or alter the network traffic such techniques would require. The boundary is
enforced by what the extension is able to do, not only by intent.

**Consequence:** on Netflix the picture is usually unavailable to analysis. That
is the correct outcome, and FrameScript reports it as `Video — Protected` rather
than degrading silently.

## Netflix

### Quality

FrameScript **does not change Netflix's playback quality.** Netflix selects the
delivered representation server-side inside protected playback, and every
technique that claims otherwise involves manipulating a protected manifest or
spoofing entitlement.

What the Netflix guard does instead, all of it honest:

| Reports | Source | Reliability |
| --- | --- | --- |
| Environment ceiling | Screen height × device pixel ratio, capped at 2160 | What this display *could* show; not a claim about the stream |
| Current stream | `HTMLVideoElement.videoHeight` | The decoded frame size, when the element exposes it |
| Unknown | — | Printed verbatim when the frame size is not readable |

Those are three distinct claims and the UI never conflates them. If the stream
resolution cannot be read, the popup says `Current stream: Unknown`. It does not
substitute the ceiling.

The guard additionally names the things that legitimately cap quality — account
playback settings (Auto/High/Medium/Low), a small player viewport, the display
itself — so you can act on them in Netflix's own UI. FrameScript never changes an
account setting or resizes anything on your behalf.

### Picture analysis

Canvas readback of protected playback yields black frames. `TemporalScanner`
detects sustained blank frames and reports the video source as
`protected-content` once, rather than emitting a stream of meaningless dark-frame
events. Screenplay reconstruction continues from subtitles, audio and timing.

### Subtitles

Netflix renders subtitles as positioned DOM, not burned-in pixels, so FrameScript
reads real text and needs no OCR. This is the reason a useful Netflix screenplay
is possible at all despite the picture being unavailable.

### Track switching

FrameScript reads whichever subtitle track you have selected in the player. It
does not drive Netflix's audio/subtitle menu. Switching tracks yourself adds a
language; it never discards one already captured.

### What is untested here

Netflix playback requires a signed-in account, which this build environment does
not have. The Netflix selectors are written against the `data-uia` attributes
Netflix uses for its own test automation — semantic and durable — with class
fallbacks, but they have **not been verified against a live authenticated
session**. See `docs/QA.md`.

## YouTube

### Quality

FrameScript operates the real player UI: it opens the settings menu, reads the
options the player actually offers, picks the best within your preference,
clicks it, and verifies against the decoded frame size.

It does **not** use the deprecated IFrame API quality methods as its
implementation. Those report levels rather than what an account may select. They
appear only in the optional MAIN-world bridge, as a read-only cross-check when
the DOM cannot be parsed.

Consequences:

- FrameScript can only select what the player lists as selectable. A tier marked
  disabled (entitlement, codec, device) is reported as
  `limitedBy: 'entitlement'` and never clicked.
- Premium / enhanced-bitrate tiers are detected and used **only if your account
  can already select them**. FrameScript cannot and does not unlock them.
- Verification uses `videoHeight`, which lags a switch by a moment on adaptive
  streams. A slow network may legitimately not sustain the selected tier; that is
  reported as unverified, not as failure.

### Manual override

If you pick a quality yourself, FrameScript stands down for that video and
resumes its policy on the next one. It will not fight you.

### Live streams and Shorts

Both are handled by the same adapter. Live streams have no stable duration, so
coverage reporting is degraded (coverage shows as unknown). Shorts navigate
rapidly; quality application is debounced accordingly.

### What is untested here

The YouTube selectors are written against the player's long-standing `ytp-*`
structure and are locale-independent by construction — quality-row detection
keys off resolution patterns in the row's *value*, not its translated label,
which is verified in the DOM fixture tests for English, Korean and Japanese UIs.
They have **not been verified against live YouTube in this build environment**
(no network access to the site). See `docs/QA.md`.

## Speech recognition

There is **no local speech recognition**, and this is a platform limitation
rather than an omission.

Chrome's built-in `SpeechRecognition` listens to a microphone; it cannot consume
a `MediaStream` from `tabCapture`. No shipped browser API transcribes captured
tab audio locally. Rather than fake it, FrameScript:

- reports the ASR source as `unavailable` with an explanation,
- relies on platform subtitles for dialogue,
- and offers a BYOK path to any OpenAI-compatible transcription endpoint.

Everything else in the audio engine — VAD, diarization, sound events, silence —
runs locally and needs no provider.

## On-screen text

Without a configured AI provider, FrameScript detects *that* superimposed text is
present (edge energy in the title band) but does not read it. It emits no
screenplay line for unrecognized text, because inventing the characters would
poison the screenplay with words nobody wrote.

With a vision provider and `Use the vision provider to read on-screen text`
enabled, text in analyzed windows is read.

## Local vision analysis

Without a provider, the local vision path measures **change**, not meaning. It
can honestly say "the shot changes" and "sustained movement in the centre of
frame". It cannot say who moved or what they touched, and it says so in its
`uncertainties` output rather than guessing.

This means that with remote AI off, the screenplay is real but thinner: dialogue,
speakers, sound, silence, scene structure, timing and coverage — with action
described only in terms of observable change.

## Sound event classification

A handful of spectral features cannot reliably separate a door slam from a
gunshot. The local detector is good at *onset detection* (something happened) and
deliberately conservative about classification: only `impact`, `alarm` and
`applause` are claimed, each on a distinctive acoustic signature. Everything else
is emitted as `unclassified` and rendered as "A sudden sound."

An authored `[door slams]` caption always outranks the classifier, because a
human wrote it.

## Speaker identity

Diarization clusters voices; it does not identify people. There is no face
recognition and no voice matching against any external database. Unnamed
characters render as `SPEAKER 2`. Names come from subtitle speaker labels or
from you.

Diarization thresholds are currently calibrated against synthetic harmonic
signals and are biased toward over-splitting rather than over-merging, because a
split cluster is one click to merge whereas a merged cluster silently attributes
two people's lines to one character. Real-speech calibration is outstanding.

## Analysis coverage

FrameScript reconstructs only what it observed. If you seek past twenty minutes,
those twenty minutes have no evidence and no scenes — the coverage bar shows the
gap and exports include the unobserved ranges. Nothing is inferred to fill it.

## Browser support

Desktop Chrome 116+ only. The extension uses MV3 offscreen documents, the Side
Panel API, `OffscreenCanvas`, and AudioWorklet. Firefox and Safari have different
extension models; mobile Chrome does not support these APIs. The architecture is
kept adapter-shaped so future Chromium targets are feasible, but no other browser
is claimed as supported.
