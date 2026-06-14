import type { RateLimitStrategy } from "../types";

export const slidingWindow: RateLimitStrategy = {
  name: "sliding-window",
  async check(_identifier, _limit, _windowMs, _redis) {
    throw new Error("sliding-window: not yet implemented");
  },
};

export const fixedWindow: RateLimitStrategy = {
  name: "fixed-window",
  async check(_identifier, _limit, _windowMs, _redis) {
    throw new Error("fixed-window: not yet implemented");
  },
};

export const tokenBucket: RateLimitStrategy = {
  name: "token-bucket",
  async check(_identifier, _limit, _windowMs, _redis) {
    throw new Error("token-bucket: not yet implemented");
  },
};

export const leakyBucket: RateLimitStrategy = {
  name: "leaky-bucket",
  async check(_identifier, _limit, _windowMs, _redis) {
    throw new Error("leaky-bucket: not yet implemented");
  },
};

export const strategies: Record<string, RateLimitStrategy> = {
  "sliding-window": slidingWindow,
  "fixed-window": fixedWindow,
  "token-bucket": tokenBucket,
  "leaky-bucket": leakyBucket,
};