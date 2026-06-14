import { CircuitBreaker } from "../../src/circuit-breaker";
import { describe, expect, it, afterAll } from "@jest/globals";
describe("CircuitBreaker state machine", () => {
  // ── CLOSED → OPEN ───────────────────────────────────────────────────────────

  it("starts CLOSED", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(cb.getState().state).toBe("CLOSED");
    expect(cb.shouldAllow()).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState().state).toBe("CLOSED"); // not yet
    cb.recordFailure();
    expect(cb.getState().state).toBe("OPEN");   // threshold hit
  });

  it("blocks all requests when OPEN", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure();
    expect(cb.getState().state).toBe("OPEN");
    expect(cb.shouldAllow()).toBe(false);
    expect(cb.shouldAllow()).toBe(false);
  });

  it("sets nextProbeAt when opening", () => {
    const before = Date.now();
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000 });
    cb.recordFailure();
    const state = cb.getState();
    expect(state.nextProbeAt).toBeGreaterThanOrEqual(before + 5000);
  });

  // ── OPEN → HALF_OPEN ────────────────────────────────────────────────────────

  it("transitions to HALF_OPEN after cooldown", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    cb.recordFailure();
    expect(cb.getState().state).toBe("OPEN");

    await new Promise((res) => setTimeout(res, 120));

    // shouldAllow() triggers the OPEN → HALF_OPEN transition
    expect(cb.shouldAllow()).toBe(true);
    expect(cb.getState().state).toBe("HALF_OPEN");
  });

  it("allows only one probe in HALF_OPEN, blocks subsequent requests", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure();
    await new Promise((res) => setTimeout(res, 60));

    const probe = cb.shouldAllow();     // first call → probe
    const blocked = cb.shouldAllow();   // second call → blocked

    expect(probe).toBe(true);
    expect(blocked).toBe(false);
  });

  // ── HALF_OPEN → CLOSED ──────────────────────────────────────────────────────

  it("closes circuit when probe succeeds", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure();
    await new Promise((res) => setTimeout(res, 60));

    cb.shouldAllow(); // enter HALF_OPEN
    cb.recordSuccess();

    expect(cb.getState().state).toBe("CLOSED");
    expect(cb.getState().failureCount).toBe(0);
    expect(cb.shouldAllow()).toBe(true);
  });

  // ── HALF_OPEN → OPEN ────────────────────────────────────────────────────────

  it("reopens circuit when probe fails", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure();
    await new Promise((res) => setTimeout(res, 60));

    cb.shouldAllow(); // enter HALF_OPEN
    cb.recordFailure();

    expect(cb.getState().state).toBe("OPEN");
    expect(cb.shouldAllow()).toBe(false);
  });

  // ── Success resets failure count ─────────────────────────────────────────────

  it("resets failure count on success in CLOSED state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState().failureCount).toBe(3);

    cb.recordSuccess();
    expect(cb.getState().failureCount).toBe(0);
    expect(cb.getState().state).toBe("CLOSED");
  });
});