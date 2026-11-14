---
title: "Benchmarking TypeScript KV & Cache Engines in 2026: KVDock vs. Unstorage vs. Keyv"
tags: typescript, javascript, node, performance
---

Choosing a key-value or caching abstraction in TypeScript usually comes down to three questions:

1. **What happens when a hot cache key expires under 1,000 concurrent requests?** (Does your database get slammed by a thundering herd?)
2. **Can I pair an in-process L1 memory cache with a distributed L2 store (like Redis or Cloudflare KV) without writing 200 lines of glue code?**
3. **Does it work across Node.js, Bun, Deno, and Edge Workers with zero dependency bloat?**

We ran a head-to-head architectural and benchmark comparison between [**KVDock**](https://github.com/zisam-glitch/kvdock), **Unstorage**, and **Keyv**.

> 🎮 **[Launch the Live Browser Stampede Simulator](https://zisam-glitch.github.io/kvdock/playground/index.html)**  
> ⭐ **Support open-source infrastructure: [Star KVDock on GitHub ★](https://github.com/zisam-glitch/kvdock)**

---

## 1. Architectural Feature Matrix

| Capability | `kvdock` | `unstorage` | `keyv` |
| :--- | :---: | :---: | :---: |
| **Single-Flight Stampede Protection (`getOrSet`)** | 🟢 **Built-in** | ❌ Manual | ❌ No |
| **Native Multi-Tier Caching (`TieredDock` L1+L2)** | 🟢 **Built-in with auto-promotion** | 🟡 Overlay driver | ❌ No |
| **Zero Runtime Dependencies in Core** | 🟢 **Yes (0 deps)** | 🟢 Yes | ❌ No |
| **Memory-Safe Streaming Scans (`dock.scan()`)** | 🟢 **`AsyncIterable` cursor** | 🟡 Full array `getKeys()` | 🟡 Iterator |
| **Compare-And-Swap (`cas`) & Atomic Counters** | 🟢 **Built-in (`cas`, `increment`)** | ❌ No | ❌ No |
| **Tag-Based Group Invalidation (`invalidateTag`)** | 🟢 **Built-in** | ❌ No | ❌ No |
| **Next.js 15 App Router Incremental Cache** | 🟢 **Official Handler** | 🟡 Community | ❌ No |
| **Distributed Locks with Fencing Tokens** | 🟢 **Built-in (`withLock`)** | ❌ No | ❌ No |

---

## 2. The Thundering Herd Benchmark (1,000 Concurrent Misses)

When a cached key expires at the exact moment 1,000 requests hit your API, a standard `get()` + `set()` cache pattern causes all 1,000 callers to see `null` and query PostgreSQL simultaneously.

With `kvdock.getOrSet()`, concurrent requests for the same missing key attach to a single in-flight promise:

```typescript
import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const dock = new KVDock({ adapter: new MemoryAdapter() });

// 1,000 concurrent callers -> 1 database query, 999 coalesced waiters
const data = await dock.getOrSet("report:daily", async () => {
  return await db.query("SELECT * FROM heavy_aggregation");
}, { ttl: 60_000 });
```

You can reproduce this benchmark locally in one command:
```bash
git clone https://github.com/zisam-glitch/kvdock.git
cd kvdock && npm install && npm run build
node scripts/benchmark-stampede.mjs
```

---

## Explore KVDock

- 📦 **GitHub**: [https://github.com/zisam-glitch/kvdock](https://github.com/zisam-glitch/kvdock)
- 🎮 **Interactive Simulator**: [https://zisam-glitch.github.io/kvdock/playground/index.html](https://zisam-glitch.github.io/kvdock/playground/index.html)

If you appreciate zero-dependency TypeScript libraries with real benchmarks, **please give [zisam-glitch/kvdock a ★ Star on GitHub](https://github.com/zisam-glitch/kvdock)**!
