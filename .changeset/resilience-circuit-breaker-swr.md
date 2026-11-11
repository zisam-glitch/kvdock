---
"kvdock": minor
---

feat(middleware): add resilient Circuit Breaker, Active-Passive Failover, and zero-downtime Stale-While-Revalidate (SWR) with XFetch

- Added production sliding-window Circuit Breaker middleware (`withCircuitBreaker`, `CircuitBreaker`) with automatic fallback adapter routing, slow call detection, and graceful degradation.
- Added active-passive Multi-Adapter Failover adapter (`withFailover`) with write replication to pre-warm standby caches and automatic health recovery failback.
- Added RFC 5861 Stale-While-Revalidate (`staleWhileRevalidate`) and ACM 2015 XFetch optimal probabilistic cache stampede prevention (`xfetch`, `beta`) in `KVDock.getOrSet`.
- Added standalone runnable demonstration in `examples/circuit-breaker-failover/index.ts`.
