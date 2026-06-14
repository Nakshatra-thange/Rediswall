import type {
    CircuitBreakerConfig,
    CircuitBreakerState,
    CircuitState,
  } from "../types";
  
  export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 5,
    cooldownMs: 30_000,
  };
  
  export function createInitialCircuitState(): CircuitBreakerState {
    return {
      state: "CLOSED",
      failureCount: 0,
      lastFailureAt: null,
      nextProbeAt: null,
    };
  }
  
  export class CircuitBreaker {
    private state: CircuitBreakerState;
    private config: CircuitBreakerConfig;
  
    constructor(config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG) {
      this.config = config;
      this.state = createInitialCircuitState();
    }
  
    getState(): CircuitBreakerState {
      return { ...this.state };
    }
  
    isOpen(): boolean {
      // Will contain real transition logic on Day 3
      return this.state.state === "OPEN";
    }
  
    recordSuccess(): void {
      // Day 3: close circuit, reset counters
    }
  
    recordFailure(): void {
      // Day 3: increment counter, open circuit at threshold
    }
  
    shouldProbe(): boolean {
      // Day 3: half-open probe logic
      return false;
    }
  }