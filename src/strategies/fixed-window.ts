import type Redis from "ioredis";
import type { RateLimitStrategy , RateLimitResult } from "../types";

export const fixedWindow: RateLimitStrategy = {
    name : "fixed-window",
    async check(
        identifier: string,
        limit: number,
        windowMs: number,
        redis: Redis  
    ): Promise<RateLimitResult> {
        const windowId = Math.floor(Date.now() / windowMs);
        const key = `rw:fw:${identifier}:${windowId}`;
        const resetAt = (windowId + 1) * windowMs;
        const count = await redis.incr(key);
        if (count === 1) {
            await redis.pexpire(key, windowMs);
        }

        const allowed = count <= limit;
        const remaining = Math.max(0, limit - count);

        return {
          allowed,
          limit,
          remaining,
          resetAt,
          retryAfter: allowed ? undefined : Math.ceil((resetAt - Date.now()) / 1000),
        };
      },
    };


    
