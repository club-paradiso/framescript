# Permissions

Every permission FrameScript requests, why it is needed, and what would break
without it.

## Requested

| Permission | Why | Without it |
| --- | --- | --- |
| `storage` | Settings, including your own API keys, in `chrome.storage.local`. Deliberately `local` rather than `sync`, so keys are never replicated to your other machines by the browser. | No settings persist. |
| `sidePanel` | The screenplay workspace, which needs to sit beside playback. | No side panel. |
| `tabCapture` | Reading the tab's audio and picture for analysis. Only ever obtained from a user gesture in the popup or side panel. | Only subtitles and playback timing; no audio or picture analysis. |
| `offscreen` | Hosting the media pipeline in a document that can hold a `MediaStream` and use Web Audio. A service worker cannot. | No audio or video analysis at all. |
| `scripting` | Injecting the read-only MAIN-world bridge on demand, used as a fallback when the quality menu cannot be parsed. | Quality selection loses a fallback path. |
| `activeTab` | Acting on the tab you are watching when you open the popup. | The popup cannot identify the current video. |
| `unlimitedStorage` | A feature-length screenplay with provenance runs to several megabytes in IndexedDB. | Saving long films could hit the default quota. |

## Host permissions

```
https://www.youtube.com/*
https://www.netflix.com/*
```

Exactly the two sites FrameScript supports. The content script matches the same
two origins and nothing else.

## Deliberately NOT requested

| Permission | Why not |
| --- | --- |
| `<all_urls>` | FrameScript has no business on any other site. |
| `history` | Your viewing history is not FrameScript's concern and is never read. |
| `cookies` | FrameScript never reads or writes any cookie, on any site. It has no login, no account, and no server. |
| `webRequest` / `declarativeNetRequest` | Never needed. FrameScript does not intercept, inspect, or modify any network request — including the media manifests that a DRM-circumvention tool would target. |
| `downloads` | Exports are delivered via an object URL from the side panel, so no downloads permission is required. |
| `tabs` (broad) | `activeTab` plus host permissions cover everything needed. |
| `identity`, `management`, `proxy`, `debugger` | Not needed, and each would be a serious escalation for a viewing tool. |

## Network access

FrameScript makes **no network requests at all** in its shipped configuration.

The only outbound requests it can ever make are to an AI endpoint you configure
yourself, after enabling remote AI and acknowledging the data notice. Both are
off by default. The endpoint URL is yours; nothing is hardcoded to a vendor and
no FrameScript-operated server exists.

There is no analytics endpoint, no telemetry endpoint, and no update-check
endpoint beyond the Chrome Web Store's own.

## Content Security Policy

```
script-src 'self'; object-src 'self'
```

Every byte of JavaScript the extension executes is bundled in the package. No
remotely hosted code, no CDN, no `eval`.

## What FrameScript cannot do, structurally

These are not policy promises; they follow from the permissions above.

- It cannot read any site other than YouTube and Netflix.
- It cannot see or modify network traffic, so it cannot touch DRM manifests or
  licence exchanges even in principle.
- It cannot read your cookies or session, so it cannot act as you on any service.
- It cannot start analyzing a tab on its own: `tabCapture.getMediaStreamId`
  requires a user gesture, which must come from the popup or side panel.
