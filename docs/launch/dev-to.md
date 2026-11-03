---
title: How We Solved Cache Stampedes in Node.js and Bun with Zero Dependencies
published: false
description: A technical deep dive into single-flight coalescing, multi-tier L1/L2 caching, and distributed fencing tokens in TypeScript.
tags: node, bun, typescript, webdev
---

Every backend engineer has seen this incident at least once:

You deploy a microservice with a caching layer. Everything looks fine in staging. Then traffic spikes in production, an expensive database query's 5-minute cache TTL expires, and **2,000 incoming requests simultaneously discover a cache miss**.

Instead of 1 database query, your database gets hit with 2,000 identical queries in under 50 milliseconds. The connection pool saturates, CPU spikes to 100%, health checks fail, and your service crashes.

This is the classic **Cache Stampede** (or **Thundering Herd** problem).

When building [KVDock](https://github.com/zisam-glitch/kvdock), our goal was to eliminate this class of bug across modern JavaScript and TypeScript runtimes (Node.js, Bun, Deno, Cloudflare Workers) with **zero runtime dependencies** in the core store.

Here is how the architecture works under the hood.

---

## 1. Single-Flight Promise Coalescing

The fundamental fix for cache stampedes is **single-flight request coalescing**.

When multiple concurrent asynchronous operations request the same key at the same moment, only the **first caller** should invoke the data loader. All subsequent callers should attach to that identical in-flight promise and await the result.

### Implementation Architecture

In KVDock, `dock.getOrSet(key, fetcher, options)` manages an internal `Map<string, Promise<T>>`:

```typescript
// Conceptual core mechanism in KVDock
class Store<T> {
  private inFlight = new Map<string, Promise<T>>();

  async getOrSet(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T> {
    // 1. Check local cache first
    const cached = await this.get(key);
    if (cached !== undefined) return cached;

    // 2. If already in flight, coalesce and await the same promise
    const active = this.inFlight.get(key);
    if (active) return active;

    // 3. Initiate single flight with guaranteed cleanup
    const promise = (async () => {
      try {
        const value = await fetcher();
        await this.set(key, value, { ttl });
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }
}
```

### The Invalidation and Error Safety Guarantee
Crucially, using a `try / finally` guarantees that if the `fetcher()` rejects (e.g., database timeout or network disconnect), the in-flight reference is purged immediately. Subsequent calls do not get stuck returning a stale rejected promise, and retry loops function naturally.

---

## 2. Multi-Tier Caching (L1 Memory + L2 Distributed)

A single remote cache (like Redis or Upstash) still incurs a **1–5ms network round-trip** per read. At 20,000 requests per second, network serialization and socket latency add up.

To solve this, KVDock provides `TieredDock`, combining:
- **L1 (Local Memory)**: Sub-0.05ms in-process LRU cache.
- **L2 (Distributed)**: Redis, MongoDB, or PostgreSQL cluster for cross-process synchronization.

```typescript
import { TieredDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { RedisAdapter } from "kvdock/adapters/redis";

const cache = new TieredDock({
  l1: new MemoryAdapter({ maxEntries: 5_000 }),
  l2: new RedisAdapter({ url: process.env.REDIS_URL }),
  l1Ttl: "1m",  // Keep local memory hot for 1 minute
  l2Ttl: "1h",  // Remote persistence survives container restarts
});

// Reads check L1 -> L2 -> DB
// On L2 hit, automatically promotes value back to L1
const product = await cache.getOrSet("product:99", async () => {
  return await db.products.findById("99");
});
```

When an L1 miss occurs:
1. It queries L2.
2. If L2 returns a value, it transparently populates L1 with the configured `l1Ttl`.
3. If both miss, it executes the coalesced fetcher and writes to both L1 and L2 simultaneously.

---

## 3. Distributed Locking with Fencing Tokens

Simple boolean Redis locks (`SET key val NX EX 30`) suffer from a notorious flaw: **garbage collection pauses or slow queries can cause the lock lease to expire while the worker is still executing**.

When the original worker finally finishes and writes to the database, it overwrites work done by a newer lock holder (split-brain condition).

To prevent this, KVDock's `withLock` middleware implements **fencing tokens**:

```typescript
import { withLock } from "kvdock/middleware/lock";

await withLock(dock, "order:checkout:user_42", async (lock) => {
  // lock.fencingToken is a strictly monotonically increasing counter
  console.log(`Lock acquired with fencing token #${lock.fencingToken}`);

  // Auto-renewal lease keeps the lock alive while async work continues
  await processPayment();

  // Pass the fencing token to the database transaction to prevent stale writes:
  // UPDATE orders SET status = 'paid', fence = :fencingToken WHERE id = :id AND fence < :fencingToken
}, {
  ttl: "5s",
  autoRenew: true, // Renews lease heartbeat in background until done
});
```

---

## 4. Real Performance Benchmarks

Here is the real benchmark measurement executed locally across different payload sizes (1,000 operations per batch):

| Storage Backend | 1KB Write (ops/s) | 1KB Read (ops/s) | 10KB Write (ops/s) | 100KB Read (ops/s) |
| :--- | :---: | :---: | :---: | :---: |
| **MemoryAdapter** | 588,120 | 936,841 | 125,324 | 19,995 |
| **SQLiteAdapter (:memory:)** | 296,633 | 460,017 | 63,204 | 19,493 |
| **LocalStorageAdapter** | 803,428 | 571,415 | 125,910 | 8,054 |

---

## 5. Supply Chain and Security Hardening

In modern software development, reliability is as much about supply chain integrity as code quality:
- **Zero dependencies** for the core engine.
- Optional peer dependencies (`ioredis`, `pg`, `mongodb`) only pulled when using those adapters.
- **OpenSSF Scorecard supply-chain security action** (`v2.5.0`) running automated SARIF analysis on every push.
- All GitHub Action workflows pinned to immutable full-length commit SHAs with `permissions: read-all`.
- Full integration test suites running against live Redis, Postgres, and MongoDB instances.

---

## Getting Started

You can test KVDock in any Node, Bun, or Deno project today:

```bash
npm install kvdock
```

Or check out the runnable recipe examples on GitHub:
- [Tiered Cache Example](https://github.com/zisam-glitch/kvdock/tree/main/examples/tiered-cache)
- [Distributed Lock Example](https://github.com/zisam-glitch/kvdock/tree/main/examples/distributed-lock)
- [Hono Edge Route Caching](https://github.com/zisam-glitch/kvdock/tree/main/examples/hono-caching)

GitHub Repository: [github.com/zisam-glitch/kvdock](https://github.com/zisam-glitch/kvdock)

We would love your feedback on edge cases, adapter APIs, and your favorite caching architectures!
