# Zero-cost production vision

FrameScript production on Vercel is hard-routed through Vercel AI Gateway to `minimax/minimax-m3`, which is currently listed by Vercel as a free multimodal model. Existing `FRAMESCRIPT_VISION_*` overrides are intentionally ignored in Vercel production so stale paid-capable configuration cannot silently create billable vision traffic.

Local and non-production environments retain the existing explicit-provider and OpenRouter configuration paths.
