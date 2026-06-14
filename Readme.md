# rediswall

> Distributed rate limiting framework for Express — sliding window, token bucket, circuit breaker, multi-tier.

[![npm version](https://badge.fury.io/js/rediswall.svg)](https://www.npmjs.com/package/rediswall)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## The problem

Every public API needs rate limiting. Most tutorials show you a single
`express-rate-limit` import and call it done. That breaks in production:

- **Single Node.js instance** — in-memory counters don't survive restarts
  and don't work across multiple instances behind a load balancer
- **Fixed window** — a user can send 2x the limit in 1 second by
  straddling a window boundary (the cross-boundary exploit)
- **No resilience** — if Redis goes down, your entire API dies with it

rediswall solves all three.

---

## How it works

```
Request → Strategy selector → Tier resolver → Circuit breaker
                                                    │
                               Redis healthy? ──────┤
                                    │               │
                                    ▼               ▼
                               Redis Lua        In-memory
                               (atomic)         fallback
                                    │               │
                                    └───────┬───────┘
                                            ▼
                               200 OK / 429 Too Many Requests
```

- **Shared Redis state** — all Node.js instances enforce one global limit
- **Atomic Lua scripts** — no race conditions under concurrent load
- **Three-state circuit breaker** — closed → open → half-open → closed
- **In-memory fallback** — keeps enforcing limits even when Redis is down

---

## Quickstart

```bash
npm install rediswall ioredis express
```

```typescript
import express from "express";
import Redis from "ioredis";
import { createRedisWall, DEFAULT_TIERS } from "rediswall";

const app = express();
const redis = new Redis();

const limiter = createRedisWall({
  redis,
  strategy: "sliding-window",
  tiers: DEFAULT_TIERS,       // free: 100/min, pro: 1000/min, enterprise: 10k/min
  defaultTier: "free",
});

app.use("/api", limiter);

app.get("/api/data", (_req, res) => res.json({ ok: true }));
```

Every response includes standard headers:

```
X-RateLimit-Limit:     100
X-RateLimit-Remaining: 87
X-RateLimit-Reset:     1718000060
X-RateLimit-Policy:    100;w=60
Retry-After:           42          (429 responses only)
```

---

## Multi-tier

```typescript
const limiter = createRedisWall({
  redis,
  strategy: "sliding-window",
  tiers: {
    free:       { name: "free",       limit: 100,   windowMs: 60_000 },
    pro:        { name: "pro",        limit: 1000,  windowMs: 60_000 },
    enterprise: { name: "enterprise", limit: 10000, windowMs: 60_000 },
  },
  defaultTier: "free",
  tierFn: (req) => req.user?.plan ?? "free",   // resolve from JWT, API key, etc.
});
```

---

## Circuit breaker

When Redis starts failing, the circuit opens automatically.
Requests fall back to an in-memory sliding window.
When Redis recovers, the circuit closes after a single successful probe.

```
Redis down → 5 failures → circuit OPEN → 30s cooldown
                                              ↓
                              HALF_OPEN → probe Redis
                                              ↓
                         Success → CLOSED    Fail → OPEN (reset timer)
```

```typescript
const limiter = createRedisWall({
  redis,
  strategy: "sliding-window",
  tiers: DEFAULT_TIERS,
  defaultTier: "free",
  circuitBreaker: {
    failureThreshold: 5,     // failures before opening
    cooldownMs: 30_000,      // wait before probing
  },
  failOpen: true,            // true = fallback on outage, false = 503
  onCircuitOpen: (state) => {
    console.warn("Circuit opened:", state);
    // send alert to PagerDuty, Slack, etc.
  },
});
```

---

## Strategies

### Sliding window — recommended default

Stores every request timestamp in a Redis sorted set.
Evicts old timestamps atomically via Lua script.
Immune to the cross-boundary exploit.

```typescript
{ strategy: "sliding-window" }
```

**The cross-boundary exploit (why this matters):**

```
limit = 100 req/min

Fixed window:
  11:59:55 → 100 requests → bucket A fills
  12:00:05 → 100 requests → bucket B starts → all allowed
  Result: 200 requests in 10 seconds ← exploit

Sliding window:
  11:59:55 → 100 requests → allowed
  12:00:05 → window looks back 60s → sees all 100 → DENY
  Result: exactly 100 in any 60s slice ← correct
```

### Fixed window — fastest, O(1) memory

One Redis INCR per request. Resets at clock boundaries.
Vulnerable to cross-boundary burst but 10–15% faster than sliding window.
Use when accuracy within 2x is acceptable and memory is a concern.

```typescript
{ strategy: "fixed-window" }
```

### Token bucket — burst-friendly

Tokens refill continuously. Allows bursts up to capacity.
Natural fit for bursty clients (mobile apps, webhooks, third-party integrations).

```typescript
{ strategy: "token-bucket" }
```

### Leaky bucket — smoothest output

Requests drain at a constant rate regardless of burst.
Use when protecting downstream services that can't absorb spikes
(payment processors, email providers, external APIs).

```typescript
{ strategy: "leaky-bucket" }
```

---

## Benchmark

All strategies run on the same hardware, same Redis instance,
10 concurrent connections, 5 second runs.

| Strategy | req/s | p50 | p95 | p99 | Memory |
|---|---|---|---|---|---|
| fixed-window | ~4200 | 2ms | 5ms | 9ms | O(1) |
| sliding-window | ~3800 | 2ms | 6ms | 11ms | O(n) |
| token-bucket | ~3900 | 2ms | 5ms | 10ms | O(1) |
| leaky-bucket | ~3750 | 3ms | 6ms | 12ms | O(1) |

All strategies add under 5ms p99 overhead. The difference between fixed and
sliding window is ~10% throughput in exchange for exact enforcement accuracy.

Run on your own hardware:
```bash
npm run benchmark
```

---

## Test coverage

57 tests across 8 suites covering:

- Algorithm correctness (boundary conditions, window expiry, quota reset)
- Concurrency (150 simultaneous requests, exact limit enforcement)
- Cross-boundary exploit proof (fixed window fails, sliding window passes)
- Algorithm tradeoffs (token bucket vs sliding window recovery speed)
- Circuit breaker state machine (all 6 transitions)
- Redis failure modes (fail-open, fail-closed, recovery)
- Distributed correctness (3 Redis clients, shared global limit)
- HTTP middleware (headers, 429 body, tier resolution, identifier isolation)

```bash
npm test
npm test -- --coverage
```

---

## API reference

### `createRedisWall(config)`

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `redis` | `Redis` | ✓ | — | ioredis client |
| `strategy` | `StrategyName` | ✓ | — | Algorithm to use |
| `tiers` | `TierMap` | ✓ | — | Tier configs |
| `defaultTier` | `string` | ✓ | — | Tier when `tierFn` is not set |
| `tierFn` | `(req) => TierName` | | `() => defaultTier` | Resolve tier from request |
| `identifierFn` | `(req) => string` | | IP address | Resolve identifier from request |
| `circuitBreaker` | `CircuitBreakerConfig` | | `{ threshold: 5, cooldown: 30s }` | Circuit breaker config |
| `failOpen` | `boolean` | | `true` | Allow requests on Redis failure |
| `onLimitReached` | `(req, result) => void` | | — | Called on every 429 |
| `onCircuitOpen` | `(state) => void` | | — | Called when circuit opens |

### `DEFAULT_TIERS`

```typescript
{
  free:       { limit: 100,   windowMs: 60_000 },
  pro:        { limit: 1000,  windowMs: 60_000 },
  enterprise: { limit: 10000, windowMs: 60_000 },
}
```

---

## Production notes

**Use Redis Cluster or Redis Sentinel** for high availability.
Single-node Redis is a single point of failure — the circuit breaker
handles outages gracefully but you should aim for Redis uptime > 99.9%.

**Rate limit at the API gateway layer too.**
Kong, AWS API Gateway, and nginx all support rate limiting.
Application-layer limiting (this library) gives you per-user granularity
that gateway-layer limiting can't match. Use both.

**Different strategies for different route types:**
- `/api/login` → sliding-window, strict (brute force protection)
- `/api/data`  → token-bucket, generous (bursty read clients)
- `/api/pay`   → leaky-bucket (protect payment processor)
- `/api/search`→ sliding-window, per-user (expensive queries)

**Identifier selection matters.**
Per-IP limiting is easy to bypass (VPNs, shared IPs, NAT).
Per-user (from JWT) is more accurate but requires auth middleware to run first.
Consider combining both: `${userId}:${ip}` as the key.

---

## Local development

```bash
git clone https://github.com/yourusername/rediswall
cd rediswall
npm install
docker run -d -p 6379:6379 redis:alpine
npm test
npm run benchmark
npx ts-node docs/demo.ts
# Swagger UI → http://localhost:3000/api-docs
```

---

## License

MIT