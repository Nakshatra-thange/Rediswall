import swaggerJsdoc from "swagger-jsdoc";

/*
 * OpenAPI 3.0 specification for rediswall demo API.
 * Documents every endpoint, all rate limit headers, and the 429 response.
 * Served as live Swagger UI at /api-docs.
 */
export const spec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "rediswall",
      version: "0.1.0",
      description: `
**Distributed rate limiting framework for Express.**

Implements four algorithms as pluggable middleware with per-tier quotas,
atomic Lua scripts for race-condition-free distributed enforcement,
and a three-state circuit breaker for Redis outage resilience.

### Algorithms
| Strategy | Memory | Accuracy | Best for |
|---|---|---|---|
| sliding-window | O(n) | Exact | General APIs |
| fixed-window | O(1) | ±2x burst | High-volume, tolerant |
| token-bucket | O(1) | High | Bursty clients |
| leaky-bucket | O(1) | High | Protecting downstream |

### Rate limit headers
Every response includes standard headers:
- \`X-RateLimit-Limit\` — requests allowed per window
- \`X-RateLimit-Remaining\` — requests left in current window
- \`X-RateLimit-Reset\` — unix timestamp when window resets
- \`X-RateLimit-Policy\` — limit and window in IETF draft format
- \`Retry-After\` — seconds to wait (429 responses only)
      `,
      contact: {
        name: "rediswall on GitHub",
        url: "https://github.com/yourusername/rediswall",
      },
      license: { name: "MIT" },
    },
    servers: [
      { url: "http://localhost:3000", description: "Local demo" },
    ],
    components: {
      parameters: {
        TierHeader: {
          in: "header",
          name: "x-tier",
          schema: { type: "string", enum: ["free", "pro", "enterprise"] },
          required: false,
          description: "User tier. Controls rate limit quota. Defaults to `free`.",
          example: "pro",
        },
      },
      headers: {
        XRateLimitLimit: {
          description: "Maximum requests allowed in the current window.",
          schema: { type: "integer", example: 100 },
        },
        XRateLimitRemaining: {
          description: "Requests remaining in the current window.",
          schema: { type: "integer", example: 87 },
        },
        XRateLimitReset: {
          description: "Unix timestamp (seconds) when the window resets.",
          schema: { type: "integer", example: 1718000060 },
        },
        XRateLimitPolicy: {
          description: "IETF draft format: `limit;w=windowSeconds`.",
          schema: { type: "string", example: "100;w=60" },
        },
        RetryAfter: {
          description: "Seconds to wait before retrying. Only present on 429.",
          schema: { type: "integer", example: 42 },
        },
      },
      responses: {
        RateLimited: {
          description: "Rate limit exceeded.",
          headers: {
            "X-RateLimit-Limit":     { $ref: "#/components/headers/XRateLimitLimit" },
            "X-RateLimit-Remaining": { $ref: "#/components/headers/XRateLimitRemaining" },
            "X-RateLimit-Reset":     { $ref: "#/components/headers/XRateLimitReset" },
            "X-RateLimit-Policy":    { $ref: "#/components/headers/XRateLimitPolicy" },
            "Retry-After":           { $ref: "#/components/headers/RetryAfter" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error:      { type: "string", example: "Too Many Requests" },
                  message:    { type: "string", example: "Rate limit exceeded. You are allowed 100 requests per 60s." },
                  retryAfter: { type: "integer", example: 42 },
                  limit:      { type: "integer", example: 100 },
                  remaining:  { type: "integer", example: 0 },
                  resetAt:    { type: "string", format: "date-time", example: "2024-01-01T12:01:00.000Z" },
                },
              },
            },
          },
        },
        ServiceUnavailable: {
          description: "Rate limiting service (Redis) is down and `failOpen` is false.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error:   { type: "string", example: "Service temporarily unavailable" },
                  message: { type: "string", example: "Rate limiting service is down. Please try again shortly." },
                },
              },
            },
          },
        },
        SuccessResponse: {
          description: "Request allowed.",
          headers: {
            "X-RateLimit-Limit":     { $ref: "#/components/headers/XRateLimitLimit" },
            "X-RateLimit-Remaining": { $ref: "#/components/headers/XRateLimitRemaining" },
            "X-RateLimit-Reset":     { $ref: "#/components/headers/XRateLimitReset" },
            "X-RateLimit-Policy":    { $ref: "#/components/headers/XRateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  strategy: { type: "string" },
                  ok:       { type: "boolean", example: true },
                },
              },
            },
          },
        },
      },
    },
    tags: [
      { name: "Strategies", description: "One endpoint per algorithm — same traffic, different enforcement" },
      { name: "System",     description: "Health and circuit breaker status" },
    ],
    paths: {
      "/api/sliding-window": {
        get: {
          tags: ["Strategies"],
          summary: "Sliding window",
          description: `
**The hero algorithm.** Stores every request timestamp in a Redis sorted set.
On each request, evicts timestamps older than \`windowMs\`, counts what remains,
and enforces the limit atomically via a Lua script.

**Why Lua?** Without atomicity, two concurrent requests can both read \`count=99\`,
both decide "I'm allowed", and both write — giving you 101 requests when the limit is 100.
The Lua script runs as a single Redis command. No interleaving possible.

**The cross-boundary exploit (why sliding window beats fixed window):**
A user sends 100 requests at 11:59:55 and 100 more at 12:00:05.
Fixed window allows all 200 — different buckets.
Sliding window looks back 60s from 12:00:05, sees all 100 from 11:59:55, blocks at 101.

**Redis ops:** ZREMRANGEBYSCORE + ZCARD + ZADD + PEXPIRE (in one Lua script)
**Memory:** O(n) — one sorted set entry per request in current window
          `,
          parameters: [{ $ref: "#/components/parameters/TierHeader" }],
          responses: {
            200: { $ref: "#/components/responses/SuccessResponse" },
            429: { $ref: "#/components/responses/RateLimited" },
            503: { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/api/fixed-window": {
        get: {
          tags: ["Strategies"],
          summary: "Fixed window",
          description: `
**The baseline.** Divides time into fixed buckets (e.g. 12:00:00–12:01:00).
Counts requests per bucket with a single Redis INCR.

**Fastest algorithm** — one Redis command, O(1) memory.
**Vulnerable to cross-boundary burst** — see sliding-window for details.

Use when: high volume, accuracy within ±2x is acceptable, memory is a concern.

**Redis ops:** INCR + PEXPIRE (on first request only)
**Memory:** O(1) — one integer key per user per window
          `,
          parameters: [{ $ref: "#/components/parameters/TierHeader" }],
          responses: {
            200: { $ref: "#/components/responses/SuccessResponse" },
            429: { $ref: "#/components/responses/RateLimited" },
            503: { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/api/token-bucket": {
        get: {
          tags: ["Strategies"],
          summary: "Token bucket",
          description: `
**Burst-friendly.** A bucket holds \`limit\` tokens. Tokens refill at
\`limit/windowMs\` per millisecond. Each request consumes one token.

**Key difference from sliding window:** allows short bursts up to full capacity,
then enforces the average rate. A user can send all 100 requests in 1 second,
then must wait ~60s for the bucket to refill.

Sliding window blocks at request 101 within any rolling 60s slice.
Token bucket blocks at request 101 but starts allowing again as tokens trickle in.

Use when: clients have naturally bursty traffic patterns (mobile apps, webhooks).

**Redis ops:** HMGET + HMSET + PEXPIRE (in one Lua script)
**Memory:** O(1) — one hash with two fields per user
          `,
          parameters: [{ $ref: "#/components/parameters/TierHeader" }],
          responses: {
            200: { $ref: "#/components/responses/SuccessResponse" },
            429: { $ref: "#/components/responses/RateLimited" },
            503: { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/api/leaky-bucket": {
        get: {
          tags: ["Strategies"],
          summary: "Leaky bucket",
          description: `
**Smoothest output.** Requests flow in at any rate and drain at a constant rate.
If the queue fills up, new requests are denied.

**Inverse of token bucket:** instead of tracking available tokens,
tracks queued requests. Drains at \`limit/windowMs\` per millisecond.

**Strictest algorithm for downstream protection.** No burst allowed past the drain rate.
Ideal when your API proxies to a third-party service with its own rate limits
(payment processors, email providers, external data APIs).

Use when: downstream services can't absorb spikes, smooth traffic is critical.

**Redis ops:** HMGET + HMSET + PEXPIRE (in one Lua script)
**Memory:** O(1) — one hash with two fields per user
          `,
          parameters: [{ $ref: "#/components/parameters/TierHeader" }],
          responses: {
            200: { $ref: "#/components/responses/SuccessResponse" },
            429: { $ref: "#/components/responses/RateLimited" },
            503: { $ref: "#/components/responses/ServiceUnavailable" },
          },
        },
      },
      "/status": {
        get: {
          tags: ["System"],
          summary: "Health check",
          description: "Returns server uptime and Redis connection status. Not rate limited.",
          responses: {
            200: {
              description: "Server is healthy.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      uptime: { type: "number", description: "Process uptime in seconds", example: 142.3 },
                      redis:  { type: "string", description: "ioredis connection state", example: "ready" },
                      message: { type: "string", example: "rediswall running" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  apis: [],
});