# Zero-cost production vision

FrameScript production on Vercel routes scene understanding only to a zero-cost model. With no `OPENROUTER_API_KEY`, it goes through Vercel AI Gateway (deployment OIDC) to `stealth/pixel-canary`. In the live Gateway catalog on 2026-09-27, that model took image input, and every one of its serving endpoints priced prompt, completion, image, request and reasoning at $0. The model's catalog entry does not declare `response_format`, so FrameScript leaves that parameter out for it and sends `reasoning: { effort: "none" }`. Every response is still schema-validated the same way.

The provider states that prompts and outputs may be retained for training. In practice that means the selected, downscaled keyframes and the dialogue text of each analyzed window.

If `OPENROUTER_API_KEY` is set in production, vision uses the OpenRouter hard-free path instead. There it accepts only `:free` slugs or `openrouter/free`; the default is `google/gemma-4-31b-it:free`. A paid slug is refused with a configuration error. It never falls back to a paid model.

`FRAMESCRIPT_VISION_*` and `FRAMESCRIPT_GATEWAY_VISION_MODEL` are ignored in Vercel production, so stale configuration that could reach a paid model cannot create billable vision traffic.

A pinned model can be withdrawn or repriced upstream. `minimax/minimax-m3-free` was a promotional SKU; once the offer ended, Gateway answered 404 `model_not_found`. For that reason the Production AI smoke (`scripts/production-ai-smoke.mjs`) re-proves a $0 price against the public catalog on every production deployment, before it sends any frame. A withdrawn model shows up as `VISION_MODEL_UNAVAILABLE` with `reason=model_not_found`.

## Transcription

Production transcription goes through Vercel AI Gateway with deployment OIDC and uses `openai/gpt-4o-transcribe`. Neither the Gateway nor OpenRouter catalog lists a zero-cost transcription model, so ASR bills against the Vercel team's AI Gateway credits. `FRAMESCRIPT_ASR_API_KEY` switches ASR to an explicit OpenAI-compatible endpoint and takes precedence over Gateway, so do not set it in production unless that endpoint's account is funded.

When a provider refuses for an account reason, `/api/transcribe` and `/api/analyze-frame` answer 503 `*_MODEL_UNAVAILABLE` with one of these `reason` values, and the smoke prints it:

- `payment_required`: a bare 402.
- `insufficient_funds`: Gateway has no credit balance.
- `customer_verification_required`: the Vercel team must add a valid payment method.
- `no_providers_available`: a team allowlist blocks the model.
- `model_not_found`: the slug was withdrawn.

`reason` is a closed enum. Provider response bodies are never returned.
