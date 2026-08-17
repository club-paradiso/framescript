# Privacy

## Summary

FrameScript is an analysis tool, not a recorder and not a data collector. In its
shipped configuration it makes no network requests whatsoever.

| | Default |
| --- | --- |
| Analytics | None. No code exists to send any. |
| Telemetry | None. Diagnostics are local-only and off by default. |
| Remote AI | **Off**, and gated behind a separate explicit consent step |
| Raw audio persistence | **Off** — and not implemented |
| Raw video persistence | **Off** — and not implemented |
| Viewing history transmission | Never |
| Subtitle transmission | Never, unless you enable remote AI |
| Saved screenplays | Only when you press Save, only on this device |

## What is held in memory, and for how long

FrameScript holds media briefly and by necessity, in fixed-size buffers:

| Data | Where | Lifetime | Bound |
| --- | --- | --- | --- |
| Audio samples | `AudioPipeline` ring | ~35 seconds | Fixed sample count |
| Keyframes (downscaled JPEG) | `KeyframeBuffer` | Seconds | Fixed frame count **and** byte ceiling (default 8 MB) |
| Frame signatures | `TemporalScanner` | One frame | 2 frames at a time; pixels dropped immediately |
| Evidence events | `EvidenceTimeline` | Session | Capped, with least-informative eviction |

All of it is dropped when analysis stops, when playback pauses (keyframes), or
when the tab closes. Nothing here is written to disk, and there is no code path
in FrameScript that writes media to disk. The Privacy settings page states this
explicitly rather than presenting retention as a toggle that does nothing.

## The 100 ms scanner does not retain the film

Observing the picture ten times a second sounds like recording it. It is not.
Each observation becomes a 32×18 luma grid plus a histogram — a few hundred
bytes — and the pixels are discarded in the same function call. The keyframe
ring, which does hold real image bytes, is bounded to a couple of seconds'
worth at analysis resolution and exists solely so a deep-analysis request can
carry temporal ordering.

## Remote AI

Off by default. Turning it on requires two separate actions in Settings → AI:
acknowledging a notice that enumerates exactly what would be sent, and then
enabling the feature. The notice is generated from your live configuration, not
written as static copy.

When enabled with a vision provider, each *analyzed window* sends:

- up to 8 downscaled keyframes (analysis resolution, not playback resolution),
- the dialogue text that occurred in that window,
- sound-event labels for that window,
- the local change metrics.

When enabled with a speech provider, each *detected speech region* sends a short
audio window, downsampled to 16 kHz mono. Silence, music and non-speech audio
are never sent — VAD gates this.

**Never sent, under any configuration:** the full video, the full audio track,
your account details, your viewing history, your list of watched titles, or your
IP address to anyone but the endpoint you chose.

A 120-minute film in Detailed mode produces roughly 72,000 observations and
roughly 7,000 deep-analysis candidates, of which the budget admits a small
fraction. The system is built so that dense observation does *not* imply dense
transmission.

## API keys

Stored in `chrome.storage.local`. Not `chrome.storage.sync`, specifically so the
browser does not replicate your keys to your other machines without you asking.

Keys are never logged, never included in error messages, and never sent anywhere
except the endpoint you configured. Error handling deliberately excludes provider
response bodies from logs, because a response can echo the request and requests
contain frame data.

## Saved screenplays

Stored in IndexedDB on this device only, and only when you press Save. Each
record contains scenes, characters, provenance and coverage — no media. You can
list and delete them individually, or delete all of them, in Settings → Storage.

## Diagnostics

The diagnostics panel (Settings → Advanced) reports measured rates, source
states and queue depths. It is off by default and everything in it stays local.
No diagnostic data is transmitted, ever.

## Third parties

FrameScript has no server, no account system, no SDK, and no third-party
dependency that runs at analysis time. The only third party that can ever
receive data is the AI endpoint you configure, and only under the conditions
above.
