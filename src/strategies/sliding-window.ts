import type Redis from "ioredis";
import type { RateLimitStrategy, RateLimitResult } from "../types";

const SLIDING_WINDOW_LUA = `
local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local window_ms  = tonumber(ARGV[2])
local limit      = tonumber(ARGV[3])
local member     = ARGV[4]

-- Step 1: remove timestamps outside the current window
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)

-- Step 2: count requests in current window
local count = redis.call('ZCARD', key)

-- Step 3: decide
if count < limit then
  -- Add this request's timestamp as both score and member
  -- Member includes a unique suffix to handle same-millisecond requests
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window_ms)
  return { 1, limit - count - 1 }   -- allowed, remaining
else
  return { 0, 0 }                    -- denied
end

`

export const slidingWindow: RateLimitStrategy = {
    name: "sliding-window",
  
    async check(
      identifier: string,
      limit: number,
      windowMs: number,
      redis: Redis
    ): Promise<RateLimitResult> {
      const now = Date.now();
      const key = `rw:sw:${identifier}`;
      // Unique member per request: timestamp + random suffix prevents collisions
      // when two requests arrive within the same millisecond
      const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
  
      const result = await redis.eval(
        SLIDING_WINDOW_LUA,
        1,           // number of KEYS
        key,         // KEYS[1]
        String(now),
        String(windowMs),
        String(limit),
        member
      ) as [number, number];
  
      const allowed = result[0] === 1;
      const remaining = result[1];
      const resetAt = now + windowMs;
  
      return {
        allowed,
        limit,
        remaining,
        resetAt,
        retryAfter: allowed ? undefined : Math.ceil(windowMs / 1000),
      };
    },
  };

  