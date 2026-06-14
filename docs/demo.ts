import express from "express";
import Redis from "ioredis";
import swaggerUi from "swagger-ui-express";
import { createRedisWall, DEFAULT_TIERS, type RedisWallConfig } from "../src";
import { spec } from "./openapi";

const app = express();
const redis = new Redis({ host: "localhost", port: 6379 });

// ── Swagger UI ────────────────────────────────────────────────────────────────
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(spec, {
    customSiteTitle: "rediswall API",
    customCss: `
      .swagger-ui .topbar { background: #1a1a2e; }
      .swagger-ui .topbar .download-url-wrapper { display: none; }
      .swagger-ui .info .title { font-size: 2rem; }
    `,
    swaggerOptions: {
      docExpansion: "list",
      defaultModelsExpandDepth: -1, // hide schemas section by default
      tryItOutEnabled: true,
    },
  })
);

// Raw spec at /api-docs.json — useful for importing into Postman
app.get("/api-docs.json", (_req, res) => res.json(spec));

// ── Shared config ─────────────────────────────────────────────────────────────
const baseConfig: Omit<RedisWallConfig, "strategy"> = {
  redis,
  tiers: {
    free:       { name: "free",       limit: 10,    windowMs: 60_000 },
    pro:        { name: "pro",        limit: 1000,  windowMs: 60_000 },
    enterprise: { name: "enterprise", limit: 10000, windowMs: 60_000 },
  },
  defaultTier: "free",
  tierFn: (req) => {
    const t = req.headers["x-tier"] as string;
    if (t === "pro" || t === "enterprise") return t;
    return "free";
  },
  circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 },
  failOpen: true,
  onLimitReached: (req, result) => {
    console.log(
      `[429] ${req.ip} | tier: ${req.headers["x-tier"] ?? "free"} ` +
      `| reset: ${new Date(result.resetAt).toISOString()}`
    );
  },
  onCircuitOpen: (state) => {
    console.warn("[rediswall] ⚡ circuit OPEN:", state);
  },
};

// ── Strategy routes ───────────────────────────────────────────────────────────
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

// ── Status ────────────────────────────────────────────────────────────────────
app.get("/status", (_req, res) => {
  res.json({ uptime: process.uptime(), redis: redis.status, message: "rediswall running" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`\nrediswall demo → http://localhost:${PORT}`);
  console.log(`Swagger UI     → http://localhost:${PORT}/api-docs`);
  console.log(`OpenAPI spec   → http://localhost:${PORT}/api-docs.json\n`);
  console.log("Endpoints:");
  console.log("  GET /api/sliding-window");
  console.log("  GET /api/fixed-window");
  console.log("  GET /api/token-bucket");
  console.log("  GET /api/leaky-bucket");
  console.log("  GET /status\n");
  console.log("Tiers via header:  x-tier: free | pro | enterprise\n");
});