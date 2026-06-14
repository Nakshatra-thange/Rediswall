import express from "express";
import Redis from "ioredis";
import { createRedisWall, DEFAULT_TIERS } from "../src";

const app = express();
const redis = new Redis({ host: "localhost", port: 6379 });

// Mount a separate limiter per route to demo all four strategies
const strategies = ["sliding-window", "fixed-window", "token-bucket", "leaky-bucket"] as const;

strategies.forEach((strategy) => {
  const limiter = createRedisWall({
    redis,
    strategy,
    tiers: DEFAULT_TIERS,
    defaultTier: "free",
  });

  app.get(`/api/${strategy}`, limiter, (_req, res) => {
    res.json({ strategy, message: "allowed", time: Date.now() });
  });
});

app.listen(3000, () => {
  console.log("rediswall demo running");
  console.log("  GET /api/sliding-window");
  console.log("  GET /api/fixed-window");
  console.log("  GET /api/token-bucket");
  console.log("  GET /api/leaky-bucket");
});