# Zero-cost production vision

FrameScript production on Vercel routes scene understanding only to a zero-cost model. With no `OPENROUTER_API_KEY`, it defaults through Vercel AI Gateway (deployment OIDC) to `stealth/pixel-canary`. In the live Gateway catalog on 2026-09-27, that model took image input and was priced at $0. When a pinned model is withdrawn upstream (Gateway answers 404 `model_not_found`), FrameScript surfaces `VISION_MODEL_UNAVAILABLE` with `reason=model_not_found` rather than crashing or switching to a billable model.

If `OPENROUTER_API_KEY` is set in production, vision uses the OpenRouter hard-free path instead. There it accepts only `:free` slugs or `openrouter/free`; the primary default is `google/gemma-4-31b-it:free`. A paid slug is refused with a configuration error. If the primary free model is temporarily rate limited (429) or unavailable (404/5xx), FrameScript automatically falls back to verified free alternatives in the catalog:
- `google/gemma-4-31b-it:free` (primary)
- `google/gemma-4-26b-a4b-it:free`
- `qwen/qwen3.8-27b:free`
- `openrouter/free`

It never falls back to a paid model under any circumstances. Setting `OPENROUTER_API_KEY` is the recommended production configuration for zero-cost scene understanding.

`FRAMESCRIPT_VISION_*` and `FRAMESCRIPT_GATEWAY_VISION_MODEL` are ignored in Vercel production, so stale configuration that could reach a paid model cannot create billable vision traffic. If neither zero-cost route has a credential, production reports vision as not configured instead of using them.

A pinned model can be withdrawn or repriced upstream. `minimax/minimax-m3-free` was a promotional SKU; once the offer ended, Gateway answered 404 `model_not_found`. For that reason the Production AI smoke (`scripts/production-ai-smoke.mjs`) re-proves a $0 price against the public catalog on every production deployment, before it sends any frame. A withdrawn model shows up as `VISION_MODEL_UNAVAILABLE` with `reason=model_not_found`.

## Transcription

Production transcription goes through Vercel AI Gateway with deployment OIDC and uses `openai/gpt-4o-transcribe`. If `openai/gpt-4o-transcribe` encounters a model outage (404) or upstream 5xx failure on the Gateway, FrameScript degrades to the 50% cheaper verified model `openai/gpt-4o-mini-transcribe`. This fallback is strictly restricted to primary model outages: it never activates on account gates (`payment_required`, `customer_verification_required`, `insufficient_funds`), auth failures (401/403), client errors (400), rate limits (429), or cancellations. Operators can disable automatic ASR fallback entirely by setting `FRAMESCRIPT_DISABLE_ASR_FALLBACK=1`.

Neither the Gateway nor OpenRouter catalog lists a zero-cost transcription model, so ASR bills against the Vercel team's AI Gateway credits. `FRAMESCRIPT_ASR_API_KEY` switches ASR to an explicit OpenAI-compatible endpoint and takes precedence over Gateway, so do not set it in production unless that endpoint's account is funded.

When a provider refuses for an account reason, `/api/transcribe` and `/api/analyze-frame` answer 503 `*_MODEL_UNAVAILABLE` with one of these allowlisted `reason` values, and the smoke and UI display it clearly:

- `payment_required`: a bare 402 or unpaid provider balance.
- `insufficient_funds`: Gateway has no credit balance.
- `customer_verification_required`: the Vercel team must add a valid payment method.
- `no_providers_available`: a team allowlist blocks the model.
- `model_not_found`: the slug was withdrawn or is not found.
- `unsupported_modality`: the requested model does not support the media format.

`reason` is a closed enum. Provider response bodies are never returned or leaked. Rate limits (429) propagate the provider's `Retry-After` header to coordinate pauses across concurrent workers and suggest appropriate retry wait times to users.

