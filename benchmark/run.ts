import Redis from "ioredis";
import express from "express";
import { createServer } from "http";
import { createRedisWall } from "../src";
import type { StrategyName } from "../src";

const autocannon = require("autocannon");

const redis = new Redis({ host: "localhost", port: 6379 });

interface BenchmarkResult {
  strategy: StrategyName;
  requestsPerSec: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  totalRequests: number;
  allowed: number;
  denied: number;
}

async function benchmarkStrategy(
  strategy: StrategyName,
  duration = 5
): Promise<BenchmarkResult> {
  const app = express();

  let allowed = 0;
  let denied = 0;

  const limiter = createRedisWall({
    redis,
    strategy,
    tiers: {
      bench: {
        name: "bench",
        limit: 1000,
        windowMs: 60_000,
      },
    },
    defaultTier: "bench",
    identifierFn: () => "benchmark-user",
    onLimitReached: () => denied++,
  });

  app.get("/bench", limiter, (_req, res) => {
    allowed++;
    res.json({ ok: true });
  });

  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const port = (server.address() as { port: number }).port;

  return new Promise<BenchmarkResult>((resolve, reject) => {
    const instance = autocannon(
      {
        url: `http://localhost:${port}/bench`,
        connections: 10,
        duration,
        silent: true,
      },
      (err: Error | null, result: any) => {
        server.close();

        if (err) {
          reject(err);
          return;
        }

        resolve({
          strategy,
          requestsPerSec: Math.round(result.requests.average),
          latencyP50: result.latency.p50,
          latencyP95: result.latency.p95,
          latencyP99: result.latency.p99,
          totalRequests: result.requests.total,
          allowed,
          denied,
        });
      }
    );

    autocannon.track(instance, {
      renderProgressBar: false,
    });
  });
}

async function run(): Promise<void> {
  const strategies: StrategyName[] = [
    "fixed-window",
    "sliding-window",
    "token-bucket",
    "leaky-bucket",
  ];

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║               rediswall — algorithm benchmark              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log("10 connections · 5s per strategy · limit: 1000/min\n");

  const results: BenchmarkResult[] = [];

  for (const strategy of strategies) {
    process.stdout.write(`Running ${strategy.padEnd(20)}`);

    const result = await benchmarkStrategy(strategy, 5);

    results.push(result);

    console.log(` ✓ ${result.requestsPerSec} req/s`);

    await new Promise((res) => setTimeout(res, 1000));
  }

  console.log("\nResults");
  console.log("─".repeat(90));

  console.log(
    "Strategy".padEnd(22) +
      "req/s".padEnd(12) +
      "p50".padEnd(12) +
      "p95".padEnd(12) +
      "p99".padEnd(12) +
      "Memory"
  );

  console.log("─".repeat(90));

  const memoryComplexity: Record<StrategyName, string> = {
    "fixed-window": "O(1) integer counter",
    "sliding-window": "O(n) timestamps",
    "token-bucket": "O(1) hash",
    "leaky-bucket": "O(1) hash",
  };

  for (const r of results) {
    console.log(
      r.strategy.padEnd(22) +
        String(r.requestsPerSec).padEnd(12) +
        String(r.latencyP50).padEnd(12) +
        String(r.latencyP95).padEnd(12) +
        String(r.latencyP99).padEnd(12) +
        memoryComplexity[r.strategy]
    );
  }

  console.log("\nTradeoffs");
  console.log("─".repeat(90));

  const tradeoffs: Record<
    StrategyName,
    { pro: string; con: string }
  > = {
    "fixed-window": {
      pro: "Fastest and simplest",
      con: "Cross-boundary burst exploit",
    },
    "sliding-window": {
      pro: "Mathematically precise",
      con: "Higher memory usage",
    },
    "token-bucket": {
      pro: "Allows bursts",
      con: "Burst may overwhelm downstream services",
    },
    "leaky-bucket": {
      pro: "Smooth output traffic",
      con: "Most restrictive",
    },
  };

  for (const [strategy, info] of Object.entries(tradeoffs)) {
    console.log(`\n${strategy}`);
    console.log(`  ✓ ${info.pro}`);
    console.log(`  ✗ ${info.con}`);
  }

  await redis.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});