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
subset earns semantic analysis. Observation is cheap and constant; inference is
expensive and rationed by a token bucket.

Per-observation cost is dominated by `getImageData` and the 576-cell loop, both
of which are microseconds at 480×270.

## Measured

`npm run benchmark` runs the real engine over synthetic material and prints the
numbers below. It is reproducible, so a regression shows up as a number rather
than a feeling.

Read one caveat first: this is **Node on a server, not Chrome on a laptop
competing with a video decoder**. The *ratios* — redundancy skipping, deep
analyses per minute, audio throughput relative to real time — carry over. The
absolute per-observation cost is a floor, not a promise. In particular the
benchmark feeds pixel buffers directly, so it excludes the `getImageData`
readback that a browser must pay.

Node v22 · analysis frame 480×270 · signature 32×18:

**Video — 10 minutes of moving content at 100 ms (Detailed):**

| | |
| --- | --- |
| Observations | 6,000 |
| Per observation | **0.79 ms** |
| Share of the 100 ms budget | **0.79 %** |
| Throughput | 126× real time |
| Events emitted | 557 |
| Scene cuts detected | 58 |
| Deep-analysis requests | 213 (**21.3/minute** of media) |

Under a hundredth of the frame budget, against a synthetic worst case in which
something moves in *every* frame. Deep analysis lands near 0.36/second observed
against 10/second — well inside the Detailed profile's 1/second baseline, with
headroom spent on the scene cuts where it is worth spending.

**Video — 10 minutes of a locked-off shot:**

| | |
| --- | --- |
| Per observation | 0.71 ms |
| Redundant observations skipped | 5,999 of 6,000 (**100.0 %**) |
| Deep-analysis requests | **0** |

Redundancy skipping is not a partial optimization. A static frame costs one
signature and nothing else, and never reaches inference at all.

**Audio — 10 minutes of 16 kHz mono:**

| Stage | Time | Relative to real time |
| --- | --- | --- |
| VAD | 86 ms | 6,959× |
| Diarization (59 regions) | 501 ms | — |
| Sound-event detection | 1,620 ms | 370× |
| **Full pass** | **2,207 ms** | **272×** |

Sound-event detection dominates because it is the only stage running an FFT over
every frame of the signal rather than over detected speech.

**Reconstruction — a feature-length subtitle track:**

| | |
| --- | --- |
| Parse 1,200 cues | 8 ms |
| Track duration | 126 minutes |
| Reconstruct + render | 87 ms |
| Scenes planted in the fixture | 75 |
| Scenes detected | **75** |

The fixture is built as a film actually behaves — tight exchanges inside a
scene, then a hole while the story moves elsewhere — and boundary detection
recovers every one of its 75 scenes from subtitle timing alone, with no picture,
no ambience and no chapter markers. That path is what the CLI, Studio and the
MCP server run on.

## Analysis resolution vs playback resolution

Completely independent.

| Profile | Analysis frame | Detail frame | Keyframe ring |
| --- | --- | --- | --- |
| Efficient | 320×180 | 640×360 | 24 frames |
| Detailed | 480×270 | 960×540 | 48 frames |
| Forensic | 640×360 | 1280×720 | 96 frames |

Playback may be 3840×2160 throughout. The analysis copy is drawn from the
captured stream into an `OffscreenCanvas` at the profile's size.

## Fidelity profiles

These are the *configured* rates. What actually happens is reported by the
diagnostics panel and by the benchmark above; the two differ, and the measured
number is the one to trust.

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
