# Production Architecture: Multi-Tiered (L1 + L2) Caching

High-velocity web applications and APIs often face a classic trade-off:
- **In-Memory Caches (L1):** Sub-millisecond latency (`< 0.05ms`), but cannot be shared across multiple instances and consume precious RAM.
- **Distributed Caches (L2, Redis/Upstash):** Shared state across microservices and containers, but network hops introduce latency (`1 – 5ms`) and network saturation under heavy load.

`kvdock` solves this with built-in **`TieredDock`**: a two-tier caching engine that pairs an ultra-fast L1 local cache with a persistent or distributed L2 store.

---

## Architecture Flow

```text
Request ──► [ TieredDock ]
                 │
                 ├── 1. Check L1 (In-Memory LRU) ──[ HIT: < 0.05ms ] ──► Return Value
                 │
                 └── 2. MISS in L1 ──► Check L2 (Redis / SQLite)
                                             │
                                             ├──[ HIT: ~ 1ms ] ──► Promote to L1 ──► Return Value
                                             │
                                             └──[ MISS: Fetch Origin ] ──► Populate L1 + L2
```

---

## Example: In-Memory L1 with Redis L2

```typescript
import { TieredDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { RedisAdapter } from "kvdock/adapters/redis";
import Redis from "ioredis";

const redisClient = new Redis(process.env.REDIS_URL);

export const cache = new TieredDock({
  // L1: Fast in-process memory store (LRU max 5,000 items)
  l1: new MemoryAdapter({ maxSize: 5_000 }),

  // L2: Shared distributed Redis instance
  l2: new RedisAdapter({ client: redisClient, prefix: "prod:" }),

  // Micro-cache hot items in memory for 10 seconds to slash Redis traffic by 90%+
  l1TTL: 10_000,

  // Keep items in Redis for 1 hour
  defaultTTL: 3600_000,
});

// Cache-aside with automatic Single-Flight deduplication
export async function getProduct(id: string) {
  return await cache.getOrSet(`product:${id}`, async () => {
    return await db.query("SELECT * FROM products WHERE id = $1", [id]);
  });
}
```

---

## Cache Stampede Protection (Single-Flight)

When an item expires or misses under heavy concurrent load (e.g. 5,000 req/sec), traditional caches fail with the **thundering herd / stampede problem**: all 5,000 requests hit the database simultaneously.

`TieredDock` and `KVDock` feature **Single-Flight Promise Coalescing**:
- When multiple requests request the same missing key concurrently, only **one** fetcher is dispatched.
- All other concurrent requests wait on that single execution and share the returned result.
- Telemetry metrics track coalesced executions via `cache.stats.stampedeCoalesced`.
