import express from "express";
import request from "supertest";
import Redis from "ioredis";
import { createRedisWall } from "../../src";
import { describe, expect, it, afterAll } from "@jest/globals";
/*
 * Failure mode tests
 * ──────────────────
 * These tests simulate Redis going down mid-flight and verify
 * that rediswall responds correctly in every failure scenario.
 *
 * We use a mock Redis client that throws on command, simulating
 * a connection timeout or network partition. This lets us test
 * failure modes without actually killing Redis.
 */

// ── Mock Redis that throws on every command ───────────────────────────────────

function createBrokenRedis(): Redis {
  const mock = new Redis({ lazyConnect: true });

  // Override every method that our strategies call
  const throwFn = () => {
    throw new Error("ECONNREFUSED: Redis connection refused");
  };

  mock.eval = throwFn as never;
  mock.incr = throwFn as never;
  mock.pexpire = throwFn as never;
  mock.hmget = throwFn as never;
  mock.hmset = throwFn as never;

  return mock;
}

// ── Mock Redis that succeeds after N calls ────────────────────────────────────

function createFlakyRedis(failCount: number): Redis {
  const real = new Redis({ host: "localhost", port: 6379 });
  let calls = 0;

  const originalEval = real.eval.bind(real);
  real.eval = ((...args: Parameters<Redis["eval"]>) => {
    calls++;
    if (calls <= failCount) {
      throw new Error("Simulated transient failure");
    }
    return originalEval(...args);
  }) as never;

  return real;
}

const healthyRedis = new Redis({ host: "localhost", port: 6379 });

afterAll(async () => {
  await healthyRedis.quit();
});

// ── fail-open behaviour ───────────────────────────────────────────────────────

describe("fail-open (default behaviour)", () => {
    it("uses fallback rate limiting when Redis is completely down", async () => {
        const app = express();
      
        const limiter = createRedisWall({
          redis: createBrokenRedis(),
          strategy: "sliding-window",
          tiers: {
            default: {
              name: "default",
              limit: 5,
              windowMs: 60_000,
            },
          },
          defaultTier: "default",
          failOpen: true,
          circuitBreaker: {
            failureThreshold: 3,
            cooldownMs: 60_000,
          },
          identifierFn: () => "fallback-user",
        });
      
        app.get("/test", limiter, (_req, res) => res.json({ ok: true }));
      
        const responses = await Promise.all(
          Array.from({ length: 10 }, () => request(app).get("/test"))
        );
      
        const successCount = responses.filter(
          (r) => r.status === 200
        ).length;
      
        const blockedCount = responses.filter(
          (r) => r.status === 429
        ).length;
      
        expect(successCount).toBeGreaterThan(0);
        expect(blockedCount).toBeGreaterThan(0);
      
        // failOpen=true should never return 503
        expect(
          responses.every((r) => r.status !== 503)
        ).toBe(true);
      });

  it("in-memory fallback still enforces limits when circuit is open", async () => {
    const app = express();
    const limiter = createRedisWall({
      redis: createBrokenRedis(),
      strategy: "sliding-window",
      tiers: { default: { name: "default", limit: 3, windowMs: 60_000 } },
      defaultTier: "default",
      failOpen: true,
      // Open circuit immediately — threshold=1 means first failure opens it
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      identifierFn: (req) => (req.headers["x-id"] as string) ?? "test",
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    const id = `fallback-limit-${Date.now()}`;

    // Allow 3 (limit)
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/test").set("x-id", id);
      expect(res.status).toBe(200);
    }

    // 4th should be blocked by in-memory fallback
    const blocked = await request(app).get("/test").set("x-id", id);
    expect(blocked.status).toBe(429);
  });

  it("does not crash the server when Redis throws", async () => {
    const app = express();
    const limiter = createRedisWall({
      redis: createBrokenRedis(),
      strategy: "sliding-window",
      tiers: { default: { name: "default", limit: 100, windowMs: 60_000 } },
      defaultTier: "default",
      failOpen: true,
      circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 },
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    // Fire 20 requests — none should throw a 500
    const results = await Promise.all(
      Array.from({ length: 20 }, () => request(app).get("/test"))
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s !== 500)).toBe(true);
  });
});

// ── fail-closed behaviour ─────────────────────────────────────────────────────

describe("fail-closed", () => {
  it("returns 503 when Redis is down and failOpen=false", async () => {
    const app = express();
    const limiter = createRedisWall({
      redis: createBrokenRedis(),
      strategy: "sliding-window",
      tiers: { default: { name: "default", limit: 100, windowMs: 60_000 } },
      defaultTier: "default",
      failOpen: false,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    // All requests should get 503 (not 500, not 429)
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/test");
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("Service temporarily unavailable");
    }
  });
});

// ── circuit breaker integration with real Redis ───────────────────────────────

describe("circuit breaker integration", () => {
  it("opens after threshold failures then uses fallback", async () => {
    const circuitOpened: boolean[] = [];

    const app = express();
    const limiter = createRedisWall({
      redis: createBrokenRedis(),
      strategy: "sliding-window",
      tiers: { default: { name: "default", limit: 100, windowMs: 60_000 } },
      defaultTier: "default",
      failOpen: true,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
      onCircuitOpen: () => circuitOpened.push(true),
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    // Fire enough requests to trip the circuit
    await Promise.all(
      Array.from({ length: 10 }, () => request(app).get("/test"))
    );

    // Circuit should have opened exactly once
    expect(circuitOpened.length).toBeGreaterThanOrEqual(1);
  });

  it("recovers after cooldown when Redis comes back", async () => {
    /*
     * This test simulates a Redis outage and recovery.
     * We use a flaky Redis that fails 3 times then recovers.
     */
    const flakyRedis = createFlakyRedis(3);
    const app = express();

    const limiter = createRedisWall({
      redis: flakyRedis,
      strategy: "sliding-window",
      tiers: { default: { name: "default", limit: 100, windowMs: 60_000 } },
      defaultTier: "default",
      failOpen: true,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 200 }, // short cooldown for test
      identifierFn: () => `recovery-test-${Date.now()}`,
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    // Phase 1: 3 failures open the circuit
    for (let i = 0; i < 5; i++) {
      await request(app).get("/test");
    }

    // Phase 2: wait for cooldown
    await new Promise((res) => setTimeout(res, 250));

    // Phase 3: probe fires, Redis now healthy → circuit closes
    const recovery = await request(app).get("/test");
    expect(recovery.status).toBe(200);

    await flakyRedis.quit();
  });
});

// ── onLimitReached and onCircuitOpen callbacks ────────────────────────────────

describe("callbacks", () => {
  it("calls onLimitReached when a request is denied", async () => {
    const limitReachedCalls: string[] = [];

    const app = express();
    const limiter = createRedisWall({
      redis: healthyRedis,
      strategy: "sliding-window",
      tiers: { default: { name: "default", limit: 2, windowMs: 60_000 } },
      defaultTier: "default",
      identifierFn: (req) => (req.headers["x-id"] as string) ?? "test",
      onLimitReached: (req) => {
        limitReachedCalls.push(req.headers["x-id"] as string);
      },
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    const id = `cb-${Date.now()}`;
    await request(app).get("/test").set("x-id", id);
    await request(app).get("/test").set("x-id", id);

    // 3rd request triggers the callback
    await request(app).get("/test").set("x-id", id);

    expect(limitReachedCalls).toContain(id);
  });

  it("calls onCircuitOpen when circuit opens", async () => {
    const openCalls: number[] = [];

    const app = express();
    const limiter = createRedisWall({
      redis: createBrokenRedis(),
      strategy: "sliding-window",
      tiers: { default: { name: "default", limit: 100, windowMs: 60_000 } },
      defaultTier: "default",
      failOpen: true,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
      onCircuitOpen: (state) => openCalls.push(state.failureCount),
    });

    app.get("/test", limiter, (_req, res) => res.json({ ok: true }));

    await Promise.all(
      Array.from({ length: 5 }, () => request(app).get("/test"))
    );

    expect(openCalls.length).toBeGreaterThanOrEqual(1);
  });
});