# Reddit Launch Playbook & Technical Deep-Dive Posts

Reddit developer communities are intensely allergic to low-effort self-promotion, but they celebrate **deep technical teardowns with reproducible benchmarks, diagrams, and code snippets**.

---

## 1. Post for `r/programming` (Target: Front Page)

**Title**: *Why your cache is probably causing thundering herds (and how single-flight coalescing fixes it)*

```markdown
Every engineer who has run a high-traffic service has lived through this scenario:

You have an expensive endpoint (e.g., aggregating leaderboard data or rendering a personalized dashboard). To protect your Postgres database, you cache the result with a 60-second TTL.

Everything runs smoothly until the key expires under 1,500 requests/second. 

Within a 50-millisecond window, 75 concurrent requests see a cache miss. All 75 threads immediately fire the heavy SQL query against Postgres simultaneously. Your database connection pool spikes, queries queue up, latency explodes, and your pod crashes. This is the **thundering herd / cache stampede problem**.

### The Traditional (Fragile) Workarounds:
1. **Probabilistic Early Expiration (XFetch algorithm)**: Recomputes the value before it actually expires based on an exponential distribution. Works well, but wastes CPU recalculating keys that may never be accessed again.
2. **Distributed Locks (Redlock / Mutex)**: Acquiring a Redis lock before computing. High overhead, prone to deadlocks if a worker dies mid-calculation, and adds network roundtrips.

### The Zero-Overhead Alternative: Single-Flight Coalescing
Instead of locking distributed infrastructure, we can coalesce concurrent requests in-process at the Promise/Future execution layer.

When Key A is requested and misses the cache:
1. Check if an execution promise for Key A is currently in-flight.
2. If YES: Do not touch the database. Return the existing promise and await it.
3. If NO: Register a new in-flight promise, execute the database fetcher, cache the result, resolve all awaiting callers, and deregister the promise in a `finally` block.

```typescript
// How KVDock implements single-flight promise coalescing:
const running = this.inFlight.get(key);
if (running) {
  this.metrics.stampedeCoalesced++;
  return (await running) as T;
}

const run = (async () => {
  try {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await fetcher();
    await this.set(key, fresh, options);
    return fresh;
  } finally {
    this.inFlight.delete(key);
  }
})();

this.inFlight.set(key, run);
return (await run) as T;
```

### The Benchmark Numbers:
Under 1,000 concurrent requests to a missing key with 25ms database latency:
- **Naive Caching**: 1,000 queries hit the database (100% load spike).
- **KVDock Single-Flight**: Exactly 1 database query executed, 999 coalesced (99.9% database load reduction).

We engineered this into an open-source, zero-dependency caching engine with multi-tier storage (L1 Memory + L2 Redis/SQLite/S3/KV) natively across TypeScript, Rust, and Go:
https://github.com/zisam-glitch/kvdock

Curious to hear how other teams handle stampedes in their caching layers!
```

---

## 2. Post for `r/node` & `r/javascript`

**Title**: *We built a zero-dependency multi-tier caching engine with stampede protection (Node, Bun, Deno, Workers)*

```markdown
Hey everyone! Over the last few months, we got tired of stitching together separate in-memory caches, Redis clients, serializers, and custom stampede protection logic across different JavaScript runtimes.

We built **KVDock** (https://github.com/zisam-glitch/kvdock) as a unified, modern key-value and caching engine:

### Key Highlights:
- **Zero Runtime Dependencies**: The core engine and built-in drivers have zero external npm dependencies.
- **Multi-Tiered Caching (`TieredDock`)**: Pair an ultra-fast in-memory L1 cache (< 0.05ms) with a distributed L2 (Redis, Upstash, SQLite, Cloudflare KV) with automatic promotion.
- **Cache Stampede Guard**: Built-in `dock.getOrSet()` prevents thundering herds with single-flight promise deduplication.
- **Cross-Runtime**: First-class support for Node.js >=18, Bun, Deno, and Cloudflare Workers.
- **Tag-Based Invalidation**: Invalidate entire groups of related keys in one call (`dock.invalidateTag('user:101')`).

Check out the interactive playground and benchmarks:
https://github.com/zisam-glitch/kvdock

Feedback and PRs are warmly welcomed!
```

---

## 3. Post for `r/rust`

**Title**: *kvdock-rs: Thread-safe, zero-dependency key-value engine with monotonic Instant TTL expiration*

```markdown
Hi Rustaceans! As part of the polyglot KVDock project, we published `kvdock-rs` (https://github.com/zisam-glitch/kvdock-rs).

It’s engineered with:
- Zero external dependencies in core.
- Mutex-guarded $O(1)$ LRU with monotonic `Instant` TTL enforcement (immune to system clock drift).
- Trait-based pluggable `StorageAdapter`.
- Thread-safe `KVDock<A>` for async runtimes (Tokio).

Would love feedback on our memory layout and lock-free eviction roadmap!
```
