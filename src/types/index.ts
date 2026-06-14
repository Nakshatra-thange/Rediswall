import type { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";

export type StrategyName =
  | "sliding-window"
  | "fixed-window"
  | "token-bucket"
  | "leaky-bucket";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;        // unix ms — when the window resets
  retryAfter?: number;    // seconds to wait if blocked
}

export interface RateLimitStrategy {
  name: StrategyName;
  check(
    identifier: string,
    limit: number,
    windowMs: number,
    redis: Redis
  ): Promise<RateLimitResult>;
}


export type TierName = "free" | "pro" | "enterprise" | string;

export interface TierConfig {
  name: TierName;
  limit: number;          // max requests per window
  windowMs: number;       // window size in milliseconds
}

export interface TierMap {
  [tier: string]: TierConfig;
}


export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number;   // consecutive failures before opening
  cooldownMs: number;         // how long to stay open before half-open probe
}

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: number | null;   // unix ms
  nextProbeAt: number | null;     // unix ms — when to attempt half-open probe
}


export interface RedisWallConfig {
  redis: Redis;
  strategy: StrategyName;
  tiers: TierMap;
  failOpen ? : boolean;
  defaultTier: TierName;
  circuitBreaker?: CircuitBreakerConfig;
  identifierFn?: (req: Request) => string;   // defaults to IP
  tierFn?: (req: Request) => TierName;       // defaults to defaultTier
  onLimitReached?: (req: Request, result: RateLimitResult) => void;
  onCircuitOpen?: (state: CircuitBreakerState) => void;
}

export type RedisWallMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;