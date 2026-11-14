# Architectural Comparison: KVDock vs. Unstorage vs. Keyv

Choosing a caching and key-value layer is a critical architectural decision for modern TypeScript and Node.js applications. This guide highlights the key differences between **KVDock**, **Unstorage** (UnJS), and **Keyv**.

---

## 1. Feature Comparison Matrix

| Feature | `kvdock` | `unstorage` | `keyv` |
| :--- | :---: | :---: | :---: |
| **Built-in Cache Stampede Protection (Single-Flight)** | 🟢 **Yes (`dock.getOrSet`)** | ❌ No (requires manual custom locking) | ❌ No |
| **Native Multi-Tier Storage (`TieredDock`)** | 🟢 **Yes (L1 RAM + L2 Persistent)** | 🟡 Custom overlay drivers | ❌ No (single adapter per instance) |
| **Zero Runtime Dependencies Core** | 🟢 **Yes (0 external packages)** | 🟢 Yes | ❌ Has dependencies |
| **Streaming Keys Scan (`dock.scan()`)** | 🟢 **AsyncIterable Stream** | 🟡 Batched Array | 🟡 Iterator |
| **Atomic Compare-And-Swap (`cas`)** | 🟢 **Built-in** | ❌ Backend-dependent | ❌ No |
| **Tag-Based Invalidation (`invalidateTag`)** | 🟢 **Built-in** | ❌ No | ❌ No |
| **Cross-Process Invalidation Bus (`KVDockBus`)** | 🟢 **Built-in (BroadcastChannel, Redis)** | ❌ No | ❌ No |
| **Circuit Breaker & Fallback Middleware** | 🟢 **Built-in** | ❌ No | ❌ No |
| **Next.js 15 App Router Incremental Cache** | 🟢 **Official Handler** | 🟡 Unofficial adapters | ❌ No |
| **Target Ecosystem** | Cross-runtime (Node, Bun, Deno, Edge, Browser) | Nuxt / Nitro / UnJS ecosystem | Traditional Node.js |

---

## 2. Deep Dive: Key Architectural Differences

### 1. Single-Flight Promise Coalescing (The Stampede Shield)
- **Problem**: When a cached key expires while under high traffic (e.g. 1,000 requests/second), conventional caches experience a **cache stampede (thundering herd)**. All 1,000 incoming threads discover a cache miss simultaneously and hammer the primary database.
- **Keyv / Unstorage**: Leave stampede protection to the developer. Teams typically resort to fragile distributed locks or probabilistic early expiration algorithms.
- **KVDock**: `dock.getOrSet(key, fetcher)` tracks active in-flight promises in-process. Exactly **1** query reaches the database; the other 999 callers await the existing promise with zero lock contention.

### 2. Multi-Tier Caching Out of the Box (`TieredDock`)
- **Keyv**: Designed as a single-backend key-value store. Combining in-memory LRU with Redis requires wrapping multiple instances and writing manual promotion logic.
- **Unstorage**: Provides driver composition, but lacks automated tier backfilling and dual-tier tag invalidation.
- **KVDock**: `TieredDock` declaratively chains tiers (e.g., L1 Memory for `< 0.05ms` hits, L2 Redis/PostgreSQL for persistent state). Reads automatically promote misses from L2 into L1. Writes and tag invalidations propagate across all tiers.

### 3. Cross-Runtime and Zero Dependencies
KVDock's core engine, local memory adapters (LRU, Byte-sized, W-TinyLFU), filesystem driver, and SQLite drivers operate with **zero external dependencies**, ensuring rapid installation in containerized environments and full compatibility with Bun, Deno, and Cloudflare Workers.
