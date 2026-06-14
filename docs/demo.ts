import express from "express";
import Redis from "ioredis";
import {
  createRedisWall,
  DEFAULT_TIERS,
  type RedisWallConfig,
} from "../src";

const app = express();
const redis = new Redis({ host: "localhost", port: 6379 });

// ── Shared config base ────────────────────────────────────────────────────────
const baseConfig: Omit<RedisWallConfig, "strategy"> = {
  redis,
  tiers: {
    ...DEFAULT_TIERS,
    // Override free tier to 10/min so you can hit limits during demo
    free: { name: "free", limit: 10, windowMs: 60_000 },
  },
  defaultTier: "free",

  // Resolve tier from header — try: curl -H "x-tier: pro" localhost:3000/...
  tierFn: (req) => {
    const tier = req.headers["x-tier"];
    if (tier === "pro" || tier === "enterprise") return tier;
    return "free";
  },

  // Circuit breaker: open after 3 failures, probe after 10s (short for demo)
  circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 },
  failOpen: true,

  onLimitReached: (req, result) => {
    console.log(`[429] ${req.ip} | remaining: ${result.remaining} | reset: ${new Date(result.resetAt).toISOString()}`);
  },

  onCircuitOpen: (state) => {
    console.warn("[rediswall] ⚡ circuit OPEN:", state);
  },
};

// ── Routes — one per strategy ─────────────────────────────────────────────────

app.get(
  "/api/sliding-window",
  createRedisWall({ ...baseConfig, strategy: "sliding-window" }),
  (_req, res) => res.json({ strategy: "sliding-window", ok: true })
);

app.get(
  "/api/fixed-window",
  createRedisWall({ ...baseConfig, strategy: "fixed-window" }),
  (_req, res) => res.json({ strategy: "fixed-window", ok: true })
);

app.get(
  "/api/token-bucket",
  createRedisWall({ ...baseConfig, strategy: "token-bucket" }),
  (_req, res) => res.json({ strategy: "token-bucket", ok: true })
);

app.get(
  "/api/leaky-bucket",
  createRedisWall({ ...baseConfig, strategy: "leaky-bucket" }),
  (_req, res) => res.json({ strategy: "leaky-bucket", ok: true })
);

// ── Status endpoint — inspect circuit state ───────────────────────────────────
// In production you'd put this behind auth
const slidingLimiter = createRedisWall({
  ...baseConfig,
  strategy: "sliding-window",
});

app.get("/status", (_req, res) => {
  res.json({
    uptime: process.uptime(),
    redis: redis.status,
    message: "rediswall running",
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("\nrediswall demo → http://localhost:3000");
  console.log("  GET /api/sliding-window    (limit: 10/min, free tier)");
  console.log("  GET /api/fixed-window");
  console.log("  GET /api/token-bucket");
  console.log("  GET /api/leaky-bucket");
  console.log("  GET /status");
  console.log("\n  Pro tier: add header  x-tier: pro  (limit: 1000/min)");
  console.log("  Trigger circuit: kill Redis while hitting an endpoint\n");
});