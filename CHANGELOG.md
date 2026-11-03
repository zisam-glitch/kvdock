# Changelog

All notable changes to `kvdock` will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-11-03

### Added
- **Official SvelteKit Integration (`kvdock/integrations/sveltekit`)**:
  - `createKVDockHandle`: SvelteKit server `Handle` hook providing route response caching with automatic weak SHA-1 ETag computation and conditional `If-None-Match` revalidation returning `304 Not Modified` (#96).
  - Supports configurable TTLs, vary header tracking, dynamic skip predicates (`shouldCache`), and custom `Cache-Control` propagation.
  - `createSvelteKitSessionStore`: Type-safe session management engine integrated directly into SvelteKit cookies and server hooks with automatic session lifecycle management (`save`, `destroy`, `touch`).

## [0.3.0] - 2026-11-03

### Added
- **Official Framework Integrations**:
  - **Next.js 14/15 CacheHandler (`kvdock/integrations/nextjs`)**: Drop-in App Router ISR and fetch cache handler with tag invalidation (#68).
  - **Hono Edge Middlewares (`kvdock/integrations/hono`)**: Route caching with automatic ETag generation, conditional 304 revalidation, and encrypted session management for Cloudflare Workers, Bun, Node, and Deno (#67).
  - **Express Session Store (`kvdock/integrations/express`)**: Production session store conforming to Express session store contract with TTL pruning (#69).
  - **Fastify Cache Plugin (`kvdock/integrations/fastify`)**: Route caching plugin decorating Fastify instances with `fastify.dock` (#70).
  - **Nuxt 3 / Nitro Driver (`kvdock/integrations/nuxt`)**: Native unstorage driver integrating KVDock directly into Nitro's storage layer.
- **Enterprise Storage Adapters**:
  - **Bun Native SQLite (`kvdock/adapters/bun-sqlite`)**: Ultra-fast native SQLite driver leveraging `bun:sqlite` with WAL mode and prepared statements (#60).
  - **LibSQL / Turso Edge (`kvdock/adapters/libsql`)**: Distributed SQLite driver supporting Turso embedded replicas and HTTP edge connections (#56).
  - **Cloudflare D1 (`kvdock/adapters/d1`)**: Serverless SQL storage adapter for Cloudflare Workers D1 databases (#57).
  - **Deno KV Native Runtime (`kvdock/adapters/deno-kv`)**: Native Deno KV adapter using tuple key mapping and atomic transactions (#59).
  - **MongoDB Collection Adapter (`kvdock/adapters/mongodb`)**: Document storage driver utilizing MongoDB native Background TTL Indexes (#55).
  - **PostgreSQL Adapter (`kvdock/adapters/postgres`)**: Relational key-value driver with automatic schema migration and parameterized queries (#54).
  - **React Native AsyncStorage (`kvdock/adapters/async-storage`)**: Mobile client storage driver for React Native applications (#62).
  - **LocalStorage Fallback Adapter (`kvdock/adapters/localstorage`)**: Zero-dependency browser storage driver with sweep cleaner and quota degradation (#61, #46).
  - **DynamoDB Adapter (`kvdock/adapters/dynamodb`)**: Serverless document storage driver for AWS Lambda, ECS, and Fargate (#53).
  - **Memcached Adapter (`kvdock/adapters/memcached`)**: High-performance binary protocol caching adapter with native CAS token support (#58).
  - **LevelDB Adapter (`kvdock/adapters/leveldb`)**: Embedded fast key-value storage driver for Node.js runtimes.
- **Observability & Telemetry Plugins**:
  - **OpenTelemetry Plugin (`kvdock/plugins/opentelemetry`)**: W3C distributed tracing instrumenting storage calls with duration and status attributes (#65).
  - **Prometheus Exporter (`kvdock/plugins/prometheus`)**: Production metrics collector exporting standard Prometheus scrapable metrics (#66).
- **Concurrency & Tooling**:
  - **Distributed Locks (`kvdock/middleware/lock`)**: `DistributedMutex` with monotonic fencing tokens and lease renewal, plus `DistributedSemaphore` with permit slots (#48).
  - **Zero-Downtime Migration Utility (`kvdock/tooling/migrate`)**: Key migration engine between arbitrary docks and adapters with TTL preservation, retry backoff, and CLI command (`npx kvdock migrate`) (#72).
  - **Multi-Adapter Performance Matrix (`scripts/benchmark-matrix.mjs`)**: Automated benchmark runner and Markdown report generator (`docs/PERFORMANCE_MATRIX.md`) (#51).
- **Codecs & Protection**:
  - **TokenBucketLimiter & SlidingWindowLimiter (`kvdock/plugins/rate-limiter`)**: Production rate limiters running directly on any KVDock storage adapter with atomic CAS support and smooth boundary estimation (#71, #47).
  - **Transparent Compression Codec (`kvdock/codecs/compression`)**: Zero-dependency compression supporting Brotli, Gzip, and Deflate with configurable size threshold and magic byte prefixing (#63, #44).
  - **Authenticated Encryption Codec (`kvdock/codecs/encryption`)**: AES-256-GCM authenticated encryption at rest with randomized IVs and tamper-detection auth tags (#64, #45).

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
