# Daily changelog

One honest line per shipped item.

- **2026-11-03**: Added opt-in real Redis server integration test suite (`src/adapters/redis/integration.test.ts`), fixed prefix handling in `RedisAdapter.clear()`, and added `@types/node` and `ioredis` to devDependencies.
- **2026-11-03**: Added opt-in real PostgreSQL and MongoDB integration test suites (`src/adapters/postgres/integration.test.ts`, `src/adapters/mongodb/integration.test.ts`), declared optional peerDependencies for `pg`, `mongodb`, and `ioredis` in `package.json`.
- **2026-11-03**: Updated `README.md` with honest maturity tiers (Stable, Production Integration, Experimental), detailed peer dependency documentation, and updated `SECURITY.md` supported versions table.
- **2026-11-03**: Added automated `npm pack` tarball smoke test to CI pipeline (`.github/workflows/ci.yml`), verifying fresh isolated installation and package export integrity.
- **2026-11-03**: Published real newcomer issues with `good first issue` and `help wanted` labels (#106, #107, #108) with actionable specs, verified `SECURITY.md` and `CONTRIBUTING.md`.
- **2026-11-03**: Published multi-adapter benchmark results in `docs/PERFORMANCE_MATRIX.md` executed locally with real payload measurements across 1KB, 10KB, and 100KB sizes.
- **2026-11-03**: Upgraded OpenSSF Scorecard action to `v2.5.0` (`ghcr.io`), pinned all workflow action SHAs, declared minimal workflow permissions across `ci.yml`, `release.yml`, and `scorecard.yml`.
- **2026-11-03**: Cleaned up legacy follower bot artifacts, corrected `docs/launch/show-hn.md` claims to 100% technical accuracy, and authored comprehensive technical dev.to deep-dive draft (`docs/launch/dev-to.md`).
- **2026-11-03**: Hardened JSON envelope parsing in `LocalStorageAdapter` and `AsyncStorageAdapter` against malformed payloads and non-envelope primitives, resolving #108 with full unit test coverage.
- **2026-11-03**: Authored ElysiaJS and Bun.serve caching guide in `docs/guides/elysia.md` and created runnable cookbook recipe in `examples/elysia-caching/`, closing #107.
- **2026-11-03**: Added automated Miniflare integration test suites for `CloudflareKVAdapter` and `D1Adapter`, fixed recursive loop in D1 delete/get, and implemented batch methods (`getMany`, `setMany`, `deleteMany`).
- **2026-11-03**: Added Prometheus metrics scraping endpoint handlers (Web Fetch API, Node HTTP, standalone server) and operation latency histograms with configurable buckets to `kvdock/plugins/prometheus`.
- **2026-11-07**: Added W3C distributed trace context propagation (traceparent, tracestate, baggage) and transparent storage adapter tracing in `kvdock/plugins/opentelemetry`.
- **2026-11-10**: Added resilient exponential backoff retry middleware with full, equal, and decorrelated jitter strategies in `kvdock/middleware/retry` with transparent storage adapter wrapping and cancellation support.
