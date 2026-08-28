# FrameScript engineering guide

- Keep `src/core` platform-independent. The extension, Studio, CLI, and MCP server must consume the same evidence, reconstruction, scene, and export implementations.
- Evidence is the source of truth. Preserve observed vs inferred state, ordinal confidence, conflicts, and incomplete coverage; never create plausible screenplay facts without supporting evidence.
- Studio file workflows are local by default. Do not add uploads, analytics, authentication, databases, or client-side secrets to ordinary file analysis. The media file itself is never uploaded.
- AI acquires evidence; the deterministic engine writes the screenplay. A provider response is validated, clamped into the window it was shown, marked `inferred`, and then goes through the same timeline, fusion and scene construction as a subtitle file. Never let a model produce a beat, a heading, or a line directly.
- Provider credentials for Studio live in the server environment and are read only by `api/`. Never `VITE_*`, never `localStorage`, never in the client bundle — `e2e-web/studio.spec.ts` asserts this. Keep `connect-src 'self'`; new remote capabilities go behind a same-origin `/api/` route, and the SPA rewrite in `vercel.json` must keep excluding `/api/`.
- Remote work is bounded per file: plan speech into windows, cap keyframes to those the scanner selected, cap concurrency, retry only 429 and 5xx, and stop a stage after repeated failure. Local observation fidelity and remote analysis depth are separate settings and must stay that way.
- Every stage may fail alone. Surface a typed error code with user-readable copy, keep the evidence the other stages produced, and never leave the UI mid-analysis.
- Coverage is per source. "Timeline observed" is not "speech transcribed" is not "screenplay complete"; do not merge them into one number.
- A green subtitle or WAV test does not cover video. `e2e-web/media.spec.ts` records an encoded MP4 in the browser under test and runs it through the production build and the real API routes; keep it that way rather than mocking the media pipeline.
- Streaming-player access belongs to the Chrome extension. A normal web route must never claim it can inspect YouTube or Netflix tabs.
- Treat subtitle and project content as untrusted. Render text through React, validate versioned project files, bound file sizes, and surface malformed or skipped input.
- Preserve the multilingual scene-gap regression: merge overlapping or adjacent speech ranges before measuring dialogue-gap rhythm.
- Production gates are `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:all`, `npm run check:mcp`, `npm run benchmark`, and `npx playwright test` after the extension and Studio builds.
