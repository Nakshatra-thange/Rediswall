import type { RedisWallConfig, RedisWallMiddleware } from "../types";

export function createRedisWall(config: RedisWallConfig): RedisWallMiddleware {
  // Day 3: wire strategy + tiers + circuit breaker together
  return async (_req, _res, next) => {
    next(); // pass-through stub — safe to run today
  };
}