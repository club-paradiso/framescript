# Zero-cost production vision

FrameScript production on Vercel is hard-routed through Vercel AI Gateway to `minimax/minimax-m3-free`, the dedicated free MiniMax M3 SKU. Do not substitute the base `minimax/minimax-m3` id: that is a separate billable model and may not be available to the project.

Existing `FRAMESCRIPT_VISION_*` overrides are intentionally ignored in Vercel production so stale paid-capable configuration cannot silently create billable vision traffic. Local and non-production environments retain the existing explicit-provider, OpenRouter, and Gateway configuration paths.
