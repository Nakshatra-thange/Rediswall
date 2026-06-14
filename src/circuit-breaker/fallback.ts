/*
 * In-memory fallback rate limiter
 * ────────────────────────────────
 * Used when the circuit is OPEN and Redis is unreachable.
 *
 * This is a simple sliding window implemented with a plain Map.
 * It is intentionally less accurate than Redis — each Node.js instance
 * tracks its own state independently, so limits aren't shared across
 * instances during an outage.
 *
 * TRADEOFF:
 * During a Redis outage, a user hitting 3 instances could get
 * 3x the limit. We accept this because:
 *   1. Outages are rare and short
 *   2. Crashing the API is worse than briefly over-serving
 *   3. The circuit closes as soon as Redis recovers
 *
 * Alternative — fail-closed: return allowed=false for ALL requests
 * when Redis is down. Correct for auth endpoints. Wrong for most APIs.
 * Make it configurable (see RedisWallConfig.failOpen in types).
 * 
 * User Request
      ↓
Circuit Breaker OPEN
      ↓
Skip Redis
      ↓
Fallback Rate Limiter
      ↓
Allow / Deny
 */

interface FallbackWindow {
    timestamps: number[];
    limit: number;
    windowMs: number;
  }
  
  const store = new Map<string, FallbackWindow>();
  // temporary database 
  export function fallbackCheck(
    identifier: string,
    limit: number,
    windowMs: number
  ): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const cutoff = now - windowMs;
  
    let window = store.get(identifier);
  
    if (!window) {
      window = { timestamps: [], limit, windowMs };
      store.set(identifier, window);
    }
  
    // Evict timestamps outside current window
    window.timestamps = window.timestamps.filter((t) => t > cutoff);
  
    if (window.timestamps.length < limit) {
      window.timestamps.push(now);
      return {
        allowed: true,
        remaining: limit - window.timestamps.length,
      };
    }
  
    return { allowed: false, remaining: 0 };
  }
  
  // Call periodically or on process exit — prevents memory leak on long-running servers
  export function clearFallbackStore(): void {
    store.clear();
  }
  
  // Auto-evict stale keys every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, window] of store.entries()) {
      window.timestamps = window.timestamps.filter((t) => t > now - window.windowMs);
      if (window.timestamps.length === 0) store.delete(key);
    }
  }, 5 * 60 * 1000).unref(); // .unref() so this timer doesn't keep Node.js alive