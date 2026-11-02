# kvdock

[![CI](https://github.com/zisam-glitch/kvdock/actions/workflows/ci.yml/badge.svg)](https://github.com/zisam-glitch/kvdock/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/zisam-glitch/kvdock/badge)](https://securityscorecards.dev/viewer/?uri=github.com/zisam-glitch/kvdock)
[![npm version](https://img.shields.io/npm/v/kvdock.svg)](https://www.npmjs.com/package/kvdock)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/kvdock)](https://bundlephobia.com/package/kvdock)

Universal key-value and caching engine with zero-dependency core, pluggable storage adapters, multi-tier caching, and built-in cache stampede protection.

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

## Adapters Matrix

| Adapter | Status | Capabilities | Environment | Import |
| :--- | :---: | :--- | :--- | :--- |
| **Memory** | :white_check_mark: Built-in | TTL, Batch, Scan, LRU, CAS | All runtimes | `kvdock/adapters/memory` |
| **Memory (Byte-Sized)** | :white_check_mark: Built-in | TTL, Batch, Scan, CAS, Byte limit | All runtimes | `kvdock/adapters/memory-sized` |
| **SQLite** | :white_check_mark: Built-in | TTL, Batch, Scan, CAS, ACID Tx | Node.js (>=22), Bun | `kvdock/adapters/sqlite` |
| **Filesystem** | :white_check_mark: Built-in | TTL, Scan, Atomic writes | Node.js, Bun | `kvdock/adapters/fs` |
| **Redis / Valkey** | :white_check_mark: Built-in | TTL, Batch, Scan, Streaming | Node, Bun, Deno | `kvdock/adapters/redis` |
| **Valkey Cluster** | :white_check_mark: Built-in | TTL, Batch, Slot routing, MOVED | Node, Bun, Deno | `kvdock/adapters/valkey-cluster` |
| **Upstash (REST)** | :white_check_mark: Built-in | TTL, Batch, Scan, Pipeline | Serverless, Edge | `kvdock/adapters/upstash` |
| **Cloudflare KV** | :white_check_mark: Built-in | TTL (60s+ clamp), Scan, Cursors | Cloudflare Workers | `kvdock/adapters/cloudflare-kv` |
| **IndexedDB** | :white_check_mark: Built-in | TTL, Batch, Scan, CAS | Browsers, PWAs | `kvdock/adapters/indexeddb` |

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

## License

[MIT](LICENSE) © [zisam shaikh](https://github.com/zisam-glitch)
