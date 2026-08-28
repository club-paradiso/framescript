# Production AI repair notes

Observed against the August 2026 production deployment with a real 177.85 s MOV:

- local audio decode, speech detection, diarization, sound events, temporal scanning, scene cuts and keyframe capture succeeded;
- Vercel AI Gateway transcription returned upstream HTTP 400 for every attempted window;
- scene understanding returned upstream HTTP 403 while `/api/capabilities` still reported vision as configured;
- a metadata timeout notice remained even though duration, dimensions and almost-complete video observation were later available.

Repair principles:

1. mirror the official Vercel Gateway v4 transcription envelope, including `ai-transcription-model-specification-version: 4`;
2. never map configured-but-rejected 401/403 responses to `*_NOT_CONFIGURED`;
3. preserve only safe provider error metadata (`status`, `type`, `code`, model and bounded payload sizes), never provider bodies, media or credentials;
4. keep local evidence when remote inference fails;
5. use a generally routable vision default while retaining an environment override for newer or restricted-preview models.

This note is intentionally free of user media or provider credentials.
