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
`/docs` works without server functions.

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
playback. Local analysis does not claim to transcribe speech or semantically
describe the picture without evidence that provides those facts.

## Browser security boundary

A normal website cannot inspect or control a YouTube or Netflix tab. Live player
observation, subtitle collection and Maximum Quality remain Chrome Extension
responsibilities. The supported handoff is a versioned FrameScript project:
export from the extension, then open the JSON file in `/view` or `/studio`.

No media or screenplay data is placed in URLs. No production origin is hardcoded,
and there is no externally connectable extension message bridge.

## Privacy and caching

Studio reads user-selected files with browser File APIs and runs analysis in the
page. It has no backend, account, database, analytics SDK, upload endpoint or
client-side secret. User media remains local unless a future feature introduces
an explicit, separately documented server boundary.

The service worker caches only the application shell and static assets. It never
caches blob URLs, local media, imported projects, reconstructed screenplays or
exports. Each release uses a new cache name and removes obsolete shell caches on
activation.

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
```

`npm run build:web` produces `dist-web/`. On Vercel, import the repository with
the included configuration; no environment variables, functions or storage
products are required. On another static host, configure an SPA fallback to
`/index.html` for the application routes above.

After deployment, smoke-test `/`, direct navigation to `/studio`, manifest and
service-worker delivery, subtitle intake, native project import/export and a
mobile viewport.
