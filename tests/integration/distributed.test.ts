import Redis from "ioredis";
import { slidingWindow } from "../../src/strategies/sliding-window";
import { describe, expect, it, afterAll } from "@jest/globals";
/*
 * Distributed correctness
 * ────────────────────────
 * Simulates 3 Node.js instances by creating 3 separate ioredis clients,
 * all pointing at the same Redis instance.
 *
 * In production, each Node.js process would have its own Redis client.
 * The rate limit state lives entirely in Redis — shared across all instances.
 *
 * What we're proving:
 * It doesn't matter WHICH instance handles the request.
 * The limit is enforced globally because the Lua script runs in Redis,
 * not in Node.js memory.
 *
 * If we used in-memory counters instead of Redis, each instance would
 * allow the full limit independently → 3 instances = 3x the limit.
 * This test would fail in that scenario.
 */

const instance1 = new Redis({ host: "localhost", port: 6379 });
const instance2 = new Redis({ host: "localhost", port: 6379 });
const instance3 = new Redis({ host: "localhost", port: 6379 });

afterAll(async () => {
  await instance1.quit();
  await instance2.quit();
  await instance3.quit();
});

describe("distributed rate limiting", () => {
  it("shared limit holds across 3 Redis clients", async () => {
    const identifier = `dist:${Date.now()}`;
    const limit = 30;
    const windowMs = 60_000;

    // Fire 10 requests through each "instance" simultaneously
    const [r1, r2, r3] = await Promise.all([
      Promise.all(
        Array.from({ length: 10 }, () =>
          slidingWindow.check(identifier, limit, windowMs, instance1)
        )
      ),
      Promise.all(
        Array.from({ length: 10 }, () =>
          slidingWindow.check(identifier, limit, windowMs, instance2)
        )
      ),
      Promise.all(
        Array.from({ length: 10 }, () =>
          slidingWindow.check(identifier, limit, windowMs, instance3)
        )
      ),
    ]);

    const allResults = [...r1, ...r2, ...r3];
    const totalAllowed = allResults.filter((r) => r.allowed).length;
    const totalDenied = allResults.filter((r) => !r.allowed).length;

    /*
     * Total requests: 30 (10 per instance)
     * Expected allowed: exactly 30 (the limit)
     * Expected denied: 0 (we sent exactly the limit)
     *
     * If each instance had its own counter, each would allow 30 → 90 total.
     * Shared Redis state means the global count is 30.
     */
    expect(totalAllowed).toBe(limit);
    expect(totalDenied).toBe(0);
    expect(allResults.length).toBe(limit);
  });

  it("blocks correctly when traffic exceeds limit across instances", async () => {
    const identifier = `dist-overflow:${Date.now()}`;
    const limit = 20;
    const windowMs = 60_000;

    // Send 40 requests (2x the limit) spread across 3 instances
    const [r1, r2, r3] = await Promise.all([
      Promise.all(
        Array.from({ length: 15 }, () =>
          slidingWindow.check(identifier, limit, windowMs, instance1)
        )
      ),
      Promise.all(
        Array.from({ length: 15 }, () =>
          slidingWindow.check(identifier, limit, windowMs, instance2)
        )
      ),
      Promise.all(
        Array.from({ length: 10 }, () =>
          slidingWindow.check(identifier, limit, windowMs, instance3)
        )
      ),
    ]);

    const allResults = [...r1, ...r2, ...r3];
    const totalAllowed = allResults.filter((r) => r.allowed).length;
    const totalDenied = allResults.filter((r) => !r.allowed).length;

    expect(totalAllowed).toBe(limit);         // exactly 20 allowed globally
    expect(totalDenied).toBe(40 - limit);     // 20 denied
    expect(totalAllowed + totalDenied).toBe(40);
  });

  it("instance 1 traffic counts against instance 2 quota", async () => {
    const identifier = `dist-cross:${Date.now()}`;
    const limit = 5;
    const windowMs = 60_000;

    // Exhaust limit entirely through instance 1
    for (let i = 0; i < limit; i++) {
      const r = await slidingWindow.check(identifier, limit, windowMs, instance1);
      expect(r.allowed).toBe(true);
    }

    // Instance 2 should be blocked immediately — sees the same Redis state
    const blocked = await slidingWindow.check(
      identifier,
      limit,
      windowMs,
      instance2
    );

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("different identifiers are isolated across instances", async () => {
    const idA = `dist-iso-a:${Date.now()}`;
    const idB = `dist-iso-b:${Date.now()}`;
    const limit = 3;
    const windowMs = 60_000;

    // Exhaust idA through instance 1
    for (let i = 0; i < limit; i++) {
      await slidingWindow.check(idA, limit, windowMs, instance1);
    }

    // idB through instance 2 should be unaffected
    const r = await slidingWindow.check(idB, limit, windowMs, instance2);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(limit - 1);
  });
});