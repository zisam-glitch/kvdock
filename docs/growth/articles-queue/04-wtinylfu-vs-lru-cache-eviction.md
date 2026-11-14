---
title: "Why Pure LRU Cache Eviction Fails Under Scan Workloads (And How W-TinyLFU Fixes It)"
tags: typescript, algorithms, performance, backend
---

Standard **Least Recently Used (LRU)** caches have an Achilles' heel known as **cache pollution (or scan resistance failure)**:

Suppose your in-memory cache holds **10,000 hot keys** (e.g., active user sessions and top catalog items) with a 98% hit rate. Suddenly, a background reporting job or web crawler scans **10,000 one-off historical records**.

In a naive LRU cache, those 10,000 one-off records completely evict your 10,000 hot keys—dropping your production cache hit rate to **0%**!

To solve this in [**KVDock**](https://github.com/zisam-glitch/kvdock), we built a zero-dependency **Window-TinyLFU (`MemoryWTinyLFUAdapter`)** admission policy alongside our classic LRU and byte-sized adapters.

> 🎮 **[Launch the Live Browser Cache & Stampede Simulator](https://zisam-glitch.github.io/kvdock/playground/index.html)**  
> 👤 **[Follow @zisam-glitch on GitHub](https://github.com/zisam-glitch)** for weekly systems engineering deep dives!  
> ⭐ **[Star zisam-glitch/kvdock on GitHub](https://github.com/zisam-glitch/kvdock)**

---

## How W-TinyLFU Protects Your Hot Working Set

Instead of blindly admitting every new key into the main cache, **W-TinyLFU** combines:
1. **A 1% Window LRU**: Absorbs short-term burst traffic.
2. **A Compact Count-Min Sketch Frequency Filter**: Tracks access frequency using minimal memory (4-bit counters with periodic halving to keep frequency fresh).
3. **A 99% Segmented LRU (Probation + Protected)**: When the Window evicts a candidate, the TinyLFU admission filter compares the candidate's historical frequency against the victim in the Probation segment—only admitting the candidate if its frequency is higher!

```typescript
import { KVDock } from "kvdock";
import { MemoryWTinyLFUAdapter } from "kvdock/adapters/memory-wtinylfu";

const dock = new KVDock({
  adapter: new MemoryWTinyLFUAdapter({ maxEntries: 10_000 }),
  ttl: 300_000,
});

// One-off scan keys are rejected by the TinyLFU admission filter,
// preserving your hot working set in the Protected segment!
const value = await dock.getOrSet("user:hot:42", () => fetchUser(42));
```

---

## Explore the Codebase

- 📦 **GitHub Repository**: [https://github.com/zisam-glitch/kvdock](https://github.com/zisam-glitch/kvdock)
- 👤 **Author Profile**: [https://github.com/zisam-glitch](https://github.com/zisam-glitch)

If you enjoy deep-dive systems architecture in TypeScript, Rust, and Go, **[follow @zisam-glitch on GitHub](https://github.com/zisam-glitch)** and **[drop a ★ Star on kvdock](https://github.com/zisam-glitch/kvdock)**!
