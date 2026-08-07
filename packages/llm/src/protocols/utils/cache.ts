// Shared helpers for provider cache-marker lowering. Anthropic and Bedrock
// both enforce a 4-breakpoint cap per request and accept the same `5m`/`1h`
// TTL buckets, so the counter and TTL mapping live here.

export interface Breakpoints {
  remaining: number
  dropped: number
}

export const newBreakpoints = (cap: number): Breakpoints => ({ remaining: cap, dropped: 0 })

// Returns the Anthropic/Bedrock cache TTL bucket for a caller-provided
// `ttlSeconds`. Default is `"1h"`; an explicit value below one hour falls
// back to `"5m"`. Anthropic & Bedrock both treat anything shorter than an
// hour as 5m.
export const ttlBucket = (ttlSeconds: number | undefined): "1h" | "5m" => {
  if (ttlSeconds !== undefined && ttlSeconds < 3600) return "5m"
  return "1h"
}
