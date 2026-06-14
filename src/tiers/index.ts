import type { TierMap, TierConfig, TierName } from "../types";

export const DEFAULT_TIERS: TierMap = {
  free: {
    name: "free",
    limit: 100,
    windowMs: 60_000,
  },
  pro: {
    name: "pro",
    limit: 1000,
    windowMs: 60_000,
  },
  enterprise: {
    name: "enterprise",
    limit: 10_000,
    windowMs: 60_000,
  },
};

export function resolveTier(
  tierName: TierName,
  tiers: TierMap
): TierConfig {
  const tier = tiers[tierName];
  if (!tier) {
    throw new Error(
      `rediswall: unknown tier "${tierName}". Available: ${Object.keys(tiers).join(", ")}`
    );
  }
  return tier;
}