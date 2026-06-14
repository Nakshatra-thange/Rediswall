import express from "express";
import Redis from "ioredis";
import { createRedisWall, DEFAULT_TIERS } from "../src";

const app = express();
const redis = new Redis({ host: "localhost", port: 6379 });

const limiter = createRedisWall({
  redis,
  strategy: "sliding-window",
  tiers: DEFAULT_TIERS,
  defaultTier: "free",
});

app.use(limiter);

app.get("/api/data", (_req, res) => {
  res.json({ message: "ok", time: Date.now() });
});

app.listen(3000, () => {
  console.log("rediswall demo → http://localhost:3000");
});