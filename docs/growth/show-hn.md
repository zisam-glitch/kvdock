# Hacker News (Show HN) Submission Draft

## Submission Details
- **URL**: `https://github.com/zisam-glitch/kvdock`
- **Title**: `Show HN: KVDock – Zero-dep TypeScript cache with stampede coalescing`

---

## First Comment (Post immediately after submitting)

```markdown
Hi HN! I built kvdock (https://github.com/zisam-glitch/kvdock), an open-source, zero-dependency caching and key-value engine written in TypeScript.

The motivation came from handling traffic spikes in edge/Node applications:

1. **The Thundering Herd / Cache Stampede problem**:
When high-traffic cache keys expire, simultaneous requests typically trigger duplicate fetch queries against PostgreSQL or microservices. `kvdock` implements single-flight promise coalescing inside `dock.getOrSet()`. When 1,000 parallel requests arrive for an expired key, only 1 fetch execution occurs; the remaining 999 wait on the same promise and receive the cached result with zero lock contention.

2. **Native Multi-Tier Storage (`TieredDock`)**:
Often you want an in-memory L1 cache (for sub-millisecond local reads) backed by an L2 persistent store (Redis, SQLite, or S3). Instead of maintaining two separate clients and glue code, `TieredDock` handles read-through and cache-aside synchronization automatically.

3. **Portability & Zero Dependencies**:
The core engine has 0 dependencies, works on Node (>=18), Bun, Deno, Cloudflare Workers, and browsers. Adapters for Redis, SQLite, Filesystem, etc. are tree-shakeable.

We also put together an interactive playground with a live stampede simulator:
https://zisam-glitch.github.io/kvdock/playground/index.html

I’d love to hear your thoughts on the API design, race condition handling, and comparison with unstorage/keyv!
```
