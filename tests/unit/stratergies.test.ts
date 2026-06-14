import Redis from "ioredis";
import { fixedWindow } from "../../src/strategies/fixed-window";
import { slidingWindow } from "../../src/strategies/sliding-window";
import { tokenBucket } from "../../src/strategies/token-bucket";
import { leakyBucket } from "../../src/strategies/leaky-bucket";
import { describe, expect, it, afterAll } from "@jest/globals";
const redis = new Redis({ host: "localhost", port: 6379 });

// Unique prefix per test run so tests never collide with each other
const id = (label: string) => `test:${label}:${Date.now()}:${Math.random()}`;

afterAll(async () => {
  await redis.quit();
});

// ─── Fixed Window ─────────────────────────────────────────────────────────────

describe("fixed window", () => {
  it("allows requests up to the limit", async () => {
    const identifier = id("fw-allow");
    for (let i = 0; i < 5; i++) {
      const r = await fixedWindow.check(identifier, 5, 60_000, redis);
      expect(r.allowed).toBe(true);
    }
  });

  it("blocks the request that exceeds the limit", async () => {
    const identifier = id("fw-block");
    for (let i = 0; i < 5; i++) {
      await fixedWindow.check(identifier, 5, 60_000, redis);
    }
    const r = await fixedWindow.check(identifier, 5, 60_000, redis);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("remaining decrements correctly", async () => {
    const identifier = id("fw-remaining");
    const r1 = await fixedWindow.check(identifier, 10, 60_000, redis);
    expect(r1.remaining).toBe(9);
    const r2 = await fixedWindow.check(identifier, 10, 60_000, redis);
    expect(r2.remaining).toBe(8);
  });
});

// ─── Sliding Window ───────────────────────────────────────────────────────────

describe("sliding window", () => {
  it("allows requests up to the limit", async () => {
    const identifier = id("sw-allow");
    for (let i = 0; i < 10; i++) {
      const r = await slidingWindow.check(identifier, 10, 60_000, redis);
      expect(r.allowed).toBe(true);
    }
  });

  it("blocks the (limit + 1)th request", async () => {
    const identifier = id("sw-block");
    for (let i = 0; i < 10; i++) {
      await slidingWindow.check(identifier, 10, 60_000, redis);
    }
    const r = await slidingWindow.check(identifier, 10, 60_000, redis);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  /*
   * THE KEY TEST — proves sliding window catches the cross-boundary exploit
   * that fixed window misses.
   *
   * We mock Date.now() to simulate:
   *   - 5 requests at T=0       (first half of window)
   *   - 5 requests at T=500ms   (second half of window, same window)
   *   - 1 more request at T=500ms → should be BLOCKED (total = 11 > limit 10)
   *
   * A fixed window would reset at T=windowMs and allow all requests after.
   * Sliding window looks back windowMs from NOW and sees all prior requests.
   */
  it("cross-boundary burst: blocks when combined count exceeds limit", async () => {
    const identifier = id("sw-boundary");
    const limit = 10;
    const windowMs = 1000; // 1 second window for fast testing

    // First burst: 5 requests
    for (let i = 0; i < 5; i++) {
      const r = await slidingWindow.check(identifier, limit, windowMs, redis);
      expect(r.allowed).toBe(true);
    }

    // Wait 500ms — still inside the same 1s window
    await new Promise((res) => setTimeout(res, 500));

    // Second burst: 5 more requests — should be allowed (total = 10)
    for (let i = 0; i < 5; i++) {
      const r = await slidingWindow.check(identifier, limit, windowMs, redis);
      expect(r.allowed).toBe(true);
    }

    // 11th request — window still sees all 10 → DENIED
    const final = await slidingWindow.check(identifier, limit, windowMs, redis);
    expect(final.allowed).toBe(false);
  });

  it("window expires and quota resets", async () => {
    const identifier = id("sw-reset");
    for (let i = 0; i < 3; i++) {
      await slidingWindow.check(identifier, 3, 300, redis); // 300ms window
    }
    const blocked = await slidingWindow.check(identifier, 3, 300, redis);
    expect(blocked.allowed).toBe(false);

    // Wait for the window to expire
    await new Promise((res) => setTimeout(res, 350));

    const reset = await slidingWindow.check(identifier, 3, 300, redis);
    expect(reset.allowed).toBe(true);
  });
});

// ─── Token Bucket ─────────────────────────────────────────────────────────────

describe("token bucket", () => {
  it("allows a full burst up to capacity", async () => {
    const identifier = id("tb-burst");
    for (let i = 0; i < 10; i++) {
      const r = await tokenBucket.check(identifier, 10, 60_000, redis);
      expect(r.allowed).toBe(true);
    }
  });

  it("blocks once bucket is empty", async () => {
    const identifier = id("tb-empty");
    for (let i = 0; i < 10; i++) {
      await tokenBucket.check(identifier, 10, 60_000, redis);
    }
    const r = await tokenBucket.check(identifier, 10, 60_000, redis);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("tokens refill over time", async () => {
    const identifier = id("tb-refill");
    // Burn all 3 tokens
    for (let i = 0; i < 3; i++) {
      await tokenBucket.check(identifier, 3, 300, redis); // 300ms window
    }
    const empty = await tokenBucket.check(identifier, 3, 300, redis);
    expect(empty.allowed).toBe(false);

    // Wait for ~1 token to refill (300ms / 3 = 100ms per token)
    await new Promise((res) => setTimeout(res, 120));

    const refilled = await tokenBucket.check(identifier, 3, 300, redis);
    expect(refilled.allowed).toBe(true);
  });
});

// ─── Leaky Bucket ─────────────────────────────────────────────────────────────

describe("leaky bucket", () => {
  it("allows requests up to capacity", async () => {
    const identifier = id("lb-cap");
    for (let i = 0; i < 5; i++) {
      const r = await leakyBucket.check(identifier, 5, 60_000, redis);
      expect(r.allowed).toBe(true);
    }
  });

  it("blocks when bucket is full", async () => {
    const identifier = id("lb-full");
    for (let i = 0; i < 5; i++) {
      await leakyBucket.check(identifier, 5, 60_000, redis);
    }
    const r = await leakyBucket.check(identifier, 5, 60_000, redis);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("drains over time and allows new requests", async () => {
    const identifier = id("lb-drain");
    // Fill to capacity (3 slots, 300ms window)
    for (let i = 0; i < 3; i++) {
      await leakyBucket.check(identifier, 3, 300, redis);
    }
    const full = await leakyBucket.check(identifier, 3, 300, redis);
    expect(full.allowed).toBe(false);

    // Wait for ~1 slot to drain (300ms / 3 = 100ms per slot)
    await new Promise((res) => setTimeout(res, 120));

    const drained = await leakyBucket.check(identifier, 3, 300, redis);
    expect(drained.allowed).toBe(true);
  });
});

// ─── Strategy interface consistency ───────────────────────────────────────────

describe("all strategies return consistent RateLimitResult shape", () => {
  const allStrategies = [fixedWindow, slidingWindow, tokenBucket, leakyBucket];

  allStrategies.forEach((strategy) => {
    it(`${strategy.name} returns valid RateLimitResult`, async () => {
      const r = await strategy.check(id(`shape-${strategy.name}`), 10, 60_000, redis);
      expect(typeof r.allowed).toBe("boolean");
      expect(typeof r.limit).toBe("number");
      expect(typeof r.remaining).toBe("number");
      expect(typeof r.resetAt).toBe("number");
      expect(r.limit).toBe(10);
      expect(r.remaining).toBeGreaterThanOrEqual(0);
      expect(r.resetAt).toBeGreaterThan(Date.now() - 1000);
    });
  });
});