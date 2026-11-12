# kvdock Roadmap (one item shipped per day)

## Shipped Foundation
- [x] Replace mock-based tests for Redis with an opt-in integration test against a real Redis (docker compose / REDIS_URL)
- [x] Same for Postgres and MongoDB adapters (opt-in integration tests against real POSTGRES_URL and MONGODB_URI)
- [x] Wire MongoDB/Postgres adapters to real client libraries as optional peer deps and document it
- [x] README: quickstart, adapter matrix with honest maturity levels (stable / experimental)
- [x] Publish to npm with provenance; add `npm pack` smoke test in CI
- [x] Add SECURITY.md, CONTRIBUTING.md, real "good first issue" labels
- [x] Publish benchmark results in docs/PERFORMANCE_MATRIX.md from a real run
- [x] Add OpenSSF Scorecard GitHub Action and fix findings
- [x] Write a launch post (Show HN / dev.to) and respond to real feedback

## Upcoming Milestones
- [x] Add malformed JSON error recovery test coverage for `LocalStorageAdapter` and `AsyncStorageAdapter` (#108)
- [x] Add `Bun.serve` and `ElysiaJS` route caching recipe to `examples/elysia-caching` (#107)
- [x] Add cursor-based async iterator scan support for browser stores (`IndexedDBAdapter`) (#106)
- [x] Add automated Miniflare integration test for `CloudflareKVAdapter` and `D1Adapter`
- [x] Add Prometheus metrics scraping endpoint and export latency histograms in `kvdock/plugins/prometheus`
- [x] Add OpenTelemetry distributed trace context propagation in `kvdock/plugins/opentelemetry`
- [x] Add resilient exponential backoff retry middleware with jitter in `kvdock/middleware/retry`
- [x] Add high-availability Circuit Breaker middleware and active-passive failover in `kvdock/middleware/circuit-breaker`
- [x] Add zero-downtime Stale-While-Revalidate (SWR) and XFetch optimal probabilistic cache stampede prevention in `KVDock.getOrSet`
- [x] Add client-side payload decompression benchmark in `docs/BENCHMARKS.md`
- [x] Add multi-node cluster cache synchronization bus (`KVDockBus`, `RedisPubSubBus`, `BroadcastChannelBus`) with automatic L1 invalidation in `TieredDock`
- [x] Add zero-downtime Grace-Mode stale fallback on upstream database error in `KVDock.getOrSet`
- [x] Add hierarchical mount point routing and cross-mount batching in `RouterDock` (`kvdock/router`)
- [x] Add Window-TinyLFU (W-TinyLFU) high hit-ratio memory adapter with 4-bit CountMinSketch frequency filter (`kvdock/adapters/memory-wtinylfu`)
- [x] Add bidirectional middleware interceptor pipeline (`dock.use`) and reactive mutation watchers (`dock.watch`) in core `KVDock`
