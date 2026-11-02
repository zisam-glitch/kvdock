# Changelog

All notable changes to `kvdock` will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-03

### Added
- **Multi-Tiered Dock (`TieredDock`)**: Transparent L1 (in-memory) + L2 (remote/durable) cache hierarchy with automated backfills and hit/miss telemetry.
- **Single-Flight Stampede Protection**: Deterministic in-flight promise deduplication on `getOrSet()` eliminating thundering herds.
- **Tag-Based Invalidation**: Invalidate clusters of keys by cache tag (`invalidateTag`, `invalidateTags`) with internal reverse lookup index.
- **AsyncIterable Streaming Scan**: Memory-efficient batch iteration via `dock.scan({ prefix, batchSize })`.
- **Atomic Compare-And-Swap (`compareAndSwap`)**: Optimistic concurrency control across supported storage adapters.
- **Observability Hooks**: Lifecycle events (`hit`, `miss`, `set`, `delete`, `stampede_coalesced`) and pluggable logger integration.
- **SQLite Adapter (`kvdock/adapters/sqlite`)**: Zero-dependency embedded storage backed by `node:sqlite` (`DatabaseSync`) with prepared statement caching and ACID transactions.
- **Cloudflare KV Adapter (`kvdock/adapters/cloudflare-kv`)**: Tailored for Cloudflare Workers with automatic 60-second TTL clamping and cursor pagination.
- **IndexedDB Adapter (`kvdock/adapters/indexeddb`)**: Client-side offline storage driver for PWAs and modern web browsers.
- **Valkey Cluster Adapter (`kvdock/adapters/valkey-cluster`)**: Distributed Redis/Valkey cluster routing with CRC16-CCITT slot hash calculation and automatic MOVED/ASK redirect handling (#38).
- **S3 / MinIO Adapter (`kvdock/adapters/s3`)**: Cloud object storage adapter with automatic metadata-based TTL persistence, streaming body handling, and prefix scanning (#40).
- **Memory-Sized Adapter (`kvdock/adapters/memory-sized`)**: Byte-bounded LRU memory driver for strict heap allocation caps.
- **Interactive CLI (`npx kvdock`)**: Terminal commands for `doctor`, `bench`, `get`, `set`, `del`, and `keys`.
- **Adapter Conformance Test Suite (`kvdock/testing`)**: Standardized 25+ test suite exported for third-party adapter authors (`defineAdapterTestSuite`).
- **Scaffolding Generator (`npm run create:adapter <name>`)**: Single-command adapter generator producing compliant code, tests, and benchmarks.
- **Architectural Documentation**: Complete adapter matrix, building-an-adapter guide, framework recipes (Hono, Next.js, Express), and tiered caching blueprints.

## [0.1.0] - 2026-10-28

### Added
- Core `KVDock` storage engine with zero-dependency TypeScript implementation.
- Built-in `MemoryAdapter` with sub-millisecond $O(1)$ LRU eviction and deterministic TTL management.
- Built-in `FsAdapter` with atomic JSON serialization and directory management.
- Complete dual ESM and CJS bundle targets built with `tsup`.
- Multi-language ecosystem parity specifications for Rust, Go, Swift, and Kotlin.
- Multi-stage CI pipeline verifying linting, type safety, and test suites.
- Architecture Decision Records (`001-core-architecture.md`, `002-error-handling-strategy.md`, `003-zero-dependency-policy.md`).

### Fixed
- Enforce strict TTL boundary validation rejecting non-positive and non-finite values (#31).
