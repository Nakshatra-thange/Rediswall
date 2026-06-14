import type {
    CircuitBreakerConfig,
    CircuitBreakerState,
    CircuitState,
  } from "../types";
  
  /*
   * Circuit Breaker — three-state machine
   * ──────────────────────────────────────
   *
   *                   5 consecutive failures
   *   CLOSED  ────────────────────────────────►  OPEN
   *      ▲                                          │
   *      │                                          │ 30s cooldown
   *      │                                          ▼
   *      └──── probe succeeds ────────────── HALF_OPEN
   *                                                 │
   *                                                 │ probe fails
   *                                                 ▼
   *                                              OPEN (reset timer)
   *
   * CLOSED   → Redis is healthy. All requests go through normally.
   * OPEN     → Redis is down. Stop calling it entirely. Use fallback.
   *            Prevents hammering a dead service (cascading failure).
   * HALF_OPEN → Cooldown expired. Send exactly ONE probe to Redis.
   *            Success → close circuit. Failure → reopen + reset timer.
   *
   * WHY THIS MATTERS IN PRODUCTION:
   * Without a circuit breaker, every request during a Redis outage waits
   * for a TCP timeout (~30s) before failing. Under load that's thousands
   * of connections hanging, thread pool exhaustion, and your entire API
   * going down because of one dependency. The circuit breaker fails fast
   * (microseconds) and lets the rest of your system keep running.
   *
   * State lives in memory — intentionally.
   * Redis is what's failing, so we can't store circuit state in Redis.
   * Each Node.js instance manages its own circuit independently.
   * In a 3-instance cluster, each instance opens its own circuit when
   * IT experiences failures — no coordination needed.
   */
  
  export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 5,
    cooldownMs: 30_000,
  };
  
  export class CircuitBreaker {
    private config: CircuitBreakerConfig;
    private state: CircuitState = "CLOSED";
    private failureCount: number = 0;
    private lastFailureAt: number | null = null;
    private nextProbeAt: number | null = null;
    private probeInFlight: boolean = false;  // prevents multiple simultaneous probes
  
    constructor(config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG) {
      this.config = config;
    }
  
    // ─── Public read ───────────────────────────────────────────────────────────
  
    getState(): CircuitBreakerState {
      return {
        state: this.state,
        failureCount: this.failureCount,
        lastFailureAt: this.lastFailureAt,
        nextProbeAt: this.nextProbeAt,
      };
    }
  
    /*
     * shouldAllow() is called before every Redis operation.
     * Returns true  → proceed with Redis call
     * Returns false → skip Redis, use fallback immediately
     */
    shouldAllow(): boolean {
      if (this.state === "CLOSED") {
        return true;
      }
  
      if (this.state === "OPEN") {
        if (this.nextProbeAt && Date.now() >= this.nextProbeAt) {
          this.transitionTo("HALF_OPEN");
      
          // reserve the single probe slot
          this.probeInFlight = true;
      
          return true;
        }
      
        return false;
      }
  
      if (this.state === "HALF_OPEN") {
        // Only allow one probe at a time
        // If a probe is already in flight, block everything else
        if (this.probeInFlight) return false;
        this.probeInFlight = true;
        return true;
      }
  
      return false;
    }
  
    // ─── Called by middleware after Redis resolves ──────────────────────────────
  
    recordSuccess(): void {
      if (this.state === "HALF_OPEN") {
        // Probe succeeded — Redis is healthy again
        console.log("[rediswall] circuit closed — Redis recovered");
        this.transitionTo("CLOSED");
      }
      // In CLOSED state, success resets the failure counter
      this.failureCount = 0;
      this.probeInFlight = false;
    }
  
    recordFailure(): void {
      this.lastFailureAt = Date.now();
      this.probeInFlight = false;
  
      if (this.state === "HALF_OPEN") {
        // Probe failed — Redis is still down, reopen and reset timer
        console.log("[rediswall] circuit re-opened — probe failed");
        this.transitionTo("OPEN");
        return;
      }
  
      if (this.state === "CLOSED") {
        this.failureCount++;
        if (this.failureCount >= this.config.failureThreshold) {
          console.log(
            `[rediswall] circuit opened — ${this.failureCount} consecutive failures`
          );
          this.transitionTo("OPEN");
        }
      }
    }
  
    // ─── Private ───────────────────────────────────────────────────────────────
  
    private transitionTo(next: CircuitState): void {
      this.state = next;
  
      if (next === "OPEN") {
        this.nextProbeAt = Date.now() + this.config.cooldownMs;
        this.failureCount = 0;
      }
  
      if (next === "CLOSED") {
        this.failureCount = 0;
        this.lastFailureAt = null;
        this.nextProbeAt = null;
        this.probeInFlight = false;
      }
  
      if (next === "HALF_OPEN") {
        this.probeInFlight = false;
      }
    }
  }
  
  export function createInitialCircuitState(): CircuitBreakerState {
    return {
      state: "CLOSED",
      failureCount: 0,
      lastFailureAt: null,
      nextProbeAt: null,
    };
  }