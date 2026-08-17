# Performance

## The rule

Playback wins. Always.

Priority order, enforced by the design of every queue in the system:

1. Video playback
2. User controls
3. Audio playback
4. Basic timeline capture
5. Subtitle capture
6. Temporal analysis
7. Deep AI analysis

When the system cannot keep up, **analysis quality degrades before playback
quality**. There is no path in the code that lowers playback quality to make
analysis easier, and playback resolution is never coupled to analysis resolution.

## Why 10 observations/second is affordable

The naive reading of "observe the picture every 100 ms" is that it costs ten
frame analyses a second. It does not, because of three compounding reductions:

**1. Signatures, not frames.** Each observation immediately becomes a 32×18 luma
grid (576 bytes) plus a 32-bin histogram. The pixels are dropped in the same
function call. All difference, motion and cut scoring runs on that summary.

**2. Redundancy skipping.** In a locked-off shot, consecutive signatures are
near-identical and `isRedundant` short-circuits before any scoring. In practice
a static interview skips the large majority of observations.

**3. Separation of observation from inference.** Only a small, adaptively chosen
subset earns semantic analysis. Measured in the test suite: 600 observations of
moderate activity yield 30–120 deep analyses — roughly 1/second against
10/second observed.

Per-observation cost is dominated by `getImageData` and the 576-cell loop, both
of which are microseconds at 480×270.

## Analysis resolution vs playback resolution

Completely independent.

| Profile | Analysis frame | Detail frame | Keyframe ring |
| --- | --- | --- | --- |
| Efficient | 320×180 | 640×360 | 24 frames |
| Detailed | 480×270 | 960×540 | 48 frames |
| Forensic | 640×360 | 1280×720 | 96 frames |

Playback may be 3840×2160 throughout. The analysis copy is drawn from the
captured stream into an `OffscreenCanvas` at the profile's size.

## Fidelity profiles, measured

| Profile | Observation | Baseline deep | Peak deep | Intended for |
| --- | --- | --- | --- | --- |
| Efficient | ~5/s (200 ms) | 0.5/s | 2/s | Weaker machines, battery, casual viewing |
| **Detailed** | **10/s (100 ms)** | **1/s** | **10/s** | **Default** |
| Forensic | every presented frame | 2/s | 15/s | High-fidelity study |

Forensic uses `requestVideoFrameCallback`, so its observation rate is the
browser's actual presentation rate — capped by the media. You cannot observe 30
times a second from a 24 fps film, and `effectiveObservationFps` reports the
honest number rather than the aspirational one.

Forensic means *more temporal evidence and denser local analysis*. It does not
mean uploading the film frame by frame, and no profile does.

## Backpressure

Every queue is bounded. Under load each degrades in a specific, chosen direction.

| Component | Bound | Overflow behaviour |
| --- | --- | --- |
| `KeyframeBuffer` | Frame count **and** byte ceiling (8 MB) | Evicts oldest |
| `InferenceCoordinator` | 12 queued, 2 concurrent | Drops the **least important** request, not the newest — scene cuts survive, idle-shot requests do not |
| `EvidenceTimeline` | 60,000 events | Evicts least informative; user corrections and dialogue are never first to go |
| `AudioPipeline` ASR | 2 concurrent | Over the cap, the region is simply not transcribed |
| `AudioPipeline` ring | ~35 s of samples | Drops oldest |
| `VideoPipeline` encode | 1 in flight | Skips the keyframe |
| `EvidenceBatcher` | 120 events / 400 ms | Flushes early |

Two properties follow, and both are load-bearing:

- Memory cannot grow without bound however long the film runs.
- Inference cost cannot grow without bound however busy the film gets.

## Circuit breaker

Three consecutive provider failures open a breaker for 60 seconds. While open,
requests resolve to `null` immediately — no network calls, no queue growth. Local
temporal analysis continues throughout, so the screenplay gets thinner rather
than stopping.

## Threading

| Work | Thread |
| --- | --- |
| Audio capture + passthrough | Audio rendering thread (AudioWorklet) |
| VAD, diarization, sound events | Offscreen main thread |
| Frame signature + differencing | Offscreen main thread |
| JPEG encoding | Offscreen main thread (async, one at a time) |
| Scene rebuilding | Service worker |
| Rendering | Side panel |

The audio *passthrough* is on the audio thread, which is what matters: playback
audio cannot be delayed by analysis work.

DSP and frame differencing are currently on the offscreen main thread rather than
in dedicated workers. That thread has no UI and no rendering to compete with, and
per-observation cost is low. Moving them to workers is a plausible future
optimization, but it should be driven by a profile of real playback rather than
added speculatively — the transfer cost of moving frames to a worker is not
obviously smaller than the work itself at these sizes.

## Local diagnostics

Settings → Advanced → Show diagnostics. Reports **measured** values, never
configured ones:

- observation rate (Hz), measured over the observed media span
- deep analyses per minute
- redundant-skip count, scene-cut count, blank-frame count
- inference queue depth, in-flight count, mean provider latency, breaker state
- keyframe bytes retained and frames dropped
- evidence count, evicted count, coverage ratio
- per-source state and event counts

"10 fps configured" is a setting. "9.6 observations/second measured" is the
truth, and only the second is useful when something is wrong.

Nothing here is transmitted.

## Known costs

- **Tab capture itself** has a fixed cost imposed by Chrome, independent of what
  FrameScript does with the stream.
- **JPEG encoding** is the single most expensive operation in the video pipeline,
  which is why only one runs at a time and why keyframes are only encoded when a
  vision provider is configured.
- **`getImageData`** forces a readback and is the per-observation floor.
- **Scene rebuilding** is bounded by finalization: once a scene is promoted it
  stops being recomputed, so rebuild cost does not grow with film length.
