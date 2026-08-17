# Chrome Web Store listing

Draft copy. Every claim below is one the implementation actually supports — the
listing is not the place to get ambitious about capabilities.

## Name

FrameScript

## Short description (132 char limit)

> Watch at the best quality available, and build a time-synced screenplay from
> subtitles, audio and picture as you watch.

(129 characters.)

## Category

Entertainment

## Detailed description

**Watch at the best quality. Understand it like a screenplay.**

FrameScript does two things while you watch YouTube and Netflix.

**1. Maximum Quality**

FrameScript keeps playback at the highest quality the platform is actually
offering. On YouTube it reads the player's own quality menu, selects the best
option available to your account, and verifies the result against the decoded
frame size — then re-applies it on the next video. It works on non-English
YouTube interfaces, and it stands down for the rest of the video if you pick a
quality yourself.

It never unlocks a quality your account or the video does not provide.

**2. Screenplay reconstruction**

Start analysis and FrameScript watches alongside you, combining the subtitle
track, the audio, the picture and playback timing into a screenplay that builds
as you watch:

• Dialogue with speakers, grouped by voice
• Action derived from what is visible on screen
• Sound events and meaningful silences
• Scene boundaries from several agreeing signals
• On-screen text and title cards
• Timestamps you can click to jump the player

Three views: Screenplay, Dialogue (useful for language learning), and Evidence —
which shows exactly which sources justify each line and how confident FrameScript
is about it.

**Honest by design**

FrameScript tells you what it actually knows.

• Skipped part of the film? The coverage bar shows the gap. Nothing is invented
  to fill it.
• Netflix's stream resolution unreadable? It says "Unknown" rather than guessing.
• A speaker unidentified? It says "SPEAKER 2" rather than making up a name.
• Text on screen it could not read? No line is written.

Sources degrade independently. On Netflix, where the picture is protected,
FrameScript says so plainly and keeps building the screenplay from subtitles,
audio and timing.

**100 ms temporal analysis**

FrameScript observes the picture ten times a second — dense enough to catch a
character reaching for a door, hesitating, then opening it. It groups those
observations into readable screenplay actions rather than a frame-by-frame log,
and it does this without sending every observation anywhere: analysis is
adaptive and budgeted so playback always comes first.

Three modes: Efficient, Detailed (recommended) and Forensic.

**Multiple languages**

Scene understanding is computed once and rendered per language. Switch subtitle
tracks in the player and FrameScript keeps every track it has seen — it never
discards one. Dual-language view aligns two languages by time rather than by cue
number, so it works even when the tracks split sentences differently.

Platform subtitles and AI translations are always labelled differently. A
translation is never presented as something the service supplied.

**Export**

Fountain (opens in Final Draft, Highland, Slugline), Markdown, plain text, SRT,
and JSON with full provenance. Every export states clearly that it is a
reconstruction from observed playback, and includes a coverage report.

**Privacy**

FrameScript makes no network requests at all in its default configuration.

• No analytics, no telemetry, no accounts, no server
• No raw audio or video is ever written to disk
• Your viewing history is never read or transmitted
• Analysis only ever starts when you press the button

Optional AI features use your own API key, are off by default, and require you to
read and acknowledge exactly what would be sent before they can be enabled.

**What FrameScript does not do**

It does not bypass DRM, unlock unavailable resolutions, download video, or
circumvent subscription limits. It cannot: it holds no permission to see or
modify network traffic. On Netflix it reports playback quality honestly rather
than claiming to change it.

FrameScript is not affiliated with YouTube, Google, or Netflix. Reconstructed
screenplays are not original, shooting, or production screenplays.

## Permission justifications

Required by the Web Store for each permission.

**storage** — Saves your settings and, if you configure one, your own AI API key.
Stored locally on this device only.

**sidePanel** — The screenplay is displayed in Chrome's side panel so it can sit
beside the video you are watching.

**tabCapture** — Reads the audio and picture of the tab you are watching so the
screenplay can be built from them. Only ever started by you, from the FrameScript
popup or side panel. Media is analyzed in memory and discarded; nothing is
recorded.

**offscreen** — Media analysis runs in an offscreen document because Chrome
extension service workers cannot process audio or video. This also keeps analysis
off the page's own thread so playback stays smooth.

**scripting** — Injects a small read-only script into YouTube pages, on demand
only, as a fallback for reading the player's available quality levels when the
menu cannot be parsed.

**activeTab** — Lets FrameScript identify the video in the tab you are currently
watching when you open the popup.

**unlimitedStorage** — A saved screenplay for a feature-length film can exceed
the default storage quota. Only screenplays you explicitly save are stored.

**Host permissions (youtube.com, netflix.com)** — FrameScript only works on these
two sites and requests access to no others.

## Single purpose statement

FrameScript has one purpose: to help a viewer get the best available playback
quality on YouTube and Netflix and to build a readable, time-synchronized
screenplay of what they are watching from observable evidence.

## Data usage disclosures

- **Does not collect** personally identifiable information
- **Does not collect** health, financial, authentication, or location information
- **Does not collect** personal communications
- **Does not collect** web history or user activity
- **Does not sell or transfer** data to third parties
- **Does not use or transfer** data for purposes unrelated to the item's single
  purpose
- **Does not use or transfer** data to determine creditworthiness

Optional user-configured AI: when a user enables remote AI and supplies their own
API key, selected downscaled video frames, dialogue text from the analyzed
window, and short speech-audio windows are sent to the endpoint that user
configured. This is off by default, requires explicit acknowledgement of a notice
listing exactly what is sent, and involves no server operated by FrameScript.

## Screenshots to capture

1. Side panel beside a YouTube video, Screenplay view, active line highlighted
2. Evidence view showing sources and confidence on each line
3. Popup on YouTube showing selected quality and live source indicators
4. Popup on Netflix showing environment ceiling, `Current stream: Unknown`, and
   `Video — Protected`
5. Dual-language view, English and Korean aligned
6. Settings → AI, with the data-transmission notice visible and remote AI off
7. Coverage bar showing an unobserved gap after a skip

## Support

Link to the repository issue tracker.
