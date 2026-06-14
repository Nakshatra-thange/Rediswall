import express, { type Express } from "express";
import { describe, expect, it, afterAll } from "@jest/globals";
import request from "supertest";
import Redis from "ioredis";
import { createRedisWall, DEFAULT_TIERS } from "../../src";

// supertest isn't installed yet — add it
// npm install -D supertest @types/supertest

const redis = new Redis({ host: "localhost", port: 6379 });

afterAll(async () => {
  await redis.quit();
});

function buildApp(limit: number, strategy: "sliding-window" | "fixed-window" = "sliding-window"): Express {
  const app = express();
  const limiter = createRedisWall({
    redis,
    strategy,
    tiers: {
      default: { name: "default", limit, windowMs: 60_000 },
    },
    defaultTier: "default",
    // Use a random identifier so parallel tests don't collide
    identifierFn: (req) => req.headers["x-test-id"] as string ?? "test",
  });

  app.get("/test", limiter, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("middleware integration", () => {
  it("allows requests under the limit", async () => {
    const app = buildApp(5);
    const id = `int-allow-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get("/test")
        .set("x-test-id", id);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });

  it("returns 429 when limit is exceeded", async () => {
    const app = buildApp(3);
    const id = `int-block-${Date.now()}`;

    for (let i = 0; i < 3; i++) {
      await request(app).get("/test").set("x-test-id", id);
    }

    const res = await request(app).get("/test").set("x-test-id", id);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too Many Requests");
    expect(res.body.retryAfter).toBeGreaterThan(0);
  });

  it("sets all required RateLimit headers", async () => {
    const app = buildApp(10);
    const id = `int-headers-${Date.now()}`;

    const res = await request(app).get("/test").set("x-test-id", id);

    expect(res.headers["x-ratelimit-limit"]).toBe("10");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    expect(res.headers["x-ratelimit-policy"]).toBeDefined();
  });

  it("remaining header decrements on each request", async () => {
    const app = buildApp(5);
    const id = `int-decrement-${Date.now()}`;

    const r1 = await request(app).get("/test").set("x-test-id", id);
    const r2 = await request(app).get("/test").set("x-test-id", id);
    const r3 = await request(app).get("/test").set("x-test-id", id);

    expect(Number(r1.headers["x-ratelimit-remaining"])).toBe(4);
    expect(Number(r2.headers["x-ratelimit-remaining"])).toBe(3);
    expect(Number(r3.headers["x-ratelimit-remaining"])).toBe(2);
  });

  it("different identifiers have independent limits", async () => {
    const app = buildApp(2);
    const idA = `int-iso-a-${Date.now()}`;
    const idB = `int-iso-b-${Date.now()}`;

    // Exhaust idA
    await request(app).get("/test").set("x-test-id", idA);
    await request(app).get("/test").set("x-test-id", idA);
    const blockedA = await request(app).get("/test").set("x-test-id", idA);
    expect(blockedA.status).toBe(429);

    // idB should still be allowed
    const allowedB = await request(app).get("/test").set("x-test-id", idB);
    expect(allowedB.status).toBe(200);
  });

  it("tier resolution controls limit per request", async () => {
    const app = express();
    const limiter = createRedisWall({
      redis,
      strategy: "sliding-window",
      tiers: DEFAULT_TIERS,
      defaultTier: "free",
      identifierFn: (req) => req.headers["x-test-id"] as string,
      tierFn: (req) => {
        const t = req.headers["x-tier"] as string;
        return t === "pro" ? "pro" : "free";
      },
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    const proRes = await request(app)
      .get("/test")
      .set("x-test-id", `tier-pro-${Date.now()}`)
      .set("x-tier", "pro");

    expect(proRes.headers["x-ratelimit-limit"]).toBe("1000");

    const freeRes = await request(app)
      .get("/test")
      .set("x-test-id", `tier-free-${Date.now()}`)
      .set("x-tier", "free");

    expect(freeRes.headers["x-ratelimit-limit"]).toBe("100");
  });
});