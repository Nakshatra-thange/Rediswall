// Core factory
export { createRedisWall } from "./middleware";

// Types — everything a consumer needs to configure the package
export type {
  RedisWallConfig,
  RedisWallMiddleware,
  RateLimitStrategy,
  RateLimitResult,
  TierConfig,
  TierMap,
  TierName,
  StrategyName,
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitState,
} from "./types";

// Utilities consumers might want
export { DEFAULT_TIERS, resolveTier } from "./tiers";
export { CircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from "./circuit-breaker";
export { strategies } from "./strategies";