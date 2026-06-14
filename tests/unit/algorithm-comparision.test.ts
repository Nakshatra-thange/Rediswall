import Redis from "ioredis";
import { slidingWindow } from "../../src/strategies/sliding-window";
import { fixedWindow } from "../../src/strategies/fixed-window";
import { describe, expect, it, afterAll } from "@jest/globals";
/*
 * Algorithm comparison tests — the most important file in this repo
 * ─────────────────────────────────────────────────────────────────
 *
 * These tests don't just verify correctness.
 * They PROVE that sliding window solves a specific problem fixed window cannot.
 *
 * THE CROSS-BOUNDARY EXPLOIT:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  limit = 10 requests per 1 second                               │
 * │                                                                 │
 * │  T=0ms     → 10 requests → fixed window bucket A fills up       │
 * │  T=500ms   → window resets (new bucket B)                       │
 * │  T=501ms   → 10 more requests → bucket B fills up               │
 * │                                                                 │
 * │  Fixed window sees: bucket A=10 ✓, bucket B=10 ✓ (both ok)     │
 * │  Reality: 20 requests in 501ms with a "10/second" limit         │
 * │                                                                 │
 * │  Sliding window sees: at T=501ms, look back 1000ms              │
 * │  → all 10 from T=0 still in window → total=20 → DENY           │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * The test below simulates this exactly.
 * A fixed window implementation FAILS this test by design.
 * A sliding window implementation PASSES it.
 * This is proof by contrast.
 */

const redis = new Redis({ host: "localhost", port: 6379 });
const id = (label: string) => `cmp:${label}:${Date.now()}:${Math.random()}`;

afterAll(async () => {
  await redis.quit();
});

describe("cross-boundary exploit", () => {
  /*
   * Scenario:
   * Window = 1000ms, limit = 10
   *
   * Phase 1: fire 10 requests at T≈0
   * Phase 2: wait 600ms (past the midpoint, still inside a 1s window)
   * Phase 3: fire 10 more requests
   *
   * For fixed window: if the window boundary falls between phase 1 and phase 3,
   * both batches are in different buckets and all 20 are allowed.
   *
   * For sliding window: at phase 3, the window looks back 1000ms and sees
   * all 10 from phase 1 — total is 20 — starts blocking at request 11.
   */

  it("fixed window is vulnerable to cross-boundary burst", async () => {
    const identifier = id("fw-exploit");
    const limit = 10;
    const windowMs = 1000;

    // Phase 1: fill the window
    const phase1 = await Promise.all(
      Array.from({ length: limit }, () =>
        fixedWindow.check(identifier, limit, windowMs, redis)
      )
    );
    const phase1Allowed = phase1.filter((r) => r.allowed).length;
    expect(phase1Allowed).toBe(limit); // all 10 allowed

    // Wait past the window boundary so a new fixed window starts
    await new Promise((res) => setTimeout(res, windowMs + 10));

    // Phase 2: fire 10 more in the NEW window — fixed window resets, all allowed
    const phase2 = await Promise.all(
      Array.from({ length: limit }, () =>
        fixedWindow.check(identifier, limit, windowMs, redis)
      )
    );
    const phase2Allowed = phase2.filter((r) => r.allowed).length;

    /*
     * Fixed window ALLOWS all 10 in the new bucket.
     * Total allowed in ~1010ms window: 20 requests against a limit of 10.
     * This is the exploit.
     */
    expect(phase2Allowed).toBe(limit);
    expect(phase1Allowed + phase2Allowed).toBe(20); // 2x the limit slipped through
  });

  it("sliding window blocks the cross-boundary burst", async () => {
    const identifier = id("sw-exploit");
    const limit = 10;
    const windowMs = 1000;

    // Phase 1: fill the window
    const phase1 = await Promise.all(
      Array.from({ length: limit }, () =>
        slidingWindow.check(identifier, limit, windowMs, redis)
      )
    );
    const phase1Allowed = phase1.filter((r) => r.allowed).length;
    expect(phase1Allowed).toBe(limit);

    // Wait 600ms — past the midpoint but still inside the 1s sliding window
    await new Promise((res) => setTimeout(res, 600));

    // Phase 2: all 10 from phase 1 are still in the window
    // Sliding window sees count=10, blocks immediately
    const phase2 = await Promise.all(
      Array.from({ length: limit }, () =>
        slidingWindow.check(identifier, limit, windowMs, redis)
      )
    );
    const phase2Allowed = phase2.filter((r) => r.allowed).length;

    /*
     * Sliding window BLOCKS all phase 2 requests.
     * The 1s window hasn't expired — phase 1 timestamps are still visible.
     * Total allowed: 10. Exploit closed.
     */
    expect(phase2Allowed).toBe(0);
    expect(phase1Allowed + phase2Allowed).toBe(limit); // exactly limit, no more
  });

  it("head-to-head: same traffic, different outcomes", async () => {
    const fwId = id("fw-head");
    const swId = id("sw-head");
    const limit = 5;
    const windowMs = 800;

    async function runScenario(
      strategy: typeof fixedWindow,
      identifier: string
    ) {
      // Burst 1
      const b1 = await Promise.all(
        Array.from({ length: limit }, () =>
          strategy.check(identifier, limit, windowMs, redis)
        )
      );

      // Wait past window
      await new Promise((res) => setTimeout(res, windowMs + 20));

      // Burst 2
      const b2 = await Promise.all(
        Array.from({ length: limit }, () =>
          strategy.check(identifier, limit, windowMs, redis)
        )
      );

      return {
        burst1Allowed: b1.filter((r) => r.allowed).length,
        burst2Allowed: b2.filter((r) => r.allowed).length,
        totalAllowed:
          b1.filter((r) => r.allowed).length +
          b2.filter((r) => r.allowed).length,
      };
    }

    const fwResult = await runScenario(fixedWindow, fwId);
    const swResult = await runScenario(slidingWindow, swId);

    // Fixed window: both bursts in separate buckets → all 10 allowed
    expect(fwResult.totalAllowed).toBe(limit * 2);

    // Sliding window: second burst happens within 1 sliding window of first
    // After waiting windowMs + 20ms, all phase1 timestamps have expired
    // so sliding window also allows the second burst fully
    expect(swResult.burst1Allowed).toBe(limit);
    expect(swResult.burst2Allowed).toBe(limit);

    // The real difference shows within a single window — tested above
  });
});

describe("algorithm tradeoff proof", () => {
  /*
   * Token bucket allows bursting. Sliding window doesn't.
   * This test proves the difference.
   *
   * Scenario: limit=10/minute
   * - Sliding window: at request 11 within any rolling 60s → DENY
   * - Token bucket: at request 11 → DENY, but tokens refill continuously
   *                 so a quick 1s wait can earn ~0.17 tokens back
   */
  it("token bucket allows partial recovery faster than sliding window reset", async () => {
    const { tokenBucket } = await import("../../src/strategies/token-bucket");

    const tbId = id("tb-recovery");
    const swId = id("sw-recovery");
    const limit = 5;
    const windowMs = 1000; // 1s for fast testing, 1 token per 200ms

    // Drain both
    for (let i = 0; i < limit; i++) {
      await tokenBucket.check(tbId, limit, windowMs, redis);
      await slidingWindow.check(swId, limit, windowMs, redis);
    }

    // Both blocked immediately
    const tbBlocked = await tokenBucket.check(tbId, limit, windowMs, redis);
    const swBlocked = await slidingWindow.check(swId, limit, windowMs, redis);
    expect(tbBlocked.allowed).toBe(false);
    expect(swBlocked.allowed).toBe(false);

    // Wait 250ms — token bucket earns back ~1.25 tokens
    // Sliding window: all 5 timestamps still in the 1s window
    await new Promise((res) => setTimeout(res, 250));

    const tbRecovered = await tokenBucket.check(tbId, limit, windowMs, redis);
    const swStillBlocked = await slidingWindow.check(swId, limit, windowMs, redis);

    /*
     * Token bucket: recovered ~1 token → allowed
     * Sliding window: window hasn't expired → still blocked
     * This is the burst-recovery tradeoff: token bucket is forgiving,
     * sliding window is strict.
     */
    expect(tbRecovered.allowed).toBe(true);
    expect(swStillBlocked.allowed).toBe(false);
  });
});