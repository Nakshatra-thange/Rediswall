import type { Request, Response, NextFunction } from "express";
import type { RedisWallConfig, RedisWallMiddleware, RateLimitResult } from "../types";
import { getStrategy } from "../strategies";
import { resolveTier } from "../tiers";
import { CircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from "../circuit-breaker";
import { fallbackCheck } from "../circuit-breaker/fallback";


// HTTP Request
//       ↓
// createRedisWall middleware
//       ↓
// Identify user
//       ↓
// Find user's tier
//       ↓
// Check circuit breaker
//       ↓
// Redis available?
//      / \
//    Yes  No
//    ↓     ↓
// Redis   Fallback
// Limiter Limiter
//    ↓     ↓
// Allowed?
//    / \
//  Yes No
//  ↓    ↓
// next() 429

export function createRedisWall(config: RedisWallConfig): RedisWallMiddleware {
    const strategy = getStrategy(config.strategy);
    const breaker = new CircuitBreaker(
      config.circuitBreaker ?? DEFAULT_CIRCUIT_CONFIG
    );
    const failOpen = config.failOpen ?? true;
    // Default identifier: prefer X-Forwarded-For (behind load balancer),
    // fall back to socket IP
    const getIdentifier = config.identifierFn ?? ((req: Request): string => {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
      return req.socket.remoteAddress ?? "unknown";
    });
  
    const getTier = config.tierFn ?? (() => config.defaultTier);
  
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const identifier = getIdentifier(req);
      const tierName = getTier(req);
      const tier = resolveTier(tierName, config.tiers);
      console.log("REQUEST", {
        identifier,
        tierName,
        tier,
      });
  
      let result: RateLimitResult;
  
      // ── Circuit breaker check ─────────────────────────────────────────────────
      if (!breaker.shouldAllow()) {
        // Circuit is OPEN — Redis is down, use fallback
        config.onCircuitOpen?.(breaker.getState());
  
        if (!failOpen) {
          // fail-closed: treat outage as a hard block
          res.status(503).json({
            error: "Service temporarily unavailable",
            message: "Rate limiting service is down. Please try again shortly.",
          });
          return;
        }
  
        // fail-open: in-memory fallback
        const fallback = fallbackCheck(identifier, tier.limit, tier.windowMs);
        result = {
          allowed: fallback.allowed,
          limit: tier.limit,
          remaining: fallback.remaining,
          resetAt: Date.now() + tier.windowMs,
          retryAfter: fallback.allowed ? undefined : Math.ceil(tier.windowMs / 1000),
        };
      } else {
        // ── Normal path: call Redis strategy ───────────────────────────────────
        try {
          result = await strategy.check(
            identifier,
            tier.limit,
            tier.windowMs,
            config.redis
          );
          breaker.recordSuccess();
        } catch (err) {
          breaker.recordFailure();
  
          // Log the error — don't swallow it silently
          console.error(
            `[rediswall] Redis error (failures: ${breaker.getState().failureCount}):`,
            err
          );
  
          if (!failOpen) {
            res.status(503).json({
              error: "Service temporarily unavailable",
              message: "Rate limiting service is down. Please try again shortly.",
            });
            return;
          }
  
          // Fallback for this single request while circuit is still closing
          const fallback = fallbackCheck(identifier, tier.limit, tier.windowMs);
          result = {
            allowed: fallback.allowed,
            limit: tier.limit,
            remaining: fallback.remaining,
            resetAt: Date.now() + tier.windowMs,
          };
        }
      }
  
      // ── Standard RateLimit headers ────────────────────────────────────────────
      // These follow the IETF RateLimit header fields draft standard
      res.setHeader("X-RateLimit-Limit", tier.limit);
      res.setHeader("X-RateLimit-Remaining", result.remaining);
      res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000)); // unix seconds
      res.setHeader("X-RateLimit-Policy", `${tier.limit};w=${Math.ceil(tier.windowMs / 1000)}`);
  
      if (!result.allowed) {
        config.onLimitReached?.(req, result);
  
        if (result.retryAfter) {
          res.setHeader("Retry-After", result.retryAfter);
        }
  
        res.status(429).json({
          error: "Too Many Requests",
          message: `Rate limit exceeded. You are allowed ${tier.limit} requests per ${Math.ceil(tier.windowMs / 1000)}s.`,
          retryAfter: result.retryAfter,
          limit: result.limit,
          remaining: 0,
          resetAt: new Date(result.resetAt).toISOString(),
        });
        return;
      }
  
      next();
    };
  }
  