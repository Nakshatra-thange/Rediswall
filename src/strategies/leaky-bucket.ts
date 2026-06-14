import type Redis from "ioredis";
import type { RateLimitStrategy, RateLimitResult } from "../types";
/*
 * Leaky Bucket Algorithm
 * ──────────────────────
 * Inverse mental model of token bucket.
 * Requests flow IN at any rate. They drain OUT at a fixed rate.
 * If the bucket overflows (queue full), new requests are denied.
 *
 * Metaphor: a bucket with a hole. Water pours in (requests arrive).
 * Water drips out at a constant rate (processing). If you pour faster
 * than it drips, the bucket fills up and overflows (429).
 *
 * EFFECT: produces the smoothest possible output traffic.
 * No burst allowed past the drain rate — unlike token bucket.
 * This makes leaky bucket ideal for downstream services that can't
 * handle spikes (payment processors, external APIs with their own limits).
 *
 * DIFFERENCE vs token bucket:
 * Token bucket: allows burst up to full capacity, then averages out.
 * Leaky bucket: enforces constant rate regardless of burst intent.
 *
 * Redis state: a Hash with two fields
 *   queue      → current number of requests queued (float)
 *   lastLeak   → timestamp of last check (unix ms)
 *
 * MEMORY: O(1) per identifier.
 */

const LEAKY_BUCKET_LUA = `
local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local capacity   = tonumber(ARGV[2])   -- max queue size = limit
local window_ms  = tonumber(ARGV[3])
local leak_rate  = capacity / window_ms -- requests drained per millisecond

-- Read current state
local data     = redis.call('HMGET', key, 'queue', 'lastLeak')
local queue    = tonumber(data[1]) or 0
local lastLeak = tonumber(data[2]) or now

-- Drain the bucket based on elapsed time
local elapsed  = math.max(0, now - lastLeak)
local drained  = elapsed * leak_rate
local newQueue = math.max(0, queue - drained)

-- Try to add this request to the queue
if math.ceil(newQueue) < capacity then
  newQueue = newQueue + 1
  redis.call('HMSET', key, 'queue', newQueue, 'lastLeak', now)
  redis.call('PEXPIRE', key, window_ms * 2)
  local remaining = math.floor(capacity - newQueue)
  return { 1, remaining }   -- allowed
else
  -- Bucket full — update lastLeak so draining continues even when blocked
  redis.call('HMSET', key, 'queue', newQueue, 'lastLeak', now)
  redis.call('PEXPIRE', key, window_ms * 2)
  -- Time until one slot opens: 1 / leak_rate ms
  local wait_ms = math.ceil(1 / leak_rate)
  return { 0, 0, wait_ms }  -- denied
end
`;

export const leakyBucket: RateLimitStrategy = {
  name: "leaky-bucket",

  async check(
    identifier: string,
    limit: number,
    windowMs: number,
    redis: Redis
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const key = `rw:lb:${identifier}`;

    const result = await redis.eval(
      LEAKY_BUCKET_LUA,
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