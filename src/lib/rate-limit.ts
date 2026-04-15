/**
 * Simple in-memory sliding-window rate limiter per key (e.g. user id).
 * Best-effort on serverless (per-instance); still limits casual abuse.
 */
const buckets = new Map<string, number[]>();

export function rateLimitExceeded(key: string, maxPerWindow: number, windowMs: number): boolean {
  const now = Date.now();
  const prev = buckets.get(key) ?? [];
  const recent = prev.filter((t) => now - t < windowMs);
  if (recent.length >= maxPerWindow) {
    buckets.set(key, recent);
    return true;
  }
  recent.push(now);
  buckets.set(key, recent);
  return false;
}
