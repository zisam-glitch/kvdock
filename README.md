# kvdock

[![CI](https://github.com/zisam-glitch/kvdock/actions/workflows/ci.yml/badge.svg)](https://github.com/zisam-glitch/kvdock/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/zisam-glitch/kvdock/badge)](https://securityscorecards.dev/viewer/?uri=github.com/zisam-glitch/kvdock)
[![npm version](https://img.shields.io/npm/v/kvdock.svg)](https://www.npmjs.com/package/kvdock)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/kvdock)](https://bundlephobia.com/package/kvdock)
[![Interactive Playground](https://img.shields.io/badge/Playground-Live_Stampede_Simulator-38BDF8?style=flat-square&logo=googlechrome&logoColor=white)](https://zisam-glitch.github.io/kvdock/playground/index.html)
[![Follow @zisam-glitch](https://img.shields.io/github/followers/zisam-glitch?label=Follow%20%40zisam-glitch&style=social)](https://github.com/zisam-glitch)

Universal key-value and caching engine with zero-dependency core, pluggable storage adapters, multi-tier caching, and built-in cache stampede protection.

> 🎮 **[Launch the Interactive Web Playground & Stampede Simulator](https://zisam-glitch.github.io/kvdock/playground/index.html)** — Test multi-tier caching and simulate 5,000 concurrent stampede requests directly in your browser!

---

## ⚡ Real-World Benchmark: Single-Flight Stampede Coalescing

What happens when a hot cache key expires while **1,000 concurrent users** request it simultaneously?

| Metric | Traditional Uncoalesced Caching | `kvdock.getOrSet()` | Net Impact |
| :--- | :---: | :---: | :---: |
| **Incoming Concurrent Requests** | 1,000 | 1,000 | Identical load |
| **Primary Database Hits** | **1,000 queries** *(Thundering Herd)* | **1 query** *(Single-Flight)* | **99.9% DB load reduction** |
| **Coalesced Waiting Callers** | 0 | 999 | Zero lock contention |
| **DB Connection Pool Exhaustion** | 💥 Critical Spike | 🟢 Baseline Stable | Zero connection exhaustion |

Run this benchmark locally at any time:
```bash
npm run build && node scripts/benchmark-stampede.mjs
```

---

## Highlights

- **Zero Runtime Dependencies**: Core engine and official local drivers have zero external dependencies.
- **Multi-Tiered Caching (`TieredDock`)**: Pair an ultra-fast in-memory L1 cache with a distributed/persistent L2 store with automatic promotion.
- **Cache Stampede Protection**: Single-flight promise coalescing stops thundering herds—concurrent requests for the same missing key run the fetcher only once.
- **Streaming Scans (`dock.scan()`)**: Memory-efficient `AsyncIterable` stream scanning to traverse millions of keys without buffer exhaustion.
- **Atomic Operations**: Compare-And-Swap (`cas`) semantics and ACID transactions across supported backends.
- **Tag-Based Invalidation**: Group keys with tags and purge entire collections in a single call (`dock.invalidateTag()`).
- **Tree-Shakeable Adapters**: Import only the storage drivers your application needs.
- **Reusable Compliance Test Suite**: Scaffold new adapters in 15 minutes with `kvdock/testing`.
- **Cross-Runtime**: Runs anywhere: Node.js (>=18), Bun, Deno, Cloudflare Workers, Edge Runtimes, and Web Browsers.

---

## Installation

```bash
npm install kvdock
```

---

## Adapters & Integrations Matrix

### Core & Local Storage Drivers (Zero External Dependencies)

| Adapter | Maturity | Capabilities | Target Runtime | Import |
| :--- | :---: | :--- | :--- | :--- |
| **Memory** | 🟢 Stable | TTL, Batch, Scan, LRU, CAS | All JS Runtimes | `kvdock/adapters/memory` |
| **Memory (Byte-Sized)** | 🟢 Stable | TTL, Batch, Scan, CAS, Byte limit | All JS Runtimes | `kvdock/adapters/memory-sized` |
| **SQLite (`node:sqlite`)** | 🟢 Stable | TTL, Batch, Scan, CAS, ACID Tx | Node.js (>=22), Bun | `kvdock/adapters/sqlite` |
| **Bun SQLite** | 🟢 Stable | TTL, Batch, Scan, CAS, High-throughput | Bun | `kvdock/adapters/bun-sqlite` |
| **Filesystem** | 🟢 Stable | TTL, Scan, Atomic writes | Node.js, Bun | `kvdock/adapters/fs` |
| **LevelDB** | 🟢 Stable | TTL, Batch, Scan, LSM-tree | Node.js, Bun, Embedded | `kvdock/adapters/leveldb` |
| **LocalStorage** | 🟢 Stable | Envelope TTL, Quota resilience | Browsers, Web Workers | `kvdock/adapters/localstorage` |
| **IndexedDB** | 🟢 Stable | TTL, Batch, Scan, CAS | Browsers, PWAs | `kvdock/adapters/indexeddb` |

### Distributed & Cloud Drivers (Optional Peer Dependencies)

| Adapter | Maturity | Peer Dependency | Capabilities | Target Runtime | Import |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **Redis** | 🟡 Production | `ioredis` (optional) | TTL, Batch, Scan, Streaming | Node, Bun, Deno | `kvdock/adapters/redis` |
| **PostgreSQL** | 🟡 Production | `pg` (optional) | TTL, Atomic CAS, Upsert, Relational | Node, Bun | `kvdock/adapters/postgres` |
| **MongoDB** | 🟡 Production | `mongodb` (optional) | Native TTL index, Atomic CAS, Document | Node, Bun | `kvdock/adapters/mongodb` |
| **Valkey Cluster** | 🟡 Production | Zero-dep client | Slot routing, MOVED redirection, Batch | Node, Bun, Deno | `kvdock/adapters/valkey-cluster` |
| **Upstash (REST)** | 🟡 Production | REST / fetch | Serverless pipelining, Edge-ready | Serverless, Edge | `kvdock/adapters/upstash` |
| **Cloudflare D1** | 🟡 Production | D1 binding | SQL persistence, TTL, CAS | Cloudflare Workers | `kvdock/adapters/d1` |
| **Cloudflare KV** | 🟡 Production | KV binding | Edge caching, Cursor pagination | Cloudflare Workers | `kvdock/adapters/cloudflare-kv` |
| **Deno KV** | 🟡 Production | Deno native | Transactional tuples, Versionstamps | Deno | `kvdock/adapters/deno-kv` |
| **LibSQL / Turso** | 🟡 Production | `@libsql/client` (optional) | Distributed SQLite, Edge replication | Edge, Node, Bun | `kvdock/adapters/libsql` |
| **S3 / MinIO / R2** | 🟡 Production | AWS SDK S3 | Blob storage, Binary, Multipart | All cloud runtimes | `kvdock/adapters/s3` |
| **AWS DynamoDB** | 🟡 Production | AWS SDK DynamoDB | Document client, TTL, Batch | AWS Lambda, Cloud | `kvdock/adapters/dynamodb` |
| **Memcached** | 🟡 Production | Binary protocol | High-speed memcached wire protocol | Node, Bun | `kvdock/adapters/memcached` |
| **React Native** | 🧪 Experimental | `@react-native-async-storage` | Mobile local persistence | React Native, Expo | `kvdock/adapters/async-storage` |

### Full-Stack Framework Integrations

| Framework | Integration | Scope | Import |
| :--- | :--- | :--- | :--- |
| **Next.js 15** | `KVDockNextCacheHandler` | App Router Incremental Cache & ISR | `kvdock/integrations/nextjs` |
| **Hono** | `kvdockHonoCache`, `kvdockHonoSession` | HTTP 304 ETag Caching & Edge Sessions | `kvdock/integrations/hono` |
| **Nuxt 3 / Nitro** | `defineKVDockDriver` | Unstorage backend driver | `kvdock/integrations/nuxt` |
| **SvelteKit** | `createSvelteKitSession` | Hook session & cache middleware | `kvdock/integrations/sveltekit` |
| **Fastify** | `kvdockFastifyPlugin` | Fastify route caching & session store | `kvdock/integrations/fastify` |
| **Express** | `KVDockExpressStore` | Express-session store conforming API | `kvdock/integrations/express` |

> See the complete [Adapters Guide & Architectural Comparison](docs/adapters-guide.md) for latency, persistence, and concurrency ratings.

---

## Quick Start

### 1. In-Memory Cache (LRU + TTL)

```typescript
import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const dock = new KVDock({
  adapter: new MemoryAdapter({ maxSize: 10_000 }),
  prefix: "app",
  defaultTTL: 60_000 // 1 minute
});

await dock.set("session:user_1", { role: "admin" });
const user = await dock.get("session:user_1");

// Cache-aside with automatic single-flight stampede protection
const data = await dock.getOrSet("expensive:analytics", async () => {
  return await computeAnalytics();
}, { ttl: 300_000 });
```

### 2. Multi-Tier Caching (`TieredDock`)

Pair in-memory L1 speed with persistent or distributed L2 caching:

```typescript
import { TieredDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { RedisAdapter } from "kvdock/adapters/redis";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

const dock = new TieredDock({
  l1: new MemoryAdapter({ maxSize: 5_000 }),  // Ultra-fast L1 (< 0.05ms)
  l2: new RedisAdapter({ client: redis }),     // Shared L2 (Redis)
  l1TTL: 10_000,                               // Micro-cache hot keys for 10s
  defaultTTL: 3600_000                         // 1 hour in Redis
});

// Checks L1 first; on miss, fetches L2 and automatically backfills L1!
const product = await dock.get("product:123");
```

> Read the [Multi-Tiered Caching Guide](docs/guides/tiered-caching.md).

### 3. SQLite Embedded Persistence

```typescript
import { KVDock } from "kvdock";
import { SQLiteAdapter } from "kvdock/adapters/sqlite";

const dock = new KVDock({
  adapter: new SQLiteAdapter({ path: "./cache.sqlite" })
});

await dock.set("token", "secret", { ttl: 120_000 });
```

### 4. Cloudflare Workers KV

```typescript
import { KVDock } from "kvdock";
import { CloudflareKVAdapter } from "kvdock/adapters/cloudflare-kv";

export default {
  async fetch(req: Request, env: { MY_KV: KVNamespace }) {
    const dock = new KVDock({
      adapter: new CloudflareKVAdapter({ kv: env.MY_KV, prefix: "app" })
    });
    const result = await dock.getOrSet("feed", () => generateFeed());
    return Response.json(result);
  }
};
```

### 5. Transparent Compression & Encryption Codecs

Save up to 80% RAM/disk space on large payloads and secure sensitive data at rest using zero-dependency codecs:

```typescript
import { KVDock, createCompressionCodec, createEncryptionCodec } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

// Automatically compress JSON payloads exceeding 1KB using Brotli
const compressedDock = new KVDock({
  adapter: new MemoryAdapter(),
  serializer: createCompressionCodec({ algorithm: "brotli", thresholdBytes: 1024 }),
});

// Authenticated AES-256-GCM encryption with tamper detection
const encryptedDock = new KVDock({
  adapter: new MemoryAdapter(),
  serializer: createEncryptionCodec({ secretKey: process.env.CACHE_SECRET_KEY! }),
});
```

### 6. Production Rate Limiting (Token Bucket & Sliding Window)

Protect APIs and workers against traffic spikes using rate limiters built directly on KVDock storage:

```typescript
import { KVDock, TokenBucketLimiter, SlidingWindowLimiter } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const dock = new KVDock({ adapter: new MemoryAdapter() });

// Token Bucket: smooth refills with burst capacity
const tokenBucket = new TokenBucketLimiter({
  dock,
  capacity: 10,       // Burst allowance of 10 requests
  refillRate: 2,      // Replenish 2 tokens per second
});

const { allowed, remaining, resetMs } = await tokenBucket.consume("ip:192.168.1.1");

// Sliding Window Counter: O(1) memory with smooth boundary estimation
const slidingWindow = new SlidingWindowLimiter({
  dock,
  limit: 100,         // 100 requests
  windowMs: 60_000,   // Per minute
});

const result = await slidingWindow.consume("api_key:secret_key");
```

---

## Runnable Examples & Framework Starters

Check out the standalone, runnable applications in the **[`examples/`](examples/)** directory:

| Starter Example | Key Capabilities Demonstrated | Run Command |
|---|---|---|
| **[`examples/tiered-cache`](examples/tiered-cache/index.ts)** | L1 (Memory) + L2 (SQLite) tiered caching, single-flight stampede coalescing (100 -> 1 query), automatic promotions | `npx tsx examples/tiered-cache/index.ts` |
| **[`examples/distributed-lock`](examples/distributed-lock/index.ts)** | Distributed Mutex with monotonic fencing tokens, lease renewal, and Distributed Semaphore concurrency pooling | `npx tsx examples/distributed-lock/index.ts` |
| **[`examples/hono-caching`](examples/hono-caching/index.ts)** | Edge HTTP route caching, automatic ETag generation, conditional `304 Not Modified` revalidation, encrypted sessions | `npx tsx examples/hono-caching/index.ts` |
| **[`examples/nextjs-isr`](examples/nextjs-isr/index.ts)** | Next.js 14/15 App Router IncrementalCache handler (`cacheHandler`), tag-based invalidation (`revalidateTag`) | `npx tsx examples/nextjs-isr/index.ts` |

---

## CLI Tool

`kvdock` includes an interactive CLI binary for inspecting keys, diagnosing adapters, and running micro-benchmarks:

```bash
# Diagnostic inspection
npx kvdock doctor

# Benchmark adapter throughput
npx kvdock bench --adapter=memory --ops=10000
npx kvdock bench --adapter=sqlite --ops=5000

# Inspect and manage keys
npx kvdock set user:1 '{"name":"Alice"}' --adapter=sqlite
npx kvdock get user:1 --adapter=sqlite --json
npx kvdock keys "user:*" --adapter=sqlite
```

---

## Contributing & Developer Flywheel

We actively encourage and welcome external contributors! We designed our repository so anyone can build and submit an adapter or feature in under 15 minutes without merge conflicts:

- **1-Command Scaffolding:** `npm run create:adapter <name>` automatically creates your adapter directory, tests, benchmarks, and exports.
- **Exported Compliance Test Suite:** Import `defineAdapterTestSuite` from `kvdock/testing` to instantly run 25+ conformance checks against your driver.
- **Open Issues & Milestones:** Check out our [Open Issues](https://github.com/zisam-glitch/kvdock/issues) labeled `good first issue` and `help wanted`.

Read the [Contributor Guide: Building a Custom Adapter in 15 Minutes](docs/guides/building-an-adapter.md).

---

## Multi-Language Implementations

- **Rust**: [`zisam-glitch/kvdock-rs`](https://github.com/zisam-glitch/kvdock-rs) — Thread-safe, zero-dependency caching layer with monotonic `Instant` TTL.
- **Go**: [`zisam-glitch/kvdock-go`](https://github.com/zisam-glitch/kvdock-go) — Generic key-value cache engine with atomic telemetry.
- **Swift**: [`zisam-glitch/kvdock-swift`](https://github.com/zisam-glitch/kvdock-swift) — Actor-isolated concurrent cache with `ContinuousClock`.
- **Kotlin**: [`zisam-glitch/kvdock-kt`](https://github.com/zisam-glitch/kvdock-kt) — Thread-safe $O(1)$ LRU key-value cache for JVM.

---

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/zisam-glitch"><img src="https://avatars.githubusercontent.com/u/190885141?v=4" width="100px;" alt="zisam shaikh"/><br /><sub><b>zisam shaikh</b></sub></a><br /><a href="#infra-zisam-glitch" title="Infrastructure">🚇</a> <a href="#maintenance-zisam-glitch" title="Maintenance">🚧</a> <a href="#code-zisam-glitch" title="Code">💻</a> <a href="#doc-zisam-glitch" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Vamsi-2581"><img src="https://avatars.githubusercontent.com/u/101239848?v=4" width="100px;" alt="Vamsi"/><br /><sub><b>Vamsi</b></sub></a><br /><a href="#code-Vamsi-2581" title="Code">💻</a> <a href="#test-Vamsi-2581" title="Tests">⚠️</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!

---

## Maintainer & Architecture

Designed and maintained with care by **[zisam shaikh (@zisam-glitch)](https://github.com/zisam-glitch)**.  
Follow along on GitHub for low-latency systems engineering deep dives, lock-free data structures, and zero-dependency runtime tooling.

[![Follow @zisam-glitch on GitHub](https://img.shields.io/badge/GitHub-Follow_@zisam--glitch-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/zisam-glitch)

---

## License

[MIT](LICENSE) © [zisam shaikh](https://github.com/zisam-glitch)
