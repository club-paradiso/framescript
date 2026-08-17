# FrameScript architecture

## The shape of the product

```
YOUTUBE / NETFLIX
        │
        ├── Maximum Quality  ──────────────────────────► player
        │
        └── Multimodal evidence
                ├── subtitles      (content script, MutationObserver)
                ├── audio          (offscreen, Web Audio + DSP)
                ├── video          (offscreen, 100 ms canvas scanner)
                ├── on-screen text (offscreen, region detection + optional OCR)
                ├── playback       (content script, media events)
                ├── metadata       (content script, DOM)
                └── user           (side panel)
                        │
                        ▼
                EVIDENCE TIMELINE          ← single source of truth
                        │
                        ▼
                 Evidence windows          ← adaptive, cut on scene changes
                        │
                        ▼
              Scene understanding          ← boundaries + fusion
                        │
                        ▼
             Structured scene model        ← typed beats, full provenance
                        │
                        ▼
         Screenplay reconstruction         ← rolling, provisional → finalized
                        │
             ┌──────────┼──────────┐
             ▼          ▼          ▼
           English    Korean     Japanese
```

The two rules that shape everything else:

1. **Nothing writes to the screenplay directly.** Every source produces
   `EvidenceEvent`s and nothing else. That is what makes provenance possible and
   what makes the whole reconstruction path testable without a browser.
2. **The scene model is computed once and rendered per language.** Expensive
   multimodal analysis is not repeated for English, Korean and Japanese; the
   understanding is shared and only the rendering differs.

## Execution contexts

Chrome MV3 splits the extension across five isolated realms. What lives where is
not arbitrary — it follows from what each realm can and cannot do.

| Context | Responsibilities | Why here |
| --- | --- | --- |
| **Service worker** (`src/background/`) | message routing, per-tab sessions, offscreen lifecycle, scene rebuilding | Can be terminated at any moment, so it holds no media |
| **Content script** (`src/content/`) | platform adapters, quality control, subtitle observation, playback events | Only realm with access to the page DOM |
| **Offscreen document** (`src/offscreen/`) | tab capture, audio graph, 100 ms video scanner, inference | Only realm that can hold a `MediaStream` and use Web Audio; also keeps analysis off the page's own thread |
| **Side panel / popup / options** (`src/sidepanel/`, `src/popup/`, `src/options/`) | rendering, user corrections, export | User surfaces; `tabCapture` needs a gesture from one of them |
| **MAIN-world bridge** (`src/content/mainWorldBridge.ts`) | read-only fallback for YouTube's reported quality levels | Content scripts cannot read page-owned JavaScript |

Message shapes are declared once in `src/messaging/protocol.ts` as a
discriminated union, so a mismatch is a compile error rather than a listener
that silently ignores an unknown payload.

## The temporal engine

The central design decision, in one sentence: **observation rate and inference
rate are different numbers.**

Detailed mode observes the picture every 100 ms — ten times a second. A
120-minute film produces 72,000 observations. Sending all of them to a
multimodal model would be slow, expensive, redundant, and a privacy problem. So:

```
video frame (analysis-resolution copy)
      ▼
FrameSignature          32×18 luma grid + histogram; pixels dropped here
      ▼
FrameDifference         difference / motion / scene-cut / region scores
      ▼
ImportanceScorer        one salience number, combining metrics + context
      ▼
AdaptiveSampler         token bucket → which observations earn deep analysis
      ▼
InferenceCoordinator    bounded priority queue + circuit breaker
```

`AdaptiveSampler` is a token bucket denominated in media seconds. Tokens refill
at the profile's **baseline** rate; promotion (triggered by high importance)
raises how fast tokens may be *spent*, never how fast they are earned. That
asymmetry is what bounds the long run: a montage drains the bucket in a burst
and then settles back to baseline, instead of pinning inference at the peak rate
for minutes. In Detailed mode this yields roughly 10 observations/second and
roughly 1 deep analysis/second in ordinary material.

`ActionSegmenter` sits between temporal events and scene beats. It groups a run
of 100 ms observations into one screenplay-relevant action — otherwise a door
opening becomes six lines of CCTV log — while recording the micro-structure
inside it. Hesitations (stillness sandwiched between motion) are preserved
precisely because they are the detail dense observation exists to catch.

## The audio engine

Audio is windowed far more finely than video (20 ms vs 100 ms), because speech
onsets and speaker turns happen faster than screenplay-relevant picture changes.
The two rates are deliberately independent.

```
tab audio ──► AudioWorklet ──┬──► destination   (passthrough: playback keeps working)
                             └──► analysis
                                    ├── VAD (energy + smoothed ZCR, adaptive floor)
                                    ├── diarization (cepstral features, online clustering)
                                    ├── sound events (spectral flux onsets)
                                    └── silence (relative to local rhythm)
```

The worklet's first job is copying input to output. `tabCapture` re-routes the
tab's audio; without that copy the viewer's film goes silent the moment analysis
starts.

Diarization answers exactly one question — "is this the same voice?" — and
assigns anonymous labels (`speaker-001`). It never attempts to identify who
anyone is. Naming is the user's decision, and their correction outranks
everything the system inferred.

## Evidence and provenance

```ts
interface EvidenceEvent {
  id: string;
  source: 'subtitle' | 'audio-asr' | 'video' | ... ;
  start: MediaTimeMs;          // media time, always
  end?: MediaTimeMs;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  provisional: boolean;
  payload: /* source-specific */;
}
```

All timestamps are **media time in milliseconds**. It is the only clock every
source agrees on. The offscreen document, which receives a `MediaStream` with no
media timeline at all, reconstructs it via `MediaClock` from periodic player
position reports — and returns `null` rather than extrapolating from a stale
sample, because a guessed timestamp silently misaligns evidence.

Confidence is ordinal, never a percentage. None of the sources produce
calibrated probabilities, so `97.38%` would be a lie dressed as precision.

## Fusion: the discipline

`src/scenes/fusion.ts` is where sources meet, and it enforces one rule strictly:

> **Dialogue and action are separate evidence and are never derived from one
> another.**

If a subtitle says "I'm leaving" while the picture shows someone still seated,
FrameScript writes the line and does *not* write "she stands and leaves". Action
beats come only from visual and audio evidence. Nothing in that file reads
dialogue text to invent an action.

Where sources genuinely disagree — ASR heard different words than the caption
track — the disagreement is recorded as a conflict and surfaced, not silently
resolved.

## Rolling reconstruction

`SceneBuilder` maintains two regions:

- a **finalized** prefix, immutable and safe to save and export;
- a **provisional** tail, recomputed from scratch on every rebuild.

Recomputing the tail (rather than appending) is what makes rewinding correct:
replaying a section produces the same scenes rather than duplicates, because the
tail derives from the timeline and the timeline already deduplicates. Beat ids
are content-derived hashes, so they stay stable across rebuilds — which keeps
React keys stable, keeps user edits attached, and stops the panel flickering.

The screenplay redraws about once a second even though the temporal engine
updates ten times a second. Text that reflows every 100 ms is unreadable, and
the stabilization window exists so a beat can be revised before it stops moving.

## Backpressure

Priority order under load, from `docs/PERFORMANCE.md`:

1. video playback, 2. user controls, 3. audio playback, 4. timeline capture,
5. subtitle capture, 6. temporal analysis, 7. deep AI analysis.

Every queue in the system is bounded and every one degrades downward:

- `KeyframeBuffer` — fixed frame count *and* fixed byte ceiling
- `InferenceCoordinator` — bounded priority queue; overflow drops the *least
  important* request, not the newest, so scene cuts survive
- `EvidenceTimeline` — capped, evicting least-informative events (dialogue and
  user corrections are never dropped first)
- `AudioPipeline` — capped ASR concurrency; over the cap, regions are simply not
  transcribed
- `VideoPipeline` — one keyframe encode in flight at a time

## Directory map

```
src/
├── background/     service worker, per-tab sessions
├── content/        content script, MAIN-world bridge
├── offscreen/      media clock, audio + video pipelines, worklet
├── platforms/      shared adapter contract; youtube/, netflix/
├── quality/        parser, ranking, capabilities   (pure)
├── temporal/       signatures, difference, importance, sampler, segmenter (pure)
├── audio/          dsp, vad, diarization, sound events, silence  (pure)
├── evidence/       types, timeline, windows, provenance, confidence
├── characters/     entities, attribution
├── scenes/         boundaries, fusion, builder
├── screenplay/     renderer, alignment, search, export/
├── ai/             provider interfaces, schemas, validation, coordinator
├── storage/        schema, migrations, IndexedDB repository
├── settings/       model + chrome.storage
├── messaging/      protocol + transport
├── ui/             shared hooks and components
└── popup/ sidepanel/ options/ styles/
```

Modules marked *pure* have no browser dependencies and are directly unit tested.
That is most of the interesting logic, by design.
