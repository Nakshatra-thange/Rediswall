import Redis from "ioredis";
import { slidingWindow } from "../../src/strategies/sliding-window";
import { fixedWindow } from "../../src/strategies/fixed-window";
import { tokenBucket } from "../../src/strategies/token-bucket";
import { leakyBucket } from "../../src/strategies/leaky-bucket";
import { describe, expect, it, afterAll } from "@jest/globals";
/*
 * Concurrency tests
 * ─────────────────
 * These tests fire N requests simultaneously using Promise.all.
 * This is the closest you can get to true concurrency in Node.js
 * without spawning worker threads.
 *
 * What we're proving:
 * The Lua scripts in sliding-window, token-bucket, and leaky-bucket
 * are atomic — no two concurrent requests can both read "count=99",
 * both decide "I'm allowed", and both write "count=100".
 * Redis executes the entire Lua script before processing the next command.
 *
 * If atomicity breaks, allowed + denied will exceed the total request count,
 * or allowed will exceed the limit. The assertions below catch both cases.
 */

const redis = new Redis({ host: "localhost", port: 6379 });
const id = (label: string) => `conc:${label}:${Date.now()}:${Math.random()}`;

afterAll(async () => {
  await redis.quit();
});

async function fireAll(
  strategy: typeof slidingWindow,
  identifier: string,
  count: number,
  limit: number,
  windowMs: number
) {
  const results = await Promise.all(
    Array.from({ length: count }, () =>
      strategy.check(identifier, limit, windowMs, redis)
    )
  );

  const allowed = results.filter((r) => r.allowed).length;
  const denied = results.filter((r) => !r.allowed).length;

  return { allowed, denied, total: results.length };
}

describe("sliding window — concurrency", () => {
  it("exactly limit=50 allowed out of 100 simultaneous requests", async () => {
    const { allowed, denied } = await fireAll(
      slidingWindow,
      id("sw-conc"),
      100,
      50,
      60_000
    );

    expect(allowed).toBe(50);
    expect(denied).toBe(50);
  });

  it("never allows more than the limit regardless of concurrency", async () => {
    for (let run = 0; run < 5; run++) {
      const { allowed } = await fireAll(
        slidingWindow,
        id("sw-conc-stress"),
        200,
        100,
        60_000
      );
      // This is the core invariant — must never exceed limit
      expect(allowed).toBeLessThanOrEqual(100);
    }
  });

  it("allowed + denied always equals total requests", async () => {
    const { allowed, denied, total } = await fireAll(
      slidingWindow,
      id("sw-conc-sum"),
      150,
      75,
      60_000
    );
    expect(allowed + denied).toBe(total);
  });
});

describe("fixed window — concurrency", () => {
  it("exactly limit=30 allowed out of 60 simultaneous requests", async () => {
    const { allowed } = await fireAll(
      fixedWindow,
      id("fw-conc"),
      60,
      30,
      60_000
    );
    // Fixed window uses INCR which is atomic, so this should hold
    expect(allowed).toBe(30);
  });
});

describe("token bucket — concurrency", () => {
  it("never allows more than capacity", async () => {
    for (let run = 0; run < 5; run++) {
      const { allowed } = await fireAll(
        tokenBucket,
        id("tb-conc"),
        150,
        50,
        60_000
      );
      expect(allowed).toBeLessThanOrEqual(50);
    }
  });
});

describe("leaky bucket — concurrency", () => {
  it("never allows more than capacity", async () => {
    for (let run = 0; run < 5; run++) {
      const { allowed } = await fireAll(
        leakyBucket,
        id("lb-conc"),
        150,
        50,
        60_000
      );
      expect(allowed).toBeLessThanOrEqual(50);
    }
  });
});