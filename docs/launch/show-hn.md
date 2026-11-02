# Show HN Launch Package for KVDock

## 1. Post Metadata
- **Target URL**: `https://github.com/zisam-glitch/kvdock` (or `https://kvdock.dev`)
- **Recommended Post Time**: Tuesday or Wednesday at **08:00 AM EST (13:00 UTC)**. This timing catches US East Coast morning traffic, European afternoon traffic, and allows the post to gain momentum throughout the US working day.
- **Title Formulation (Option A - Recommended)**:
  > `Show HN: KVDock – Zero-dependency caching engine with stampede protection (TS, Rust, Go)`
- **Title Formulation (Option B - Systems Engineering Angle)**:
  > `Show HN: We wrote a multi-tier cache in 5 languages to stop thundering herds`

---

## 2. The First Comment (The "Maker's Story")
*Post this immediately (< 60 seconds) after submitting the post. Hacker News readers upvote authenticity, technical depth, and clear explanations of why existing tools failed.*

```markdown
Hi HN! I’m Zisam (@zisam-glitch). Over the last several months, I built KVDock (https://github.com/zisam-glitch/kvdock)—a universal, zero-dependency key-value and caching engine with built-in cache stampede protection and multi-tier memory/persistent storage.

### Why build another caching library?
Most teams start caching with simple in-memory Maps or raw Redis clients. Soon, they hit classic production hurdles:
1. **The Thundering Herd (Cache Stampede)**: A hot key expires, and 2,000 concurrent requests hammer the primary database simultaneously to recalculate it.
2. **Multi-Tier Caching Boilerplate**: Pairing an ultra-fast L1 in-memory cache with an L2 persistent store (Redis, SQLite, or Cloudflare KV) typically requires messy custom backfill logic, double-invalidation handling, and serialization edge cases.
3. **Dependency Bloat & Runtime Incompatibility**: Many Node caching packages drag in dozens of transitive dependencies and break when ported to Bun, Deno, or Cloudflare Workers.

### What KVDock does differently:
- **Zero Runtime Dependencies**: The core engine and official local drivers (Memory, Byte-sized LRU, Filesystem, SQLite) have zero external npm dependencies.
- **Single-Flight Promise Coalescing**: `dock.getOrSet(key, fetcher)` ensures that if 1,000 requests arrive for a missing or expired key, the expensive fetcher is invoked exactly once. All other callers await that single in-flight promise.
- **Native Multi-Tier Engine (`TieredDock`)**: Declaratively combine L1 RAM (< 0.05ms) with L2 Redis/Upstash/S3. Reads hit L1 first; on miss, it pulls from L2 and promotes back to L1 automatically.
- **Streaming Scans (`dock.scan()`)**: Memory-safe `AsyncIterable` stream scanning to traverse millions of keys without buffer exhaustion.
- **Polyglot Ecosystem**: We wanted the exact same operational semantics across our entire stack, so we also authored native implementations in Rust (`kvdock-rs`), Go (`kvdock-go`), Swift (`kvdock-swift`), and Kotlin (`kvdock-kt`).

### Interactive Demo & Benchmarks:
We put together an interactive browser playground where you can test stampede scenarios under load:
https://github.com/zisam-glitch/kvdock/tree/main/docs/playground

We’d love feedback from the HN community on our adapter architecture, concurrency semantics, and edge cases. What storage backends would you like to see next?
```

---

## 3. Anticipated HN Skeptic Questions & Battle-Tested Answers

### Q: "Why not just use Redis directly?"
> **Answer**: Redis is phenomenal as a distributed L2 cache, but network hops still incur 1–5ms latency and network bandwidth costs. KVDock lets you wrap an in-memory L1 LRU (< 0.05ms) in front of Redis with zero boilerplate. Furthermore, Redis does not natively solve application-layer stampedes unless you implement complex distributed lock algorithms like Redlock. KVDock solves stampedes at the single-flight runtime layer.

### Q: "How does single-flight coalescing handle errors or slow fetchers?"
> **Answer**: `dock.getOrSet()` stores the in-flight promise in a scoped map with strict `finally` cleanup. If the fetcher rejects or times out, the error propagates to all waiting promises, the in-flight key is cleared immediately, and subsequent requests can retry cleanly without getting stuck in a deadlocked state.

### Q: "Is this production ready?"
> **Answer**: Yes. KVDock is covered by 198 automated unit and integration tests across 11 storage backends, adheres to semantic versioning, includes full TypeScript type exports, and has an automated compliance test suite (`kvdock/testing`).
