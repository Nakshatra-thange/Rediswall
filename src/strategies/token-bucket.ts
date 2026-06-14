import type Redis from "ioredis";
import type { RateLimitStrategy, RateLimitResult } from "../types";

/*
 * Token Bucket Algorithm
 * ──────────────────────
 * Imagine a bucket that holds `limit` tokens.
 * Tokens refill at a steady rate: (limit / windowMs) tokens per millisecond.
 * Each request consumes one token. If the bucket is empty, deny.
 *
 * KEY DIFFERENCE from sliding window:
 * Token bucket allows short bursts up to the full bucket size, then
 * enforces the average rate. Sliding window enforces a hard count per window.
 *
 * Example (100 tokens, 60s window = ~1.67 tokens/sec):
 * - User sends 100 requests instantly → all allowed (burns full bucket)
 * - User must wait ~60s for bucket to refill before another burst
 * - Sliding window would block at request 101 within any 60s slice
 *
 * Redis state: a Hash with two fields
 *   tokens     → current token count (float stored as string)
 *   lastRefill → timestamp of last request (unix ms)
 *
 * MEMORY: O(1) per identifier. Two hash fields, one key.
 */

const TOKEN_BUCKET_LUA = `
local key          = KEYS[1]
local now          = tonumber(ARGV[1])
local limit        = tonumber(ARGV[2])
local window_ms    = tonumber(ARGV[3])
local refill_rate  = limit / window_ms   

-- Read current state
local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens     = tonumber(data[1]) or limit   -- start full
local lastRefill = tonumber(data[2]) or now

-- Calculate tokens earned since last request
local elapsed      = math.max(0, now - lastRefill)
local earned       = elapsed * refill_rate
local newTokens    = math.min(limit, tokens + earned)

-- Attempt to consume one token
if newTokens >= 1 then
  newTokens = newTokens - 1
  redis.call('HMSET', key, 'tokens', newTokens, 'lastRefill', now)
  redis.call('PEXPIRE', key, window_ms * 2)
  local remaining = math.floor(newTokens)
  return { 1, remaining }   -- allowed
else
  -- Don't update lastRefill — tokens keep accumulating
  redis.call('HMSET', key, 'tokens', newTokens, 'lastRefill', now)
  redis.call('PEXPIRE', key, window_ms * 2)
  -- Time until one full token regenerates
  local wait_ms = math.ceil((1 - newTokens) / refill_rate)
  return { 0, 0, wait_ms }  -- denied, wait_ms
end
`;

export const tokenBucket: RateLimitStrategy = {
  name: "token-bucket",

  async check(
    identifier: string,
    limit: number,
    windowMs: number,
    redis: Redis
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const key = `rw:tb:${identifier}`;

    const result = await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      String(now),
      String(limit),
      String(windowMs)
    ) as [number, number, number?];

    const allowed = result[0] === 1;
    const remaining = result[1];
    const waitMs = result[2] ?? 0;

    return {
      allowed,
      limit,
      remaining,
      resetAt: now + waitMs,
      retryAfter: allowed ? undefined : Math.ceil(waitMs / 1000),
    };
  },
};