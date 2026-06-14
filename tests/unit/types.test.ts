import { DEFAULT_TIERS, resolveTier } from "../../src/tiers";
import { createInitialCircuitState } from "../../src/circuit-breaker";
import { strategies } from "../../src/strategies";
import { describe, expect, it } from "@jest/globals";
describe("rediswall scaffold", () => {
  it("default tiers resolve correctly", () => {
    const free = resolveTier("free", DEFAULT_TIERS);
    expect(free.limit).toBe(100);
    expect(free.windowMs).toBe(60_000);

    const pro = resolveTier("pro", DEFAULT_TIERS);
    expect(pro.limit).toBe(1000);

    const enterprise = resolveTier("enterprise", DEFAULT_TIERS);
    expect(enterprise.limit).toBe(10_000);
  });

  it("throws on unknown tier", () => {
    expect(() => resolveTier("ghost", DEFAULT_TIERS)).toThrow(
      'unknown tier "ghost"'
    );
  });

  it("circuit breaker initialises as CLOSED", () => {
    const state = createInitialCircuitState();
    expect(state.state).toBe("CLOSED");
    expect(state.failureCount).toBe(0);
    expect(state.lastFailureAt).toBeNull();
  });

  it("all four strategies are registered", () => {
    const names = Object.keys(strategies);
    expect(names).toContain("sliding-window");
    expect(names).toContain("fixed-window");
    expect(names).toContain("token-bucket");
    expect(names).toContain("leaky-bucket");
  });
});