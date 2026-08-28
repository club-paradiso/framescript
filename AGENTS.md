# FrameScript engineering guide

- Keep `src/core` platform-independent. The extension, Studio, CLI, and MCP server must consume the same evidence, reconstruction, scene, and export implementations.
- Evidence is the source of truth. Preserve observed vs inferred state, ordinal confidence, conflicts, and incomplete coverage; never create plausible screenplay facts without supporting evidence.
- Studio file workflows are local by default. Do not add uploads, analytics, authentication, databases, or client-side secrets to ordinary file analysis.
- Streaming-player access belongs to the Chrome extension. A normal web route must never claim it can inspect YouTube or Netflix tabs.
- Treat subtitle and project content as untrusted. Render text through React, validate versioned project files, bound file sizes, and surface malformed or skipped input.
- Preserve the multilingual scene-gap regression: merge overlapping or adjacent speech ranges before measuring dialogue-gap rhythm.
- Production gates are `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:all`, `npm run check:mcp`, `npm run benchmark`, and `npx playwright test` after the extension and Studio builds.
