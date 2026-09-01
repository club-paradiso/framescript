# Manual QA

## What the automated suite already covers

Run all of it before starting a manual pass — there is no point testing a build
by hand that fails on its own.

```bash
npm run verify        # typecheck, lint, unit tests, all three builds
npm run check:mcp     # MCP server over its real stdio transport
npm run benchmark     # engine throughput + structural invariants
npm run test:e2e      # builds extension + Studio, then runs their production flows
```

If the environment already ships a Chromium that Playwright did not install,
point at it rather than downloading another:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:e2e
```

## What it cannot cover

None of the above verifies that selectors still match today's YouTube, that tab
capture behaves on real media, or anything requiring an authenticated Netflix
account. Every fixture is synthetic by design — no copyrighted footage is used
in any test.

This document is the checklist for what only a human at a real browser can
confirm. Items marked **[UNVERIFIED]** have never been run against the live site
in this build environment.

## Setup

```bash
npm install
npm run build
```

Then: `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.

Record Chrome version, OS and display resolution with any result — quality
behaviour depends on all three.

---

## 1. YouTube — Maximum Quality **[UNVERIFIED]**

| #    | Scenario                                                | Expected                                                               |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1.1  | Homepage → click a video                                | Quality applied within a few seconds of playback starting              |
| 1.2  | Search results → video                                  | As above                                                               |
| 1.3  | Video → next video in a playlist                        | Re-applied on the new video; previous observers gone                   |
| 1.4  | Browser back, then forward                              | Re-applied once per navigation, not several times                      |
| 1.5  | A video whose max is 720p                               | Selects 720p; popup shows `Limited by the platform`                    |
| 1.6  | A 1080p video                                           | Selects 1080p, verified                                                |
| 1.7  | A 1440p video                                           | Selects 1440p                                                          |
| 1.8  | A 2160p video                                           | Selects 2160p; verification may lag on a slow connection               |
| 1.9  | A 60 fps video                                          | `2160p60` parses; frame rate shown                                     |
| 1.10 | An HDR video                                            | HDR detected and preferred within its tier                             |
| 1.11 | Premium account, enhanced-bitrate tier present          | Selected when the setting is on                                        |
| 1.12 | Non-Premium account, Premium tier listed but disabled   | **Not clicked.** Reports `limitedBy: entitlement`                      |
| 1.13 | Preference set to `Prefer 1080p or lower` on a 4K video | Selects 1080p; reports `limitedBy: preference`                         |
| 1.14 | Change quality by hand mid-video                        | FrameScript stands down; popup shows `Your choice`                     |
| 1.15 | Navigate to the next video after 1.14                   | Automatic selection resumes                                            |
| 1.16 | Fullscreen and theater mode                             | Quality unaffected; no re-application storm                            |
| 1.17 | Seek repeatedly                                         | No repeated menu opening                                               |
| 1.18 | A Short                                                 | No crash; quality applied or cleanly skipped                           |
| 1.19 | A live stream                                           | No crash; coverage reports unknown                                     |
| 1.20 | **Set YouTube UI language to Korean, repeat 1.6**       | Quality row still found (keys off the resolution value, not the label) |
| 1.21 | Same in Japanese                                        | As above                                                               |
| 1.22 | Watch the settings menu during application              | Menu opens and closes cleanly; not left open                           |

**Regression watch:** if 1.20/1.21 fail but English works, YouTube changed the
menu _value_ format. Fix `matchesQualityMenuItem` in
`src/platforms/youtube/selectors.ts` — nowhere else.

## 2. YouTube — subtitles **[UNVERIFIED]**

| #   | Scenario                                       | Expected                                                                           |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2.1 | Subtitles off                                  | Source shows `Subtitles — Unavailable` with an explanation; other sources continue |
| 2.2 | Manual (authored) subtitles                    | Cues captured; confidence `high`                                                   |
| 2.3 | Automatic captions                             | Progressive growth collapses to one cue per utterance, not one per word            |
| 2.4 | Automatic captions, fast speech                | No duplicated fragments                                                            |
| 2.5 | Switch subtitle language mid-video             | Both language tracks retained; neither discarded                                   |
| 2.6 | A video with speaker labels (`JANE:`)          | Label stripped from dialogue, character created and named                          |
| 2.7 | A video with `[music]` / `[applause]` captions | Become sound beats, not dialogue                                                   |
| 2.8 | Seek backwards over captured captions          | No duplicate cues                                                                  |
| 2.9 | Pause mid-cue                                  | Cue closed cleanly, not left hanging                                               |

## 3. Netflix **[UNVERIFIED — requires an account]**

Do not store Netflix credentials or cookies anywhere in this repository or in
any automated test.

| #    | Scenario                     | Expected                                                                                  |
| ---- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| 3.1  | Play a film                  | Popup shows environment ceiling and current stream separately                             |
| 3.2  | Read `Current stream`        | Either a real resolution from `videoHeight`, or `Unknown` — never the ceiling substituted |
| 3.3  | Start analysis               | Video source reports `Protected` within ~2 s of blank frames                              |
| 3.4  | Confirm audio still plays    | **Critical.** Tab capture must not mute playback                                          |
| 3.5  | Subtitles on                 | Timed-text captured as real text                                                          |
| 3.6  | Subtitles off                | Source unavailable; audio and timing continue                                             |
| 3.7  | Switch subtitle language     | Both tracks retained                                                                      |
| 3.8  | Series episode               | Series title, season and episode parsed from the title element                            |
| 3.9  | Auto-advance to next episode | New content detected; previous screenplay not carried over                                |
| 3.10 | A film (no episode label)    | Title parsed; no invented season/episode                                                  |
| 3.11 | Pause, seek, rewind          | Coverage updates; no duplicate scenes                                                     |
| 3.12 | Fullscreen                   | No crash; capture continues                                                               |
| 3.13 | Non-English Netflix UI       | Episode label parsing degrades to plain title rather than guessing                        |

## 4. Tab capture and audio **[UNVERIFIED]**

| #   | Scenario                      | Expected                                                                             |
| --- | ----------------------------- | ------------------------------------------------------------------------------------ |
| 4.1 | Start analysis from the popup | Capture starts; no permission error                                                  |
| 4.2 | **Listen**                    | Audio continues at the same volume. Any silence or level change is a release blocker |
| 4.3 | Stop analysis                 | Audio still fine; capture indicator gone                                             |
| 4.4 | Start, stop, start again      | No duplicate audio graph, no feedback                                                |
| 4.5 | Decline the capture prompt    | Clear message; subtitles keep working                                                |
| 4.6 | Close the tab while analyzing | Session cleaned up; offscreen document closed                                        |
| 4.7 | Two tabs, analyze one         | Only the analyzing tab produces evidence                                             |

## 5. Temporal engine **[UNVERIFIED at scale]**

| #   | Scenario                             | Expected                                                                         |
| --- | ------------------------------------ | -------------------------------------------------------------------------------- |
| 5.1 | Detailed mode, diagnostics on        | Measured observation rate ≈ 10/s                                                 |
| 5.2 | Efficient mode                       | ≈ 5/s; fewer deep analyses                                                       |
| 5.3 | Forensic mode                        | Approaches the media frame rate, capped by it                                    |
| 5.4 | Static shot (a locked-off interview) | Redundant-skip count climbs; few events emitted                                  |
| 5.5 | Rapid montage                        | Deep-analysis rate rises then settles back to baseline — it must not stay pinned |
| 5.6 | Action sequence                      | No dropped frames in playback; analysis degrades first                           |
| 5.7 | Seek                                 | Continuity reset; no phantom scene cut across the jump                           |
| 5.8 | 30-minute continuous run             | Memory stable; keyframe bytes bounded                                            |

## 6. Screenplay reconstruction **[UNVERIFIED]**

| #    | Scenario                      | Expected                                                |
| ---- | ----------------------------- | ------------------------------------------------------- |
| 6.1  | Dialogue-heavy scene          | Dialogue appears within a few seconds; speakers grouped |
| 6.2  | Action scene, no dialogue     | Action or sound beats appear; not an empty screenplay   |
| 6.3  | Scene change                  | Scene boundary detected; not one per shot change        |
| 6.4  | Two-hander conversation       | Alternation attribution plausible                       |
| 6.5  | Crowd scene                   | Unknown speakers rather than confident wrong names      |
| 6.6  | Watch the panel for 5 minutes | Text does not flicker or reflow constantly              |
| 6.7  | Rename a speaker              | All their lines re-attribute immediately                |
| 6.8  | Rename with `apply forward`   | Later lines re-attribute; earlier ones do not           |
| 6.9  | Merge two speakers            | Combined; line counts add                               |
| 6.10 | Skip 20 minutes               | Coverage bar shows the gap; no invented scenes          |
| 6.11 | Rewind into analyzed material | No duplicate scenes                                     |
| 6.12 | Click a line                  | Player seeks to it                                      |
| 6.13 | Scroll away while following   | Auto-scroll stands down; "Jump to current line" appears |
| 6.14 | Evidence view                 | Every line shows sources and confidence                 |

## 7. Languages **[UNVERIFIED]**

| #   | Scenario                                              | Expected                                                 |
| --- | ----------------------------------------------------- | -------------------------------------------------------- |
| 7.1 | English subtitles → English screenplay                | Dialogue from platform subtitles                         |
| 7.2 | Switch player to Korean, keep watching                | Korean track added; English retained                     |
| 7.3 | Switch script language to Korean                      | Scene headings localized; dialogue uses the Korean track |
| 7.4 | Script language with no dialogue track                | Falls back and labels `Shown in <lang>`                  |
| 7.5 | Dual-language view                                    | Two languages aligned by time, not cue index             |
| 7.6 | Dual view where tracks split differently              | The shared line appears once, not twice                  |
| 7.7 | Action lines in Korean without a translation provider | Rendered in English and marked as such                   |

## 8. Export and storage

| #   | Scenario                               | Expected                                       |
| --- | -------------------------------------- | ---------------------------------------------- |
| 8.1 | Export Fountain                        | Opens in a Fountain editor; disclaimer present |
| 8.2 | Export with a Korean script language   | Forced heading (`.실내. …`) parses correctly   |
| 8.3 | Export Markdown / text / JSON / SRT    | All carry the reconstruction notice            |
| 8.4 | SRT                                    | Dialogue only; no action lines                 |
| 8.5 | Export with evidence references        | Sources and confidence present                 |
| 8.6 | Filename for a series                  | `the-bear-s02e03.en.fountain`                  |
| 8.7 | Filename for a Korean title            | Non-empty, filesystem-safe slug                |
| 8.8 | Save, reload the extension, list saved | Record present with correct coverage           |
| 8.9 | Delete a saved screenplay              | Gone from the list                             |

## 9. AI providers **[UNVERIFIED]**

| #   | Scenario                        | Expected                                                                              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------- |
| 9.1 | Fresh install                   | Remote AI off; consent unchecked; `Enable remote AI` disabled                         |
| 9.2 | Try to enable without consent   | Blocked, with the reason shown                                                        |
| 9.3 | Read the data notice            | Reflects live configuration, not static text                                          |
| 9.4 | Enable vision with a valid key  | Action descriptions appear; marked `inferred` in Evidence view                        |
| 9.5 | Enable with an invalid key      | Circuit breaker opens after 3 failures; local analysis continues; playback unaffected |
| 9.6 | Provider returns malformed JSON | Response discarded; no invented beats                                                 |
| 9.7 | Disable remote AI mid-session   | Requests stop immediately                                                             |
| 9.8 | Enable an ASR endpoint          | Speech regions transcribed; silence not sent                                          |

## 10. Accessibility

| #    | Scenario                            | Expected                                        |
| ---- | ----------------------------------- | ----------------------------------------------- |
| 10.1 | Tab through popup and side panel    | Every control reachable; focus always visible   |
| 10.2 | Operate export entirely by keyboard | Possible                                        |
| 10.3 | Screen reader on the side panel     | Source states announced with their explanations |
| 10.4 | OS "reduce motion" on               | Live-capture pulse stops animating              |
| 10.5 | Text size at 140%                   | No clipping or overlap                          |
| 10.6 | Light theme                         | Contrast adequate throughout                    |
| 10.7 | Narrow side panel (320px)           | No horizontal scrolling                         |

## 11. Performance

Record with the diagnostics panel open and Chrome's task manager visible.

| #    | Measure                                           | Target                                               |
| ---- | ------------------------------------------------- | ---------------------------------------------------- |
| 11.1 | Dropped frames during Detailed analysis of 4K     | Zero attributable to FrameScript                     |
| 11.2 | Extension CPU, Detailed mode                      | Should not dominate a core                           |
| 11.3 | Extension memory after 30 min                     | Stable, not monotonically climbing                   |
| 11.4 | Keyframe buffer bytes                             | Bounded below the configured ceiling                 |
| 11.5 | Inference queue depth                             | Bounded; drops visible under load rather than growth |
| 11.6 | Playback smoothness while seeking during analysis | Unaffected                                           |

## Outstanding calibration

Two thresholds are currently tuned against synthetic signals and need real
material:

1. **Diarization** (`src/audio/diarization.ts`) — merge 0.10 / split 0.25,
   derived from harmonic test signals. Validate against a two-hander scene and a
   crowd scene; adjust with the bias toward over-splitting.
2. **Sound-event classification** (`src/audio/soundEvents.ts`) — verify that
   `impact` / `alarm` / `applause` are not over-claimed on real soundtracks. If
   they are, tighten the rules rather than adding categories.
