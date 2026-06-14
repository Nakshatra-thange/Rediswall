import type { StrategyName, RateLimitStrategy } from "../types";

export { fixedWindow } from "./fixed-window";
export { slidingWindow } from "./sliding-window";
export { tokenBucket } from "./token-bucket";
export { leakyBucket } from "./leaky-bucket";

import { fixedWindow } from "./fixed-window";
import { slidingWindow } from "./sliding-window";
import { tokenBucket } from "./token-bucket";
import { leakyBucket } from "./leaky-bucket";

export const strategies: Record<StrategyName, RateLimitStrategy> = {
  "sliding-window": slidingWindow,
  "fixed-window": fixedWindow,
  "token-bucket": tokenBucket,
  "leaky-bucket": leakyBucket,
};

export function getStrategy(name: StrategyName): RateLimitStrategy {
  const strategy = strategies[name];
  if (!strategy) {
    throw new Error(
      `rediswall: unknown strategy "${name}". Available: ${Object.keys(strategies).join(", ")}`
    );
  }
  return strategy;
}