---
"kvdock": minor
---

Add RouterDock prefix mounter, KVDockBus multi-node L1 invalidation, WindowTinyLFU adapter, and payload decompression benchmarks:
- `RouterDock` (`kvdock/router`): Hierarchical prefix mounter for heterogeneous backends with transparent single-flight stampede protection, cross-mount batching, and pattern scanning.
- `KVDockBus` (`kvdock/bus`): Distributed cluster invalidation with `EventEmitterBus`, `BroadcastChannelBus`, and `RedisPubSubBus`, seamlessly auto-evicting `TieredDock` L1 caches across horizontal nodes.
- `WindowTinyLFUAdapter` (`kvdock/adapters/memory-wtinylfu`): Memory adapter with admission policy combining a window cache and a 4-bit Count-Min frequency sketch for superior hit ratios over pure LRU.
- Grace Mode / Stale-If-Error in `KVDock.getOrSet`: Transparently serve stale cache on factory failure when within `staleWhileRevalidate` window.
- Empirical payload compression/decompression benchmark and report in `docs/BENCHMARKS.md` covering Gzip and Brotli from 1KB to 1MB.
